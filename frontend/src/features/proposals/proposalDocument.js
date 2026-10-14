import { Table } from "docx";
import { authTokenStore } from "@/api/axios";
import { parseGeneratedSections } from "@/utils/proposalSections";
import { PROPOSAL_COPY, PROPOSAL_VALIDITY_DAYS, formatProposalDate } from "@/features/proposals/proposalCopy";
import { cleanProposalHtml, decodeHtmlEntities, stripHtml } from "@/utils/htmlText";

const LEGACY_PLACEHOLDER_TOTAL = 5_000;

export function normalizeMoney(value) {
  if (value === null || value === undefined || value === "") return null;
  let text = String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[^\d.,-]/g, "")
    .trim();
  if (!text) return null;

  const hasComma = text.includes(",");
  const hasDot = text.includes(".");
  if (hasComma && hasDot) {
    const lastComma = text.lastIndexOf(",");
    const lastDot = text.lastIndexOf(".");
    text = lastComma > lastDot
      ? text.replace(/\./g, "").replace(",", ".")
      : text.replace(/,/g, "");
  } else if (hasComma) {
    const parts = text.split(",");
    text = parts[parts.length - 1]?.length === 2 ? text.replace(",", ".") : text.replace(/,/g, "");
  } else if (hasDot) {
    const parts = text.split(".");
    text = parts[parts.length - 1]?.length === 3 ? text.replace(/\./g, "") : text;
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function isValidProposalTotal(value) {
  const amount = normalizeMoney(value);
  return amount !== null && amount > 100 ? amount : null;
}

export const formatUsd = (value) => {
  const amount = normalizeMoney(value);
  if (amount === null) return "Not calculated";
  return `${new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount)} USD`;
};

function extractExplicitProposalTotal(text = "") {
  const cleanText = String(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");
  const labels = [
    "total amount",
    "grand total",
    "monto total",
    "inversi[oó]n total",
    "investment",
    "implementation cost",
    "costos de implementaci[oó]n",
    "precio total",
    "total",
  ];
  const amountPattern = "(?:\\$\\s*)?([0-9]{1,3}(?:[.,][0-9]{3})+|[0-9]{4,})(?:\\s*(?:USD|US\\$|dollars?))?";
  const labelPattern = labels.join("|");
  const labelFirst = new RegExp(`(?:${labelPattern})\\s*(?:amount|cost|price)?\\s*[:\\-–—]?\\s*(?:[^\\d$]{0,20})${amountPattern}`, "i");
  const amountFirst = new RegExp(`${amountPattern}\\s*(?:USD|US\\$|dollars?)?\\s*(?:[^a-zA-Z]{0,12})(?:${labelPattern})`, "i");
  const labelMatch = cleanText.match(labelFirst);
  const amount = labelMatch ? isValidProposalTotal(labelMatch[1]) : null;
  if (amount !== null) return amount;
  const amountMatch = cleanText.match(amountFirst);
  return amountMatch ? isValidProposalTotal(amountMatch[1]) : null;
}

export function calculateProposalTotal(proposal = {}) {
  const lineItems = proposal.lineItems || proposal.pricingRows || proposal.pricing_rows || proposal.pricingItems || proposal.pricing_items || [];
  const subtotal = Array.isArray(lineItems)
    ? lineItems.reduce((sum, item) => {
        const quantity = normalizeMoney(item.quantity ?? item.qty) ?? 0;
        const unitPrice = normalizeMoney(item.unitPrice ?? item.unit_price ?? item.price ?? item.amount) ?? 0;
        const lineTotal = normalizeMoney(item.total ?? item.subtotal);
        return sum + (lineTotal ?? quantity * unitPrice);
      }, 0)
    : 0;
  const rawDiscount = normalizeMoney(proposal.discount ?? proposal.discountAmount ?? proposal.discount_amount) ?? 0;
  const discountRate = normalizeMoney(proposal.discountRate ?? proposal.discount_rate);
  const discountAmount = discountRate !== null && discountRate > 0 && discountRate <= 1 ? subtotal * discountRate : rawDiscount;
  const rawTax = normalizeMoney(proposal.tax ?? proposal.taxAmount ?? proposal.tax_amount) ?? 0;
  const taxRate = normalizeMoney(proposal.taxRate ?? proposal.tax_rate);
  const taxAmount = taxRate !== null && taxRate > 0 && taxRate <= 1 ? subtotal * taxRate : rawTax;
  const calculatedTotal = Array.isArray(lineItems) && lineItems.length > 0
    ? Math.max(0, subtotal + taxAmount - discountAmount)
    : null;
  const content = String(proposal.content || proposal.description || proposal.industry || "");
  const contentTotal = extractExplicitProposalTotal(content);
  const storedTotal = isValidProposalTotal(proposal.totalAmount ?? proposal.total_amount ?? proposal.amount);
  const safeCalculatedTotal = calculatedTotal !== null && calculatedTotal > 100 ? calculatedTotal : null;
  const isLegacyPlaceholder = storedTotal === LEGACY_PLACEHOLDER_TOTAL && (safeCalculatedTotal !== null || contentTotal !== null || !lineItems.length);
  const totalAmount = safeCalculatedTotal ?? (!isLegacyPlaceholder ? storedTotal : null) ?? contentTotal;

  return {
    subtotal,
    taxAmount,
    discountAmount,
    totalAmount,
    formattedTotal: formatUsd(totalAmount),
  };
}

function unwrapEmbeddedProposalHtml(html = "") {
  const source = cleanProposalHtml(html);
  const embeddedIndex = source.search(/<article[^>]*class=["'][^"']*proposal-document/i);
  if (embeddedIndex >= 0) {
    const embeddedEnd = source.indexOf("</article>", embeddedIndex);
    if (embeddedEnd > embeddedIndex) return source.slice(embeddedIndex, embeddedEnd + "</article>".length);
  }
  return source;
}

function looksLikeHtmlDump(value = "") {
  const text = decodeHtmlEntities(value).trim();
  return /<\/?[a-z][\s\S]*>/i.test(text) || /class=["'][^"']*proposal-/i.test(text);
}

export function cleanStructuredText(value = "") {
  if (!value || looksLikeHtmlDump(value)) return "";
  return String(value).trim();
}

function stringifyProposalListItem(item) {
  if (item === null || item === undefined) return "";
  if (typeof item === "string" || typeof item === "number") return String(item).trim();
  if (typeof item === "object") {
    const title = item.title || item.name || item.problem || item.technology || item.metric || item.step || "";
    const body = item.description || item.body || item.explanation || item.impact || item.detail || item.details || "";
    return [title, body].filter(Boolean).join(title && body ? ": " : "").trim();
  }
  return String(item).trim();
}

function cleanStructuredList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(stringifyProposalListItem).filter((item) => item && !looksLikeHtmlDump(item));
}

function extractHtmlSection(html = "", headings = []) {
  const source = cleanProposalHtml(html);
  for (const heading of headings) {
    const re = new RegExp(`<h[1-3][^>]*>\\s*${heading}\\s*<\\/h[1-3]>([\\s\\S]*?)(?=<h[1-3][^>]*>|<\\/article>|$)`, "i");
    const match = source.match(re);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function extractListItems(html = "") {
  const matches = [...cleanProposalHtml(html).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)];
  if (matches.length) return matches.map((match) => stripHtml(match[1])).filter(Boolean);
  return stripHtml(html)
    .split(/\n+/)
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((line) => line.length > 2);
}

function splitTextSection(text = "", headings = []) {
  const lines = String(text || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const start = lines.findIndex((line) => headings.some((heading) => line.toLowerCase() === heading.toLowerCase()));
  if (start < 0) return "";
  const known = [
    "executive summary",
    "problems identified",
    "client problem",
    "proposed ai solution",
    "technologies used",
    "implementation costs",
    "pricing table",
    "expected roi",
    "roi / expected impact",
    "next steps",
  ];
  const end = lines.findIndex((line, index) => index > start && known.includes(line.toLowerCase()));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

// ── DOM-based reading of the proposal HTML ───────────────────────────────────
// The regex helpers above only find English headings and drop anything that is
// not a <p>. These keep every block (lists, tables, subheadings) and let the
// exporter recognise translated/edited headings or keep unknown sections.

const PROPOSAL_SECTION_KEYS = [
  "executiveSummary",
  "problemsIdentified",
  "proposedSolution",
  "technologiesUsed",
  "implementationCosts",
  "expectedROI",
  "nextSteps",
  "acceptance",
];

const PROPOSAL_SECTION_ALIASES = {
  problemsIdentified: ["Client Problem"],
  implementationCosts: ["Pricing Table"],
  expectedROI: ["ROI / Expected Impact"],
};

const BLOCK_CONTAINER_TAGS = new Set(["BODY", "DIV", "SECTION", "ARTICLE", "HEADER", "MAIN", "FOOTER", "ASIDE", "NAV"]);

const BLOCK_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "P", "UL", "OL", "TABLE", "BLOCKQUOTE", "PRE", "HR", "DL", "FIGURE"]);

// Pieces of our own rendered preview (when a saved proposal embeds it) that
// the exporter re-creates itself and must not be read back as content.
const GENERATED_PREVIEW_SELECTORS = [
  "style",
  "script",
  ".proposal-cover",
  ".proposal-total-card",
  ".proposal-validity-note",
  ".proposal-adjustments",
  ".proposal-acceptance",
].join(", ");

const normalizeHeadingText = (value = "") => String(value || "")
  .normalize("NFD")
  .replace(/[̀-ͯ]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

function headingsForSection(key) {
  return [...new Set([
    ...Object.values(PROPOSAL_COPY).map((copy) => copy[key]).filter(Boolean),
    ...(PROPOSAL_SECTION_ALIASES[key] || []),
  ])];
}

function sectionKeyForHeading(heading = "") {
  const normalized = normalizeHeadingText(heading);
  if (!normalized) return null;
  return PROPOSAL_SECTION_KEYS.find((key) => headingsForSection(key)
    .some((candidate) => normalizeHeadingText(candidate) === normalized)) || null;
}

function nodeText(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll?.("br").forEach((br) => br.replaceWith("\n"));
  return clone.textContent.replace(/[ \t\r\f\v]+/g, " ").replace(/ *\n */g, "\n").trim();
}

const hasHtmlTags = (value = "") => /<[a-z][\s\S]*>/i.test(String(value || ""));

function collectProposalBlocks(html = "") {
  if (typeof DOMParser === "undefined" || !hasHtmlTags(html)) return [];
  const parsed = new DOMParser().parseFromString(`<body>${cleanProposalHtml(html)}</body>`, "text/html");
  parsed.body.querySelectorAll(GENERATED_PREVIEW_SELECTORS).forEach((node) => node.remove());
  // Our preview renders list items as cards (<strong>title</strong><p>body</p>);
  // turn them back into one <li> per card so they aren't split in two.
  parsed.body.querySelectorAll(".proposal-card-list").forEach((list) => {
    const ul = parsed.createElement("ul");
    list.querySelectorAll(".proposal-detail-card").forEach((card) => {
      const title = card.querySelector("strong") ? nodeText(card.querySelector("strong")) : "";
      const body = [...card.querySelectorAll("p")].map(nodeText).filter(Boolean).join(" ");
      const li = parsed.createElement("li");
      li.textContent = [title, body].filter(Boolean).join(": ");
      ul.appendChild(li);
    });
    list.replaceWith(ul);
  });
  const blocks = [];
  let inline = parsed.createElement("p");
  const flushInline = () => {
    if (nodeText(inline)) blocks.push(inline);
    inline = parsed.createElement("p");
  };
  const walk = (parent) => {
    [...parent.childNodes].forEach((child) => {
      if (child.nodeType === 3) {
        inline.appendChild(child.cloneNode());
        return;
      }
      if (child.nodeType !== 1) return;
      if (BLOCK_CONTAINER_TAGS.has(child.tagName)) {
        flushInline();
        walk(child);
        flushInline();
      } else if (BLOCK_TAGS.has(child.tagName)) {
        flushInline();
        blocks.push(child);
      } else {
        inline.appendChild(child.cloneNode(true));
      }
    });
  };
  walk(parsed.body);
  flushInline();
  return blocks;
}

function blockToText(block) {
  const tag = block.tagName;
  if (tag === "UL" || tag === "OL") {
    return [...block.children]
      .filter((child) => child.tagName === "LI")
      .map((li, index) => {
        const text = nodeText(li);
        return text ? `${tag === "OL" ? `${index + 1}.` : "•"} ${text}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  if (tag === "TABLE") {
    return [...block.querySelectorAll("tr")]
      .map((row) => [...row.children].map((cell) => nodeText(cell)).filter(Boolean).join(" | "))
      .filter(Boolean)
      .join("\n\n");
  }
  if (tag === "HR") return "";
  return nodeText(block);
}

/** Section text with paragraphs AND lists/subheadings, as blocks separated by blank lines. */
function extractTextBlocks(html = "", { exclude = [] } = {}) {
  if (!hasHtmlTags(html)) return exclude.length ? "" : stripHtml(html);
  return collectProposalBlocks(html)
    .filter((block) => !exclude.includes(block.tagName))
    .map(blockToText)
    .filter(Boolean)
    .join("\n\n");
}

// A re-exported proposal already carries "Additional section: X" headings.
function stripAdditionalSectionPrefix(heading = "") {
  const label = Object.values(PROPOSAL_COPY)
    .map((copy) => copy.additionalSection)
    .find((candidate) => heading.toLowerCase().startsWith(`${candidate.toLowerCase()}:`));
  return label ? heading.slice(label.length + 1).trim() : heading;
}

/** Splits the proposal HTML into the leading intro and its <h2> (or <h3>) sections. */
function splitProposalSections(html = "") {
  const blocks = collectProposalBlocks(html);
  const boundaryTags = blocks.some((block) => block.tagName === "H2") ? ["H1", "H2"] : ["H1", "H2", "H3"];
  const intro = [];
  const sections = [];
  let current = null;
  let seenTitle = false;
  blocks.forEach((block) => {
    if (boundaryTags.includes(block.tagName)) {
      if (block.tagName === "H1" && !seenTitle && !current) {
        seenTitle = true;
        return;
      }
      current = { heading: nodeText(block), nodes: [] };
      sections.push(current);
      return;
    }
    (current ? current.nodes : intro).push(block);
  });
  const toHtml = (nodes) => nodes.map((node) => node.outerHTML).join("");
  return {
    introHtml: toHtml(intro),
    sections: sections.map((section) => ({
      heading: section.heading,
      key: sectionKeyForHeading(section.heading),
      html: toHtml(section.nodes),
    })),
  };
}

export function normalizeLineItem(row = {}) {
  const quantity = normalizeMoney(row.quantity ?? row.qty) ?? 0;
  const unitPrice = normalizeMoney(row.unitPrice ?? row.unit_price ?? row.price ?? row.amount) ?? 0;
  const subtotal = normalizeMoney(row.subtotal ?? row.total) ?? quantity * unitPrice;
  return {
    service: row.service || row.name || row.title || row.unit || "Service Unit",
    description: row.description || row.details || row.scope || "",
    quantity,
    unitPrice,
    subtotal,
  };
}

function parseLineItemsFromHtml(html = "") {
  const rows = [...cleanProposalHtml(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  return rows
    .map((row) => [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => stripHtml(cell[1])))
    .filter((cells) => cells.length >= 5 && !/^service/i.test(cells[0]))
    .map((cells) => normalizeLineItem({
      service: cells[0],
      description: cells[1],
      quantity: cells[2],
      unitPrice: cells[3],
      subtotal: cells[4],
    }));
}

export function detectProposalLanguage(text = "") {
  const value = String(text || "").toLowerCase();
  const countMatches = (pattern) => (value.match(pattern) || []).length;
  const spanishDistinctiveChars = countMatches(/[ñ¿¡]/g);
  const portugueseDistinctiveChars = countMatches(/[ãõç]/g);
  const spanishDistinctiveWords = countMatches(/\b(automatización|gestión|desafío|solución|cotización|equipo|servicios|precios|necesita|propuesta|resumen|próximos)\b/g);
  const portugueseDistinctiveWords = countMatches(/\b(automação|gestão|solução|cotação|equipe|serviços|preços|precisa|proposta|relatórios|próximos)\b/g);
  const spanishScore = spanishDistinctiveChars * 3 + spanishDistinctiveWords;
  const portugueseScore = portugueseDistinctiveChars * 3 + portugueseDistinctiveWords;
  if (spanishDistinctiveChars > 0 && spanishScore > portugueseScore) return "es";
  if (portugueseDistinctiveChars > 0 && portugueseScore > spanishScore) return "pt";
  if (spanishDistinctiveWords >= 2 && spanishScore > portugueseScore) return "es";
  if (portugueseDistinctiveWords >= 2 && portugueseScore > spanishScore) return "pt";
  return "en";
}

function detectProposalLanguageWithConfidence(text = "") {
  const value = String(text || "").toLowerCase().trim();
  if (value.length < 20) return null;
  const detected = detectProposalLanguage(value);
  if (detected !== "en") return detected;
  const englishSignals = (value.match(/\b(the|and|with|for|client|proposal|services|team|process|solution|pricing|automation|workflow|business)\b/g) || []).length;
  return englishSignals >= 2 ? "en" : null;
}

function getProposalIssuer() {
  const user = authTokenStore.getUser() || {};
  if (user.name) return user.name;
  return String(user.email || "").split("@")[0];
}

export function normalizeProposalDocument(proposal = {}) {
  const structured = proposal.structuredContent || proposal.document || proposal.proposalDocument || proposal.proposal_document || {};
  const content = unwrapEmbeddedProposalHtml(proposal.content || structured.content || proposal.industry || proposal.description || "");
  const text = stripHtml(content);
  const language = structured.language || proposal.language || detectProposalLanguage(proposal.proposalDescription || proposal.proposal_description || proposal.description || content);
  const parsedSections = splitProposalSections(content);
  // Translated or reworded headings are matched by key; the English regex and
  // plain-text splitters stay as fallbacks for older/plain-text content.
  const section = (key, names) => parsedSections.sections
    .filter((item) => item.key === key)
    .map((item) => item.html)
    .join("")
    || extractHtmlSection(content, names)
    || splitTextSection(text, names);
  // Non-list text inside a list section (intro or closing paragraphs).
  const listSectionNotes = (html) => (/<li[\s>]/i.test(html) ? extractTextBlocks(html, { exclude: ["UL", "OL"] }) : "");
  const total = calculateProposalTotal(proposal);
  const lineItems = [
    ...(structured.lineItems || structured.line_items || proposal.lineItems || proposal.pricingRows || proposal.pricing_rows || []),
  ].map(normalizeLineItem);
  const parsedLineItems = lineItems.length ? lineItems : parseLineItemsFromHtml(content);
  const technologiesSection = section("technologiesUsed", ["Technologies Used"]);
  const problemsSection = section("problemsIdentified", ["Problems Identified", "Client Problem"]);
  const nextStepsSection = section("nextSteps", ["Next Steps"]);
  const costsSection = section("implementationCosts", ["Implementation Costs", "Pricing Table"]);
  // Discount/tax breakdown over the rows actually shown in the pricing table.
  const pricing = calculateProposalTotal({ ...proposal, lineItems: parsedLineItems });
  const structuredProblems = cleanStructuredList(structured.problemsIdentified || structured.problems_identified || proposal.problemsIdentified);
  const structuredTechnologies = cleanStructuredList(structured.technologiesUsed || structured.technologies_used || proposal.technologiesUsed);
  const structuredNextSteps = cleanStructuredList(structured.nextSteps || structured.next_steps || proposal.nextSteps);
  const executiveSummary = cleanStructuredText(structured.executiveSummary || structured.executive_summary || proposal.executiveSummary)
    || extractTextBlocks(section("executiveSummary", ["Executive Summary"]))
    || cleanStructuredText(proposal.description)
    || text.split(/\n{2,}/)[0]
    || "";
  const proposedSolution = cleanStructuredText(structured.proposedSolution || structured.proposed_solution || proposal.proposedSolution)
    || extractTextBlocks(section("proposedSolution", ["Proposed AI Solution"]))
    || "";
  const generated = parseGeneratedSections(content);
  const parsedCreatedAt = proposal.createdAt ? new Date(proposal.createdAt) : null;
  const issuedOnDate = parsedCreatedAt && !Number.isNaN(parsedCreatedAt.getTime()) ? parsedCreatedAt : new Date();
  const validUntilDate = new Date(issuedOnDate);
  validUntilDate.setDate(validUntilDate.getDate() + PROPOSAL_VALIDITY_DAYS);

  const localizedTotal = (language === "es" || language === "pt") && total.totalAmount !== null && total.totalAmount !== undefined
    ? `$${new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 }).format(total.totalAmount)} USD`
    : total.formattedTotal;
  const generatedMode = generated
    ? {
      sections: generated.sections,
      formattedTotal: localizedTotal,
      // La plantilla fija ("B2B Operations", "NoonDalton Standard Proposal") no es dato del cliente.
      industry: "",
      serviceLine: "",
      executiveSummary: "",
      problemsIdentified: [],
      proposedSolution: "",
      technologiesUsed: [],
      expectedROI: "",
      nextSteps: [],
    }
    : { sections: null };

  return {
    title: structured.title || proposal.title || proposal.name || generated?.title || "AI Generated Proposal",
    client: structured.client || proposal.client || proposal.customerName || proposal.customer_name || proposal.clientName || "",
    // The saved proposal field wins over the structuredContent snapshot, so an
    // email/company edited after loading isn't replaced by the stale copy.
    clientEmail: proposal.clientEmail || proposal.client_email || structured.clientEmail || "",
    clientCompany: proposal.clientCompany || proposal.client_company || structured.clientCompany || "",
    contact: structured.contact || proposal.contact || proposal.opportunity?.contact || "",
    totalAmount: total.totalAmount,
    industry: structured.industry || proposal.industryName || proposal.opportunity?.industry || proposal.industry || "",
    serviceLine: structured.serviceLine || structured.service_line || proposal.serviceLine || proposal.template || "",
    length: structured.length || proposal.length || "standard",
    executiveSummary,
    problemsIdentified: structuredProblems.length ? structuredProblems : extractListItems(problemsSection),
    proposedSolution,
    technologiesUsed: structuredTechnologies.length ? structuredTechnologies : extractListItems(technologiesSection),
    lineItems: parsedLineItems,
    expectedROI: cleanStructuredText(structured.expectedROI || structured.expected_roi || proposal.expectedROI) || extractTextBlocks(section("expectedROI", ["Expected ROI", "ROI / Expected Impact"])) || "",
    nextSteps: structuredNextSteps.length ? structuredNextSteps : extractListItems(nextStepsSection),
    introduction: extractTextBlocks(parsedSections.introHtml),
    sectionNotes: {
      problemsIdentified: listSectionNotes(problemsSection),
      technologiesUsed: listSectionNotes(technologiesSection),
      implementationCosts: extractTextBlocks(costsSection, { exclude: ["TABLE"] }),
      nextSteps: listSectionNotes(nextStepsSection),
    },
    additionalSections: parsedSections.sections
      .filter((item) => !item.key)
      .map((item) => ({ heading: stripAdditionalSectionPrefix(item.heading), body: extractTextBlocks(item.html) }))
      .filter((item) => item.heading || item.body),
    pricingAdjustments: {
      subtotal: pricing.subtotal,
      discountAmount: pricing.discountAmount,
      taxAmount: pricing.taxAmount,
      show: pricing.discountAmount > 0 || pricing.taxAmount > 0,
    },
    formattedTotal: total.formattedTotal,
    language,
    issuedOn: formatProposalDate(issuedOnDate, language),
    validUntil: formatProposalDate(validUntilDate, language),
    issuedBy: getProposalIssuer(),
    ...generatedMode,
  };
}
