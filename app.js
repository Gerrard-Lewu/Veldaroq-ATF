const form = document.querySelector("#farm-form");
const resultArea = document.querySelector("#result-area");
const loading = document.querySelector("#loading");
const errorPanel = document.querySelector("#error");
const planCard = document.querySelector("#plan-card");
const submitButton = document.querySelector("#submit-button");
let lastPayload = null;

function showState(state) {
  resultArea.hidden = false;
  resultArea.setAttribute("aria-busy", state === "loading" ? "true" : "false");
  loading.hidden = state !== "loading";
  errorPanel.hidden = state !== "error";
  planCard.hidden = state !== "plan";
}

function getFormData() {
  const data = new FormData(form);
  return {
    town: String(data.get("town") || "").trim(),
    province: String(data.get("province") || ""),
    crop: String(data.get("crop") || ""),
    area: Number(data.get("area")),
    budget: Number(data.get("budget")),
    month: String(data.get("month") || ""),
    water: String(data.get("water") || "")
  };
}

function renderPlan(text) {
  const container = document.querySelector("#plan-content");
  container.replaceChildren();
  let list = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) { list = null; continue; }
    const heading = line.match(/^#{1,3}\s+(.+)|^(?:\*\*)?((?:Suitability|Planting window|Getting started|Budget|Buying list|Sources)(?:\s*\([^)]*\))?)(?:\*\*)?:?$/i);
    if (heading) {
      list = null;
      const h = document.createElement("h3");
      h.textContent = heading[1] || heading[2];
      container.append(h);
      continue;
    }
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (bullet) {
      if (!list) { list = document.createElement("ul"); container.append(list); }
      const li = document.createElement("li");
      li.textContent = bullet[1].replace(/\*\*/g, "");
      list.append(li);
      continue;
    }
    list = null;
    const p = document.createElement("p");
    p.textContent = line.replace(/^\*\*(.+)\*\*$/, "$1").replace(/\*\*/g, "");
    container.append(p);
  }
}

function renderSources(sources) {
  const list = document.querySelector("#sources-list");
  list.replaceChildren();
  for (const source of sources) {
    let url;
    try { url = new URL(source.url); } catch { continue; }
    if (url.protocol !== "https:") continue;
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = source.title || url.hostname;
    li.append(link);
    if (source.snippet) {
      const note = document.createElement("span");
      note.textContent = ` — ${source.snippet}`;
      li.append(note);
    }
    list.append(li);
  }
}

async function generatePlan(payload) {
  const apiUrl = window.VELDAROQ_CONFIG?.apiUrl;
  if (!apiUrl) {
    showState("error");
    document.querySelector("#error-message").textContent = "The plan service isn’t configured yet. Add your deployed Worker URL to config.js and try again.";
    return;
  }
  submitButton.disabled = true;
  showState("loading");
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `The service returned an error (${response.status}).`);
    if (typeof result.text !== "string" || !Array.isArray(result.sources) || result.sources.length === 0) {
      throw new Error("The search-backed response didn’t include usable source references. Please retry.");
    }
    renderPlan(result.text);
    renderSources(result.sources);
    document.querySelector("#plan-summary").textContent = `${payload.crop[0].toUpperCase()}${payload.crop.slice(1)} · ${payload.town}, ${payload.province} · ${payload.area.toLocaleString()} m²`;
    showState("plan");
    planCard.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showState("error");
    document.querySelector("#error-message").textContent = error instanceof TypeError
      ? "We couldn’t reach the plan service. Check your connection and try again."
      : error.message;
  } finally {
    submitButton.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  lastPayload = getFormData();
  generatePlan(lastPayload);
});
document.querySelector("#retry-button").addEventListener("click", () => {
  if (lastPayload) generatePlan(lastPayload);
});
document.querySelector("#edit-button").addEventListener("click", () => {
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  document.querySelector("#town").focus({ preventScroll: true });
});
