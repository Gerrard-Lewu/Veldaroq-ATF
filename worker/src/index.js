const MAX_REQUEST_BYTES = 12_000;
const MAX_OUTPUT_CHARS = 18_000;
const MAX_PROMPT_CHARS = 4_000;
const ALLOWED_CROPS = new Set(["spinach", "cabbage", "tomatoes"]);
const ALLOWED_MONTHS = new Set(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]);
const ALLOWED_PROVINCES = new Set(["Eastern Cape", "Free State", "Gauteng", "KwaZulu-Natal", "Limpopo", "Mpumalanga", "North West", "Northern Cape", "Western Cape"]);
const ALLOWED_WATER = new Set(["Reliable irrigation", "Limited irrigation", "Rain-fed"]);
const recentRequests = new Map();
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 10;

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
  return `You are a careful South African small-scale growing-planning assistant. Create a practical plan for this grower using Google Search grounding. All money is South African rand (ZAR). The grower gave: town ${farm.town}, province ${farm.province}, crop ${farm.crop}, plot ${farm.area} square metres, budget R${farm.budget}, intended planting month ${farm.month}, water access ${farm.water}. Soil properties are unknown: say so and never infer them from location.\n\nUse locally relevant, current sources. Clearly separate verified sourced facts from your own estimates. Never invent a supplier, price, price availability, soil measurement, yield, guarantee, or source. When supplier prices are unavailable, write “price not found” or label a reasonable quantity/cost as an estimate and explain it needs local verification. Do not claim any supplier is universally cheapest. A listing is not proof of quality. Keep every estimated essential cost itemised and make the arithmetic total and remaining budget/shortfall add up; if the full plot is not affordable, suggest a smaller feasible scope or state the shortfall without pretending an incomplete-price list fits the budget. State when the requested month is unsuitable or uncertain and give a source-supported alternative crop only when the sources support it. If evidence for a claim is not found, explicitly state that.\n\nUse these exact plain-text section headings: Suitability; Planting window; Getting started; Budget; Buying list. Under Buying list, include no more than three actually found supplier options, each with a link and price if available, otherwise say price not found. In Budget, show item, quantity, unit cost, line total, total, and remaining budget or shortfall; label estimates. Keep the answer concise and actionable, under 3,500 characters. Do not make up citation URLs: supporting citations are shown separately from Google Search grounding metadata.`;
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
    if (env.LIMIT && !await env.LIMIT.limit({ key: ip }).then((result) => result.success).catch(() => false)) {
      return json({ error: "Too many requests. Please wait a minute and try again." }, 429, configuredOrigin);
    }
    if (!env.LIMIT && !allowedByLocalLimiter(ip)) {
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

    try {
      const apiResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptFor(farm) }] }],
          tools: [{ google_search: {} }],
          generationConfig: { maxOutputTokens: 2_500, temperature: 0.3 }
        }),
        signal: AbortSignal.timeout(45_000)
      });
      if (!apiResponse.ok) {
        const status = apiResponse.status;
        return json({ error: status === 429 ? "The plan service is busy. Please wait a moment and retry." : "The plan service couldn’t complete that request. Please retry." }, status === 429 ? 429 : 502, configuredOrigin);
      }
      const data = await apiResponse.json();
      const candidate = data.candidates?.[0];
      const text = (candidate?.content?.parts || []).map((part) => part.text || "").join("\n").trim();
      if (!text || text.length > MAX_OUTPUT_CHARS) return json({ error: "The plan response was incomplete. Please retry." }, 502, configuredOrigin);
      const chunks = candidate?.groundingMetadata?.groundingChunks || [];
      const sources = [...new Map(chunks.map((chunk) => {
        const web = chunk.web;
        if (!web?.uri || !/^https:\/\//i.test(web.uri)) return null;
        return [web.uri, { url: web.uri, title: String(web.title || new URL(web.uri).hostname).slice(0, 180), snippet: String(web.snippet || "").slice(0, 300) }];
      }).filter(Boolean)).values()].slice(0, 10);
      if (sources.length === 0) return json({ error: "No verifiable search references came back. Please retry." }, 502, configuredOrigin);
      return json({ text, sources }, 200, configuredOrigin);
    } catch {
      return json({ error: "The plan service timed out or couldn’t be reached. Please retry." }, 502, configuredOrigin);
    }
  }
};
