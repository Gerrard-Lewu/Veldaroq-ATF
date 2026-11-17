const form = document.querySelector("#farm-form");
const resultArea = document.querySelector("#result-area");
const emptyState = document.querySelector("#empty-state");
const loading = document.querySelector("#loading");
const errorPanel = document.querySelector("#error");
const planCard = document.querySelector("#plan-card");
const submitButton = document.querySelector("#submit-button");
const formControls = [...form.querySelectorAll("input, select, button")];
let lastPayload = null;

const FIELD_RULES = {
  town: (field) => !field.value.trim() ? "Enter your town or city." : field.value.length > 80 ? "Town or city must be 80 characters or fewer." : "",
  province: (field) => !field.value ? "Choose your province." : "",
  crop: (field) => !field.value ? "Choose a crop." : "",
  area: (field) => !field.value || !Number.isFinite(field.valueAsNumber) ? "Enter a plot area greater than 0." : field.valueAsNumber < 1 ? "Plot area must be at least 1 m²." : field.valueAsNumber > 100000 ? "Plot area must be 100,000 m² or less." : "",
  budget: (field) => !field.value || !Number.isFinite(field.valueAsNumber) ? "Enter a budget greater than 0." : field.valueAsNumber < 1 ? "Budget must be at least R 1." : field.valueAsNumber > 100000000 ? "Budget must be R 100,000,000 or less." : "",
  month: (field) => !field.value ? "Choose your intended planting month." : ""
};

function showState(state) {
  resultArea.setAttribute("aria-busy", state === "loading" ? "true" : "false");
  emptyState.hidden = state !== "empty";
  loading.hidden = state !== "loading";
  errorPanel.hidden = state !== "error";
  planCard.hidden = state !== "plan";
  resultArea.classList.toggle("has-error", state === "error");
}

function setFieldError(name, message) {
  const field = name === "water" ? document.querySelector("#water-field") : document.querySelector(`#${name}`);
  const error = document.querySelector(`#${name}-error`);
  error.textContent = message ? `Error: ${message}` : "";
  error.hidden = !message;
  if (name === "water") {
    field.setAttribute("aria-invalid", message ? "true" : "false");
    field.querySelectorAll('input[type="radio"]').forEach((input) => input.setAttribute("aria-invalid", message ? "true" : "false"));
  } else {
    field.setAttribute("aria-invalid", message ? "true" : "false");
  }
}

function validateField(name) {
  const field = document.querySelector(`#${name}`);
  const message = FIELD_RULES[name](field);
  setFieldError(name, message);
  return !message;
}

function validateWater() {
  const checked = form.querySelector('input[name="water"]:checked');
  const message = checked ? "" : "Choose your water access.";
  setFieldError("water", message);
  return !message;
}

function validateForm() {
  const names = ["town", "province", "crop", "area", "budget", "month"];
  const validity = names.map(validateField);
  validity.push(validateWater());
  if (validity.includes(false)) {
    const firstInvalid = form.querySelector('[aria-invalid="true"]');
    firstInvalid?.focus();
    return false;
  }
  return true;
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

function cleanText(text) {
  return text.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1").replace(/\*\*/g, "").trim();
}

function parseSections(text) {
  const sections = new Map();
  let current = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = line.match(/^#{1,3}\s*(.+?)\s*#*$|^(?:\*\*)?(Suitability|Planting window|Getting started|Budget|Buying list)(?:\s*\([^)]*\))?(?:\*\*)?:?$/i);
    if (heading) {
      current = (heading[1] || heading[2]).trim().toLowerCase();
      if (current.startsWith("suitability")) current = "suitability";
      if (current.startsWith("planting window")) current = "planting window";
      if (current.startsWith("getting started")) current = "getting started";
      if (current.startsWith("buying list")) current = "buying list";
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (!current) { current = "suitability"; sections.set(current, sections.get(current) || []); }
    sections.get(current).push(line);
  }
  return sections;
}

function sectionLines(sections, name) { return sections.get(name) || []; }
function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function makePlanSection(title, className = "") {
  const section = makeElement("section", `plan-section${className ? ` ${className}` : ""}`);
  const heading = makeElement("h3", "", title);
  section.append(heading);
  return { section, heading };
}
function appendTextLines(parent, lines) {
  let list = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { list = null; continue; }
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (bullet) {
      if (!list) { list = makeElement("ul"); parent.append(list); }
      list.append(makeElement("li", "", cleanText(bullet[1])));
    } else {
      list = null;
      parent.append(makeElement("p", "", cleanText(line)));
    }
  }
}
function sourceIndex(sources) {
  const map = new Map();
  for (const source of sources) {
    try {
      const url = new URL(source.url);
      if (url.protocol === "https:") map.set(url.href, { ...source, url: url.href, domain: url.hostname });
    } catch { /* Ignore malformed provider references. */ }
  }
  return map;
}
function extractUrls(line) {
  const found = [];
  for (const match of line.matchAll(/(?:https?:\/\/[^\s)\]>]+|www\.[^\s)\]>]+)/gi)) {
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    try {
      const url = new URL(raw.startsWith("www.") ? `https://${raw}` : raw);
      if (url.protocol === "https:") found.push(url.href);
    } catch { /* Ignore malformed links. */ }
  }
  return [...new Set(found)];
}
function parseMoney(line) {
  return [...line.matchAll(/(?:R\s*)((?:\d{1,3}(?:[\s,]\d{3})+|\d+)(?:\.\d{1,2})?)/gi)]
    .map((match) => Number(match[1].replace(/[\s,]/g, ""))).filter(Number.isFinite);
}
function formatRand(amount) {
  return `R ${new Intl.NumberFormat("en-ZA", { maximumFractionDigits: 2 }).format(amount)}`;
}
function priceType(line, urls, sources) {
  if (/price\s+not\s+found|price\s+unavailable|unknown price|\bunknown\b/i.test(line)) return "unknown";
  if (/\bestimat(?:e|ed|ion)\b|\bapprox(?:imately|\.)?\b|\babout\s+R/i.test(line)) return "estimate";
  if (urls.some((url) => sources.has(url))) return "sourced";
  return "estimate";
}
function makeBadge(type) {
  const label = type === "sourced" ? "Sourced" : type === "unknown" ? "Price not found" : "Estimate";
  return makeElement("span", `price-badge price-${type}`, label);
}
function itemName(line) {
  return cleanText(line.replace(/^(?:[-*•]|\d+[.)])\s+/, "").split(/\s*(?:\||—|–)\s*/)[0].replace(/:\s*$/, "").trim());
}
function parseBudgetRows(lines, sources) {
  const rows = [];
  for (const line of lines) {
    if (!line || /^\s*\|?\s*:?-{3,}/.test(line) || /\b(item|quantity|qty|unit cost|line total|price type)\b/i.test(line) && /\|/.test(line)) continue;
    const bullet = /^(?:[-*•]|\d+[.)])\s+/.test(line);
    const urls = extractUrls(line);
    const amounts = parseMoney(line);
    const unknown = /price\s+not\s+found|price\s+unavailable|unknown price/i.test(line);
    const tableCells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (!bullet && tableCells.length < 2 && amounts.length === 0 && !unknown) continue;
    if (/^(?:total|estimated total|remaining|shortfall|budget)\b/i.test(line)) continue;
    const type = priceType(line, urls, sources);
    const cells = tableCells.length > 1 ? tableCells : [];
    const name = cells.length ? cleanText(cells[0]) : itemName(line);
    if (!name || /^budget$/i.test(name)) continue;
    const qty = cells[1] || (line.match(/\b(?:qty|quantity)\s*:?\s*([^,;|]+)/i)?.[1]?.trim()) || "—";
    const unitCost = cells[2] || (amounts.length > 1 ? formatRand(amounts[0]) : type === "unknown" ? "—" : "—");
    const lineTotal = cells[3] || (amounts.length ? formatRand(amounts[amounts.length - 1]) : "—");
    rows.push({ name, qty, unitCost, lineTotal, type });
  }
  return rows;
}
function findAmount(lines, patterns) {
  for (const line of lines) {
    if (patterns.some((pattern) => pattern.test(line))) {
      const values = parseMoney(line);
      if (values.length) return values[values.length - 1];
    }
  }
  return null;
}
function renderBudget(lines, budgetAmount, sources) {
  const { section, heading } = makePlanSection("Budget");
  const total = findAmount(lines, [/estimated\s+total/i, /total\s+(?:estimated\s+)?(?:cost|budget|for|:)/i, /^total\b/i]);
  let remaining = findAmount(lines, [/remaining\s+budget/i, /budget\s+remaining/i, /^remaining\b/i]);
  let shortfall = findAmount(lines, [/shortfall/i, /budget\s+deficit/i]);
  if (remaining === null && shortfall === null && total !== null && budgetAmount !== null) {
    const delta = Math.round((budgetAmount - total) * 100) / 100;
    if (delta >= 0) remaining = delta;
    else shortfall = Math.abs(delta);
  }
  const band = makeElement("div", "budget-band");
  const figures = [["Your budget", budgetAmount, ""], ["Estimated total", total, ""], [shortfall !== null ? "Shortfall" : "Remaining", shortfall ?? remaining, shortfall !== null ? "shortfall" : ""]];
  for (const [label, amount, modifier] of figures) {
    const figure = makeElement("div", `budget-figure${modifier ? ` ${modifier}` : ""}`);
    figure.append(makeElement("span", "", label), makeElement("strong", "", amount === null ? "Not stated" : formatRand(amount)));
    band.append(figure);
  }
  section.append(band);
  const rows = parseBudgetRows(lines, sources);
  if (rows.some((row) => row.type !== "sourced")) section.append(makeElement("p", "price-note", "Total includes estimates and excludes items with no price found. Estimates: verify locally."));
  if (rows.length) {
    const wrap = makeElement("div", "budget-table-wrap");
    const table = makeElement("table", "budget-table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const label of ["Item", "Qty", "Unit cost", "Line total", "Price type"]) headerRow.append(makeElement("th", "", label));
    thead.append(headerRow);
    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      const cells = [row.name, row.qty, row.unitCost, row.lineTotal, ""];
      const labels = ["Item", "Qty", "Unit cost", "Line total", "Price type"];
      cells.forEach((value, index) => {
        const td = document.createElement("td");
        td.dataset.label = labels[index];
        if (index === 2 || index === 3) td.classList.add("numeric");
        if (index === 4) td.append(makeBadge(row.type));
        else td.textContent = value;
        tr.append(td);
      });
      tbody.append(tr);
    }
    table.append(thead, tbody);
    wrap.append(table);
    section.append(wrap);
  } else {
    appendTextLines(section, lines);
  }
  return { section, heading };
}
function renderBuyingList(lines, sources) {
  const { section } = makePlanSection("Buying list");
  const list = makeElement("div", "supplier-list");
  let count = 0;
  for (const line of lines) {
    if (!line || count >= 3) continue;
    const urls = extractUrls(line);
    const matchUrl = urls.find((url) => sources.has(url));
    if (!matchUrl) continue;
    const source = sources.get(matchUrl);
    const name = itemName(line).replace(/\s*https?:\/\/\S+/g, "").replace(/\s*\[[^\]]+\]\([^)]*\)/g, "").trim() || source.title || source.domain;
    const amounts = parseMoney(line);
    const type = priceType(line, urls, sources);
    const item = name.replace(/(?:price\s+not\s+found|price\s+unavailable|\bestimat(?:e|ed)\b.*)$/i, "").trim() || "Listed supplier";
    const card = makeElement("article", "supplier-card");
    card.append(makeElement("h4", "supplier-name", item));
    const meta = makeElement("div", "supplier-meta");
    meta.append(document.createTextNode(`${item}${amounts.length ? ` · ${formatRand(amounts[amounts.length - 1])}` : " · —"} `), makeBadge(type));
    if (type === "estimate") meta.append(makeElement("span", "price-verify", "Verify locally"));
    const link = document.createElement("a");
    link.className = "supplier-link";
    link.href = matchUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.append(document.createTextNode(`View listing at ${source.domain} `));
    link.append(makeElement("span", "visually-hidden", "(opens in a new tab)"));
    card.append(meta, link);
    list.append(card);
    count += 1;
  }
  if (count) section.append(list);
  else appendTextLines(section, lines.filter((line) => !extractUrls(line).length));
  return section;
}
function renderSuitability(lines) {
  const { section, heading } = makePlanSection("Suitability", "suitability-section");
  const sourceText = lines.map(cleanText).join(" ");
  let status = "Suitable";
  let statusClass = "status-suitable";
  if (/not\s+recommend|unsuitable|not\s+suitable|should\s+not\s+plant|avoid\s+plant/i.test(sourceText)) {
    status = "Not recommended";
    statusClass = "status-unsuitable";
  } else if (/check\s+timing|uncertain|caution|condition(?:al)?|may\s+not\s+be\s+suitable/i.test(sourceText)) {
    status = "Check timing";
    statusClass = "status-caution";
  }
  heading.classList.add("suitability-heading");
  heading.append(makeElement("span", `status-badge ${statusClass}`, status));
  appendTextLines(section, lines);
  section.append(makeElement("p", "soil-note", "Soil not tested — results depend on a soil test"));
  return section;
}
function renderPlantingWindow(lines) {
  const { section } = makePlanSection("Planting window");
  const combined = lines.map(cleanText).join(" ");
  const caution = /unsuitable|not suitable|outside (?:the )?planting|not recommended|avoid planting|poor time|wrong month/i.test(combined);
  if (caution) {
    const callout = makeElement("div", "timing-callout");
    callout.append(makeElement("strong", "", "Timing"));
    callout.append(document.createTextNode(combined || "The requested month may not be suitable; check local guidance."));
    section.append(callout);
  }
  appendTextLines(section, lines);
  return section;
}
function renderGettingStarted(lines) {
  const { section } = makePlanSection("Getting started");
  const list = document.createElement("ol");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const step = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    list.append(makeElement("li", "", cleanText(step ? step[1] : line)));
  }
  if (list.children.length) section.append(list);
  return section;
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
    link.append(document.createTextNode(source.title || url.hostname));
    link.append(makeElement("span", "visually-hidden", "(opens in a new tab)"));
    li.append(link);
    if (source.snippet) li.append(makeElement("span", "source-snippet", source.snippet));
    list.append(li);
  }
}
function renderPlan(text, sourceList, payload) {
  const content = document.querySelector("#plan-content");
  content.replaceChildren();
  const sections = parseSections(text);
  const sources = sourceIndex(sourceList);
  const suitability = sectionLines(sections, "suitability");
  const windowLines = sectionLines(sections, "planting window");
  const gettingStarted = sectionLines(sections, "getting started");
  const budgetLines = sectionLines(sections, "budget");
  const buyingLines = sectionLines(sections, "buying list");
  content.append(renderSuitability(suitability), renderPlantingWindow(windowLines), renderGettingStarted(gettingStarted), renderBudget(budgetLines, payload.budget, sources), renderBuyingList(buyingLines, sources));
  renderSources(sourceList);
  document.querySelector("#plan-summary").textContent = `${payload.crop[0].toUpperCase()}${payload.crop.slice(1)} · ${payload.town}, ${payload.province} · ${new Intl.NumberFormat("en-ZA", { maximumFractionDigits: 2 }).format(payload.area)} m² · ${payload.month} · ${payload.water}`;
}
function setFormDisabled(disabled) {
  formControls.forEach((control) => { control.disabled = disabled; });
  submitButton.setAttribute("aria-disabled", disabled ? "true" : "false");
  submitButton.textContent = disabled ? "Building your plan…" : "Build my plan";
}
function focusSuccessfulResult() {
  const title = document.querySelector("#plan-title");
  title.focus({ preventScroll: true });
  if (window.matchMedia("(max-width: 599px)").matches) {
    title.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }
}
async function generatePlan(payload) {
  const apiUrl = window.VELDAROQ_CONFIG?.apiUrl;
  setFormDisabled(true);
  showState("loading");
  if (!apiUrl) {
    showState("error");
    document.querySelector("#error-message").textContent = "The plan service isn’t configured yet. Add your deployed Worker URL to config.js and try again.";
    setFormDisabled(false);
    return;
  }
  try {
    const response = await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `The service returned an error (${response.status}).`);
    if (typeof result.text !== "string" || !Array.isArray(result.sources) || result.sources.length === 0) throw new Error("The search-backed response didn’t include usable source references. Please retry.");
    renderPlan(result.text, result.sources, payload);
    showState("plan");
    focusSuccessfulResult();
  } catch (error) {
    showState("error");
    document.querySelector("#error-message").textContent = error instanceof TypeError ? "We couldn’t reach the plan service. Check your connection and try again." : error.message;
  } finally {
    setFormDisabled(false);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!validateForm()) return;
  lastPayload = getFormData();
  generatePlan(lastPayload);
});
for (const name of Object.keys(FIELD_RULES)) {
  const control = document.querySelector(`#${name}`);
  control.addEventListener("input", () => { if (control.getAttribute("aria-invalid") === "true") validateField(name); });
  control.addEventListener("change", () => { if (control.getAttribute("aria-invalid") === "true") validateField(name); });
}
form.querySelectorAll('input[name="water"]').forEach((input) => input.addEventListener("change", () => {
  if (document.querySelector("#water-field").getAttribute("aria-invalid") === "true") validateWater();
}));
document.querySelector("#retry-button").addEventListener("click", () => { if (lastPayload) generatePlan(lastPayload); });
document.querySelector("#edit-button").addEventListener("click", () => document.querySelector("#town").focus());
