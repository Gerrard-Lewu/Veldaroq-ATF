const MAX_REQUEST_BYTES = 12_000;
const MAX_OUTPUT_CHARS = 18_000;
const ALLOWED_CROPS = new Set(["spinach", "cabbage", "tomatoes"]);
const ALLOWED_MONTHS = new Set(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]);
const ALLOWED_PROVINCES = new Set(["Eastern Cape", "Free State", "Gauteng", "KwaZulu-Natal", "Limpopo", "Mpumalanga", "North West", "Northern Cape", "Western Cape"]);
const ALLOWED_WATER = new Set(["Reliable irrigation", "Limited irrigation", "Rain-fed"]);
const recentRequests = new Map();
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 10;
const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const REQUIRED_SECTIONS = ["Suitability", "Planting window", "Getting started", "Budget", "Buying list"];

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function validInput(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof value.town === "string" && value.town.trim().length > 0 && value.town.length <= 80
    && ALLOWED_PROVINCES.has(value.province)
    && ALLOWED_CROPS.has(value.crop)
    && Number.isFinite(value.area) && value.area > 0 && value.area <= 100_000
    && Number.isFinite(value.budget) && value.budget > 0 && value.budget <= 100_000_000
    && ALLOWED_MONTHS.has(value.month)
    && ALLOWED_WATER.has(value.water);
}

function allowedByLocalLimiter(key, now = Date.now()) {
  const requests = (recentRequests.get(key) || []).filter((timestamp) => now - timestamp < WINDOW_MS);
  if (requests.length >= MAX_REQUESTS_PER_WINDOW) {
    recentRequests.set(key, requests);
    return false;
  }
  requests.push(now);
  recentRequests.set(key, requests);
  if (recentRequests.size > 2_000) {
    for (const [storedKey, timestamps] of recentRequests) {
      if (timestamps.every((timestamp) => now - timestamp >= WINDOW_MS)) recentRequests.delete(storedKey);
    }
  }
  return true;
}

function promptFor(farm) {
  return `You are a careful South African small-scale growing-planning assistant. Create a practical plan using Google Search grounding. All money is South African rand (ZAR). Do not invent sources, supplier URLs, stock or prices. Cite factual growing advice and supplier/price claims only from Google Search results. Include exactly these five headings: Suitability, Planting window, Getting started, Budget, Buying list. Under Budget, provide bulleted item lines with quantity and rand price where verified; label a verified price (sourced), an uncertain price estimate, or an unavailable price “price not found”. Do not claim a sourced price without a supporting search result. Include the literal lines “Total:” and “Remaining budget / shortfall:” but leave their values for the application to calculate. Budget: R ${farm.budget}. Do not calculate totals. Farm details: crop ${farm.crop}; town ${farm.town}; province ${farm.province}; plot ${farm.area} m²; requested planting month ${farm.month}; water access ${farm.water}. Keep the response concise enough to include all five sections.`;
}

function sanitiseForLog(value, env, farm) {
  let message = String(value || "Upstream request failed").replace(/[\u0000-\u001f\u007f]/g, " ");
  const privateValues = [env.GEMINI_API_KEY, farm?.town, farm?.province, farm?.crop, farm?.month, farm?.water, farm?.area, farm?.budget]
    .filter((item) => item !== undefined && item !== null && String(item).length > 0)
    .map(String)
    .sort((a, b) => b.length - a.length);
  for (const secret of privateValues) {
    message = message.replaceAll(secret, "[redacted]");
  }
  return message.replace(/\s+/g, " ").trim().slice(0, 240) || "Upstream request failed";
}

async function getProviderError(response, env, farm) {
  let data = {};
  try { data = await response.json(); } catch { /* Upstream may return non-JSON. */ }
  const error = data?.error || {};
  const codeValue = error.code ?? error.status ?? response.status;
  const code = String(codeValue).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 48) || String(response.status);
  const message = sanitiseForLog(error.message, env, farm);
  console.error(JSON.stringify({ event: "gemini_upstream_error", status: response.status, code, message }));
}

function hasRequiredSections(text) {
  const headings = text.match(/^\s{0,3}#{0,3}\s*(Suitability|Planting window|Getting started|Budget|Buying list)\b/im);
  if (!headings) return false;
  return REQUIRED_SECTIONS.every((section) => new RegExp(`^\\s{0,3}#{0,3}\\s*${section}\\b`, "im").test(text));
}

function collectGroundingSources(candidate) {
  const chunks = candidate?.groundingMetadata?.groundingChunks || [];
  const sources = [...new Map(chunks.map((chunk) => {
    const web = chunk.web;
    if (!web?.uri) return null;
    try {
      const url = new URL(web.uri);
      if (url.protocol !== "https:") return null;
      return [url.href, { url: url.href, title: String(web.title || url.hostname).slice(0, 180), snippet: String(web.snippet || "").slice(0, 300) }];
    } catch { return null; }
  }).filter(Boolean)).values()].slice(0, 10);
  return sources;
}

export default {
  async fetch(request, env) {
    const configuredOrigin = env.ALLOWED_ORIGIN;
    const requestOrigin = request.headers.get("Origin") || "";
    if (!configuredOrigin || requestOrigin !== configuredOrigin) {
      return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": configuredOrigin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin"
        }
      });
    }
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, configuredOrigin);
    const contentType = request.headers.get("Content-Type") || "";
    const declaredLength = Number(request.headers.get("Content-Length") || 0);
    if (!contentType.toLowerCase().includes("application/json") || declaredLength > MAX_REQUEST_BYTES) {
      return json({ error: "Send a small JSON request." }, 413, configuredOrigin);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (env.LIMIT) {
      let permitted = false;
      try { permitted = (await env.LIMIT.limit({ key: ip })).success; } catch { permitted = false; }
      if (!permitted) return json({ error: "Too many requests. Please wait a minute and try again." }, 429, configuredOrigin);
    } else if (!allowedByLocalLimiter(ip)) {
      return json({ error: "Too many requests. Please wait a minute and try again." }, 429, configuredOrigin);
    }

    let raw;
    try {
      raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) throw new Error("Request too large");
    } catch {
      return json({ error: "Request body is too large or could not be read." }, 413, configuredOrigin);
    }
    let farm;
    try { farm = JSON.parse(raw); } catch { return json({ error: "Request must be valid JSON." }, 400, configuredOrigin); }
    if (!validInput(farm)) return json({ error: "Check the town, province, crop, positive plot area, budget, month and water access." }, 400, configuredOrigin);
    if (!env.GEMINI_API_KEY) return json({ error: "The plan service is not configured. Please try again later." }, 503, configuredOrigin);

    const model = String(env.GEMINI_MODEL || DEFAULT_MODEL).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(model)) {
      return json({ error: "The plan service model configuration is invalid. Please try again later." }, 503, configuredOrigin);
    }

    let apiResponse;
    try {
      apiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptFor(farm) }] }],
          tools: [{ google_search: {} }],
          generationConfig: { maxOutputTokens: 2_500, temperature: 0.3 }
        }),
        signal: AbortSignal.timeout(45_000)
      });
    } catch (error) {
      const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
      console.error(JSON.stringify({ event: "gemini_upstream_error", status: 0, code: timeout ? "TIMEOUT" : "NETWORK_ERROR", message: timeout ? "Upstream request timed out" : "Upstream request could not be reached" }));
      return json({ error: "The plan service timed out or couldn’t be reached. Please retry." }, 502, configuredOrigin);
    }

    if (!apiResponse.ok) {
      await getProviderError(apiResponse, env, farm);
      return json({ error: apiResponse.status === 429 ? "The plan service is busy. Please wait a moment and retry." : "The plan service couldn’t complete that request. Please retry." }, apiResponse.status === 429 ? 503 : 502, configuredOrigin);
    }

    let data;
    try { data = await apiResponse.json(); } catch {
      console.error(JSON.stringify({ event: "gemini_upstream_error", status: apiResponse.status, code: "INVALID_JSON", message: "Upstream returned invalid JSON" }));
      return json({ error: "The plan response was incomplete. Please retry." }, 502, configuredOrigin);
    }
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts || []).map((part) => typeof part.text === "string" ? part.text : "").join("\n").trim();
    if (candidate?.finishReason === "MAX_TOKENS" || !text || text.length > MAX_OUTPUT_CHARS || !hasRequiredSections(text)) {
      return json({ error: "The plan response was incomplete. Please retry." }, 502, configuredOrigin);
    }
    const sources = collectGroundingSources(candidate);
    if (sources.length === 0 || !candidate?.groundingMetadata?.groundingSupport?.length) {
      return json({ error: "No verifiable Google Search references came back. Please retry." }, 502, configuredOrigin);
    }
    return json({ text, sources }, 200, configuredOrigin);
  }
};
