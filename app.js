const form = document.querySelector("#farm-form");
const resultArea = document.querySelector("#result-area");
const emptyState = document.querySelector("#empty-state");
const loading = document.querySelector("#loading");
const errorPanel = document.querySelector("#error");
const planCard = document.querySelector("#plan-card");
const submitButton = document.querySelector("#submit-button");
const formControls = [...form.querySelectorAll("input, select, button")];
let lastPayload = null;

if (!window.VELDAROQ_CONFIG && typeof VELDAROQ_CONFIG !== "undefined") {
  window.VELDAROQ_CONFIG = VELDAROQ_CONFIG;
}

const FIELD_RULES = {
  town: (field) => !field.value.trim() ? "Enter your town or city." : field.value.length > 80 ? "Town or city must be 80 characters or fewer." : "",
  province: (field) => !field.value ? "Choose your province." : "",
  crop: (field) => !field.value ? "Choose a crop." : "",
  area: (field) => !field.value || !Number.isFinite(field.valueAsNumber) ? "Enter a plot area greater than 0." : field.valueAsNumber < 1 ? "Plot area must be at least 1 m²." : field.valueAsNumber > 100000 ? "Plot area must be 100,000 m² or less." : "",
  budget: (field) => !field.value || !Number.isFinite(field.valueAsNumber) ? "Enter a budget greater than 0." : field.valueAsNumber < 1 ? "Budget must be at least R 1." : field.valueAsNumber > 100000000 ? "Budget must be R 100,000,000 or less." : "",
  month: (field) => !field.value ? "Choose your intended planting month." : ""
};

function normalizeLine(line) {
  return cleanText(line).replace(/^[-*•]\s*/, "").replace(/^\d+[.)]\s*/, "").trim();
}

function showState(state) {
  resultArea.setAttribute("aria-busy", state === "loading" ? "true" : "false");
  emptyState.hidden = state !== "empty";
  loading.hidden = state !== "loading";
  errorPanel.hidden = state !== "error";
  planCard.hidden = state !== "plan";
  if (state === "error") {
    errorPanel.removeAttribute("role");
    requestAnimationFrame(() => {
      const heading = errorPanel.querySelector("h2");
      heading?.focus();
    });
  }
}

function setFieldError(name, message) {
  const field = name === "water" ? document.querySelector("#water-field") : document.querySelector(`#${name}`);
  const error = document.querySelector(`#${name}-error`);
  if (!error) return;
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
  if (!field) return true;
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
  return String(text || "").replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1").replace(/\*\*/g, "").trim();
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
      if (current.startsWith("budget")) current = "budget";
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
    const line = normalizeLine(raw);
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
  for (const match of String(line || "").matchAll(/(?:https?:\/\/[^\s)\]>]+|www\.[^\s)\]>]+)/gi)) {
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    try {
      const url = new URL(raw.startsWith("www.") ? `https://${raw}` : raw);
      if (url.protocol === "https:") found.push(url.href);
    } catch { /* Ignore malformed links. */ }
  }
  return [...new Set(found)];
}

function parseMoney(line) {
  const normalized = cleanText(line);
  const matches = [...normalized.matchAll(/(?:^|[^A-Za-z])((?:R|ZAR)\s*(?:\d{1,3}(?:[\s,]\d{3})+|\d+)(?:\.\d{1,2})?)/gi)];
  return matches
    .map((match) => Number(match[1].replace(/^(?:R|ZAR)/i, "").replace(/[\s,]/g, "")))
    .filter(Number.isFinite);
}

function formatRand(amount) {
  const safe = Number.isFinite(amount) ? amount : 0;
  return `R ${new Intl.NumberFormat("en-ZA", { maximumFractionDigits: 2 }).format(safe)}`;
}

function priceType(line, urls, sources) {
  const normalized = normalizeLine(line);
  if (!normalized) return "unknown";
  if (/price\s+not\s+found|price\s+unavailable|unknown price|no price found/i.test(normalized)) return "unknown";
  if (urls.length && parseMoney(normalized).length) return "sourced";
  if (/\bestimat(?:e|ed|ion)\b|\bapprox(?:imately|\.)?\b|\babout\s+R|\baround\s+R\b/i.test(normalized)) return "estimate";
  return "estimate";
}

function makeBadge(type) {
  const label = type === "sourced" ? "Sourced" : type === "unknown" ? "Price not found" : "Estimate";
  return makeElement("span", `price-badge price-${type}`, label);
}

function itemName(line) {
  const cleaned = cleanText(line).replace(/^[-*•]\s*/, "").replace(/^\d+[.)]\s*/, "").replace(/\s*:\s*$/, "");
  return cleaned.split(/\s*(?:\||—|–)\s*/)[0].trim();
}

function isSummaryLine(line) {
  const normalized = normalizeLine(line);
  if (!normalized) return true;
  return /^(?:budget|total|estimated total|remaining budget|remaining|shortfall|budget remaining|total cost|total budget)/i.test(normalized)
    || /^[-*•]\s*(?:budget|total|estimated total|remaining budget|remaining|shortfall)/i.test(normalized)
    || /^\*\*(?:budget|total|estimated total|remaining budget|remaining|shortfall)/i.test(normalized);
}

function parseBudgetRows(lines, sources) {
  const rows = [];
  for (const line of lines) {
    const normalized = normalizeLine(line);
    if (!normalized || /^\s*\|?\s*:?-{3,}/.test(normalized) || /\b(item|quantity|qty|unit cost|line total|price type)\b/i.test(normalized) && /\|/.test(normalized)) continue;
    if (isSummaryLine(line)) continue;
    const urls = extractUrls(normalized);
    const amounts = parseMoney(normalized);
    const unknown = /price\s+not\s+found|price\s+unavailable|unknown price|no price found/i.test(normalized);
    const tableCells = normalized.split("|").map((cell) => cell.trim()).filter(Boolean);
    const hasStructuredRow = tableCells.length > 1 || /\bqty\b|\bquantity\b|\bunit\s+cost\b|\bline\s+total\b/i.test(normalized);
    if (!urls.length && !amounts.length && !unknown && !hasStructuredRow) continue;
    const type = priceType(normalized, urls, sources);
    const cells = tableCells.length > 1 ? tableCells : [];
    const name = cells.length ? cleanText(cells[0]) : itemName(normalized);
    if (!name || /^budget$/i.test(name)) continue;
    const qty = cells[1] || (normalized.match(/\b(?:qty|quantity)\s*:?\s*([^,;|]+)/i)?.[1]?.trim()) || "—";
    const unitCost = cells[2] || (amounts.length > 1 ? formatRand(amounts[0]) : type === "unknown" ? "—" : "—");
    const lineTotal = cells[3] || (amounts.length ? formatRand(amounts[amounts.length - 1]) : "—");
    rows.push({ name, qty, unitCost, lineTotal, type });
  }
  return rows;
}

function findAmount(lines, patterns) {
  for (const raw of lines) {
    const normalized = normalizeLine(raw);
    if (!normalized) continue;
    if (patterns.some((pattern) => pattern.test(normalized))) {
      const values = parseMoney(normalized);
      if (values.length) return values[values.length - 1];
    }
  }
  return null;
}

function deriveBudgetSummary(lines, budgetAmount) {
  let total = findAmount(lines, [/^estimated\s+total\b/i, /^total\b/i, /(?:^|\s)total\s*:/i, /total\s+cost\b/i, /estimated\s+total\s*:/i]);
  let explicitRemaining = null;
  let explicitShortfall = null;
  let directTotalSet = false;

  for (const raw of lines) {
    const normalized = normalizeLine(raw);
    if (!normalized) continue;
    const amounts = parseMoney(normalized);
    if (!amounts.length) continue;
    const hasRemaining = /remaining\b/i.test(normalized);
    const hasShortfall = /shortfall\b/i.test(normalized);
    const hasTotal = /(?:^|\s)total\b/i.test(normalized) || /(?:^|\s)estimated\s+total\b/i.test(normalized);
    if (hasTotal) {
      total = amounts[amounts.length - 1];
      directTotalSet = true;
    }
    if (hasShortfall && !hasRemaining) {
      explicitShortfall = amounts[amounts.length - 1];
    }
    if (hasRemaining && !hasShortfall) {
      explicitRemaining = amounts[amounts.length - 1];
    }
    if (/remaining\s+budget\s*\/\s*shortfall|budget\s*\/\s*shortfall/i.test(normalized)) {
      if (total !== null && Number.isFinite(budgetAmount) && total > budgetAmount) explicitShortfall = amounts[amounts.length - 1];
      else if (total === null || !Number.isFinite(budgetAmount) || total <= budgetAmount) explicitRemaining = amounts[amounts.length - 1];
    }
  }

  let remaining = null;
  let shortfall = null;

  if (total !== null && Number.isFinite(budgetAmount)) {
    const delta = budgetAmount - total;
    if (delta >= 0) remaining = delta;
    else shortfall = Math.abs(delta);
  }

  if (explicitShortfall !== null) {
    shortfall = explicitShortfall;
    remaining = null;
  }
  if (explicitRemaining !== null && shortfall === null) {
    remaining = explicitRemaining;
  }

  if (total !== null && Number.isFinite(budgetAmount) && total <= budgetAmount && remaining === null) {
    remaining = budgetAmount - total;
  }
  if (total !== null && Number.isFinite(budgetAmount) && total > budgetAmount && shortfall === null) {
    shortfall = total - budgetAmount;
  }

  return { total, remaining, shortfall };
}

function renderBudget(lines, budgetAmount, sources) {
  const { section } = makePlanSection("Budget");
  const summary = deriveBudgetSummary(lines, budgetAmount);
  const total = summary.total;
  const remaining = summary.remaining;
  const shortfall = summary.shortfall;

  const band = makeElement("div", "budget-band");
  const budgetFigure = [
    ["Your budget", Number.isFinite(budgetAmount) ? budgetAmount : null],
    ["Estimated total", total],
    [shortfall !== null ? "Shortfall" : "Remaining", shortfall !== null ? shortfall : remaining]
  ];
  for (const [label, amount] of budgetFigure) {
    const figure = makeElement("div", `budget-figure${label === "Shortfall" ? " shortfall" : ""}`);
    figure.append(makeElement("span", "", label), makeElement("strong", "", amount === null ? "Not stated" : formatRand(amount)));
    band.append(figure);
  }
  section.append(band);

  const rows = parseBudgetRows(lines, sources);
  if (rows.some((row) => row.type !== "sourced")) {
    section.append(makeElement("p", "price-note", "Total includes estimates and excludes items with no price found. Estimates: verify locally."));
  }
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
  return section;
}

function renderBuyingList(lines, sources) {
  const { section } = makePlanSection("Buying list");
  const list = makeElement("div", "supplier-list");
  const seen = new Set();

  for (const raw of lines) {
    const line = normalizeLine(raw);
    if (!line) continue;
    const urls = extractUrls(line);
    const sourceUrl = urls.find((url) => !!url) || null;
    if (!sourceUrl) continue;
    const url = new URL(sourceUrl);
    const source = sources.get(sourceUrl) || { title: "", domain: url.hostname.replace(/^www\./, "") };
    const supplierName = cleanText(source.title || source.domain || url.hostname.replace(/^www\./, ""));
    if (!supplierName || seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
    const amounts = parseMoney(line);
    const type = /price\s+not\s+found|price\s+unavailable|unknown price|no price found/i.test(line) ? "unknown" : (urls.length && amounts.length ? "sourced" : "estimate");
    const itemText = itemName(line) || "Supplier item";
    const priceText = amounts.length ? formatRand(amounts[amounts.length - 1]) : "—";

    const card = makeElement("article", "supplier-card");
    card.append(makeElement("h4", "supplier-name", supplierName));
    const meta = makeElement("div", "supplier-meta");
    meta.append(document.createTextNode(`${itemText} · ${priceText} `));
    meta.append(makeBadge(type));
    if (type === "estimate") meta.append(makeElement("span", "price-verify", "Verify locally"));
    const link = document.createElement("a");
    link.className = "supplier-link";
    link.href = sourceUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.append(document.createTextNode(`View listing at ${source.domain || url.hostname.replace(/^www\./, "")}`));
    link.append(makeElement("span", "visually-hidden", "(opens in a new tab)"));
    card.append(meta, link);
    list.append(card);
    if (list.children.length >= 3) break;
  }

  if (list.children.length) section.append(list);
  return section;
}

function renderSuitability(lines) {
  const { section, heading } = makePlanSection("Suitability", "suitability-section");
  const sourceText = lines.map(cleanText).join(" ");
  const normalizedText = sourceText.replace(/\s+/g, " ").trim();
  let status = "Check timing";
  let statusClass = "status-caution";

  if (/\bnot\s+recommended\b|\bnot\s+suitable\b|\bunsuitable\b|\bshould\s+not\s+plant\b|\bavoid\s+planting\b/i.test(normalizedText)) {
    status = "Not recommended";
    statusClass = "status-unsuitable";
  } else if (/\b(?:suitable|good fit)\b.*\b(?:for|with)\b.*\b(?:this|the)\b.*\b(?:month|planting\s+window)\b|\b(?:month|planting\s+window)\b.*\b(?:suitable|good fit)\b/i.test(normalizedText)) {
    status = "Suitable";
    statusClass = "status-suitable";
  }

  heading.classList.add("suitability-heading");
  heading.append(makeElement("span", `status-badge ${statusClass}`, status));
  appendTextLines(section, lines);
  section.append(makeElement("p", "soil-note", "Soil not tested — results depend on a soil test"));
  return section;
}

function renderPlantingWindow(lines) {
  const { section } = makePlanSection("Planting window");
  const combined = cleanText(lines.join(" "));
  const caution = /unsuitable|not suitable|outside (?:the )?planting|not recommended|avoid planting|poor time|wrong month/i.test(combined);
  if (caution) {
    const firstSentence = combined.split(/[.!?](?:\s+|$)/)[0].trim();
    const callout = makeElement("div", "timing-callout");
    callout.append(makeElement("strong", "", "Timing"));
    callout.append(document.createTextNode(firstSentence || "The requested month may not be suitable; check local guidance."));
    section.append(callout);
    return section;
  }
  appendTextLines(section, lines);
  return section;
}

function renderGettingStarted(lines) {
  const { section } = makePlanSection("Getting started");
  const list = document.createElement("ol");
  for (const raw of lines) {
    const line = normalizeLine(raw);
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

  content.append(
    renderSuitability(suitability),
    renderPlantingWindow(windowLines),
    renderGettingStarted(gettingStarted),
    renderBudget(budgetLines, payload.budget, sources),
    renderBuyingList(buyingLines, sources)
  );

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
  if (!title) return;
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
  if (!control) continue;
  control.addEventListener("input", () => { if (control.getAttribute("aria-invalid") === "true") validateField(name); });
  control.addEventListener("change", () => { if (control.getAttribute("aria-invalid") === "true") validateField(name); });
}
form.querySelectorAll('input[name="water"]').forEach((input) => input.addEventListener("change", () => {
  if (document.querySelector("#water-field").getAttribute("aria-invalid") === "true") validateWater();
}));
document.querySelector("#retry-button").addEventListener("click", () => { if (lastPayload) generatePlan(lastPayload); });
document.querySelector("#edit-button").addEventListener("click", () => document.querySelector("#town").focus());
