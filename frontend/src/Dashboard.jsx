import { useEffect, useState, useRef } from "react";
import html2pdf from "html2pdf.js";
import * as XLSX from "xlsx-js-style";
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { getDashboardData } from "./api/dashboardApi";
import api, { authApi, authTokenStore, campaignsApi, opportunitiesApi, reportsApi, settingsApi, socialApi } from "./api/axios";
import { useI18n } from "./hooks/useI18n";
import { useLanguage } from "./context/LanguageContext";
import { useTheme } from "./context/ThemeContext";
import {
  getProposals,
  createProposal,
  deleteProposal,
  updateProposal,
  updateProposalStatus,
  generateProposalById,
} from "./api/proposalsApi";

import Chat from "./pages/chat/Chat";
import Modal from "./components/ui/Modal";

import ReactMarkdown from "react-markdown";

const PREF_KEYS = {
  language: "marketgen_language",
  theme: "marketgen_theme",
  model: "marketgen_ai_model",
  timezone: "marketgen_timezone",
  dateFormat: "marketgen_date_format",
};

const getBrowserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const TIMEZONE_OPTIONS = [
  { value: "Europe/London", label: "(UTC+00:00) London, Dublin, Lisbon" },
  { value: "Europe/Paris", label: "(UTC+01:00) Paris, Berlin, Madrid, Amsterdam" },
  { value: "Europe/Moscow", label: "(UTC+03:00) Moscow, Istanbul" },
  { value: "Asia/Dubai", label: "(UTC+04:00) Dubai, Abu Dhabi" },
  { value: "Asia/Singapore", label: "(UTC+08:00) Singapore, Hong Kong, Perth" },
  { value: "Asia/Tokyo", label: "(UTC+09:00) Tokyo, Seoul" },
  { value: "Australia/Sydney", label: "(UTC+10:00) Sydney, Melbourne" },
  { value: "America/New_York", label: "(UTC-05:00) New York, Miami, Toronto" },
  { value: "America/Chicago", label: "(UTC-06:00) Chicago, Dallas, Mexico City" },
  { value: "America/Denver", label: "(UTC-07:00) Denver, Phoenix" },
  { value: "America/Los_Angeles", label: "(UTC-08:00) Los Angeles, San Francisco, Seattle" },
  { value: "America/Santiago", label: "(UTC-04:00) Santiago" },
  { value: "America/Sao_Paulo", label: "(UTC-03:00) São Paulo, Buenos Aires" },
  { value: "UTC", label: "(UTC+00:00) UTC" },
];

const DATE_FORMAT_OPTIONS = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"];

const PROPOSAL_STATUSES = [
  { value: "Generada", labelKey: "generated" },
  { value: "Entregada", labelKey: "delivered" },
  { value: "En Negociación", labelKey: "inNegotiation" },
  { value: "Cerrada", labelKey: "closed" },
  { value: "En Contrato", labelKey: "underContract" },
  { value: "Perdida", labelKey: "lost" },
];
const PROPOSAL_STATUS_COLOR_CLASSES = {
  Generada: "bg-slate-100 text-slate-500",
  Entregada: "bg-blue-50 text-blue-500",
  "En Negociación": "bg-amber-50 text-amber-800",
  Cerrada: "bg-green-50 text-green-600",
  "En Contrato": "bg-emerald-50 text-emerald-700",
  Perdida: "bg-rose-50 text-rose-700",
};

const getStoredPreference = (key, fallback) => localStorage.getItem(key) || fallback;
const canViewAuditLogs = (user = {}) => {
  const roles = Array.isArray(user.roles) ? user.roles : [];
  return roles.includes("admin") || roles.includes("manager");
};
const DELETED_CONTENT_IDS_KEY = "marketgen_deleted_content_asset_ids";
const LOCAL_PROPOSALS_KEY = "marketgen_local_content_library_proposals";
const LOCAL_CAMPAIGNS_KEY = "marketgen_local_campaigns";
const LEGACY_PLACEHOLDER_TOTAL = 5_000;

const readDeletedContentIds = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(DELETED_CONTENT_IDS_KEY) || "[]");
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
};

const writeDeletedContentIds = (ids) => {
  localStorage.setItem(DELETED_CONTENT_IDS_KEY, JSON.stringify([...new Set(ids)]));
};

const getContentItemKey = (item = {}) => `${item.type || "Asset"}:${item.id || item.title || ""}`;

const readLocalContentProposals = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(LOCAL_PROPOSALS_KEY) || "[]");
    return Array.isArray(stored)
      ? stored.filter((proposal) => !String(proposal?.id || "").startsWith("opportunity-proposal-"))
      : [];
  } catch {
    return [];
  }
};

const writeLocalContentProposals = (proposals) => {
  localStorage.setItem(LOCAL_PROPOSALS_KEY, JSON.stringify(proposals));
};

const saveLocalContentProposal = (proposal) => {
  const current = readLocalContentProposals();
  const existingIndex = current.findIndex((item) => item.id === proposal.id);
  const next = existingIndex >= 0
    ? current.map((item) => (item.id === proposal.id ? proposal : item))
    : [proposal, ...current];
  writeLocalContentProposals(next);
  window.dispatchEvent(new CustomEvent("marketgen:proposal-updated"));
  window.dispatchEvent(new CustomEvent("marketgen:content-library-updated"));
  return next;
};

const readLocalCampaigns = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(LOCAL_CAMPAIGNS_KEY) || "[]");
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
};

const writeLocalCampaigns = (campaigns) => {
  localStorage.setItem(LOCAL_CAMPAIGNS_KEY, JSON.stringify(campaigns));
};

const saveLocalCampaign = (campaign) => {
  const current = readLocalCampaigns();
  const existingIndex = current.findIndex((item) => item.id === campaign.id);
  const next = existingIndex >= 0
    ? current.map((item) => (item.id === campaign.id ? campaign : item))
    : [campaign, ...current];
  writeLocalCampaigns(next);
  window.dispatchEvent(new CustomEvent("marketgen:campaign-updated"));
  window.dispatchEvent(new CustomEvent("marketgen:campaigns-updated"));
  return next;
};

function normalizeMoney(value) {
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

const formatUsd = (value) => {
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

function calculateProposalTotal(proposal = {}) {
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

const decodeHtmlEntities = (value = "") => {
  let decoded = String(value || "");
  for (let index = 0; index < 3; index += 1) {
    const next = decoded
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/g, "'");
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
};

const cleanProposalHtml = (html = "") => decodeHtmlEntities(html)
  .replace(/```html/g, "")
  .replace(/```/g, "")
  .replace(/<br\s*\/?>/gi, "<br />")
  .trim();

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

function cleanStructuredText(value = "") {
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

const stripHtml = (html = "") => cleanProposalHtml(html)
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<\/(p|li|h1|h2|h3|tr|section|div|ol|ul)>/gi, "\n")
  .replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, "\"")
  .replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, " ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const cleanSocialText = (value = "") => stripHtml(String(value || ""))
  .replace(/```(?:\w+)?/g, "")
  .replace(/\*\*(.*?)\*\*/g, "$1")
  .replace(/__(.*?)__/g, "$1")
  .replace(/(?<!\*)\*(?!\*)(.*?)\*(?!\*)/g, "$1")
  .replace(/(?<!_)_(?!_)(.*?)_(?!_)/g, "$1")
  .replace(/^#{1,6}\s+/gm, "")
  .trim();

function normalizeCampaignContent(rawContent = "", fallbackChannel = "linkedin", fallbackTitle = "") {
  let parsed = null;
  try {
    parsed = typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent;
  } catch {
    parsed = null;
  }

  const candidates = Array.isArray(parsed) ? parsed : parsed?.posts;
  if (Array.isArray(candidates) && candidates.length) {
    return candidates.map((post, index) => ({
      channel: post.channel || post.platform || fallbackChannel,
      headline: cleanSocialText(post.headline || (index === 0 ? fallbackTitle : "")),
      content: cleanSocialText(post.content || post.body || ""),
      hashtags: Array.isArray(post.hashtags)
        ? post.hashtags.map((tag) => cleanSocialText(tag)).filter(Boolean)
        : [],
    })).filter((post) => post.content);
  }

  const legacyText = cleanSocialText(rawContent);
  return legacyText ? [{
    channel: fallbackChannel,
    headline: cleanSocialText(fallbackTitle),
    content: legacyText,
    hashtags: [],
  }] : [];
}

const escapeHtml = (value = "") => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

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

function extractParagraphs(html = "") {
  const matches = [...cleanProposalHtml(html).matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)];
  const paragraphs = matches.map((match) => stripHtml(match[1])).filter(Boolean);
  return paragraphs.length ? paragraphs.join("\n\n") : stripHtml(html);
}

function extractH1Text(html = "") {
  const match = cleanProposalHtml(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return match ? stripHtml(match[1]).trim() : "";
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

function normalizeLineItem(row = {}) {
  const quantity = normalizeMoney(row.quantity ?? row.qty) ?? 0;
  const unitPrice = normalizeMoney(row.unitPrice ?? row.unit_price ?? row.price ?? row.amount) ?? 0;
  const subtotal = normalizeMoney(row.subtotal ?? row.total) ?? quantity * unitPrice;
  return {
    service: row.service || row.name || row.title || row.unit || "Service Unit",
    description: row.description || row.details || row.scope || "Scope to be confirmed.",
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

function detectProposalLanguage(text = "") {
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

const PROPOSAL_COPY = {
  en: {
    preparedBy: "Prepared by NoonDalton",
    client: "Client",
    contact: "Contact",
    total: "Total",
    issuedOn: "Issue Date",
    validUntil: "Valid Until",
    preparedByPerson: "Prepared by",
    proposalEyebrow: "Commercial Proposal",
    preparedFor: "Prepared for",
    executiveSummary: "Executive Summary",
    problemsIdentified: "Problems Identified",
    proposedSolution: "Proposed AI Solution",
    technologiesUsed: "Technologies Used",
    implementationCosts: "Implementation Costs",
    serviceUnit: "Service / Unit",
    description: "Description",
    qty: "Qty",
    unitPrice: "Unit Price",
    subtotal: "Subtotal",
    totalImplementationCost: "Total Implementation Cost",
    expectedROI: "Expected ROI",
    nextSteps: "Next Steps",
    noExecutiveSummary: "No executive summary has been provided yet.",
    noSolution: "NoonDalton will configure a practical AI-enabled workflow around the confirmed scope, service units, and operating requirements.",
    noProblems: "Discovery will confirm the highest-priority operating constraints.",
    noPricing: "Pricing will be finalized after confirming scope, volume assumptions, and implementation timeline.",
    noROI: "Expected impact will be measured through throughput, response time, quality indicators, and conversion progress.",
    noNextSteps: ["Confirm scope and pricing assumptions.", "Approve implementation timeline.", "Prepare the final proposal package."],
    defaultTechnologies: ["Workflow automation", "Operational reporting"],
    acceptance: "Acceptance",
    acceptanceIntro: "To accept this proposal, please sign and return this document, or confirm your acceptance by email.",
    signatureName: "Name",
    signatureRole: "Title / Role",
    signatureDate: "Date",
    signatureLine: "Signature",
  },
  es: {
    preparedBy: "Preparado por NoonDalton",
    client: "Cliente",
    contact: "Contacto",
    total: "Total",
    issuedOn: "Fecha de Emisión",
    validUntil: "Válida Hasta",
    preparedByPerson: "Preparado por",
    proposalEyebrow: "Propuesta Comercial",
    preparedFor: "Preparado para",
    executiveSummary: "Resumen Ejecutivo",
    problemsIdentified: "Problemas Identificados",
    proposedSolution: "Solución de IA Propuesta",
    technologiesUsed: "Tecnologías Utilizadas",
    implementationCosts: "Costos de Implementación",
    serviceUnit: "Servicio / Unidad",
    description: "Descripción",
    qty: "Cant.",
    unitPrice: "Precio Unitario",
    subtotal: "Subtotal",
    totalImplementationCost: "Costo Total de Implementación",
    expectedROI: "ROI Esperado",
    nextSteps: "Próximos Pasos",
    noExecutiveSummary: "Aún no se ha proporcionado un resumen ejecutivo.",
    noSolution: "NoonDalton configurará un flujo práctico con IA según el alcance, los servicios y los requisitos operativos confirmados.",
    noProblems: "El levantamiento confirmará las restricciones operativas de mayor prioridad.",
    noPricing: "El precio se finalizará después de confirmar alcance, supuestos de volumen y calendario de implementación.",
    noROI: "El impacto esperado se medirá mediante tiempos de respuesta, calidad operativa, visibilidad y avance de conversión.",
    noNextSteps: ["Confirmar alcance y supuestos de precio.", "Aprobar calendario de implementación.", "Preparar el paquete final de propuesta."],
    defaultTechnologies: ["Automatización de flujos", "Reportería operativa"],
    acceptance: "Aceptación",
    acceptanceIntro: "Para aceptar esta propuesta, firme y devuelva este documento, o confirme su aceptación por correo electrónico.",
    signatureName: "Nombre",
    signatureRole: "Cargo",
    signatureDate: "Fecha",
    signatureLine: "Firma",
  },
  pt: {
    preparedBy: "Preparado por NoonDalton",
    client: "Cliente",
    contact: "Contato",
    total: "Total",
    issuedOn: "Data de Emissão",
    validUntil: "Válida Até",
    preparedByPerson: "Preparado por",
    proposalEyebrow: "Proposta Comercial",
    preparedFor: "Preparado para",
    executiveSummary: "Resumo Executivo",
    problemsIdentified: "Problemas Identificados",
    proposedSolution: "Solução de IA Proposta",
    technologiesUsed: "Tecnologias Utilizadas",
    implementationCosts: "Custos de Implementação",
    serviceUnit: "Serviço / Unidade",
    description: "Descrição",
    qty: "Qtd.",
    unitPrice: "Preço Unitário",
    subtotal: "Subtotal",
    totalImplementationCost: "Custo Total de Implementação",
    expectedROI: "ROI Esperado",
    nextSteps: "Próximos Passos",
    noExecutiveSummary: "Ainda não foi fornecido um resumo executivo.",
    noSolution: "A NoonDalton configurará um fluxo prático com IA em torno do escopo, serviços e requisitos operacionais confirmados.",
    noProblems: "A descoberta confirmará as restrições operacionais de maior prioridade.",
    noPricing: "O preço será finalizado após confirmar escopo, premissas de volume e cronograma de implementação.",
    noROI: "O impacto esperado será medido por produtividade, tempo de resposta, indicadores de qualidade e progresso de conversão.",
    noNextSteps: ["Confirmar escopo e premissas de preço.", "Aprovar cronograma de implementação.", "Preparar o pacote final da proposta."],
    defaultTechnologies: ["Automação de fluxos", "Relatórios operacionais"],
    acceptance: "Aceitação",
    acceptanceIntro: "Para aceitar esta proposta, assine e devolva este documento, ou confirme a aceitação por e-mail.",
    signatureName: "Nome",
    signatureRole: "Cargo",
    signatureDate: "Data",
    signatureLine: "Assinatura",
  },
};

const getProposalCopy = (language) => PROPOSAL_COPY[language] || PROPOSAL_COPY.en;

const PROPOSAL_VALIDITY_DAYS = 30;
const PROPOSAL_DATE_LOCALES = { en: "en-US", es: "es-CL", pt: "pt-BR" };

function formatProposalDate(date, language) {
  const locale = PROPOSAL_DATE_LOCALES[language] || PROPOSAL_DATE_LOCALES.en;
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(date);
}

function getProposalIssuer() {
  const user = authTokenStore.getUser() || {};
  if (user.name) return user.name;
  return String(user.email || "").split("@")[0];
}

function normalizeProposalDocument(proposal = {}) {
  const structured = proposal.structuredContent || proposal.document || proposal.proposalDocument || proposal.proposal_document || {};
  const content = unwrapEmbeddedProposalHtml(proposal.content || structured.content || proposal.industry || proposal.description || "");
  const text = stripHtml(content);
  const language = structured.language || proposal.language || detectProposalLanguage(proposal.proposalDescription || proposal.proposal_description || proposal.description || content);
  const section = (names) => extractHtmlSection(content, names) || splitTextSection(text, names);
  const total = calculateProposalTotal(proposal);
  const lineItems = [
    ...(structured.lineItems || structured.line_items || proposal.lineItems || proposal.pricingRows || proposal.pricing_rows || []),
  ].map(normalizeLineItem);
  const parsedLineItems = lineItems.length ? lineItems : parseLineItemsFromHtml(content);
  const technologiesSection = section(["Technologies Used"]);
  const problemsSection = section(["Problems Identified", "Client Problem"]);
  const nextStepsSection = section(["Next Steps"]);
  const structuredProblems = cleanStructuredList(structured.problemsIdentified || structured.problems_identified || proposal.problemsIdentified);
  const structuredTechnologies = cleanStructuredList(structured.technologiesUsed || structured.technologies_used || proposal.technologiesUsed);
  const structuredNextSteps = cleanStructuredList(structured.nextSteps || structured.next_steps || proposal.nextSteps);
  const executiveSummary = cleanStructuredText(structured.executiveSummary || structured.executive_summary || proposal.executiveSummary)
    || extractParagraphs(section(["Executive Summary"]))
    || cleanStructuredText(proposal.description)
    || text.split(/\n{2,}/)[0]
    || "";
  const proposedSolution = cleanStructuredText(structured.proposedSolution || structured.proposed_solution || proposal.proposedSolution)
    || extractParagraphs(section(["Proposed AI Solution"]))
    || "";
  const parsedCreatedAt = proposal.createdAt ? new Date(proposal.createdAt) : null;
  const issuedOnDate = parsedCreatedAt && !Number.isNaN(parsedCreatedAt.getTime()) ? parsedCreatedAt : new Date();
  const validUntilDate = new Date(issuedOnDate);
  validUntilDate.setDate(validUntilDate.getDate() + PROPOSAL_VALIDITY_DAYS);

  return {
    title: structured.title || proposal.title || proposal.name || "AI Generated Proposal",
    client: structured.client || proposal.client || proposal.customerName || proposal.customer_name || proposal.clientName || "",
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
    expectedROI: cleanStructuredText(structured.expectedROI || structured.expected_roi || proposal.expectedROI) || extractParagraphs(section(["Expected ROI", "ROI / Expected Impact"])) || "",
    nextSteps: structuredNextSteps.length ? structuredNextSteps : extractListItems(nextStepsSection),
    formattedTotal: total.formattedTotal,
    language,
    issuedOn: formatProposalDate(issuedOnDate, language),
    validUntil: formatProposalDate(validUntilDate, language),
    issuedBy: getProposalIssuer(),
  };
}

const PROPOSAL_PDF_PAGE_BREAK_CSS = `
h1, h2, h3 {
  page-break-after: avoid;
  break-after: avoid;
}

h2 + p, h2 + ul, h2 + div {
  page-break-before: avoid;
  break-before: avoid;
}

p {
  orphans: 3;
  widows: 3;
}

.proposal-detail-card {
  page-break-inside: avoid;
  break-inside: avoid;
}
`.trim();

function proposalDocumentToHtml(proposal = {}) {
  const doc = normalizeProposalDocument(proposal);
  const copy = getProposalCopy(doc.language);
  const splitCardText = (value) => {
    const text = String(value || "").trim();
    const parts = text.split(/:\s+| - | – | — /);
    if (parts.length > 1 && parts[0].length <= 90) {
      return {
        title: parts[0].trim(),
        body: text.slice(parts[0].length).replace(/^(:|\s+-\s+|\s+–\s+|\s+—\s+)/, "").trim(),
      };
    }
    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
    return {
      title: sentences[0]?.trim() || text,
      body: sentences.slice(1).join(" ").trim(),
    };
  };
  const paragraphsToHtml = (value) => String(value || "")
    .split(/\n{2,}|\n(?=[A-Z])/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("");
  const cardsToHtml = (items) => items.map((item) => {
    const card = splitCardText(item);
    return `<div class="proposal-detail-card"><strong>${escapeHtml(card.title)}</strong>${card.body ? `<p>${escapeHtml(card.body)}</p>` : ""}</div>`;
  }).join("");
  const rows = doc.lineItems.map((item) => `
    <tr>
      <td>${escapeHtml(item.service)}</td>
      <td>${escapeHtml(item.description)}</td>
      <td>${escapeHtml(item.quantity)}</td>
      <td>${escapeHtml(formatUsd(item.unitPrice))}</td>
      <td>${escapeHtml(formatUsd(item.subtotal))}</td>
    </tr>
  `).join("");
  return `
    <style data-proposal-pdf-page-breaks>${PROPOSAL_PDF_PAGE_BREAK_CSS}</style>
    <article class="proposal-preview-document">
      <div class="proposal-paper">
        <header class="proposal-cover">
          <p class="proposal-eyebrow">${escapeHtml(copy.preparedBy)}</p>
          <h1>${escapeHtml(doc.title)}</h1>
          <p class="proposal-subtitle">${escapeHtml(copy.proposalEyebrow)} · ${escapeHtml(copy.preparedFor)} ${escapeHtml(doc.client)}</p>
          <div class="proposal-meta">
            ${doc.industry ? `<span>${escapeHtml(doc.industry)}</span>` : ""}
            ${doc.contact ? `<span>${escapeHtml(doc.contact)}</span>` : ""}
            ${doc.serviceLine ? `<span>${escapeHtml(doc.serviceLine)}</span>` : ""}
          </div>
          <div class="proposal-cover-info">
            <span><strong>${escapeHtml(copy.total)}</strong>${escapeHtml(doc.formattedTotal)}</span>
            <span><strong>${escapeHtml(copy.issuedOn)}</strong>${escapeHtml(doc.issuedOn)}</span>
            <span><strong>${escapeHtml(copy.validUntil)}</strong>${escapeHtml(doc.validUntil)}</span>
            <span><strong>${escapeHtml(copy.preparedByPerson)}</strong>${escapeHtml(doc.issuedBy || "—")}</span>
          </div>
        </header>
        <section><h2>${escapeHtml(copy.executiveSummary)}</h2>${paragraphsToHtml(doc.executiveSummary || copy.noExecutiveSummary)}</section>
        <section><h2>${escapeHtml(copy.problemsIdentified)}</h2><div class="proposal-card-list">${cardsToHtml(doc.problemsIdentified.length ? doc.problemsIdentified : [copy.noProblems])}</div></section>
        <section><h2>${escapeHtml(copy.proposedSolution)}</h2>${paragraphsToHtml(doc.proposedSolution || copy.noSolution)}</section>
        <section><h2>${escapeHtml(copy.technologiesUsed)}</h2><div class="proposal-card-list">${cardsToHtml(doc.technologiesUsed.length ? doc.technologiesUsed : copy.defaultTechnologies)}</div></section>
        <section><h2>${escapeHtml(copy.implementationCosts)}</h2><table><thead><tr><th>${escapeHtml(copy.serviceUnit)}</th><th>${escapeHtml(copy.description)}</th><th>${escapeHtml(copy.qty)}</th><th>${escapeHtml(copy.unitPrice)}</th><th>${escapeHtml(copy.subtotal)}</th></tr></thead><tbody>${rows || `<tr><td colspan="5">${escapeHtml(copy.noPricing)}</td></tr>`}</tbody></table><p class="proposal-validity-note">${escapeHtml(copy.validUntil)}: ${escapeHtml(doc.validUntil)}</p></section>
        <div class="proposal-total-card"><span>${escapeHtml(copy.totalImplementationCost)}</span><strong>${escapeHtml(doc.formattedTotal)}</strong></div>
        <section><h2>${escapeHtml(copy.expectedROI)}</h2>${paragraphsToHtml(doc.expectedROI || copy.noROI)}</section>
        <section><h2>${escapeHtml(copy.nextSteps)}</h2><ol>${(doc.nextSteps.length ? doc.nextSteps : copy.noNextSteps).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol></section>
        <section class="proposal-acceptance">
          <h2>${escapeHtml(copy.acceptance)}</h2>
          <p>${escapeHtml(copy.acceptanceIntro)}</p>
          <div class="proposal-signature-grid">
            <div class="proposal-signature-field"><span>${escapeHtml(copy.signatureName)}</span><div class="proposal-signature-line"></div></div>
            <div class="proposal-signature-field"><span>${escapeHtml(copy.signatureRole)}</span><div class="proposal-signature-line"></div></div>
            <div class="proposal-signature-field"><span>${escapeHtml(copy.signatureDate)}</span><div class="proposal-signature-line"></div></div>
            <div class="proposal-signature-field"><span>${escapeHtml(copy.signatureLine)}</span><div class="proposal-signature-line"></div></div>
          </div>
        </section>
      </div>
    </article>
  `;
}

function ProposalParagraphs({ text, fallback }) {
  const paragraphs = String(text || fallback || "")
    .split(/\n{2,}|\n(?=[A-Z])/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>);
}

function splitProposalCardText(value) {
  const text = String(value || "").trim();
  const parts = text.split(/:\s+| - | – | — /);
  if (parts.length > 1 && parts[0].length <= 90) {
    return {
      title: parts[0].trim(),
      body: text.slice(parts[0].length).replace(/^(:|\s+-\s+|\s+–\s+|\s+—\s+)/, "").trim(),
    };
  }
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  return {
    title: sentences[0]?.trim() || text,
    body: sentences.slice(1).join(" ").trim(),
  };
}

function ProposalDetailCards({ items }) {
  return (
    <div className="proposal-card-list">
      {items.map((item) => {
        const card = splitProposalCardText(item);
        return (
          <div className="proposal-detail-card" key={item}>
            <strong>{card.title}</strong>
            {card.body && <p>{card.body}</p>}
          </div>
        );
      })}
    </div>
  );
}

function ProposalDocumentPreview({ proposal, className = "", exportRef = null }) {
  const doc = normalizeProposalDocument(proposal);
  const copy = getProposalCopy(doc.language);
  const problems = Array.isArray(doc.problemsIdentified) ? doc.problemsIdentified.filter(Boolean) : [];
  const technologies = Array.isArray(doc.technologiesUsed) ? doc.technologiesUsed.filter(Boolean) : [];
  const nextSteps = Array.isArray(doc.nextSteps) ? doc.nextSteps.filter(Boolean) : [];

  return (
    <article ref={exportRef} className={`proposal-preview-document ${className}`}>
      <div className="proposal-paper">
        <header className="proposal-cover">
          <p className="proposal-eyebrow">{copy.preparedBy}</p>
          <h1>{doc.title}</h1>
          <p className="proposal-subtitle">{copy.proposalEyebrow} · {copy.preparedFor} {doc.client}</p>
          <div className="proposal-meta">
            {doc.industry && <span>{doc.industry}</span>}
            {doc.contact && <span>{doc.contact}</span>}
            {doc.serviceLine && <span>{doc.serviceLine}</span>}
          </div>
          <div className="proposal-cover-info">
            <span><strong>{copy.total}</strong>{doc.formattedTotal}</span>
            <span><strong>{copy.issuedOn}</strong>{doc.issuedOn}</span>
            <span><strong>{copy.validUntil}</strong>{doc.validUntil}</span>
            <span><strong>{copy.preparedByPerson}</strong>{doc.issuedBy || "—"}</span>
          </div>
        </header>

        <section>
          <h2>{copy.executiveSummary}</h2>
          <ProposalParagraphs text={doc.executiveSummary} fallback={copy.noExecutiveSummary} />
        </section>

        <section>
          <h2>{copy.problemsIdentified}</h2>
          <ProposalDetailCards items={problems.length ? problems : [copy.noProblems]} />
        </section>

        <section>
          <h2>{copy.proposedSolution}</h2>
          <ProposalParagraphs text={doc.proposedSolution} fallback={copy.noSolution} />
        </section>

        <section>
          <h2>{copy.technologiesUsed}</h2>
          <ProposalDetailCards items={technologies.length ? technologies : copy.defaultTechnologies} />
        </section>

        <section>
          <h2>{copy.implementationCosts}</h2>
          <div className="proposal-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{copy.serviceUnit}</th>
                  <th>{copy.description}</th>
                  <th>{copy.qty}</th>
                  <th>{copy.unitPrice}</th>
                  <th>{copy.subtotal}</th>
                </tr>
              </thead>
              <tbody>
                {doc.lineItems.length ? doc.lineItems.map((item, index) => (
                  <tr key={`${item.service}-${index}`}>
                    <td>{item.service}</td>
                    <td>{item.description}</td>
                    <td>{item.quantity}</td>
                    <td>{formatUsd(item.unitPrice)}</td>
                    <td>{formatUsd(item.subtotal)}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={5}>{copy.noPricing}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="proposal-validity-note">{copy.validUntil}: {doc.validUntil}</p>
        </section>

        <div className="proposal-total-card">
          <span>{copy.totalImplementationCost}</span>
          <strong>{doc.formattedTotal}</strong>
        </div>

        <section className="proposal-highlight-section">
          <h2>{copy.expectedROI}</h2>
          <ProposalParagraphs text={doc.expectedROI} fallback={copy.noROI} />
        </section>

        <section>
          <h2>{copy.nextSteps}</h2>
          <ol className="proposal-next-steps">
            {(nextSteps.length ? nextSteps : copy.noNextSteps).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>

        <section className="proposal-acceptance">
          <h2>{copy.acceptance}</h2>
          <p>{copy.acceptanceIntro}</p>
          <div className="proposal-signature-grid">
            <div className="proposal-signature-field"><span>{copy.signatureName}</span><div className="proposal-signature-line" /></div>
            <div className="proposal-signature-field"><span>{copy.signatureRole}</span><div className="proposal-signature-line" /></div>
            <div className="proposal-signature-field"><span>{copy.signatureDate}</span><div className="proposal-signature-line" /></div>
            <div className="proposal-signature-field"><span>{copy.signatureLine}</span><div className="proposal-signature-line" /></div>
          </div>
        </section>
      </div>
    </article>
  );
}

const sanitizeDownloadName = (title = "proposal") => String(title || "proposal")
  .trim()
  .replace(/[^a-z0-9]+/gi, "_")
  .replace(/^_+|_+$/g, "")
  || "proposal";

function downloadBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.URL.revokeObjectURL(url);
}

function createProposalExportClone(sourceElement) {
  if (!sourceElement) return null;
  const clone = sourceElement.cloneNode(true);
  if (!clone.querySelector("style[data-proposal-pdf-page-breaks]")) {
    const style = document.createElement("style");
    style.dataset.proposalPdfPageBreaks = "true";
    style.textContent = PROPOSAL_PDF_PAGE_BREAK_CSS;
    clone.prepend(style);
  }
  clone.classList.remove("max-h-[55vh]", "max-h-[65vh]", "overflow-y-auto", "shadow-sm");
  clone.classList.add("proposal-export-pdf");
  clone.style.width = "794px";
  clone.style.maxHeight = "none";
  clone.style.overflow = "visible";
  clone.style.boxShadow = "none";
  clone.style.background = "#ffffff";

  const wrapper = document.createElement("div");
  wrapper.style.position = "fixed";
  wrapper.style.left = "-10000px";
  wrapper.style.top = "0";
  wrapper.style.width = "794px";
  wrapper.style.background = "#ffffff";
  wrapper.style.padding = "24px";
  wrapper.appendChild(clone);
  document.body.appendChild(wrapper);
  return { wrapper, clone };
}

function createTemporaryProposalPreview(proposal) {
  const wrapper = document.createElement("div");
  wrapper.style.position = "fixed";
  wrapper.style.left = "-10000px";
  wrapper.style.top = "0";
  wrapper.style.width = "794px";
  wrapper.style.background = "#ffffff";
  wrapper.style.padding = "24px";
  wrapper.innerHTML = proposalDocumentToHtml(proposal);
  document.body.appendChild(wrapper);
  return { wrapper, element: wrapper.querySelector(".proposal-preview-document") };
}

async function exportProposalPdf(proposal, sourceElement) {
  const doc = normalizeProposalDocument(proposal);
  const temporary = sourceElement ? null : createTemporaryProposalPreview(proposal);
  const exportNode = createProposalExportClone(sourceElement || temporary?.element);
  if (!exportNode) throw new Error("Proposal preview is not available for PDF export.");

  try {
    const filename = `${sanitizeDownloadName(doc.title)}.pdf`;
    const buildWorker = () => html2pdf()
      .set({
        filename,
        // A bigger top margin alone can't fix "page 2 starts mid-sentence" —
        // it applies equally to every page, so cranking it up just pushes
        // page 1's cover down too. The actual fix is below: never let a <p>
        // get sliced in half across a page boundary. With that in place this
        // margin only needs to cover the page's breathing room, not also
        // fake a "fresh paragraph" feeling.
        margin: [14, 8, 18, 8],
        image: { type: "png", quality: 1 },
        html2canvas: {
          scale: 3,
          useCORS: true,
          backgroundColor: "#ffffff",
          scrollX: 0,
          scrollY: 0,
          windowWidth: 940,
        },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait", compress: true },
        pagebreak: {
          mode: ["css", "legacy"],
          avoid: [
            ".proposal-cover",
            ".proposal-highlight-section",
            ".proposal-total-card",
            ".proposal-detail-card",
            ".proposal-card-list",
            ".proposal-table-wrap",
            ".proposal-acceptance",
            "table",
            "thead",
            "tr",
            "h1",
            "h2",
            "p",
            "li",
          ],
        },
      })
      .from(exportNode.clone);

    let worker = buildWorker();
    let pdf = await worker.toPdf().get("pdf").then((generatedPdf) => generatedPdf);

    if (pdf.internal.getNumberOfPages() > 6) {
      exportNode.clone.classList.add("proposal-export-pdf-compact");
      worker = buildWorker();
      pdf = await worker.toPdf().get("pdf").then((generatedPdf) => generatedPdf);
    }

    if (pdf.internal.getNumberOfPages() > 6) {
      exportNode.clone.classList.add("proposal-export-pdf-ultra");
      worker = buildWorker();
      pdf = await worker.toPdf().get("pdf").then((generatedPdf) => generatedPdf);
    }

    const pageCount = pdf.internal.getNumberOfPages();
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    for (let page = 1; page <= pageCount; page += 1) {
      pdf.setPage(page);
      pdf.setFontSize(9);
      pdf.setTextColor(148, 163, 184);
      pdf.text(`NoonDalton - ${page} / ${pageCount}`, pageWidth / 2, pageHeight - 8, { align: "center" });
    }
    pdf.save(filename);
  } finally {
    exportNode.wrapper.remove();
    temporary?.wrapper.remove();
  }
}

function extractProposalDocumentFromDom(sourceElement, fallbackProposal = {}) {
  const fallback = normalizeProposalDocument(fallbackProposal);
  if (!sourceElement) return fallback;

  const textOf = (selector) => sourceElement.querySelector(selector)?.textContent?.trim() || "";
  const coverInfoLabelMap = Object.values(PROPOSAL_COPY).reduce((acc, copy) => {
    acc[copy.total.toLowerCase()] = "total";
    return acc;
  }, {});
  const coverInfo = [...sourceElement.querySelectorAll(".proposal-cover-info span")].reduce((acc, item) => {
    const label = item.querySelector("strong")?.textContent?.trim().toLowerCase();
    const value = item.textContent.replace(item.querySelector("strong")?.textContent || "", "").trim();
    if (label) acc[coverInfoLabelMap[label] || label] = value;
    return acc;
  }, {});
  const sections = [...sourceElement.querySelectorAll(".proposal-paper section")].reduce((acc, section) => {
    const heading = section.querySelector("h2")?.textContent?.trim();
    if (!heading) return acc;
    acc[heading] = section;
    return acc;
  }, {});
  const translatedHeadings = (key) => [...new Set(Object.values(PROPOSAL_COPY).map((copy) => copy[key]))];
  const findSection = (key) => translatedHeadings(key).map((heading) => sections[heading]).find(Boolean);
  const sectionParagraphs = (key) => [...(findSection(key)?.querySelectorAll("p") || [])]
    .map((node) => node.textContent.trim())
    .filter(Boolean)
    .join("\n\n");
  // The cover-card sections (problems identified, technologies used) render
  // as .proposal-detail-card divs, not <li> — keep this in sync with
  // proposalDocumentToHtml()/cardsToHtml(), otherwise these always extract
  // empty and the DOCX export throws when it builds a zero-row Table from them.
  const sectionList = (key, selector = ".proposal-detail-card") => [...(findSection(key)?.querySelectorAll(selector) || [])]
    .map((node) => node.textContent.trim())
    .filter(Boolean);
  const lineItems = [...(findSection("implementationCosts")?.querySelectorAll("tbody tr") || [])]
    .map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent.trim()))
    .filter((cells) => cells.length >= 5)
    .map((cells) => normalizeLineItem({
      service: cells[0],
      description: cells[1],
      quantity: cells[2],
      unitPrice: cells[3],
      subtotal: cells[4],
    }));

  return {
    ...fallback,
    title: textOf(".proposal-paper .proposal-cover h1") || fallback.title,
    totalAmount: normalizeMoney(coverInfo.total) ?? fallback.totalAmount,
    executiveSummary: sectionParagraphs("executiveSummary") || fallback.executiveSummary,
    problemsIdentified: sectionList("problemsIdentified").length ? sectionList("problemsIdentified") : fallback.problemsIdentified,
    proposedSolution: sectionParagraphs("proposedSolution") || fallback.proposedSolution,
    technologiesUsed: sectionList("technologiesUsed").length ? sectionList("technologiesUsed") : fallback.technologiesUsed,
    lineItems: lineItems.length ? lineItems : fallback.lineItems,
    expectedROI: sectionParagraphs("expectedROI") || fallback.expectedROI,
    nextSteps: sectionList("nextSteps", "li").length ? sectionList("nextSteps", "li") : fallback.nextSteps,
    formattedTotal: coverInfo.total || fallback.formattedTotal,
  };
}

const docxBorder = { style: BorderStyle.SINGLE, size: 4, color: "E5E7EB" };
const docxCellBorders = { top: docxBorder, bottom: docxBorder, left: docxBorder, right: docxBorder };

function docxText(text, options = {}) {
  return new TextRun({ text: String(text || ""), font: "Aptos", ...options });
}

function docxParagraph(text, options = {}) {
  return new Paragraph({
    spacing: { after: 260, line: 360 },
    keepLines: true,
    children: [docxText(text, { color: "1F2937", ...(options.textOptions || {}) })],
    ...options,
  });
}

function docxHeading(text, level = HeadingLevel.HEADING_2, spacing = {}, pageBreakBefore = false) {
  return new Paragraph({
    children: [docxText(text, { bold: true, color: "1A2B4A", size: 28 })],
    heading: level,
    keepNext: true,
    pageBreakBefore,
    border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: "6366F1", space: 4 } },
    spacing: { before: 620, after: 260, ...spacing },
  });
}

function docxCell(children, options = {}) {
  return new TableCell({
    borders: docxCellBorders,
    margins: { top: 120, bottom: 120, left: 140, right: 140 },
    children: Array.isArray(children) ? children : [children],
    ...options,
  });
}

function docxRowsFromLineItems(lineItems = [], copy = PROPOSAL_COPY.en) {
  const header = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: [copy.serviceUnit, copy.description, copy.qty, copy.unitPrice, copy.subtotal].map((label) =>
      docxCell(new Paragraph({ children: [docxText(label, { bold: true, color: "1A2B4A" })] }), {
        shading: { type: ShadingType.CLEAR, fill: "EEF2FF" },
      }),
    ),
  });
  const rows = lineItems.map((item, index) => new TableRow({
    cantSplit: true,
    children: [
      item.service,
      item.description,
      item.quantity,
      formatUsd(item.unitPrice),
      formatUsd(item.subtotal),
    ].map((value) => docxCell(new Paragraph({ children: [docxText(value, { color: "1F2937" })] }), {
      shading: { type: ShadingType.CLEAR, fill: index % 2 === 0 ? "FFFFFF" : "F6F8FB" },
    })),
  }));
  return [header, ...rows];
}

function docxTechnologyRows(technologies = []) {
  // docx's Table constructor does Array(Math.max(...rows.map(...))) internally,
  // and Math.max() over an empty list is -Infinity — a zero-row table throws
  // RangeError: Invalid array length. Never let that array be empty.
  const list = technologies.length ? technologies : ["—"];
  const chunks = [];
  for (let index = 0; index < list.length; index += 3) {
    chunks.push(list.slice(index, index + 3));
  }
  return chunks.map((chunk) => new TableRow({
    cantSplit: true,
    children: chunk.map((technology) => docxCell(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [docxText(technology, { bold: true, color: "1A2B4A" })],
      }),
      {
        shading: { type: ShadingType.CLEAR, fill: "F6F8FB" },
        margins: { top: 120, bottom: 120, left: 160, right: 160 },
      },
    )).concat(Array.from({ length: Math.max(0, 3 - chunk.length) }, () => docxCell(new Paragraph({ children: [] }), {
      borders: {
        top: { style: BorderStyle.SINGLE, size: 0, color: "FFFFFF" },
        bottom: { style: BorderStyle.SINGLE, size: 0, color: "FFFFFF" },
        left: { style: BorderStyle.SINGLE, size: 0, color: "FFFFFF" },
        right: { style: BorderStyle.SINGLE, size: 0, color: "FFFFFF" },
      },
    }))),
  }));
}

function docxSignatureCell(label) {
  return docxCell([
    new Paragraph({ children: [docxText(label, { color: "64748B", bold: true, size: 18 })], spacing: { after: 360 } }),
    new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "CBD5E1" } },
      spacing: { after: 40 },
      children: [docxText(" ")],
    }),
  ], {
    borders: {
      top: { style: BorderStyle.SINGLE, size: 0, color: "FFFFFF" },
      bottom: { style: BorderStyle.SINGLE, size: 0, color: "FFFFFF" },
      left: { style: BorderStyle.SINGLE, size: 0, color: "FFFFFF" },
      right: { style: BorderStyle.SINGLE, size: 0, color: "FFFFFF" },
    },
  });
}

async function exportProposalDocx(proposal, sourceElement) {
  const temporary = sourceElement ? null : createTemporaryProposalPreview(proposal);
  try {
    const doc = extractProposalDocumentFromDom(sourceElement || temporary?.element, proposal);
    const copy = getProposalCopy(doc.language);
    // Mirror the PDF/preview fallbacks: a Table built from a zero-length rows
    // array throws (docx tries to Array(Math.max(...[])) internally), so an
    // empty list must never reach docxTechnologyRows/docxRowsFromLineItems.
    const technologiesForDocx = doc.technologiesUsed.length ? doc.technologiesUsed : copy.defaultTechnologies;
    const problemsForDocx = doc.problemsIdentified.length ? doc.problemsIdentified : [copy.noProblems];
    const coverInfoTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            [copy.total, doc.formattedTotal],
            [copy.issuedOn, doc.issuedOn],
            [copy.validUntil, doc.validUntil],
            [copy.preparedByPerson, doc.issuedBy || "—"],
          ].map(([label, value]) => docxCell([
            new Paragraph({ children: [docxText(label, { color: "64748B", bold: true })] }),
            new Paragraph({ children: [docxText(value, { color: "1A2B4A", bold: true })] }),
          ], { shading: { type: ShadingType.CLEAR, fill: "F6F8FB" } })),
        }),
      ],
    });
    const costTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: docxRowsFromLineItems(doc.lineItems, copy),
    });
    const signatureTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ cantSplit: true, children: [docxSignatureCell(copy.signatureName), docxSignatureCell(copy.signatureRole)] }),
        new TableRow({ cantSplit: true, children: [docxSignatureCell(copy.signatureDate), docxSignatureCell(copy.signatureLine)] }),
      ],
    });
    const borderlessCell = (children) => docxCell(children, {
      borders: {
        top: { style: BorderStyle.SINGLE, size: 0, color: "FFFFFF" },
        bottom: { style: BorderStyle.SINGLE, size: 0, color: "FFFFFF" },
        left: { style: BorderStyle.SINGLE, size: 0, color: "FFFFFF" },
        right: { style: BorderStyle.SINGLE, size: 0, color: "FFFFFF" },
      },
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    const costSectionTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [new TableRow({
        cantSplit: true,
        children: [borderlessCell([
          docxHeading(copy.implementationCosts),
          costTable,
          new Paragraph({
            children: [docxText(`${copy.totalImplementationCost}: ${doc.formattedTotal}`, { bold: true, color: "1A2B4A", size: 28 })],
            shading: { type: ShadingType.CLEAR, fill: "EEF2FF" },
            border: { left: { style: BorderStyle.SINGLE, size: 18, color: "6366F1" } },
            spacing: { before: 240, after: 260 },
            alignment: AlignmentType.CENTER,
          }),
        ])],
      })],
    });
    const acceptanceSectionTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [new TableRow({
        cantSplit: true,
        children: [borderlessCell([
          docxHeading(copy.acceptance),
          docxParagraph(copy.acceptanceIntro),
          signatureTable,
        ])],
      })],
    });
    const proposalDoc = new Document({
      styles: {
        default: {
          document: { run: { font: "Aptos" } },
        },
      },
      sections: [{
        properties: {},
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  docxText("NoonDalton · ", { color: "94A3B8", size: 18 }),
                  new TextRun({ children: [PageNumber.CURRENT], font: "Aptos", size: 18, color: "94A3B8" }),
                  docxText(" / ", { color: "94A3B8", size: 18 }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], font: "Aptos", size: 18, color: "94A3B8" }),
                ],
              }),
            ],
          }),
        },
        children: [
          new Paragraph({
            children: [docxText(copy.preparedBy.toUpperCase(), { bold: true, color: "4F46E5", size: 22 })],
            border: { top: { style: BorderStyle.SINGLE, size: 18, color: "6366F1" } },
            spacing: { before: 360, after: 220 },
          }),
          new Paragraph({ children: [docxText(doc.title, { bold: true, color: "111C30", size: 42 })], spacing: { after: 260, line: 360 } }),
          docxParagraph(`${copy.proposalEyebrow} - ${copy.preparedFor} ${doc.client}`, { spacing: { after: 360, line: 360 }, textOptions: { color: "475569", size: 24 } }),
          docxParagraph([doc.industry, doc.contact, doc.serviceLine].filter(Boolean).join("   "), { spacing: { after: 420, line: 320 }, textOptions: { color: "334155", bold: true } }),
          coverInfoTable,
          new Paragraph({ children: [docxText(" ")], spacing: { after: 420 } }),
          docxHeading(copy.executiveSummary, HeadingLevel.HEADING_2),
          ...String(doc.executiveSummary || "").split(/\n{2,}/).filter(Boolean).map((text) => docxParagraph(text)),
          docxHeading(copy.problemsIdentified),
          ...problemsForDocx.map((item) => new Paragraph({ text: item, bullet: { level: 0 }, keepLines: true, spacing: { after: 140 } })),
          docxHeading(copy.proposedSolution),
          ...String(doc.proposedSolution || "").split(/\n{2,}/).filter(Boolean).map((text) => docxParagraph(text)),
          docxHeading(copy.technologiesUsed),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: docxTechnologyRows(technologiesForDocx),
          }),
          costSectionTable,
          docxHeading(copy.expectedROI),
          ...String(doc.expectedROI || "").split(/\n{2,}/).filter(Boolean).map((text) => docxParagraph(text)),
          docxHeading(copy.nextSteps),
          ...doc.nextSteps.map((item) => new Paragraph({ text: item, numbering: { reference: "next-steps", level: 0 }, keepLines: true, spacing: { after: 140 } })),
          acceptanceSectionTable,
        ],
      }],
      numbering: {
        config: [{
          reference: "next-steps",
          levels: [{
            level: 0,
            format: "decimal",
            text: "%1.",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 360, hanging: 260 } } },
          }],
        }],
      },
    });

    const blob = await Packer.toBlob(proposalDoc);
    downloadBlob(blob, `${sanitizeDownloadName(doc.title)}.docx`);
  } finally {
    temporary?.wrapper.remove();
  }
}

async function exportProposalDocument(proposal, format, sourceElement) {
  if (format === "docx") {
    await exportProposalDocx(proposal, sourceElement);
    return;
  }
  await exportProposalPdf(proposal, sourceElement);
}
/* ═══════════════════════════════════════════════════════════════ */
/*  INLINE SVG ICONS                                               */
/* ═══════════════════════════════════════════════════════════════ */
const I = ({ children, size = 16, className = "", ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} {...p}>{children}</svg>
);
const GridIcon = (p) => <I {...p}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></I>;
const BookIcon = (p) => <I {...p}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15z"/></I>;
const BriefIcon = (p) => <I {...p}><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></I>;
const UsersIcon = (p) => <I {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></I>;
const ImageIcon = (p) => <I {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21,15 16,10 5,21"/></I>;
const FileIcon = (p) => <I {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></I>;
const ChartIcon = (p) => <I {...p}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></I>;
const ChatIcon = (p) => <I {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></I>;
const GearIcon = (p) => <I {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1.08 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1.08z"/></I>;
const RadarIcon = (p) => <I {...p}><path d="M19.07 4.93A10 10 0 0 0 2 12c0 5.52 4.48 10 10 10a10 10 0 0 0 7.07-17.07z"/><path d="M12 12l4.24-4.24"/><circle cx="12" cy="12" r="2"/></I>;
const TargetIcon = (p) => <I {...p}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></I>;
const InboxIcon = (p) => <I {...p}><polyline points="22,12 16,12 14,15 10,15 8,12 2,12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></I>;
const SendIcon = (p) => <I {...p}><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22,2 15,22 11,13 2,9"/></I>;
const MailIcon = (p) => <I {...p}><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></I>;
const SearchIcon = (p) => <I {...p}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></I>;
const PlusIcon = (p) => <I {...p}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></I>;
const TrendIcon = (p) => <I {...p}><polyline points="23,6 13.5,15.5 8.5,10.5 1,18"/><polyline points="17,6 23,6 23,12"/></I>;
const SparkIcon = (p) => <I {...p}><path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z"/></I>;
const XIcon = (p) => <I {...p}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></I>;
const CheckIcon = (p) => <I {...p}><polyline points="20,6 9,17 4,12"/></I>;
const ClockIcon = (p) => <I {...p}><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></I>;
const ShieldIcon = (p) => <I {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></I>;
const PenIcon = (p) => <I {...p}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></I>;
const TrashIcon = (p) => <I {...p}><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></I>;
const LogOutIcon = (p) => <I {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16,17 21,12 16,7"/><line x1="21" y1="12" x2="9" y2="12"/></I>;
const SaveIcon = (p) => <I {...p}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17,21 17,13 7,13 7,21"/><polyline points="7,3 7,8 15,8"/></I>;
const BotIcon = (p) => <I {...p}><path d="M12 8V4H8"/><rect x="2" y="8" width="20" height="12" rx="2"/><circle cx="8" cy="14" r="2"/><circle cx="16" cy="14" r="2"/></I>;
const KeyIcon = (p) => <I {...p}><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></I>;
const GlobeIcon = (p) => <I {...p}><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></I>;
const SlidersIcon = (p) => <I {...p}><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="10" r="2"/><circle cx="20" cy="14" r="2"/></I>;
const CodeIcon = (p) => <I {...p}><polyline points="16,18 22,12 16,6"/><polyline points="8,6 2,12 8,18"/></I>;
const RssIcon = (p) => <I {...p}><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></I>;
const PlayIcon = (p) => <I {...p}><polygon points="5,3 19,12 5,21"/></I>;
const LayersIcon = (p) => <I {...p}><polygon points="12,2 2,7 12,12 22,7"/><polyline points="2,17 12,22 22,17"/><polyline points="2,12 12,17 22,12"/></I>;
const Share2Icon = (p) => <I {...p}><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98"/><path d="m15.41 6.51-6.82 3.98"/></I>;
const PlugIcon = (p) => <I {...p}><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a6 6 0 0 1-12 0V8z"/></I>;
const ArrowRightIcon = (p) => <I {...p}><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12,5 19,12 12,19"/></I>;
const RefreshIcon = (p) => <I {...p}><polyline points="23,4 23,10 17,10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></I>;
const AlertIcon = (p) => <I {...p}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></I>;
const DownloadIcon = (p) => <I {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></I>;
const FolderIcon = (p) => <I {...p}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></I>;
const LinkIcon = (p) => <I {...p}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></I>;
const EyeIcon = (p) => <I {...p}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></I>;
const TagIcon = (p) => <I {...p}><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></I>;
const ZapIcon = (p) => <I {...p}><polygon points="13,2 3,14 12,14 11,22 21,10 12,10"/></I>;
const FilterIcon = (p) => <I {...p}><polygon points="22,3 2,3 10,12.46 10,19 14,21 14,12.46"/></I>;

/* ═══════════════════════════════════════════════════════════════ */
/*  SHARED UI                                                      */
/* ═══════════════════════════════════════════════════════════════ */
const Badge = ({ label, color = "bg-gray-100 text-gray-600" }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${color}`}>{label}</span>
);

const stageTranslationKey = (stage) => ({
  All: "all",
  Detected: "detected",
  Researching: "researching",
  Contacted: "contacted",
  Replied: "replied",
  "In Conversation": "inConversation",
  Won: "won",
  Customer: "customer",
  Lost: "lost",
}[stage] || String(stage || "").toLowerCase());

const StageBadge = ({ stage }) => {
  const { t } = useI18n();
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const lightMap = {
    "Detected":       "bg-blue-100 text-blue-700",
    "Researching":    "bg-cyan-100 text-cyan-700",
    "Contacted":      "bg-indigo-100 text-indigo-700",
    "Replied":        "bg-amber-100 text-amber-700",
    "In Conversation":"bg-purple-100 text-purple-700",
    "Won":            "bg-green-100 text-green-700",
    "Lost":           "bg-red-100 text-red-700",
    "Customer":       "bg-emerald-100 text-emerald-700",
  };
  const darkMap = {
    "Detected":       "bg-blue-500/10 text-blue-200 border border-blue-400/20",
    "Researching":    "bg-cyan-500/10 text-cyan-200 border border-cyan-400/20",
    "Contacted":      "bg-indigo-500/10 text-indigo-200 border border-indigo-400/20",
    "Replied":        "bg-amber-500/10 text-amber-200 border border-amber-400/20",
    "In Conversation":"bg-purple-500/10 text-purple-200 border border-purple-400/20",
    "Won":            "bg-green-500/10 text-green-200 border border-green-400/20",
    "Lost":           "bg-red-500/10 text-red-200 border border-red-400/20",
    "Customer":       "bg-emerald-500/10 text-emerald-200 border border-emerald-400/20",
  };
  const map = isDark ? darkMap : lightMap;
  return <Badge label={t(`opportunitiesPage.stages.${stageTranslationKey(stage)}`)} color={map[stage] || (isDark ? "bg-slate-900 text-slate-300 border border-white/10" : "bg-gray-100 text-gray-600")} />;
};

const Btn = ({ variant = "primary", children, icon, className = "", small, ...p }) => {
  const v = {
    primary: "bg-indigo-600 text-white hover:bg-indigo-700",
    secondary: "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50",
    teal: "bg-teal-500 text-white hover:bg-teal-600",
    ghost: "text-gray-500 hover:bg-gray-100",
    destructive: "bg-red-600 text-white hover:bg-red-700",
  };
  return (
    <button className={`inline-flex items-center gap-1.5 font-medium rounded-lg transition-colors text-xs ${small ? "px-2.5 py-1.5" : "px-3.5 py-2"} ${v[variant] || v.primary} ${className}`} {...p}>
      {icon}{children}
    </button>
  );
};

const Card = ({ children, className = "" }) => (
  <div className={`bg-white rounded-2xl border border-gray-100 shadow-sm ${className}`}>{children}</div>
);

const Section = ({ title, IconComp, desc, badge, children }) => (
  <Card className="p-5">
    <div className="flex items-center justify-between mb-4 pb-3 border-b border-gray-100">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center"><IconComp size={14} className="text-indigo-600" /></div>
        <div>
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          {desc && <p className="text-xs text-gray-400">{desc}</p>}
        </div>
      </div>
      {badge}
    </div>
    {children}
  </Card>
);

const Tag = ({ label }) => (
  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-medium">
    {label}<button className="hover:text-indigo-900"><XIcon size={9} /></button>
  </span>
);

const TagInput = ({ tags, placeholder }) => (
  <div className="flex flex-wrap gap-1.5 p-2 border border-gray-300 rounded-lg bg-white min-h-[32px]">
    {tags.map(t => <Tag key={t} label={t} />)}
    <input type="text" placeholder={tags.length === 0 ? placeholder : ""} className="flex-1 min-w-[80px] outline-none text-xs bg-transparent placeholder-gray-400" />
  </div>
);

const KpiCard = ({ icon: Ic, label, value, sub, color, onClick, ariaLabel, title, detail, actions }) => {
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const iconClass = isDark
    ? `${color.replace(/\bbg-\S+/g, "bg-[#0F172A]")} border border-white/10`
    : color;
  const content = (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${iconClass}`}><Ic size={18} /></div>
          <div>
            <p className="text-xs text-gray-500">{label}</p>
            <p className="text-lg font-bold text-gray-900">{value}</p>
            {sub && <p className="text-xs text-gray-400">{sub}</p>}
            {detail && (
              <div style={{ fontSize: '0.8em', color: '#94A3B8', marginTop: 4 }}>
                {detail}
              </div>
            )}
          </div>
        </div>
        {actions}
      </div>
    </div>
  );

  if (onClick) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") onClick(event);
        }}
        aria-label={ariaLabel || `Open ${label}`}
        title={title || `Open ${label}`}
        className="w-full text-left bg-white rounded-2xl border border-gray-100 shadow-sm p-4 cursor-pointer transition-all hover:bg-[#F8FAFC] hover:border-indigo-200 hover:shadow-md active:scale-[0.99] focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
      >
        {content}
      </div>
    );
  }

  return <Card className="p-4">{content}</Card>;
};

const QuickMetric = ({ label, value }) => (
  <div className="rounded-lg bg-gray-50 px-3 py-2">
    <p className="text-[11px] font-medium text-gray-500 leading-tight">{label}</p>
    <p className="mt-1 text-base font-bold text-gray-900">{value}</p>
  </div>
);

const QuickActionCard = ({ icon: Ic, title, description, badges, metrics, buttonLabel, onClick, ariaLabel, accent = "indigo" }) => {
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const accentClasses = accent === "teal"
    ? {
      icon: isDark ? "bg-slate-900 text-teal-200 border border-white/10" : "bg-teal-50 text-teal-600",
      button: "bg-teal-500 text-white hover:bg-teal-600",
      ring: "hover:border-teal-200 focus:ring-teal-500/25",
    }
    : {
      icon: isDark ? "bg-slate-900 text-indigo-200 border border-white/10" : "bg-indigo-50 text-indigo-600",
      button: "bg-indigo-600 text-white hover:bg-indigo-700",
      ring: "hover:border-indigo-200 focus:ring-indigo-500/25",
    };
  const badgeColor = isDark
    ? "bg-slate-900 text-slate-300 border border-white/10"
    : "bg-gray-100 text-gray-600";

  const handleKeyDown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      aria-label={ariaLabel || title}
      title={title}
      className={`group bg-white rounded-2xl border border-gray-100 shadow-sm p-5 cursor-pointer transition-all hover:shadow-md active:scale-[0.995] focus:outline-none focus:ring-2 ${accentClasses.ring}`}
    >
      <div className="flex items-start gap-4">
        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 ${accentClasses.icon}`}>
          <Ic size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-gray-900">{title}</h2>
              <p className="mt-1 text-xs leading-5 text-gray-500">{description}</p>
            </div>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onClick();
              }}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${accentClasses.button}`}
            >
              <PlusIcon size={13} />
              {buttonLabel}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {badges.map((badge) => (
              <Badge key={badge} label={badge} color={badgeColor} />
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {metrics.map((metric) => (
              <QuickMetric key={metric.label} label={metric.label} value={metric.value} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const Input = ({ className = "", ...p }) => (
  <input className={`w-full border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 ${className}`} {...p} />
);
const Select = ({ children, ...p }) => <select className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500" {...p}>{children}</select>;
const Field = ({ label, hint, children }) => (
  <div className="mb-[18px]">
    <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
    {hint && <p className="text-xs text-gray-400 mb-1">{hint}</p>}
    {children}
  </div>
);

const TOAST_LIMIT = 3;
const TOAST_DURATION = {
  error: 8000,
  default: 5000,
};

function normalizeToast(toast) {
  if (!toast) return null;
  const base = typeof toast === "string" ? { message: toast } : toast;
  const type = base.type || "success";
  return {
    id: base.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    message: base.message || String(base),
    duration: base.duration || (type === "error" ? TOAST_DURATION.error : TOAST_DURATION.default),
  };
}

function useToastQueue() {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef(new Map());

  const clearTimer = (id) => {
    const timer = timersRef.current.get(id);
    if (timer?.timeoutId) clearTimeout(timer.timeoutId);
    timersRef.current.delete(id);
  };

  const removeToast = (id) => {
    clearTimer(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  };

  const scheduleToast = (toast, duration = toast.duration) => {
    clearTimer(toast.id);
    const startedAt = Date.now();
    const timeoutId = setTimeout(() => removeToast(toast.id), duration);
    timersRef.current.set(toast.id, { timeoutId, startedAt, remaining: duration });
  };

  const setToast = (toast) => {
    if (!toast) {
      timersRef.current.forEach((timer) => {
        if (timer?.timeoutId) clearTimeout(timer.timeoutId);
      });
      timersRef.current.clear();
      setToasts([]);
      return;
    }
    const normalized = normalizeToast(toast);
    if (!normalized) return;
    setToasts((current) => {
      const next = [...current, normalized];
      const overflow = next.slice(0, Math.max(0, next.length - TOAST_LIMIT));
      overflow.forEach((oldToast) => clearTimer(oldToast.id));
      return next.slice(-TOAST_LIMIT);
    });
    scheduleToast(normalized);
  };

  const pauseToast = (id) => {
    const timer = timersRef.current.get(id);
    if (!timer) return;
    clearTimeout(timer.timeoutId);
    timersRef.current.set(id, {
      ...timer,
      timeoutId: null,
      remaining: Math.max(0, timer.remaining - (Date.now() - timer.startedAt)),
    });
  };

  const resumeToast = (id) => {
    const timer = timersRef.current.get(id);
    const toast = toasts.find((item) => item.id === id);
    if (!timer || !toast || timer.timeoutId) return;
    scheduleToast(toast, timer.remaining || toast.duration);
  };

  useEffect(() => () => {
    timersRef.current.forEach((timer) => {
      if (timer?.timeoutId) clearTimeout(timer.timeoutId);
    });
    timersRef.current.clear();
  }, []);

  return { toasts, setToast, removeToast, pauseToast, resumeToast };
}

function ToastStack({ toasts, onClose, onMouseEnter, onMouseLeave }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed right-6 top-6 z-[80] space-y-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          onMouseEnter={() => onMouseEnter(toast.id)}
          onMouseLeave={() => onMouseLeave(toast.id)}
          className={`rounded-xl border bg-white px-4 py-3 shadow-lg text-xs text-gray-700 flex items-center gap-2 ${
            toast.type === "error" ? "border-red-100" : toast.type === "warning" ? "border-amber-100" : "border-green-100"
          }`}
        >
          {toast.type === "error"
            ? <XIcon size={14} className="text-red-600" />
            : toast.type === "warning"
            ? <AlertIcon size={14} className="text-amber-500" />
            : <CheckIcon size={14} className="text-green-600" />}
          {toast.message}
          <button onClick={() => onClose(toast.id)} className="ml-2 text-gray-400 hover:text-gray-600"><XIcon size={12} /></button>
        </div>
      ))}
    </div>
  );
}

function ProgressModal({ title, subtitle = "Estimated time: 10 - 15 seconds", completeLabel = "complete", retryLabel = "Retry", cancelLabel = "Cancel", steps, state, onCancel, onRetry }) {
  if (!state) return null;
  const progress = Math.max(0, Math.min(100, Number(state.progress || 0)));
  const failed = Boolean(state.error);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-slate-900/55 backdrop-blur-sm" />
      <div className="relative w-full max-w-md mx-4 rounded-2xl bg-white shadow-2xl border border-gray-100 overflow-hidden">
        <div className="p-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          <p className="text-xs text-gray-400 mt-1">{subtitle}</p>
        </div>
        <div className="p-5 space-y-3">
          {steps.map((step, index) => {
            const done = state.completedSteps?.includes(index);
            const active = state.activeStep === index && !done && !failed;
            return (
              <div key={step} className="flex items-center gap-3">
                <span className={`flex h-5 w-5 items-center justify-center rounded-full border text-xs ${
                  done
                    ? "border-green-200 bg-green-50 text-green-600"
                    : active
                    ? "border-indigo-200 bg-indigo-50 text-indigo-600"
                    : failed && state.activeStep === index
                    ? "border-red-200 bg-red-50 text-red-600"
                    : "border-gray-200 text-gray-400"
                }`}>
                  {done ? <CheckIcon size={11} /> : active ? <RefreshIcon size={11} className="animate-spin" /> : index + 1}
                </span>
                <span className={`text-xs flex-1 ${done ? "text-gray-700" : active ? "text-indigo-700 font-medium" : "text-gray-400"}`}>
                  {step}
                </span>
                {done && <CheckIcon size={13} className="text-green-500" />}
              </div>
            );
          })}
          <div className="pt-2">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>{progress}% {completeLabel}</span>
              {failed && <span className="text-red-600">{state.error}</span>}
            </div>
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${failed ? "bg-red-500" : "bg-indigo-600"}`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 p-4 bg-gray-50 border-t border-gray-100">
          {failed && <Btn variant="secondary" small onClick={onRetry}>{retryLabel}</Btn>}
          <Btn variant="ghost" small onClick={onCancel}>{cancelLabel}</Btn>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  PAGE: UNIFIED DASHBOARD                                        */
/* ═══════════════════════════════════════════════════════════════ */
const DEMO_OPPORTUNITIES = [
  { company: "FinServe Global", job: "Data Entry Specialist", contact: "Sarah Chen", role: "VP Operations", stage: "Replied", score: 92, source: "JSearch", kw: ["data entry","back office"], content: "BPO Guide for Finance", date: "Apr 15" },
  { company: "MedTech Inc", job: "Customer Support Lead", contact: "James Wilson", role: "Head of HR", stage: "Contacted", score: 87, source: "Indeed", kw: ["customer support"], content: "Support Excellence", date: "Apr 15" },
  { company: "RetailMax", job: "Accounts Payable Clerk", contact: "Ana Ruiz", role: "Procurement Mgr", stage: "Detected", score: 78, source: "JSearch", kw: ["accounting","BPO"], content: "-", date: "Apr 14" },
  { company: "LogiCorp", job: "Back Office Manager", contact: "Mike Ross", role: "COO", stage: "Won", score: 95, source: "RSS", kw: ["back office","outsourcing"], content: "Outsourcing Playbook", date: "Apr 12" },
  { company: "StartupXYZ", job: "Virtual Assistant", contact: "Lisa Park", role: "Founder", stage: "In Conversation", score: 65, source: "Scraper", kw: ["outsourcing"], content: "Follow-up Template", date: "Apr 10" },
  { company: "DataFlow Inc", job: "Data Analyst", contact: "Tom Brown", role: "VP Data", stage: "Customer", score: 88, source: "JSearch", kw: ["data entry"], content: "Data Entry Services", date: "Mar 28" },
];

const DEMO_REVIEW_EMAILS = [
  { to: "Sarah Chen", role: "VP Operations", company: "FinServe Global", vacancy: "Data Entry Specialist", score: 92, contentRef: "BPO Guide for Finance", subject: "Optimize your data entry with NoonDalton", preview: "Dear Sarah,\n\nI noticed that FinServe Global is looking for a Data Entry Specialist. At NoonDalton, we help financial services companies scale their back-office operations with dedicated teams.\n\nDrawing from our experience documented in our BPO Guide for Finance, we've helped similar organizations reduce operational costs by up to 40%.\n\nWould you have 15 minutes this week for a brief call?" },
  { to: "James Wilson", role: "Head of HR", company: "MedTech Inc", vacancy: "Customer Support Lead", score: 74, contentRef: "Support Excellence", subject: "Specialized Customer Support for MedTech", preview: "Dear James,\n\nI saw that MedTech Inc is looking for a Customer Support Lead. At NoonDalton, we have extensive experience providing specialized customer support teams for the healthcare sector.\n\nOur whitepaper on Customer Support Excellence outlines the frameworks we use with healthcare clients.\n\nCould we schedule a 20-minute demo?" },
  { to: "Ana Ruiz", role: "Procurement Mgr", company: "RetailMax", vacancy: "Accounts Payable Clerk", score: 68, contentRef: "Data Entry Services", subject: "Accounts Payable as a Service for RetailMax", preview: "Dear Ana,\n\nI noticed the AP Clerk opening at RetailMax. NoonDalton offers comprehensive accounts payable services that could reduce your operational costs by up to 40%.\n\nOur Data Entry Services proposal for the retail sector details our approach." },
];

const DEMO_OUTREACH_HISTORY = [
  { name: "Sarah Chen", co: "FinServe Global", subj: "Optimize your data entry...", st: "Replied", stc: "bg-green-100 text-green-700", date: "Apr 15", score: "92%", content: "BPO Guide" },
  { name: "Mike Ross", co: "LogiCorp", subj: "Back office outsourcing...", st: "Opened", stc: "bg-blue-100 text-blue-700", date: "Apr 15", score: "95%", content: "Outsourcing Playbook" },
  { name: "Lisa Park", co: "DataFlow", subj: "Professional data entry...", st: "Sent", stc: "bg-gray-100 text-gray-600", date: "Apr 14", score: "88%", content: "Data Entry Services" },
  { name: "Tom Brown", co: "HealthCo", subj: "BPO customer support...", st: "Opened", stc: "bg-blue-100 text-blue-700", date: "Apr 14", score: "81%", content: "Support Excellence" },
  { name: "Ana Ruiz", co: "RetailMax", subj: "AP as a service...", st: "Bounced", stc: "bg-red-100 text-red-700", date: "Apr 13", score: "68%", content: "Data Entry Services" },
];

const DEMO_CONTENT_ITEMS = [
  { id: "mock-case-study-finance-guide", title: "BPO Guide for Finance", type: "Case Study", industry: "Finance", services: ["data entry","back office"], status: "Published", uses: 23, date: "Apr 15" },
  { id: "mock-proposal-fintech-bpo", title: "BPO Proposal for Fintech", type: "Proposal", industry: "Finance", services: ["BPO"], status: "Sent", uses: 8, date: "Apr 14" },
  { id: "mock-template-follow-up-email", title: "Follow-up Email", type: "Template", industry: "General", services: ["outreach"], status: "Active", uses: 45, date: "Apr 14" },
  { id: "mock-whitepaper-support-excellence", title: "Customer Support Excellence", type: "Whitepaper", industry: "Healthcare", services: ["customer support"], status: "Published", uses: 12, date: "Apr 12" },
  { id: "mock-case-study-outsourcing-playbook", title: "Outsourcing Playbook 2026", type: "Case Study", industry: "General", services: ["outsourcing","BPO"], status: "Draft", uses: 0, date: "Apr 10" },
  { id: "mock-template-cold-outreach", title: "Cold Outreach - Data Entry", type: "Template", industry: "General", services: ["data entry"], status: "Active", uses: 31, date: "Apr 8" },
  { id: "mock-social-posts-q2", title: "LinkedIn Posts: Q2", type: "Social Post", industry: "General", services: ["brand"], status: "Generating...", uses: 0, date: "Apr 8" },
  { id: "mock-one-pager-finance-bpo", title: "BPO One-Pager for Finance", type: "One-Pager", industry: "Finance", services: ["sales enablement"], status: "Generated", uses: 6, date: "Apr 7" },
  { id: "mock-proposal-data-entry-services", title: "Data Entry Services", type: "Proposal", industry: "Retail", services: ["data entry","accounting"], status: "Accepted", uses: 18, date: "Apr 5" },
];

const asArray = (value) => Array.isArray(value)
  ? value
  : Array.isArray(value?.items)
  ? value.items
  : Array.isArray(value?.data)
  ? value.data
  : [];

const OPPORTUNITY_STAGES = ["All","Detected","Researching","Contacted","Replied","In Conversation","Won","Customer","Lost"];
const normalizeStageName = (stage = "") => String(stage || "").trim().toLowerCase().replace(/[_-]+/g, " ");
const stageMatches = (item, stage) => normalizeStageName(item?.stage || item?.status) === normalizeStageName(stage);
const hasEnrichedOpportunityContact = (item = {}) => Boolean(item.contact || item.contactName || item.contact_name || item.contactEmail || item.contact_email);
const getOpportunityStageCounts = (opportunities = []) => OPPORTUNITY_STAGES.reduce((counts, stage) => ({
  ...counts,
  [stage]: stage === "All" ? opportunities.length : opportunities.filter((item) => stageMatches(item, stage)).length,
}), {});
const selectOpportunityMetrics = (opportunities = []) => {
  const stageCounts = getOpportunityStageCounts(opportunities);
  return {
    stageCounts,
    detected: stageCounts.Detected || 0,
    researched: opportunities.filter(hasEnrichedOpportunityContact).length,
    contacted: stageCounts.Contacted || 0,
    replied: stageCounts.Replied || 0,
    won: stageCounts.Won || 0,
  };
};
const validContentRef = (value) => value && !["-", "—", "â€”"].includes(String(value).trim());
const percentWidth = (value, total) => {
  const numericValue = Number(value) || 0;
  const numericTotal = Number(total) || 0;
  if (numericValue <= 0 || numericTotal <= 0) return "0%";
  return `${Math.max(2, Math.min(100, Math.round((numericValue / numericTotal) * 100)))}%`;
};
const formatUpdatedTime = (date = new Date()) => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const normalizeOpportunityKeywords = (value) => {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
};
const normalizeOpportunity = (item = {}) => ({
  ...item,
  kw: normalizeOpportunityKeywords(item.kw || item.keywords || item.tags),
});
const exportOpportunitiesWorkbook = (opportunities = []) => {
  const headers = ["Company", "Job", "Contact", "Role", "Stage", "Score", "Source", "Keywords", "Content", "Date"];
  const rows = opportunities.map((o) => [
    o.company || "",
    o.job || "",
    o.contact || "",
    o.role || "",
    o.stage || "",
    Number.isFinite(Number(o.score)) ? Number(o.score) : "",
    o.source || "",
    normalizeOpportunityKeywords(o.kw).join(", "),
    o.content || "",
    o.date || "",
  ]);
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const range = XLSX.utils.decode_range(worksheet["!ref"]);
  const headerStyle = {
    fill: { fgColor: { rgb: "1A2B4A" } },
    font: { color: { rgb: "FFFFFF" }, bold: true },
    alignment: { horizontal: "center", vertical: "center" },
    border: {
      top: { style: "thin", color: { rgb: "D9E2EF" } },
      bottom: { style: "thin", color: { rgb: "D9E2EF" } },
      left: { style: "thin", color: { rgb: "D9E2EF" } },
      right: { style: "thin", color: { rgb: "D9E2EF" } },
    },
  };
  const cellBorder = {
    top: { style: "thin", color: { rgb: "D9E2EF" } },
    bottom: { style: "thin", color: { rgb: "D9E2EF" } },
    left: { style: "thin", color: { rgb: "D9E2EF" } },
    right: { style: "thin", color: { rgb: "D9E2EF" } },
  };

  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: col });
      if (!worksheet[address]) continue;
      worksheet[address].s = row === 0
        ? headerStyle
        : {
          border: cellBorder,
          alignment: { vertical: "top", wrapText: true },
          ...(row % 2 === 0 ? { fill: { fgColor: { rgb: "F8FAFC" } } } : {}),
        };
      if (col === 5 && row > 0 && worksheet[address].v !== "") {
        worksheet[address].t = "n";
        worksheet[address].z = "0";
      }
    }
  }

  worksheet["!cols"] = [
    { wch: 24 },
    { wch: 30 },
    { wch: 22 },
    { wch: 22 },
    { wch: 18 },
    { wch: 10 },
    { wch: 16 },
    { wch: 30 },
    { wch: 34 },
    { wch: 14 },
  ];
  worksheet["!rows"] = [{ hpt: 24 }];
  worksheet["!autofilter"] = { ref: worksheet["!ref"] };

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Opportunities");
  XLSX.writeFile(workbook, "opportunities_export.xlsx", { compression: true });
};

const DASHBOARD_SNAPSHOT_KEY = "marketgen_dashboard_snapshot";

const createEmptyDashboardState = () => ({
  metrics: {
    detected: 0,
    researched: 0,
    contacted: 0,
    pendingReview: 0,
    replied: 0,
    won: 0,
    proposals: 0,
    contentUsed: 0,
    totalProposalValue: 0,
  },
  sourceLabel: "local",
  opportunities: [],
  reviewEmails: [],
  outreachHistory: [],
  contentUsed: [],
  quickActions: {
    proposal: {
      created: 0,
      approved: 0,
      sent: 0,
      won: 0,
    },
    campaign: {
      saved: 0,
      active: 0,
      posts: 0,
      emailsSent: 0,
      replies: 0,
    },
  },
  funnel: {
    scanned: 0,
    relevant: [],
    contactsEnriched: 0,
    contentMatched: 0,
    emailsSent: 0,
    repliesReceived: 0,
    dealsWon: 0,
  },
  pipelineActivity: [],
  lastUpdated: "",
});

function isValidDashboardSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (!snapshot.metrics || typeof snapshot.metrics !== "object") return false;
  if (!snapshot.funnel || typeof snapshot.funnel !== "object") return false;
  if (!Array.isArray(snapshot.contentUsed)) return false;
  return ["detected", "researched", "contacted", "pendingReview", "replied", "won"].every((key) => Number.isFinite(Number(snapshot.metrics[key])));
}

function hasPipelineSignals(state) {
  if (!state || typeof state !== "object") return false;
  const kpiTotal = ["detected", "researched", "contacted", "pendingReview", "replied", "won"]
    .reduce((sum, key) => sum + (Number(state.metrics?.[key]) || 0), 0);
  const funnelTotal = ["scanned", "contactsEnriched", "contentMatched", "emailsSent", "repliesReceived", "dealsWon"]
    .reduce((sum, key) => sum + (Number(state.funnel?.[key]) || 0), 0);
  const relevantTotal = Array.isArray(state.funnel?.relevant)
    ? state.funnel.relevant.length
    : Number(state.funnel?.relevant) || 0;
  return kpiTotal + funnelTotal + relevantTotal > 0;
}

function hasFunnelSignals(state) {
  if (!state || typeof state !== "object") return false;
  const funnelTotal = ["scanned", "contactsEnriched", "contentMatched", "emailsSent", "repliesReceived", "dealsWon"]
    .reduce((sum, key) => sum + (Number(state.funnel?.[key]) || 0), 0);
  const relevantTotal = Array.isArray(state.funnel?.relevant)
    ? state.funnel.relevant.length
    : Number(state.funnel?.relevant) || 0;
  return funnelTotal + relevantTotal > 0;
}

function buildLocalPipelineFallbackSnapshot(snapshot = createEmptyDashboardState()) {
  const opportunities = DEMO_OPPORTUNITIES;
  const reviewEmails = DEMO_REVIEW_EMAILS;
  const outreachHistory = DEMO_OUTREACH_HISTORY;
  const opportunityMetrics = selectOpportunityMetrics(opportunities);
  const relevant = opportunities.filter((item) => Number(item.score || 0) >= 60);
  const emailsSent = outreachHistory.filter((item) => ["sent", "opened", "replied"].includes(normalizeStageName(item.st || item.status))).length;
  const contentMatched = Math.max(Number(snapshot.funnel?.contentMatched || 0), (snapshot.contentUsed || []).length);

  return {
    ...snapshot,
    sourceLabel: "local",
    opportunities,
    reviewEmails,
    outreachHistory,
    metrics: {
      ...snapshot.metrics,
      detected: opportunityMetrics.detected,
      researched: opportunityMetrics.researched,
      contacted: opportunityMetrics.contacted,
      pendingReview: reviewEmails.length,
      replied: opportunityMetrics.replied,
      won: opportunityMetrics.won,
    },
    funnel: {
      ...snapshot.funnel,
      scanned: opportunities.length,
      relevant,
      contactsEnriched: opportunityMetrics.researched,
      contentMatched,
      emailsSent,
      repliesReceived: opportunityMetrics.replied,
      dealsWon: opportunityMetrics.won,
    },
    pipelineActivity: [
      opportunities.length,
      relevant.length,
      opportunityMetrics.researched,
      contentMatched,
      emailsSent,
      opportunityMetrics.replied,
      opportunityMetrics.won,
    ],
  };
}

function normalizeDashboardSnapshotForDisplay(snapshot) {
  if (!isValidDashboardSnapshot(snapshot)) return null;
  const hydrated = { ...createEmptyDashboardState(), ...snapshot };
  if (hydrated.sourceLabel === "demo") return null;
  return hydrated;
}

function loadDashboardSnapshot() {
  try {
    const snapshot = JSON.parse(localStorage.getItem(DASHBOARD_SNAPSHOT_KEY) || "null");
    const normalized = normalizeDashboardSnapshotForDisplay(snapshot);
    return normalized ? { ...normalized, sourceLabel: "cached" } : null;
  } catch {
    return null;
  }
}

function saveDashboardSnapshot(snapshot) {
  if (!isValidDashboardSnapshot(snapshot)) return;
  localStorage.setItem(DASHBOARD_SNAPSHOT_KEY, JSON.stringify({
    ...snapshot,
    savedAt: new Date().toISOString(),
  }));
}

function hasAnyDashboardMetric(state) {
  if (!isValidDashboardSnapshot(state)) return false;
  return hasMeaningfulDashboardData(state);
}

function hasMeaningfulDashboardData(state) {
  if (!state || typeof state !== "object") return false;
  const metricTotal = Object.values(state.metrics || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const funnelTotal = Object.entries(state.funnel || {}).reduce((sum, [key, value]) => {
    if (key === "relevant") return sum + (Array.isArray(value) ? value.length : Number(value) || 0);
    return sum + (Number(value) || 0);
  }, 0);
  const activityTotal = (state.pipelineActivity || []).reduce((sum, value) => sum + (Number(value) || 0), 0);
  return metricTotal > 0 || funnelTotal > 0 || activityTotal > 0 || (state.contentUsed || []).length > 0;
}

const dashboardSourceLabel = (sourceLabel) => ({
  backend: "Based on backend data",
  local: "Based on local data",
  cached: "Based on cached data",
  demo: "Demo data",
}[sourceLabel] || sourceLabel || "Based on local data");

const dashboardSourceColor = (sourceLabel) => ({
  backend: "bg-green-100 text-green-700",
  local: "bg-blue-100 text-blue-700",
  cached: "bg-slate-100 text-slate-700",
  demo: "bg-amber-100 text-amber-700",
}[sourceLabel] || "bg-gray-100 text-gray-600");
async function fetchOptional(endpoint, fallback = null) {
  try {
    const { data } = await api.get(endpoint, { suppressPermissionToast: true });
    return data;
  } catch {
    return fallback;
  }
}

async function buildDashboardMetricsFromSources({ allowDemo = false } = {}) {
  const [apiDashboard, backendProposalsRaw, backendCampaignsRaw, contentLibrary, backendOpportunitiesRaw, outreachRaw, reviewQueueRaw] = await Promise.all([
    getDashboardData().catch(() => null),
    getProposals().catch(() => []),
    campaignsApi.list().then(({ data }) => data).catch(() => null),
    fetchOptional("/content-library", null),
    fetchOptional("/opportunities", null),
    fetchOptional("/outreach", null),
    fetchOptional("/outreach/review-queue", null),
  ]);

  const localProposals = readLocalContentProposals();
  const localCampaigns = readLocalCampaigns();
  const backendCampaigns = asArray(backendCampaignsRaw);
  const backendCampaignIds = new Set(backendCampaigns.map((campaign) => campaign.id));
  const campaigns = [
    ...backendCampaigns,
    ...localCampaigns.filter((campaign) => !backendCampaignIds.has(campaign.id)),
  ];
  const backendProposals = asArray(backendProposalsRaw);
  const proposals = [...localProposals, ...backendProposals];
  const backendOpportunities = asArray(backendOpportunitiesRaw);
  const libraryAssets = [...asArray(contentLibrary?.assets), ...asArray(contentLibrary?.templates), ...asArray(contentLibrary?.proposals)];
  const backendReviewEmails = asArray(reviewQueueRaw).length ? asArray(reviewQueueRaw) : asArray(outreachRaw?.reviewQueue);
  const backendOutreachHistory = asArray(outreachRaw?.history).length ? asArray(outreachRaw.history) : asArray(outreachRaw);
  const apiMetrics = {
    detected: Number(apiDashboard?.detected || 0),
    researched: Number(apiDashboard?.researched || 0),
    contacted: Number(apiDashboard?.contacted || 0),
    pendingReview: Number(apiDashboard?.pendingReview || apiDashboard?.pending_review || 0),
    replied: Number(apiDashboard?.replied || 0),
    won: Number(apiDashboard?.won || 0),
  };
  const apiFunnel = {
    scanned: Number(apiDashboard?.jobsScanned ?? apiDashboard?.scanned ?? 0),
    relevant: Number(apiDashboard?.relevantOpportunities ?? apiDashboard?.relevant ?? 0),
    contactsEnriched: Number(apiDashboard?.contactsEnriched ?? apiDashboard?.contacts_enriched ?? 0),
    contentMatched: Number(apiDashboard?.contentMatched ?? apiDashboard?.content_matched ?? 0),
    emailsSent: Number(apiDashboard?.emailsSent ?? apiDashboard?.emails_sent ?? 0),
    repliesReceived: Number(apiDashboard?.repliesReceived ?? apiDashboard?.replies_received ?? 0),
    dealsWon: Number(apiDashboard?.dealsWon ?? apiDashboard?.deals_won ?? 0),
  };
  const backendDashboardHasData = hasMeaningfulDashboardData({
    metrics: apiMetrics,
    funnel: apiFunnel,
    contentUsed: asArray(apiDashboard?.contentUsed || apiDashboard?.content_used),
    pipelineActivity: asArray(apiDashboard?.pipelineActivity || apiDashboard?.pipeline_activity),
  });
  const hasBackendPipelineSource = backendDashboardHasData
    || backendOpportunities.length > 0
    || backendReviewEmails.length > 0
    || backendOutreachHistory.length > 0;
  const hasContentSource = localProposals.length > 0 || backendProposals.length > 0 || libraryAssets.length > 0 || campaigns.length > 0;
  const hasLocalSource = localProposals.length > 0 || localCampaigns.length > 0;
  const hasSources = hasContentSource || hasBackendPipelineSource;

  if (!hasSources && !allowDemo) return null;

  const useDemo = allowDemo && !hasSources;
  const opportunities = backendOpportunities.length ? backendOpportunities : useDemo ? DEMO_OPPORTUNITIES : [];
  const reviewEmails = backendReviewEmails.length ? backendReviewEmails : useDemo ? DEMO_REVIEW_EMAILS : [];
  const outreachHistory = backendOutreachHistory.length ? backendOutreachHistory : useDemo ? DEMO_OUTREACH_HISTORY : [];
  const contentItems = [
    ...libraryAssets.map((item) => ({
      ...item,
      title: item.title || item.name || "Untitled asset",
      type: item.type === "social_post" ? "Social Post" : item.type || (item.variables ? "Template" : "Asset"),
      uses: item.uses ?? item.usageCount ?? 0,
    })),
    ...proposals.map((proposal) => ({
      ...proposal,
      title: proposal.title || proposal.name || "AI Generated Proposal",
      type: "Proposal",
      uses: proposal.uses ?? proposal.usageCount ?? 0,
    })),
  ];
  const activeContentItems = contentItems.length ? contentItems : useDemo ? DEMO_CONTENT_ITEMS : [];
  const totalProposalValue = proposals.reduce((sum, proposal) => sum + (calculateProposalTotal(proposal).totalAmount || 0), 0);
  const contentRefs = [
    ...opportunities.map((item) => item.content || item.contentUsed || item.contentRef),
    ...reviewEmails.map((item) => item.contentRef || item.content),
    ...outreachHistory.map((item) => item.content || item.contentRef),
  ].filter(validContentRef);
  const contentUsed = activeContentItems
    .map((item) => ({
      ...item,
      uses: Number(item.uses || 0) + contentRefs.filter((ref) => String(ref).toLowerCase().includes(String(item.title || "").toLowerCase().slice(0, 10))).length,
    }))
    .sort((a, b) => Number(b.uses || 0) - Number(a.uses || 0))
    .slice(0, 4);

  const opportunityMetrics = selectOpportunityMetrics(opportunities);
  const scanned = Math.max(
    opportunities.length,
    backendDashboardHasData ? apiFunnel.scanned : 0,
    backendDashboardHasData ? apiMetrics.detected : 0,
  );
  const relevant = opportunities.filter((item) => Number(item.score || item.matchScore || 0) >= 60);
  const relevantCount = Math.max(
    relevant.length,
    backendDashboardHasData ? apiFunnel.relevant : 0,
    opportunities.length === 0 && backendDashboardHasData ? apiMetrics.detected : 0,
  );
  const relevantFunnelItems = relevant.length
    ? relevant
    : Array.from({ length: relevantCount }, (_, index) => ({ id: `backend-relevant-${index + 1}` }));
  const contactsEnriched = Math.max(
    opportunityMetrics.researched,
    backendDashboardHasData ? apiFunnel.contactsEnriched : 0,
    backendDashboardHasData ? apiMetrics.researched : 0,
  );
  const matchedContentItems = contentUsed.filter((item) => Number(item.uses || 0) > 0).length;
  const contentMatched = Math.max(
    contentRefs.length,
    matchedContentItems,
    activeContentItems.length,
    backendDashboardHasData ? apiFunnel.contentMatched : 0,
  );
  const emailsSent = Math.max(
    outreachHistory.filter((item) => ["sent", "opened", "replied"].includes(normalizeStageName(item.st || item.status))).length,
    backendDashboardHasData ? apiFunnel.emailsSent : 0,
    backendDashboardHasData ? apiMetrics.contacted : 0,
  );
  const repliedCount = Math.max(
    opportunityMetrics.replied,
    backendDashboardHasData ? apiFunnel.repliesReceived : 0,
    backendDashboardHasData ? apiMetrics.replied : 0,
  );
  const wonCount = Math.max(
    opportunityMetrics.won,
    backendDashboardHasData ? apiFunnel.dealsWon : 0,
    backendDashboardHasData ? apiMetrics.won : 0,
  );
  const metrics = {
    detected: Math.max(opportunityMetrics.detected, backendDashboardHasData ? apiMetrics.detected : 0),
    researched: Math.max(opportunityMetrics.researched, backendDashboardHasData ? apiMetrics.researched : 0),
    contacted: Math.max(opportunityMetrics.contacted, backendDashboardHasData ? apiMetrics.contacted : 0),
    pendingReview: Math.max(reviewEmails.length, backendDashboardHasData ? apiMetrics.pendingReview : 0),
    replied: Math.max(opportunityMetrics.replied, backendDashboardHasData ? apiMetrics.replied : 0),
    won: Math.max(opportunityMetrics.won, backendDashboardHasData ? apiMetrics.won : 0),
    proposals: proposals.length,
    contentUsed: contentUsed.reduce((sum, item) => sum + Number(item.uses || 0), 0),
    totalProposalValue,
  };
  const assets = activeContentItems.filter((item) => item.type !== "Proposal");
  const proposalApproved = proposals.filter((proposal) => ["approved", "accepted"].includes(normalizeStageName(proposal.status || proposal.state))).length;
  const proposalSent = proposals.filter((proposal) => normalizeStageName(proposal.status || proposal.state) === "sent").length;
  const socialPosts = activeContentItems.filter((item) => {
    const type = normalizeStageName(item.type || item.assetType || item.category);
    return type === "social post" || type === "socialpost";
  }).length;
  const activeCampaigns = campaigns.filter((campaign) => normalizeStageName(campaign.status) === "active").length;
  const campaignReplies = Math.max(repliedCount, outreachHistory.filter((item) => normalizeStageName(item.st || item.status) === "replied").length);
  const quickActions = {
    proposal: {
      created: proposals.length,
      approved: proposalApproved,
      sent: proposalSent,
      won: opportunities.filter((item) => ["won", "customer"].includes(normalizeStageName(item.stage || item.status))).length,
    },
    campaign: {
      saved: campaigns.length,
      active: activeCampaigns,
      posts: socialPosts,
      emailsSent,
      replies: campaignReplies,
    },
  };
  console.log("Dashboard sources", {
    opportunities,
    proposals,
    assets,
    outreach: { reviewEmails, outreachHistory },
    campaigns,
  });
  console.log("Dashboard metrics recalculated", metrics);

  return {
    metrics,
    sourceLabel: hasBackendPipelineSource || backendProposals.length > 0 || backendCampaigns.length > 0 || libraryAssets.length > 0 ? "backend" : hasLocalSource ? "local" : "demo",
    opportunities,
    reviewEmails,
    outreachHistory,
    contentUsed,
    quickActions,
    funnel: {
      scanned,
      relevant: relevantFunnelItems,
      contactsEnriched,
      contentMatched,
      emailsSent,
      repliesReceived: repliedCount,
      dealsWon: wonCount,
    },
    pipelineActivity: [
      scanned,
      relevantCount,
      contactsEnriched,
      contentMatched,
      emailsSent,
      repliedCount,
      wonCount,
    ],
    lastUpdated: formatUpdatedTime(),
  };
}

function QuickProposalModal({ onClose, onCreated }) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    title: "",
    customer: "",
    objective: "",
    context: "",
  });

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const saveProposal = (status = "draft") => {
    const now = new Date();
    const title = form.title.trim() || t("dashboard.quickActionCards.proposalDefaultTitle");
    const customer = form.customer.trim() || t("dashboard.quickActionCards.proposalDefaultCustomer");
    const proposal = {
      id: `quick-proposal-${Date.now()}`,
      title,
      name: title,
      type: "Proposal",
      status,
      customerName: customer,
      clientName: customer,
      objective: form.objective,
      description: form.context,
      date: now.toISOString().slice(0, 10),
      updatedAt: now.toISOString(),
      content: proposalDocumentToHtml({
        title,
        customerName: customer,
        executiveSummary: form.context || form.objective || title,
        sections: [
          {
            title: t("dashboard.quickActionCards.proposalObjective"),
            body: form.objective || form.context || title,
          },
        ],
        pricingRows: [],
        totalAmount: 0,
      }),
      structuredContent: {
        title,
        customerName: customer,
        executiveSummary: form.context || form.objective || title,
        sections: [
          {
            title: t("dashboard.quickActionCards.proposalObjective"),
            body: form.objective || form.context || title,
          },
        ],
      },
      pricingRows: [],
      totalAmount: 0,
    };
    saveLocalContentProposal(proposal);
    onCreated(t("dashboard.quickActionCards.proposalDraftCreated"));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 p-5">
          <div>
            <p className="text-sm font-semibold text-gray-900">{t("dashboard.quickActionCards.proposalModalTitle")}</p>
            <p className="text-xs text-gray-500">{t("dashboard.quickActionCards.proposalModalSubtitle")}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600" aria-label={t("common.close")}>
            <XIcon size={16} />
          </button>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label={t("dashboard.quickActionCards.proposalName")}>
            <Input value={form.title} onChange={(event) => update("title", event.target.value)} placeholder={t("dashboard.quickActionCards.proposalNamePlaceholder")} />
          </Field>
          <Field label={t("dashboard.quickActionCards.proposalCustomer")}>
            <Input value={form.customer} onChange={(event) => update("customer", event.target.value)} placeholder={t("dashboard.quickActionCards.proposalCustomerPlaceholder")} />
          </Field>
          <Field label={t("dashboard.quickActionCards.proposalObjective")}>
            <Input value={form.objective} onChange={(event) => update("objective", event.target.value)} placeholder={t("dashboard.quickActionCards.proposalObjectivePlaceholder")} />
          </Field>
          <div />
          <div className="sm:col-span-2">
            <Field label={t("dashboard.quickActionCards.context")}>
              <textarea
                value={form.context}
                onChange={(event) => update("context", event.target.value)}
                rows={4}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder={t("dashboard.quickActionCards.proposalContextPlaceholder")}
              />
            </Field>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-100 bg-gray-50 p-4">
          <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
          <Btn variant="secondary" onClick={() => saveProposal("draft")}>{t("dashboard.quickActionCards.saveDraft")}</Btn>
          <Btn icon={<ArrowRightIcon size={13} />} onClick={() => saveProposal("draft")}>{t("dashboard.quickActionCards.createProposalButton")}</Btn>
        </div>
      </div>
    </div>
  );
}

function CampaignModal({ onClose, onCreated }) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    name: "",
    audience: "",
    channel: "linkedin",
    objective: "lead_generation",
    context: "",
  });
  const [saving, setSaving] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [generationStep, setGenerationStep] = useState("");

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const saveCampaign = async (status = "draft") => {
    const now = new Date();
    const name = form.name.trim() || t("dashboard.quickActionCards.campaignDefaultName");
    const payload = {
      name,
      audience: form.audience,
      channels: [form.channel],
      objective: form.objective,
      context: form.context,
      status,
    };

    setSaving(true);
    setGenerationProgress(status === "active" ? 8 : 0);
    setGenerationStep(status === "active" ? t("dashboard.quickActionCards.aiStepSaving") : "");
    let createdCampaign = null;
    let progressTimer = null;
    try {
      const { data } = await campaignsApi.create(payload);
      if (!data || typeof data !== "object" || Array.isArray(data) || !data.id) {
        throw new Error("Invalid campaign response");
      }
      createdCampaign = data;
      saveLocalCampaign({ ...data, channel: data.channels?.[0] || form.channel });

      if (status === "draft") {
        onCreated(t("dashboard.quickActionCards.campaignSaved"));
        return;
      }

      setGenerationProgress(20);
      setGenerationStep(t("dashboard.quickActionCards.aiStepAnalyzing"));
      progressTimer = window.setInterval(() => {
        setGenerationProgress((current) => {
          const next = Math.min(current + 7, 88);
          if (next >= 62) setGenerationStep(t("dashboard.quickActionCards.aiStepPublishing"));
          else if (next >= 36) setGenerationStep(t("dashboard.quickActionCards.aiStepWriting"));
          return next;
        });
      }, 700);

      await campaignsApi.generate(data.id);
      window.clearInterval(progressTimer);
      progressTimer = null;
      setGenerationProgress(100);
      setGenerationStep(t("dashboard.quickActionCards.aiStepComplete"));
      window.dispatchEvent(new CustomEvent("marketgen:content-library-updated"));
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      onCreated({ type: "success", message: t("dashboard.quickActionCards.campaignCreatedWithContent") });
    } catch (error) {
      if (createdCampaign) {
        setGenerationStep(t("dashboard.quickActionCards.aiStepFailed"));
        onCreated({ type: "error", message: t("dashboard.quickActionCards.campaignCreatedAiError") });
        return;
      }
      saveLocalCampaign({
        ...payload,
        id: `campaign-${Date.now()}`,
        channel: form.channel,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      onCreated(t("dashboard.quickActionCards.campaignSavedLocally"));
    } finally {
      if (progressTimer) window.clearInterval(progressTimer);
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 p-5">
          <div>
            <p className="text-sm font-semibold text-gray-900">{t("dashboard.quickActionCards.campaignModalTitle")}</p>
            <p className="text-xs text-gray-500">{t("dashboard.quickActionCards.campaignModalSubtitle")}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600" aria-label={t("common.close")}>
            <XIcon size={16} />
          </button>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label={t("dashboard.quickActionCards.campaignName")}>
            <Input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder={t("dashboard.quickActionCards.campaignNamePlaceholder")} />
          </Field>
          <Field label={t("dashboard.quickActionCards.targetAudience")}>
            <Input value={form.audience} onChange={(event) => update("audience", event.target.value)} placeholder={t("dashboard.quickActionCards.targetAudiencePlaceholder")} />
          </Field>
          <Field label={t("dashboard.quickActionCards.primaryChannel")}>
            <Select value={form.channel} onChange={(event) => update("channel", event.target.value)}>
              <option value="linkedin">LinkedIn</option>
              <option value="substack">Substack</option>
              <option value="email_outreach">Email Outreach</option>
            </Select>
          </Field>
          <Field label={t("dashboard.quickActionCards.objective")}>
            <Select value={form.objective} onChange={(event) => update("objective", event.target.value)}>
              <option value="lead_generation">{t("dashboard.quickActionCards.objectiveLeadGeneration")}</option>
              <option value="awareness">{t("dashboard.quickActionCards.objectiveAwareness")}</option>
              <option value="follow_up">{t("dashboard.quickActionCards.objectiveFollowUp")}</option>
              <option value="conversion">{t("dashboard.quickActionCards.objectiveConversion")}</option>
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field label={t("dashboard.quickActionCards.context")}>
              <textarea
                value={form.context}
                onChange={(event) => update("context", event.target.value)}
                rows={4}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-teal-500"
                placeholder={t("dashboard.quickActionCards.campaignContextPlaceholder")}
              />
            </Field>
          </div>
        </div>
        {saving && generationStep && (
          <div className="mx-5 mb-5 rounded-xl border border-teal-100 bg-teal-50 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold text-teal-800">{generationStep}</p>
              <span className="text-xs font-semibold text-teal-700">{generationProgress}%</span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white">
              <div
                className="h-full rounded-full bg-teal-500 transition-all duration-500"
                style={{ width: `${generationProgress}%` }}
              />
            </div>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 border-t border-gray-100 bg-gray-50 p-4">
          <p className="text-xs font-medium text-teal-600">
            {saving && generationStep ? t("dashboard.quickActionCards.generatingAiContent") : ""}
          </p>
          <div className="flex gap-2">
            <Btn variant="ghost" onClick={onClose} disabled={saving}>{t("common.cancel")}</Btn>
            <Btn variant="secondary" onClick={() => saveCampaign("draft")} disabled={saving}>{t("dashboard.quickActionCards.saveDraft")}</Btn>
            <Btn variant="teal" icon={<ArrowRightIcon size={13} />} onClick={() => saveCampaign("active")} disabled={saving}>{t("dashboard.quickActionCards.continue")}</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

const WIZARD_STEPS = [
  { id: 1, label: "Audience", icon: "👥" },
  { id: 2, label: "Brief", icon: "🎯" },
  { id: 3, label: "AI Content", icon: "✦" },
  { id: 4, label: "Assets", icon: "📁" },
  { id: 5, label: "Review", icon: "✏️" },
  { id: 6, label: "Activate", icon: "🚀" },
  { id: 7, label: "Results", icon: "📊" },
];

const createInitialCampaignWizardData = () => ({
  currentStep: 1,
  selectedOpportunities: [],
  brief: {
    name: "",
    objective: "lead_generation",
    channels: ["linkedin"],
    startDate: "",
    budget: "",
    kpis: "",
    context: "",
  },
  campaignId: null,
  generatedContent: null,
  selectedAssets: [],
  approved: false,
  activated: false,
});

const CAMPAIGN_FLOW_STEPS = [
  { id: 1, label: "Audience", page: "opportunities" },
  { id: 2, label: "Brief", page: "campaign_brief" },
  { id: 3, label: "AI Content", page: "assistant" },
  { id: 4, label: "Assets", page: "content" },
  { id: 5, label: "Review", page: "outreach" },
  { id: 6, label: "Activate", page: "outreach" },
  { id: 7, label: "Results", page: "reports" },
];

const completeCampaignFlowSteps = (current, steps, nextStep) => ({
  ...current,
  currentStep: nextStep,
  completedSteps: Array.from(new Set([...(current?.completedSteps || []), ...steps])),
});

function CampaignWizard({ wizardData, setWizardData, onClose, onCreated, onNavigate }) {
  const [opportunities, setOpportunities] = useState([]);
  const [assets, setAssets] = useState([]);
  const [loadingOpportunities, setLoadingOpportunities] = useState(false);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [savingBrief, setSavingBrief] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [activating, setActivating] = useState(false);
  const [wizardError, setWizardError] = useState("");
  const step = wizardData.currentStep || 1;
  const brief = wizardData.brief || {};
  const generatedPosts = Array.isArray(wizardData.generatedContent) ? wizardData.generatedContent : [];

  useEffect(() => {
    setLoadingOpportunities(true);
    opportunitiesApi.list()
      .then(({ data }) => setOpportunities(Array.isArray(data) ? data : []))
      .catch(() => setOpportunities([]))
      .finally(() => setLoadingOpportunities(false));
  }, []);

  useEffect(() => {
    if (step !== 4 || assets.length) return;
    setLoadingAssets(true);
    fetchOptional("/content-library", [])
      .then((data) => setAssets(Array.isArray(data) ? data : []))
      .finally(() => setLoadingAssets(false));
  }, [assets.length, step]);

  const updateWizard = (patch) => setWizardData((current) => ({ ...current, ...patch }));
  const updateBrief = (field, value) => {
    setWizardData((current) => ({
      ...current,
      brief: { ...(current.brief || {}), [field]: value },
    }));
  };
  const toggleChannel = (channel) => {
    const channels = brief.channels || [];
    const next = channels.includes(channel)
      ? channels.filter((item) => item !== channel)
      : [...channels, channel];
    updateBrief("channels", next);
  };
  const toggleOpportunity = (opportunity) => {
    setWizardData((current) => {
      const selected = current.selectedOpportunities || [];
      const exists = selected.some((item) => item.id === opportunity.id);
      return {
        ...current,
        selectedOpportunities: exists
          ? selected.filter((item) => item.id !== opportunity.id)
          : [...selected, opportunity],
      };
    });
  };
  const toggleAsset = (asset) => {
    setWizardData((current) => {
      const selected = current.selectedAssets || [];
      const exists = selected.some((item) => item.id === asset.id);
      return {
        ...current,
        selectedAssets: exists
          ? selected.filter((item) => item.id !== asset.id)
          : [...selected, asset],
      };
    });
  };

  const opportunityName = (item = {}) => item.company || item.companyName || item.name || item.title || "Untitled company";
  const opportunityContact = (item = {}) => item.contact || item.contactName || item.person || item.email || "No contact";
  const assetTitle = (item = {}) => item.title || item.name || item.assetName || "Untitled asset";
  const assetType = (item = {}) => item.type || item.assetType || item.category || "Asset";

  const saveBrief = async () => {
    if (wizardData.campaignId) return wizardData.campaignId;
    setSavingBrief(true);
    setWizardError("");
    try {
      const payload = {
        name: brief.name?.trim() || "Untitled Campaign",
        audience: (wizardData.selectedOpportunities || []).map(opportunityName).join(", "),
        objective: brief.objective || "lead_generation",
        channels: brief.channels?.length ? brief.channels : ["linkedin"],
        context: brief.context || "",
        status: "draft",
        briefData: {
          startDate: brief.startDate || "",
          budget: brief.budget || "",
          kpis: brief.kpis || "",
          selectedOpportunityIds: (wizardData.selectedOpportunities || []).map((item) => item.id).filter(Boolean),
        },
      };
      const { data } = await campaignsApi.create(payload);
      saveLocalCampaign({ ...data, channel: data.channels?.[0] || payload.channels[0] });
      updateWizard({ campaignId: data.id, brief: { ...brief, name: payload.name } });
      window.dispatchEvent(new CustomEvent("marketgen:campaigns-updated"));
      return data.id;
    } catch {
      setWizardError("Could not save the campaign brief. Please try again.");
      return null;
    } finally {
      setSavingBrief(false);
    }
  };

  const generateContent = async () => {
    if (!wizardData.campaignId || generating) return;
    setGenerating(true);
    setWizardError("");
    try {
      const { data } = await campaignsApi.generate(wizardData.campaignId);
      const posts = normalizeCampaignContent(
        data?.asset?.content || data?.content || data,
        brief.channels?.[0] || "linkedin",
        brief.name || "Campaign content",
      );
      updateWizard({ generatedContent: posts });
      window.dispatchEvent(new CustomEvent("marketgen:content-library-updated"));
    } catch {
      setWizardError("AI content generation failed. You can try again.");
    } finally {
      setGenerating(false);
    }
  };

  useEffect(() => {
    if (step === 3 && wizardData.campaignId && !wizardData.generatedContent && !generating) {
      generateContent();
    }
  }, [step, wizardData.campaignId, wizardData.generatedContent]);

  useEffect(() => {
    if (step !== 6 || !wizardData.campaignId || wizardData.activated || activating) return;
    setActivating(true);
    setWizardError("");
    campaignsApi.update(wizardData.campaignId, { status: "active" })
      .then(() => {
        updateWizard({ activated: true });
        window.dispatchEvent(new CustomEvent("marketgen:campaigns-updated"));
      })
      .catch(() => setWizardError("Could not activate this campaign. Please try again."))
      .finally(() => setActivating(false));
  }, [activating, step, wizardData.activated, wizardData.campaignId]);

  const updatePost = (index, field, value) => {
    setWizardData((current) => ({
      ...current,
      generatedContent: (current.generatedContent || []).map((post, postIndex) => (
        postIndex === index ? { ...post, [field]: value } : post
      )),
    }));
  };

  const goToStep = (nextStep) => updateWizard({ currentStep: Math.min(7, Math.max(1, nextStep)) });
  const isStepComplete = (stepId) => {
    if (stepId === 1) return (wizardData.selectedOpportunities || []).length > 0;
    if (stepId === 2) return Boolean(brief.name?.trim()) && Boolean(brief.objective) && Boolean(brief.channels?.length);
    if (stepId === 3) return generatedPosts.length > 0;
    if (stepId === 4) return true;
    if (stepId === 5) return Boolean(wizardData.approved);
    if (stepId === 6) return Boolean(wizardData.activated);
    return true;
  };
  const handleNext = async () => {
    if (step === 2) {
      const campaignId = await saveBrief();
      if (!campaignId) return;
    }
    if (step === 7) return;
    goToStep(step + 1);
  };
  const resetWizard = () => setWizardData(createInitialCampaignWizardData());

  return (
    <div className="campaign-wizard-overlay">
      <div className="campaign-wizard-header">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Campaign Wizard</h2>
          <p className="text-xs text-slate-500">Build, approve, activate, and track a connected campaign.</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close campaign wizard">
          <XIcon size={18} />
        </button>
      </div>
      <div className="campaign-wizard-steps">
        {WIZARD_STEPS.map((wizardStep) => {
          const completed = wizardStep.id < step || isStepComplete(wizardStep.id);
          return (
            <button
              key={wizardStep.id}
              type="button"
              onClick={() => goToStep(wizardStep.id)}
              className={`campaign-wizard-step ${wizardStep.id === step ? "active" : ""} ${wizardStep.id < step && completed ? "completed" : ""}`}
            >
              <span>{wizardStep.id < step && completed ? "✓" : wizardStep.id}</span>
              <span>{wizardStep.icon}</span>
              <span>{wizardStep.label}</span>
            </button>
          );
        })}
      </div>
      <div className="campaign-wizard-content">
        {wizardError && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{wizardError}</div>}

        {step === 1 && (
          <div className="space-y-5">
            <div>
              <h3 className="text-xl font-semibold text-slate-900">Select Audience</h3>
              <p className="mt-1 text-sm text-slate-500">Choose one or more opportunities to target with this campaign.</p>
            </div>
            {loadingOpportunities ? (
              <div className="rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500">Loading opportunities...</div>
            ) : opportunities.length ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {opportunities.map((opportunity) => {
                  const selected = (wizardData.selectedOpportunities || []).some((item) => item.id === opportunity.id);
                  return (
                    <button
                      key={opportunity.id || opportunityName(opportunity)}
                      type="button"
                      onClick={() => toggleOpportunity(opportunity)}
                      className={`rounded-xl border bg-white p-4 text-left transition ${selected ? "border-indigo-500 ring-2 ring-indigo-100" : "border-slate-200 hover:border-indigo-200"}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-slate-900">{opportunityName(opportunity)}</p>
                          <p className="mt-1 text-xs text-slate-500">{opportunityContact(opportunity)}</p>
                        </div>
                        <Badge label={`${opportunity.score || 0}%`} color="bg-indigo-100 text-indigo-700" />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
                        <span className="rounded-full bg-slate-100 px-2 py-1">{opportunity.stage || opportunity.status || "Detected"}</span>
                        <span className="rounded-full bg-slate-100 px-2 py-1">{opportunity.industry || "General"}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center">
                <p className="text-sm font-medium text-slate-700">No opportunities found yet.</p>
                <Btn className="mt-4" onClick={() => onNavigate("opportunities")}>Add Opportunity</Btn>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="mx-auto max-w-4xl space-y-5">
            <div>
              <h3 className="text-xl font-semibold text-slate-900">Campaign Brief</h3>
              <p className="mt-1 text-sm text-slate-500">Define the campaign contract that the existing Campaigns API will save.</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Campaign name">
                <Input value={brief.name || ""} onChange={(event) => updateBrief("name", event.target.value)} placeholder="Q3 AI marketing outreach" />
              </Field>
              <Field label="Objective">
                <Select value={brief.objective || "lead_generation"} onChange={(event) => updateBrief("objective", event.target.value)}>
                  <option value="lead_generation">Lead generation</option>
                  <option value="awareness">Awareness</option>
                  <option value="follow_up">Follow-up</option>
                  <option value="conversion">Conversion</option>
                </Select>
              </Field>
              <Field label="Start date">
                <Input type="date" value={brief.startDate || ""} onChange={(event) => updateBrief("startDate", event.target.value)} />
              </Field>
              <Field label="Budget">
                <Input type="number" min="0" value={brief.budget || ""} onChange={(event) => updateBrief("budget", event.target.value)} placeholder="Optional" />
              </Field>
            </div>
            <Field label="Channels">
              <div className="flex flex-wrap gap-2">
                {[
                  ["linkedin", "LinkedIn"],
                  ["facebook", "Facebook"],
                  ["twitter_x", "Twitter / X"],
                  ["substack", "Substack"],
                  ["email_outreach", "Email Outreach"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => toggleChannel(value)}
                    className={`rounded-lg border px-3 py-2 text-xs font-medium transition ${brief.channels?.includes(value) ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-600 hover:border-indigo-200"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Expected KPIs">
              <Input value={brief.kpis || ""} onChange={(event) => updateBrief("kpis", event.target.value)} placeholder="Open rate, response rate, meetings booked..." />
            </Field>
            <Field label="Context">
              <textarea value={brief.context || ""} onChange={(event) => updateBrief("context", event.target.value)} rows={5} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500" placeholder="Additional context for the AI..." />
            </Field>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-semibold text-slate-900">AI Content Generation</h3>
                <p className="mt-1 text-sm text-slate-500">Review and edit generated copy per channel.</p>
              </div>
              <Btn variant="secondary" onClick={generateContent} disabled={generating || !wizardData.campaignId}>Regenerate</Btn>
            </div>
            {generating && (
              <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-8 text-center">
                <span className="mx-auto block h-6 w-6 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
                <p className="mt-3 text-sm font-medium text-indigo-700">Generating campaign content with AI...</p>
              </div>
            )}
            <div className="grid gap-4 lg:grid-cols-2">
              {generatedPosts.map((post, index) => (
                <Card key={`${post.channel}-${index}`} className="p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <Badge label={post.channel} color="bg-indigo-100 text-indigo-700" />
                  </div>
                  <Field label="Headline">
                    <Input value={post.headline || ""} onChange={(event) => updatePost(index, "headline", event.target.value)} />
                  </Field>
                  <Field label="Content">
                    <textarea value={post.content || ""} onChange={(event) => updatePost(index, "content", event.target.value)} rows={8} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </Field>
                </Card>
              ))}
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-5">
            <div>
              <h3 className="text-xl font-semibold text-slate-900">Attach Assets</h3>
              <p className="mt-1 text-sm text-slate-500">Select supporting content from the Content Library.</p>
            </div>
            {loadingAssets ? (
              <div className="rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500">Loading content library...</div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {assets.map((asset) => {
                  const selected = (wizardData.selectedAssets || []).some((item) => item.id === asset.id);
                  return (
                    <button
                      key={asset.id || assetTitle(asset)}
                      type="button"
                      onClick={() => toggleAsset(asset)}
                      className={`rounded-xl border bg-white p-4 text-left transition ${selected ? "border-indigo-500 ring-2 ring-indigo-100" : "border-slate-200 hover:border-indigo-200"}`}
                    >
                      <Badge label={assetType(asset)} color="bg-slate-100 text-slate-700" />
                      <p className="mt-3 font-semibold text-slate-900">{assetTitle(asset)}</p>
                      <p className="mt-1 line-clamp-2 text-xs text-slate-500">{asset.description || asset.content || "Ready to attach"}</p>
                    </button>
                  );
                })}
                {!assets.length && <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 md:col-span-2 xl:col-span-3">No content assets found.</div>}
              </div>
            )}
          </div>
        )}

        {step === 5 && (
          <div className="mx-auto max-w-5xl space-y-4">
            <h3 className="text-xl font-semibold text-slate-900">Review & Approval</h3>
            {[
              ["Audience", 1, `${(wizardData.selectedOpportunities || []).length} opportunities selected`],
              ["Brief", 2, `${brief.name || "Untitled"} · ${brief.objective || "lead_generation"} · ${(brief.channels || []).join(", ")}`],
              ["AI Content", 3, `${generatedPosts.length} generated channel drafts`],
              ["Assets", 4, `${(wizardData.selectedAssets || []).length} assets attached`],
            ].map(([title, targetStep, detail]) => (
              <Card key={title} className="p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="font-semibold text-slate-900">{title}</p>
                    <p className="mt-1 text-sm text-slate-500">{detail}</p>
                  </div>
                  <Btn variant="secondary" small onClick={() => goToStep(targetStep)}>Edit</Btn>
                </div>
              </Card>
            ))}
            <Card className="p-4">
              <label className="flex items-start gap-3 text-sm text-slate-700">
                <input type="checkbox" className="mt-1 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" checked={Boolean(wizardData.approved)} onChange={(event) => updateWizard({ approved: event.target.checked })} />
                <span>I confirm this campaign is ready to activate</span>
              </label>
            </Card>
          </div>
        )}

        {step === 6 && (
          <div className="flex min-h-[420px] items-center justify-center">
            <div className="text-center">
              <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-green-100 text-4xl text-green-600">{activating ? "..." : "✓"}</div>
              <h3 className="mt-5 text-2xl font-bold text-slate-900">{wizardData.activated ? "Campaign activated successfully!" : "Activating campaign..."}</h3>
              <p className="mt-2 text-sm text-slate-500">{brief.name || "Campaign"} · {(brief.channels || []).join(", ")} · {(wizardData.selectedOpportunities || []).length} audience targets</p>
              <Btn className="mt-6" onClick={() => onNavigate("outreach")}>View in Outreach</Btn>
            </div>
          </div>
        )}

        {step === 7 && (
          <div className="mx-auto max-w-5xl space-y-5">
            <div>
              <h3 className="text-xl font-semibold text-slate-900">Results Preview</h3>
              <p className="mt-1 text-sm text-slate-500">Live metrics will begin tracking after launch.</p>
            </div>
            <Card className="p-5">
              <p className="text-sm font-semibold text-slate-900">Defined KPIs</p>
              <p className="mt-2 text-sm text-slate-600">{brief.kpis || "No KPIs defined."}</p>
            </Card>
            <div className="grid gap-3 md:grid-cols-3">
              {["Open Rate", "Response Rate", "Conversions"].map((metric) => (
                <Card key={metric} className="p-4">
                  <p className="text-xs text-slate-500">{metric}</p>
                  <p className="mt-2 text-2xl font-bold text-slate-900">--</p>
                  <Badge label="Tracking..." color="bg-amber-100 text-amber-700" />
                </Card>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Btn onClick={() => onNavigate("reports")}>Go to Reports</Btn>
              <Btn variant="secondary" onClick={resetWizard}>Create Another Campaign</Btn>
            </div>
          </div>
        )}
      </div>
      <div className="campaign-wizard-footer">
        <Btn variant="secondary" onClick={() => goToStep(step - 1)} disabled={step === 1 || savingBrief || generating || activating}>Back</Btn>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">Step {step} of {WIZARD_STEPS.length}</span>
          {step < 7 ? (
            <Btn onClick={handleNext} disabled={!isStepComplete(step) || savingBrief || generating || activating}>
              {savingBrief ? "Saving..." : step === 6 ? "View Results" : "Next"}
            </Btn>
          ) : (
            <Btn onClick={() => {
              onCreated({ type: "success", message: "Campaign wizard complete" });
              onClose();
            }}>Done</Btn>
          )}
        </div>
      </div>
    </div>
  );
}

function CampaignBriefPage({ onNavigate = () => {}, campaignFlow = null, setCampaignFlow = () => {} }) {
  const [form, setForm] = useState({
    name: campaignFlow?.brief?.name || "",
    objective: campaignFlow?.brief?.objective || "lead_generation",
    channels: campaignFlow?.brief?.channels || [],
    startDate: campaignFlow?.brief?.startDate || "",
    budget: campaignFlow?.brief?.budget || "",
    kpis: campaignFlow?.brief?.kpis || "",
    context: campaignFlow?.brief?.context || "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const toggleChannel = (channel) => {
    setForm((current) => {
      const channels = current.channels || [];
      return {
        ...current,
        channels: channels.includes(channel)
          ? channels.filter((item) => item !== channel)
          : [...channels, channel],
      };
    });
  };
  const handleSubmit = async () => {
    if (!form.name.trim() || !form.channels.length) return;
    setSaving(true);
    setError("");
    try {
      const response = await campaignsApi.create({
        name: form.name.trim(),
        audience: (campaignFlow?.selectedOpportunities || []).map((item) => item.company || item.name).filter(Boolean).join(", "),
        objective: form.objective,
        channels: form.channels,
        context: form.context,
        briefData: {
          startDate: form.startDate,
          budget: form.budget,
          kpis: form.kpis,
          selectedOpportunityIds: (campaignFlow?.selectedOpportunities || []).map((item) => item.id).filter(Boolean),
        },
        status: "draft",
      });
      const data = response.data;
      saveLocalCampaign({ ...data, channel: data.channels?.[0] || form.channels[0] });
      window.dispatchEvent(new CustomEvent("marketgen:campaigns-updated"));
      setCampaignFlow((prev) => ({
        ...completeCampaignFlowSteps(prev, [2], 3),
        campaignId: data.id,
        campaignName: form.name.trim(),
        brief: form,
      }));
      onNavigate("assistant");
    } catch (err) {
      console.error(err);
      setError("Could not create the campaign brief. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {campaignFlow && (
        <div className="flow-step-banner">
          <span>🎯 Step 2: Define your campaign brief</span>
        </div>
      )}
      <div>
        <h1 className="text-xl font-bold text-gray-900">Campaign Brief</h1>
        <p className="text-xs text-gray-500">Define the campaign before moving to AI content.</p>
      </div>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      <Card className="p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Campaign name">
            <Input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Q3 outbound campaign" />
          </Field>
          <Field label="Objective">
            <Select value={form.objective} onChange={(event) => update("objective", event.target.value)}>
              <option value="lead_generation">Lead generation</option>
              <option value="awareness">Awareness</option>
              <option value="follow_up">Follow-up</option>
              <option value="conversion">Conversion</option>
            </Select>
          </Field>
          <Field label="Start date">
            <Input type="date" value={form.startDate} onChange={(event) => update("startDate", event.target.value)} />
          </Field>
          <Field label="Budget">
            <Input type="number" min="0" value={form.budget} onChange={(event) => update("budget", event.target.value)} placeholder="Optional" />
          </Field>
          <div className="md:col-span-2">
            <Field label="Channels">
              <div className="flex flex-wrap gap-2">
                {[
                  ["linkedin", "LinkedIn"],
                  ["substack", "Substack"],
                  ["email_outreach", "Email Outreach"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => toggleChannel(value)}
                    className={`rounded-lg border px-3 py-2 text-xs font-medium transition ${form.channels.includes(value) ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-600 hover:border-indigo-200"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Field>
          </div>
          <div className="md:col-span-2">
            <Field label="KPIs">
              <Input value={form.kpis} onChange={(event) => update("kpis", event.target.value)} placeholder="Open rate, response rate, booked meetings..." />
            </Field>
          </div>
          <div className="md:col-span-2">
            <Field label="Context">
              <textarea
                value={form.context}
                onChange={(event) => update("context", event.target.value)}
                rows={5}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="Additional context for the campaign..."
              />
            </Field>
          </div>
        </div>
      </Card>
      <div className="flex justify-between">
        <Btn variant="secondary" onClick={() => onNavigate("opportunities")}>Back</Btn>
        <Btn onClick={handleSubmit} disabled={saving || !form.name.trim() || !form.channels.length}>
          {saving ? "Saving..." : "Continue to AI Content →"}
        </Btn>
      </div>
    </div>
  );
}

function DashboardPage({ onNavigate, setCampaignFlow = () => {} }) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const cachedDashboardSnapshot = loadDashboardSnapshot();
  const [dashboardState, setDashboardState] = useState(() => cachedDashboardSnapshot || createEmptyDashboardState());
  const [lastUpdated, setLastUpdated] = useState(() => cachedDashboardSnapshot?.lastUpdated || formatUpdatedTime());
  const [refreshing, setRefreshing] = useState(false);
  const [proposalModalOpen, setProposalModalOpen] = useState(false);
  const [campaignWizardOpen, setCampaignWizardOpen] = useState(false);
  const [wizardData, setWizardData] = useState(createInitialCampaignWizardData);
  const { toasts, setToast, removeToast, pauseToast, resumeToast } = useToastQueue();

  const refreshDashboard = async (showToast = false) => {
    setRefreshing(true);
    try {
      const currentSnapshot = loadDashboardSnapshot();
      const nextSnapshot = await buildDashboardMetricsFromSources({ allowDemo: false });
      if (nextSnapshot && (hasAnyDashboardMetric(nextSnapshot) || !currentSnapshot)) {
        saveDashboardSnapshot(nextSnapshot);
        setDashboardState(nextSnapshot);
        setLastUpdated(nextSnapshot.lastUpdated || formatUpdatedTime());
      } else if (!currentSnapshot) {
        localStorage.removeItem(DASHBOARD_SNAPSHOT_KEY);
        const emptySnapshot = createEmptyDashboardState();
        setDashboardState(emptySnapshot);
        setLastUpdated(formatUpdatedTime());
      }
    } finally {
      setRefreshing(false);
    }
    if (showToast) setToast("Dashboard updated");
  };

  useEffect(() => {
    refreshDashboard(false);
    const reload = () => refreshDashboard(false);
    window.addEventListener("marketgen:content-library-updated", reload);
    window.addEventListener("marketgen:campaigns-updated", reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener("marketgen:content-library-updated", reload);
      window.removeEventListener("marketgen:campaigns-updated", reload);
      window.removeEventListener("storage", reload);
    };
  }, []);

  const navigate = (page, state = {}) => {
    if (onNavigate) onNavigate(page, state);
  };
  const startCampaignFlow = () => {
    setCampaignFlow({
      campaignId: null,
      currentStep: 1,
      campaignName: "New Campaign",
      completedSteps: [],
      selectedOpportunities: [],
      brief: {},
      selectedAssets: [],
      savedNotes: [],
    });
    if (onNavigate) onNavigate("opportunities");
  };

  const { metrics, funnel, contentUsed, sourceLabel, quickActions } = dashboardState;
  const closeProposalModal = (message) => {
    setProposalModalOpen(false);
    if (message) setToast(message);
    refreshDashboard(false);
  };
  const closeCampaignModal = (message) => {
    setCampaignWizardOpen(false);
    if (message) setToast(message);
    refreshDashboard(false);
  };
  const proposalQuickMetrics = quickActions?.proposal || createEmptyDashboardState().quickActions.proposal;
  const campaignQuickMetrics = quickActions?.campaign || createEmptyDashboardState().quickActions.campaign;
  const proposalBadges = [
    t("sidebar.chat"),
    t("sidebar.books"),
    t("dashboard.quickActionCards.templates"),
    t("dashboard.quickActionCards.proposals"),
    t("sidebar.contentLibrary"),
    t("dashboard.quickActionCards.exportFormats"),
  ];
  const campaignBadges = [
    t("sidebar.chat"),
    t("sidebar.opportunities"),
    t("sidebar.contentLibrary"),
    t("sidebar.outreach"),
    t("sidebar.reports"),
    "LinkedIn",
    "Substack",
  ];
  const kpiCards = [
    { icon: SearchIcon, label: t("dashboard.kpis.detected"), value: metrics.detected, sub: t("dashboard.kpis.thisWeek"), color: "bg-blue-50 text-blue-600", page: "opportunities", state: { stageFilter: "Detected" }, aria: "Open opportunities filtered by detected stage" },
    { icon: UsersIcon, label: t("dashboard.kpis.researched"), value: metrics.researched, sub: t("dashboard.kpis.contacts"), color: "bg-cyan-50 text-cyan-600", page: "opportunities", state: { hasContact: true }, aria: "Open researched opportunities" },
    { icon: MailIcon, label: t("dashboard.kpis.contacted"), value: metrics.contacted, sub: t("dashboard.kpis.emails"), color: "bg-indigo-50 text-indigo-600", page: "outreach", state: { tab: "history", statusFilter: "sent" }, aria: "Open contacted outreach history" },
    { icon: AlertIcon, label: t("dashboard.kpis.pendingReview"), value: metrics.pendingReview, sub: t("dashboard.kpis.needAttention"), color: "bg-amber-50 text-amber-600", page: "outreach", state: { tab: "review" }, aria: "Open Outreach Review Queue" },
    { icon: ChatIcon, label: t("dashboard.kpis.replied"), value: metrics.replied, sub: t("dashboard.kpis.conversations"), color: "bg-purple-50 text-purple-600", page: "opportunities", state: { stageFilter: "Replied" }, aria: "Open opportunities filtered by replied stage" },
    { icon: CheckIcon, label: t("dashboard.kpis.won"), value: metrics.won, sub: t("dashboard.kpis.newClients"), color: "bg-green-50 text-green-600", page: "opportunities", state: { stageFilter: "Won" }, aria: "Open opportunities filtered by won stage" },
  ];
  const funnelMax = Math.max(
    Number(funnel.scanned || 0),
    Array.isArray(funnel.relevant) ? funnel.relevant.length : Number(funnel.relevant || 0),
    Number(funnel.contactsEnriched || 0),
    Number(funnel.contentMatched || 0),
    Number(funnel.emailsSent || 0),
    Number(funnel.repliesReceived || 0),
    Number(funnel.dealsWon || 0),
  );
  const funnelRows = [
    { label: t("dashboard.funnel.jobsScanned"), val: funnel.scanned, w: percentWidth(funnel.scanned, funnelMax), color: "bg-blue-300", icon: <SearchIcon size={13} />, page: "opportunities", state: { stageFilter: "All" } },
    { label: t("dashboard.funnel.relevantOpportunities"), val: funnel.relevant.length, w: percentWidth(funnel.relevant.length, funnelMax), color: "bg-blue-500", icon: <TargetIcon size={13} />, page: "opportunities", state: { minScore: 60 } },
    { label: t("dashboard.funnel.contactsEnriched"), val: funnel.contactsEnriched, w: percentWidth(funnel.contactsEnriched, funnelMax), color: "bg-cyan-500", icon: <UsersIcon size={13} />, page: "opportunities", state: { hasContact: true } },
    { label: t("dashboard.funnel.contentMatched"), val: funnel.contentMatched, w: percentWidth(funnel.contentMatched, funnelMax), color: "bg-indigo-400", icon: <FileIcon size={13} />, page: "content", state: { typeFilter: "All" } },
    { label: t("dashboard.funnel.personalizedEmails"), val: funnel.emailsSent, w: percentWidth(funnel.emailsSent, funnelMax), color: "bg-indigo-600", icon: <MailIcon size={13} />, page: "outreach", state: { tab: "history", statusFilter: "sent" } },
    { label: t("dashboard.funnel.repliesReceived"), val: funnel.repliesReceived, w: percentWidth(funnel.repliesReceived, funnelMax), color: "bg-purple-500", icon: <ChatIcon size={13} />, page: "opportunities", state: { stageFilter: "Replied" } },
    { label: t("dashboard.funnel.dealsWon"), val: funnel.dealsWon, w: percentWidth(funnel.dealsWon, funnelMax), color: "bg-green-500", icon: <CheckIcon size={13} />, page: "opportunities", state: { stageFilter: "Won" } },
  ];
  const pipelineCountLabel = (key, value) => String(t(`dashboard.pipeline.${key}`)).replace(/^\s*[-+]?\d+/, Number(value) || 0);
  const lastPipelineRunLabel = String(t("dashboard.lastPipelineRun")).split(/\s+(?:-|\u2014|\u00e2\u20ac\u201d)\s+/)[0] || t("dashboard.lastPipelineRun");
  const pipelineSteps = [
    { label: t("dashboard.pipeline.scout"), sub: pipelineCountLabel("leads", funnel.scanned), color: "bg-blue-500", done: funnel.scanned > 0 },
    { label: t("dashboard.pipeline.research"), sub: pipelineCountLabel("contacts", funnel.contactsEnriched), color: "bg-cyan-500", done: funnel.contactsEnriched > 0 },
    { label: t("dashboard.pipeline.matchContent"), sub: pipelineCountLabel("assets", funnel.contentMatched), color: "bg-indigo-500", done: funnel.contentMatched > 0 },
    { label: t("dashboard.pipeline.compose"), sub: pipelineCountLabel("emails", funnel.emailsSent), color: "bg-purple-500", done: funnel.emailsSent > 0 },
    { label: t("dashboard.pipeline.review"), sub: pipelineCountLabel("pending", metrics.pendingReview), color: "bg-amber-500", done: metrics.pendingReview === 0 && funnel.emailsSent > 0 },
    { label: t("dashboard.pipeline.send"), sub: pipelineCountLabel("sent", funnel.emailsSent), color: "bg-green-500", done: funnel.emailsSent > 0 },
  ];

  return (
    
    <div className="space-y-2.5">
      <ToastStack
        toasts={toasts}
        onClose={removeToast}
        onMouseEnter={pauseToast}
        onMouseLeave={resumeToast}
      />
      {proposalModalOpen && (
        <QuickProposalModal
          onClose={() => setProposalModalOpen(false)}
          onCreated={closeProposalModal}
        />
      )}
      {campaignWizardOpen && (
        <CampaignWizard
          wizardData={wizardData}
          setWizardData={setWizardData}
          onClose={() => setCampaignWizardOpen(false)}
          onCreated={closeCampaignModal}
          onNavigate={onNavigate}
        />
      )}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("dashboard.title")}</h1>
          <p className="text-xs text-gray-500">{t("dashboard.subtitle")}</p>
          <div className="mt-1 flex items-center gap-1 text-xs text-gray-400">
            <span>Last updated: {lastUpdated}</span>
            {refreshing && <span className="text-indigo-500 font-medium">Refreshing...</span>}
            <Badge
              label={dashboardSourceLabel(sourceLabel)}
              color={isDark ? "bg-slate-900 text-slate-300 border border-white/10" : dashboardSourceColor(sourceLabel)}
            />
          </div>
        </div>
        <div className="flex gap-1">
          <Btn
            variant="secondary"
            icon={<RefreshIcon size={13} className={refreshing ? "animate-spin" : ""} />}
            onClick={() => refreshDashboard(true)}
            disabled={refreshing}
          >
            {t("dashboard.refresh")}
          </Btn>
          <Btn variant="teal" icon={<PlayIcon size={13} />}>{t("dashboard.runPipeline")}</Btn>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
        <QuickActionCard
          icon={BriefIcon}
          title={t("dashboard.quickActionCards.createProposalTitle")}
          description={t("dashboard.quickActionCards.createProposalDescription")}
          badges={proposalBadges}
          buttonLabel={t("dashboard.quickActionCards.createProposalButton")}
          ariaLabel={t("dashboard.quickActionCards.createProposalAria")}
          onClick={() => onNavigate("content", { openCreateContentModal: true })}
          metrics={[
            { label: t("dashboard.quickActionCards.proposalsCreated"), value: proposalQuickMetrics.created },
            { label: t("dashboard.quickActionCards.proposalsApproved"), value: proposalQuickMetrics.approved },
            { label: t("dashboard.quickActionCards.proposalsSent"), value: proposalQuickMetrics.sent },
            { label: t("dashboard.quickActionCards.salesWon"), value: proposalQuickMetrics.won },
          ]}
        />
        <QuickActionCard
          icon={Share2Icon}
          title={t("dashboard.quickActionCards.socialMarketingTitle")}
          description={t("dashboard.quickActionCards.socialMarketingDescription")}
          badges={campaignBadges}
          buttonLabel={t("dashboard.quickActionCards.createCampaignButton")}
          ariaLabel={t("dashboard.quickActionCards.createCampaignAria")}
          onClick={startCampaignFlow}
          metrics={[
            { label: t("dashboard.quickActionCards.savedCampaigns"), value: campaignQuickMetrics.saved || 0 },
            { label: t("dashboard.quickActionCards.generatedPosts"), value: campaignQuickMetrics.posts },
            { label: t("dashboard.quickActionCards.sentEmails"), value: campaignQuickMetrics.emailsSent },
            { label: t("dashboard.quickActionCards.responses"), value: campaignQuickMetrics.replies },
          ]}
          accent="teal"
        />
      </div>

      {/* Full-funnel KPI row */}
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {kpiCards.map((card) => (
          <KpiCard
            key={card.label}
            icon={card.icon}
            label={card.label}
            value={card.value}
            sub={card.sub}
            color={card.color}
            ariaLabel={card.aria}
            title={card.aria}
            onClick={() => navigate(card.page, card.state)}
          />
        ))}
      </div>

      {/* Full-funnel visualization */}
      <Card className="p-3">
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-semibold text-gray-900">{t("dashboard.funnel.title")}</p>
          <div className="flex gap-1 text-xs text-gray-400">
            <span>{t("dashboard.funnel.intelligence")}</span><span>→</span><span>{t("dashboard.funnel.content")}</span><span>→</span><span>{t("dashboard.funnel.outreach")}</span><span>→</span><span>{t("dashboard.funnel.conversion")}</span>
          </div>
        </div>
        <div className="space-y-1.5">
          {funnelRows.map((f) => (
            <button
              key={f.label}
              type="button"
              onClick={() => navigate(f.page, f.state)}
              aria-label={`Open ${f.label}`}
              title={`Open ${f.label}`}
              className="w-full flex items-center gap-1.5 rounded-lg px-2 py-1 text-left cursor-pointer transition-colors hover:bg-gray-50 active:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            >
              <span className="w-5 text-gray-500">{f.icon}</span>
              <span className="text-xs text-gray-600 w-56 shrink-0">{f.label}</span>
              <div className={`flex-1 h-5 rounded-full overflow-hidden ${isDark ? "bg-[#0F172A] border border-white/10" : "bg-gray-100"}`}><div className={`h-full ${f.color} rounded-full transition-all`} style={{width:f.w}} /></div>
              <span className="text-xs font-semibold text-gray-700 w-10 text-right">{f.val}</span>
            </button>
          ))}
        </div>
      </Card>

      {/* Two-column: Activity + Content impact */}
      <div className="grid grid-cols-2 gap-2">
        <Card className="p-2">
          <p className="text-xs font-semibold text-gray-700 mb-1.5">{t("dashboard.pipelineActivity")}</p>
          <div className="h-32 bg-gradient-to-t from-indigo-50 to-transparent rounded-lg flex items-end justify-around px-4 pb-2">
            {funnelRows.map((row, i) => (
              <button
                key={row.label}
                type="button"
                onClick={() => navigate(row.page, row.state)}
                aria-label={`Open ${row.label}`}
                title={`Open ${row.label}`}
                className="w-5 h-full flex items-end justify-center rounded hover:bg-white/60"
              >
                <span className="w-2 rounded-t" style={{height: row.w, background: i % 2 === 0 ? "#818cf8" : "#2dd4bf"}} />
              </button>
            ))}
          </div>
          <div className="flex justify-center gap-2 mt-2">
            <span className="flex items-center gap-1 text-xs text-gray-500"><span className="w-2 h-2 rounded bg-indigo-400"/>{t("dashboard.chart.emails")}</span>
            <span className="flex items-center gap-1 text-xs text-gray-500"><span className="w-2 h-2 rounded bg-teal-400"/>{t("dashboard.chart.replies")}</span>
          </div>
        </Card>
        <Card className="p-2">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs font-semibold text-gray-700">{t("dashboard.contentUsed")}</p>
            <button
              type="button"
              onClick={() => navigate("content", { typeFilter: "All" })}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-700"
            >
              View all
            </button>
          </div>
          {contentUsed.length === 0 ? (
            <div className="py-8 text-center text-xs text-gray-400 border border-dashed border-gray-200 rounded-xl">
              No data yet
            </div>
          ) : (
            <div className="space-y-1.5">
              {contentUsed.map((c, index) => {
                const colors = ["bg-indigo-500", "bg-teal-500", "bg-amber-500", "bg-purple-500"];
                return (
                  <button
                    key={c.id || c.title}
                    type="button"
                    onClick={() => navigate("content", { typeFilter: c.type === "Proposal" ? "Proposals" : "All" })}
                    aria-label={`Open content asset ${c.title}`}
                    title={`Open content asset ${c.title}`}
                    className="w-full flex items-center gap-1 rounded-lg px-1 py-1 text-left cursor-pointer transition-colors hover:bg-gray-50 active:bg-gray-100"
                  >
                    <div className={`w-1 h-8 rounded-full ${colors[index % colors.length]}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-gray-800 truncate">{c.title}</p>
                      <p className="text-xs text-gray-400">{c.type || "Asset"}</p>
                    </div>
                    <span className="text-xs font-semibold text-gray-600">{Number(c.uses || 0)}x</span>
                  </button>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Latest pipeline run */}
      <Card className="p-2">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs font-semibold text-gray-700">{lastPipelineRunLabel} - {lastUpdated}</p>
          <Badge label={t("dashboard.completed")} color="bg-green-100 text-green-700" />
        </div>
        <div className="flex items-center gap-1">
          {pipelineSteps.map((s, i) => (
            <div key={s.label} className="flex items-center gap-1 flex-1">
              <div className="flex-1">
                <div className="flex items-center gap-1 mb-1">
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center text-white text-xs ${s.done ? s.color : "bg-gray-300"}`}>
                    {s.done ? <CheckIcon size={10} /> : i + 1}
                  </div>
                  <span className="text-xs font-medium text-gray-700">{s.label}</span>
                </div>
                <p className="text-xs text-gray-400 ml-6">{s.sub}</p>
              </div>
              {i < 5 && <div className={`w-6 h-0.5 ${s.done ? s.color : "bg-gray-200"}`} />}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  PAGE: OPPORTUNITIES (merged Leads + Customers)                 */
/* ═══════════════════════════════════════════════════════════════ */
function OpportunityProposalModal({ opportunity, onClose }) {
  const { t } = useI18n();
  const { language: activeLanguage } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const [step, setStep] = useState(1);
  const [pricingRows, setPricingRows] = useState([]);
  const [generationModal, setGenerationModal] = useState(null);
  const [proposal, setProposal] = useState(null);
  const [draftContent, setDraftContent] = useState("");
  const [editingPreview, setEditingPreview] = useState(false);
  const { toasts, setToast, removeToast, pauseToast, resumeToast } = useToastQueue();
  const proposalPreviewRef = useRef(null);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const opportunityTags = opportunity?.kw || opportunity?.tags || [];
  const contentUsed = opportunity?.content && opportunity.content !== "—" && opportunity.content !== "â€”" ? opportunity.content : t("opportunitiesPage.proposalModal.none");
  const proposalForm = {
    name: `${opportunity?.company || "Opportunity"} Proposal`,
    customer: opportunity?.company || "",
    template: "NoonDalton Standard Proposal",
    date: new Date().toISOString().slice(0, 10),
    tags: opportunityTags.join(", "),
  };
  const opportunitySummary = `${opportunity?.company} is evaluating support for ${opportunity?.job}. The current stage is ${opportunity?.stage}, with a fit score of ${opportunity?.score}%. Primary tags: ${opportunityTags.join(", ") || "not specified"}.`;
  const pricingTotal = calculateProposalTotal({ pricingRows }).totalAmount;
  const progressSteps = t("opportunitiesPage.proposalModal.steps");
  const [proposalLanguage, setProposalLanguage] = useState(activeLanguage || getStoredPreference(PREF_KEYS.language, "en"));
  useEffect(() => {
    setProposalLanguage(activeLanguage || getStoredPreference(PREF_KEYS.language, "en"));
  }, [activeLanguage]);
  const opportunityLanguageLabels = {
    en: "English",
    es: "Español",
    pt: "Português",
  };
  const proposalLength = "standard";

  const updatePricingRow = (id, field, value) => {
    setPricingRows((current) => current.map((row) => row.id === id ? { ...row, [field]: value } : row));
  };
  const addPricingRow = () => {
    setPricingRows((current) => [...current, { id: Date.now(), service: "", description: "", quantity: 1, unitPrice: 0 }]);
  };
  const removePricingRow = (id) => setPricingRows((current) => current.filter((row) => row.id !== id));

  const getOpportunityProfile = () => {
    const text = [
      opportunity?.company,
      opportunity?.job,
      opportunity?.role,
      opportunity?.content,
      ...opportunityTags,
    ].join(" ").toLowerCase();

    if (/hospital|clinic|health|healthcare|medical|patient|medtech/.test(text)) {
      return {
        industry: "Healthcare",
        executiveFocus: "improve patient support, operational responsiveness, and back-office reliability without increasing administrative load on clinical teams",
        problems: [
          "High-volume administrative work competes with patient-facing priorities.",
          "Support and documentation workflows depend on manual handoffs across teams.",
          "Leadership needs better visibility into service levels, response times, and follow-up quality.",
        ],
        solution: "Deploy an AI-assisted operations layer that triages inbound requests, structures documentation tasks, routes exceptions to the right team, and gives managers a clear view of throughput and quality.",
        technologies: ["AI workflow orchestration", "Document classification", "CRM/helpdesk integration", "Human-in-the-loop quality review", "Operational analytics dashboard"],
        roi: "Reduced administrative backlog, faster response cycles, fewer missed follow-ups, and more consistent patient or stakeholder communication.",
      };
    }

    if (/restaurant|food|pizzeria|pizza|hospitality|dining|kitchen/.test(text)) {
      return {
        industry: "Restaurant & Hospitality",
        executiveFocus: "increase booking, ordering, and customer follow-up efficiency while keeping service quality consistent during peak demand",
        problems: [
          "Customer inquiries, catering requests, and follow-ups are handled inconsistently during busy periods.",
          "Manual coordination between front-of-house, operations, and marketing slows response time.",
          "The business needs repeatable outreach and customer engagement without adding management overhead.",
        ],
        solution: "Implement AI-assisted customer engagement workflows for inquiry intake, follow-up messaging, local campaign content, and operational task routing.",
        technologies: ["AI customer response assistant", "Campaign content generator", "Lightweight CRM pipeline", "Automation triggers", "Performance reporting"],
        roi: "Faster response to customer requests, higher conversion from inquiries, better repeat-customer engagement, and less manual coordination for managers.",
      };
    }

    if (/finance|fintech|bank|accounting|payable|invoice|data entry|back office/.test(text)) {
      return {
        industry: "Finance & Back Office",
        executiveFocus: "scale finance operations with stronger accuracy, faster processing, and better audit visibility",
        problems: [
          "Manual data entry and reconciliation create cycle-time and quality risks.",
          "Back-office demand fluctuates while accuracy requirements remain high.",
          "Managers need clearer visibility into throughput, exceptions, and service performance.",
        ],
        solution: "Introduce an AI-enabled BPO workflow that structures incoming work, validates data, flags exceptions, and supports specialists with reusable operating procedures.",
        technologies: ["AI data extraction", "Exception detection", "Workflow automation", "Secure document handling", "KPI reporting"],
        roi: "Lower processing cost per transaction, improved accuracy, faster turnaround, and stronger operational controls.",
      };
    }

    if (/retail|ecommerce|store|customer|support|sales|inventory/.test(text)) {
      return {
        industry: "Retail & Customer Operations",
        executiveFocus: "improve customer support, sales follow-up, and operational responsiveness across distributed retail workflows",
        problems: [
          "Customer and operational requests arrive through multiple channels with inconsistent follow-up.",
          "Manual support workflows limit responsiveness during demand spikes.",
          "Teams need reusable content and process visibility to improve conversion and retention.",
        ],
        solution: "Create an AI-assisted operations workflow for customer triage, follow-up content, sales enablement assets, and performance tracking.",
        technologies: ["AI support triage", "CRM workflow automation", "Content personalization", "Knowledge base retrieval", "Conversion analytics"],
        roi: "Higher follow-up consistency, faster support resolution, improved conversion from warm opportunities, and better visibility into customer demand.",
      };
    }

    return {
      industry: "B2B Operations",
      executiveFocus: "turn a qualified opportunity into a structured, measurable operating model supported by AI and specialist delivery",
      problems: [
        "The opportunity requires faster execution without adding unnecessary management complexity.",
        "Current workflows depend on manual coordination and inconsistent follow-up.",
        "Leadership needs a clearer path from initial interest to measurable business impact.",
      ],
      solution: "Deploy a practical AI-assisted workflow that combines specialist delivery, reusable content, structured follow-up, and performance reporting.",
      technologies: ["Workflow automation", "CRM-ready opportunity tracking", "Content generation", "Human quality review", "Performance dashboard"],
      roi: "Shorter sales and delivery cycles, improved follow-up quality, lower manual effort, and clearer conversion metrics.",
    };
  };

  const buildOpportunityProposalData = () => {
    const profile = getOpportunityProfile();
    return {
      title: proposalForm.name,
      client: proposalForm.customer,
      contact: opportunity?.contact || "",
      stage: opportunity?.stage || "N/A",
      score: opportunity?.score,
      totalAmount: pricingTotal,
      industry: profile.industry,
      serviceLine: proposalForm.template,
      executiveSummary: `${proposalForm.customer} has a qualified opportunity to ${profile.executiveFocus}. NoonDalton proposes a focused AI-enabled delivery model that combines workflow automation, specialist execution, and management visibility. This proposal is based on the current opportunity for ${opportunity?.job || "the identified need"}, with a pipeline stage of ${opportunity?.stage || "N/A"} and a qualification score of ${opportunity?.score || "N/A"}%.`,
      problemsIdentified: profile.problems,
      proposedSolution: `${profile.solution} The solution will be configured around ${opportunityTags.length ? opportunityTags.join(", ") : "the client's core operating requirements"} and will use relevant existing content such as ${contentUsed} when appropriate.`,
      technologiesUsed: profile.technologies,
      lineItems: pricingRows.map(normalizeLineItem),
      expectedROI: `${profile.roi} Success will be measured through operational throughput, response time, quality indicators, and conversion progress from the current opportunity stage.`,
      nextSteps: [
        `Confirm scope and priority workflows with ${opportunity?.contact || "the client contact"}.`,
        "Validate pricing assumptions and service volumes.",
        "Approve implementation timeline and kickoff responsibilities.",
        "Prepare the final proposal package for stakeholder review.",
      ],
    };
  };

  const buildOpportunityProposalHtml = (structuredContent = buildOpportunityProposalData()) =>
    proposalDocumentToHtml({ ...structuredContent, structuredContent, pricingRows, totalAmount: structuredContent.totalAmount });

  const buildOpportunityBackendPayload = (structuredContent, total) => ({
    title: proposalForm.name,
    description: opportunitySummary,
    proposal_description: opportunitySummary,
    detailed_description: [
      `Opportunity: ${opportunity?.job || "N/A"}`,
      `Company: ${opportunity?.company || "N/A"}`,
      `Contact: ${opportunity?.contact || "N/A"}`,
      `Role: ${opportunity?.role || "N/A"}`,
      `Stage: ${opportunity?.stage || "N/A"}`,
      `Score: ${opportunity?.score ?? "N/A"}`,
      `Keywords: ${opportunityTags.join(", ") || "N/A"}`,
      `Content used: ${contentUsed}`,
    ].join("\n"),
    team_sizing: "",
    length: proposalLength,
    language: proposalLanguage,
    custom_prompt: `Generate a proposal for this opportunity using the provided company, role, stage, score, keywords, and content context. Keep the proposal specific to ${opportunity?.company || "the client"} and the opportunity ${opportunity?.job || "identified"}.`,
    status: "draft",
    customer_name: proposalForm.customer,
    clientName: proposalForm.customer,
    template: proposalForm.template,
    tags: opportunityTags,
    pricing_rows: pricingRows,
    lineItems: pricingRows.map(normalizeLineItem),
    total_amount: total.totalAmount,
    structured_content: {
      ...structuredContent,
      length: proposalLength,
      language: proposalLanguage,
    },
    opportunity: {
      company: opportunity?.company,
      title: opportunity?.job,
      contact: opportunity?.contact,
      role: opportunity?.role,
      stage: opportunity?.stage,
      score: opportunity?.score,
      contentUsed,
      lastActivity: opportunity?.date,
    },
  });

  const generateProposal = async () => {
    setGenerationModal({ title: proposalForm.name, activeStep: 0, completedSteps: [], progress: 5 });
    try {
      const savingDraftStep = Math.max(0, progressSteps.length - 2);
      for (let index = 0; index < savingDraftStep; index += 1) {
        setGenerationModal((current) => ({
          ...current,
          activeStep: index,
          progress: Math.round((index / savingDraftStep) * 82) + 5,
        }));
        await wait(450);
        setGenerationModal((current) => ({
          ...current,
          completedSteps: [...new Set([...(current?.completedSteps || []), index])],
          progress: Math.round(((index + 1) / savingDraftStep) * 85),
        }));
      }
      setGenerationModal((current) => ({
        ...current,
        activeStep: savingDraftStep,
        progress: 90,
      }));

      const structuredContent = buildOpportunityProposalData();
      const total = calculateProposalTotal({ pricingRows });
      const draftProposal = await createProposal(buildOpportunityBackendPayload(structuredContent, total));
      const generatedBackendProposal = await generateProposalById(draftProposal.id, {
        title: proposalForm.name,
        description: opportunitySummary,
        proposalDescription: opportunitySummary,
        proposal_description: opportunitySummary,
        detailedDescription: [
          `Opportunity: ${opportunity?.job || "N/A"}`,
          `Company: ${opportunity?.company || "N/A"}`,
          `Contact: ${opportunity?.contact || "N/A"}`,
          `Role: ${opportunity?.role || "N/A"}`,
          `Stage: ${opportunity?.stage || "N/A"}`,
          `Score: ${opportunity?.score ?? "N/A"}`,
          `Keywords: ${opportunityTags.join(", ") || "N/A"}`,
          `Content used: ${contentUsed}`,
        ].join("\n"),
        teamSizing: "",
        length: proposalLength,
        clientName: proposalForm.customer,
        customer: proposalForm.customer,
        template: proposalForm.template,
        tags: opportunityTags,
        lineItems: pricingRows.map(normalizeLineItem),
        totalAmount: total.totalAmount,
        language: proposalLanguage,
        customPrompt: `Generate a proposal for this opportunity using the provided company, role, stage, score, keywords, and content context. Keep the proposal specific to ${opportunity?.company || "the client"} and the opportunity ${opportunity?.job || "identified"}.`,
      });
      const backendStructuredContent = normalizeProposalDocument({
        ...generatedBackendProposal,
        structuredContent: generatedBackendProposal.structuredContent || generatedBackendProposal.structured_content,
        pricingRows: generatedBackendProposal.pricingRows || generatedBackendProposal.pricing_rows || pricingRows,
        lineItems: generatedBackendProposal.lineItems || pricingRows,
        totalAmount: generatedBackendProposal.totalAmount ?? generatedBackendProposal.total_amount ?? total.totalAmount,
        language: generatedBackendProposal.language || proposalLanguage,
      });
      const content = proposalDocumentToHtml({
        ...generatedBackendProposal,
        structuredContent: backendStructuredContent,
        pricingRows,
        totalAmount: backendStructuredContent.totalAmount,
      });
      const generatedProposal = {
        ...generatedBackendProposal,
        id: generatedBackendProposal.id || draftProposal.id,
        title: proposalForm.name,
        type: "Proposal",
        status: "generated",
        description: opportunitySummary,
        content,
        structuredContent: backendStructuredContent,
        ...backendStructuredContent,
        customerName: proposalForm.customer,
        date: proposalForm.date,
        template: proposalForm.template,
        pricingRows,
        totalAmount: backendStructuredContent.totalAmount ?? total.totalAmount,
        tags: opportunityTags,
        length: proposalLength,
        language: proposalLanguage,
        opportunity: {
          company: opportunity?.company,
          title: opportunity?.job,
          contact: opportunity?.contact,
          role: opportunity?.role,
          stage: opportunity?.stage,
          score: opportunity?.score,
          contentUsed,
          lastActivity: opportunity?.date,
        },
        updated: "Today",
      };
      setDraftContent(content);
      setProposal(generatedProposal);
      setStep(3);
      setGenerationModal((current) => ({
        ...current,
        activeStep: progressSteps.length - 1,
        completedSteps: progressSteps.map((_, index) => index),
        progress: 100,
        error: null,
      }));
      await wait(250);
      setGenerationModal(null);
    } catch (error) {
      console.error(error);
      setGenerationModal((current) => ({ ...current, error: t("opportunitiesPage.proposalModal.errorGenerating") }));
    }
  };

  const saveDraft = async () => {
    if (!proposal) return;
    if (!proposal.id) {
      setToast({ type: "error", message: t("opportunitiesPage.proposalModal.errorGenerating") });
      return;
    }
    const nextProposal = { ...proposal, content: draftContent || proposal.content };
    const structuredContent = normalizeProposalDocument(nextProposal);
    const total = calculateProposalTotal(nextProposal);
    const updatedProposal = {
      ...nextProposal,
      structuredContent,
      ...structuredContent,
      content: proposalDocumentToHtml({ ...nextProposal, structuredContent }),
      status: "draft",
      totalAmount: total.totalAmount,
      updated: "Today",
    };
    try {
      await updateProposal(proposal.id, {
        title: updatedProposal.title,
        description: updatedProposal.description || "",
        content: updatedProposal.content,
        structured_content: structuredContent,
        status: "draft",
        total_amount: total.totalAmount,
      });
      setProposal(updatedProposal);
      setToast(t("opportunitiesPage.proposalModal.draftSaved"));
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: t("opportunitiesPage.proposalModal.errorGenerating") });
    }
  };

  const downloadDraft = async (format) => {
    if (!proposal) return;
    await exportProposalDocument({ ...proposal, content: draftContent || proposal.content }, format, proposalPreviewRef.current);
  };

  if (!opportunity) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <ToastStack
        toasts={toasts}
        onClose={removeToast}
        onMouseEnter={pauseToast}
        onMouseLeave={resumeToast}
      />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-4xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{t("opportunitiesPage.proposalModal.title")}</h2>
            <p className="text-xs text-gray-500">{opportunity.company} · {opportunity.job}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100"><XIcon size={16} className="text-gray-400" /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {[t("opportunitiesPage.proposalModal.opportunityContext"), t("opportunitiesPage.proposalModal.pricing"), t("opportunitiesPage.proposalModal.proposalPreview")].map((label, index) => (
              <button
                key={label}
                onClick={() => proposal || index < 2 ? setStep(index + 1) : null}
                className={`rounded-lg border px-2 py-2 text-xs font-medium ${step === index + 1 ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-gray-100 bg-gray-50 text-gray-500"}`}
              >
                {t("opportunitiesPage.proposalModal.step")} {index + 1}<br />{label}
              </button>
            ))}
          </div>

          {step === 1 && (
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("opportunitiesPage.proposalModal.customer")}><Input value={proposalForm.customer} readOnly /></Field>
              <Field label={t("opportunitiesPage.proposalModal.proposalName")}><Input value={proposalForm.name} readOnly /></Field>
              <Field label={t("opportunitiesPage.proposalModal.template")}><Input value={proposalForm.template} readOnly /></Field>
              <Field label={t("opportunitiesPage.proposalModal.tags")}><Input value={proposalForm.tags} readOnly /></Field>
              <Field label={activeLanguage === "es" ? "Idioma de la propuesta" : activeLanguage === "pt" ? "Idioma da proposta" : "Proposal language"}>
                <Select value={proposalLanguage} onChange={(event) => setProposalLanguage(event.target.value)}>
                  {Object.entries(opportunityLanguageLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </Select>
              </Field>
              <div className="col-span-2">
                <Field label={t("opportunitiesPage.proposalModal.opportunityContext")}>
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-xs text-gray-700">
                    <div className="grid grid-cols-4 gap-3">
                      <div><span className="text-gray-400">{t("opportunitiesPage.proposalModal.opportunity")}</span><p className="font-semibold text-gray-900">{opportunity?.job}</p></div>
                      <div><span className="text-gray-400">{t("opportunitiesPage.proposalModal.contact")}</span><p className="font-semibold text-gray-900">{opportunity?.contact}</p></div>
                      <div><span className="text-gray-400">{t("opportunitiesPage.proposalModal.role")}</span><p className="font-semibold text-gray-900">{opportunity?.role}</p></div>
                      <div><span className="text-gray-400">{t("opportunitiesPage.proposalModal.score")}</span><p className="font-semibold text-gray-900">{opportunity?.score}%</p></div>
                    </div>
                    <p className="mt-3 leading-relaxed">{opportunitySummary}</p>
                  </div>
                </Field>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <div className="overflow-x-auto border border-gray-100 rounded-xl">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50 text-gray-500">
                    <tr>
                      <th className="px-2 py-2 text-left">{t("opportunitiesPage.proposalModal.serviceUnit")}</th>
                      <th className="px-2 py-2 text-left">{t("opportunitiesPage.proposalModal.description")}</th>
                      <th className="px-2 py-2 text-left">{t("opportunitiesPage.proposalModal.qty")}</th>
                      <th className="px-2 py-2 text-left">{t("opportunitiesPage.proposalModal.unitPrice")}</th>
                      <th className="px-2 py-2 text-right">{t("opportunitiesPage.proposalModal.subtotal")}</th>
                      <th className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {pricingRows.length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-400">{t("opportunitiesPage.proposalModal.noPricing")}</td></tr>
                    )}
                    {pricingRows.map((row) => (
                      <tr key={row.id} className="border-t border-gray-100">
                        <td className="p-2"><Input value={row.service} onChange={(e) => updatePricingRow(row.id, "service", e.target.value)} /></td>
                        <td className="p-2"><Input value={row.description} onChange={(e) => updatePricingRow(row.id, "description", e.target.value)} /></td>
                        <td className="p-2 w-20"><Input type="number" min="0" value={row.quantity} onChange={(e) => updatePricingRow(row.id, "quantity", e.target.value)} /></td>
                        <td className="p-2 w-28"><Input type="number" min="0" value={row.unitPrice} onChange={(e) => updatePricingRow(row.id, "unitPrice", e.target.value)} /></td>
                        <td className="p-2 text-right font-semibold text-gray-700">{formatUsd(Number(row.quantity || 0) * Number(row.unitPrice || 0))}</td>
                        <td className="p-2"><button onClick={() => removePricingRow(row.id)} className="p-1 rounded hover:bg-red-50"><TrashIcon size={12} className="text-red-500" /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between">
                <Btn variant="secondary" small icon={<PlusIcon size={12} />} onClick={addPricingRow}>{t("opportunitiesPage.proposalModal.addLineItem")}</Btn>
                <div className="text-sm text-gray-700">{t("opportunitiesPage.proposalModal.totalAmount")}: <strong>{pricingTotal ? formatUsd(pricingTotal) : t("opportunitiesPage.proposalModal.notCalculated")}</strong></div>
              </div>
            </div>
          )}

          {step === 3 && proposal && (
            <div className="space-y-4">
              <div className={`rounded-2xl border overflow-hidden ${isDark ? "border-white/10" : "border-gray-100"}`}>
                {editingPreview ? (
                  <div
                    className={`max-h-[55vh] overflow-y-auto rounded-xl border p-6 text-sm shadow-sm prose max-w-none ${isDark ? "border-white/10 bg-slate-800 text-slate-100 prose-invert" : "border-indigo-200 bg-white text-gray-800 ring-2 ring-indigo-100 prose-slate"}`}
                    contentEditable
                    suppressContentEditableWarning
                    dangerouslySetInnerHTML={{ __html: draftContent }}
                    onBlur={(e) => setDraftContent(e.currentTarget.innerHTML)}
                  />
                ) : (
                  <ProposalDocumentPreview
                    proposal={{ ...proposal, content: draftContent || proposal.content }}
                    exportRef={proposalPreviewRef}
                    className={`max-h-[55vh] overflow-y-auto rounded-xl border p-8 shadow-sm ${isDark ? "border-white/10 bg-slate-800 text-slate-100" : "border-gray-200 bg-white text-gray-800"}`}
                  />
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between p-5 border-t border-gray-100 bg-gray-50 rounded-b-2xl">
          <Btn variant="ghost" onClick={onClose}>{t("opportunitiesPage.proposalModal.close")}</Btn>
          <div className="flex gap-2">
            {step === 1 && <Btn icon={<ArrowRightIcon size={13} />} onClick={() => setStep(2)}>{t("opportunitiesPage.proposalModal.continuePricing")}</Btn>}
            {step === 2 && <Btn icon={<SparkIcon size={13} />} onClick={generateProposal}>{t("opportunitiesPage.proposalModal.generateDraft")}</Btn>}
            {step === 3 && proposal && (
              <>
                <Btn variant="secondary" icon={<PenIcon size={12} />} onClick={() => setEditingPreview((current) => !current)}>
                  {editingPreview ? t("opportunitiesPage.proposalModal.doneEditing") : t("opportunitiesPage.proposalModal.edit")}
                </Btn>
                <Btn variant="secondary" icon={<SaveIcon size={12} />} onClick={saveDraft}>{t("opportunitiesPage.proposalModal.saveDraft")}</Btn>
                <Btn variant="secondary" icon={<DownloadIcon size={12} />} onClick={() => downloadDraft("docx")}>{t("opportunitiesPage.proposalModal.exportDocx")}</Btn>
                <Btn icon={<DownloadIcon size={12} />} onClick={() => downloadDraft("pdf")}>{t("opportunitiesPage.proposalModal.exportPdf")}</Btn>
                <Btn variant="secondary" disabled>{t("opportunitiesPage.proposalModal.crmNext")}</Btn>
              </>
            )}
          </div>
        </div>
      </div>
      <ProgressModal
        title={`${t("opportunitiesPage.proposalModal.generating")}: ${generationModal?.title || proposalForm.name}`}
        steps={progressSteps}
        state={generationModal}
        onCancel={() => setGenerationModal(null)}
        onRetry={generateProposal}
      />
    </div>
  );
}

function CreateOpportunityModal({ open, onClose, onCreated }) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    company: "",
    job: "",
    contact: "",
    role: "",
    contactEmail: "",
    stage: "Detected",
    source: "",
    kw: "",
    content: "",
    date: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [validation, setValidation] = useState({});

  const update = (field) => (event) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
    setValidation((current) => ({ ...current, [field]: "" }));
    setError("");
  };

  const reset = () => {
    setForm({
      company: "",
      job: "",
      contact: "",
      role: "",
      contactEmail: "",
      stage: "Detected",
      source: "",
      kw: "",
      content: "",
      date: "",
    });
    setError("");
    setValidation({});
  };

  const close = () => {
    if (saving) return;
    reset();
    onClose();
  };

  const submit = async () => {
    const nextValidation = {};
    if (!form.company.trim()) nextValidation.company = t("opportunitiesPage.createModal.required");
    if (!form.job.trim()) nextValidation.job = t("opportunitiesPage.createModal.required");
    setValidation(nextValidation);
    if (Object.keys(nextValidation).length > 0) return;

    const payload = {
      company: form.company.trim(),
      job: form.job.trim(),
      contact: form.contact.trim(),
      role: form.role.trim(),
      contactEmail: form.contactEmail.trim(),
      stage: form.stage,
      source: form.source.trim(),
      kw: normalizeOpportunityKeywords(form.kw),
      content: form.content.trim(),
      date: form.date.trim(),
    };

    setSaving(true);
    setError("");
    try {
      await opportunitiesApi.create(payload);
      reset();
      onClose();
      onCreated();
    } catch (err) {
      console.error(err);
      setError(t("opportunitiesPage.createModal.createError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title={t("opportunitiesPage.createModal.title")} maxWidth="2xl">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("opportunitiesPage.createModal.company")}>
          <Input value={form.company} onChange={update("company")} placeholder={t("opportunitiesPage.createModal.companyPlaceholder")} />
          {validation.company && <p className="mt-1 text-xs text-red-600">{validation.company}</p>}
        </Field>
        <Field label={t("opportunitiesPage.createModal.job")}>
          <Input value={form.job} onChange={update("job")} placeholder={t("opportunitiesPage.createModal.jobPlaceholder")} />
          {validation.job && <p className="mt-1 text-xs text-red-600">{validation.job}</p>}
        </Field>
        <Field label={t("opportunitiesPage.createModal.contact")}>
          <Input value={form.contact} onChange={update("contact")} />
        </Field>
        <Field label={t("opportunitiesPage.createModal.role")}>
          <Input value={form.role} onChange={update("role")} />
        </Field>
        <Field label={t("opportunitiesPage.createModal.contactEmail")}>
          <Input type="email" value={form.contactEmail} onChange={update("contactEmail")} />
        </Field>
        <Field label={t("opportunitiesPage.createModal.stage")}>
          <Select value={form.stage} onChange={update("stage")}>
            {OPPORTUNITY_STAGES.filter((stage) => stage !== "All").map((stage) => (
              <option key={stage} value={stage}>{t(`opportunitiesPage.stages.${stageTranslationKey(stage)}`)}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("opportunitiesPage.createModal.source")}>
          <Input value={form.source} onChange={update("source")} />
        </Field>
        <Field label={t("opportunitiesPage.createModal.date")}>
          <Input value={form.date} onChange={update("date")} placeholder={t("opportunitiesPage.createModal.datePlaceholder")} />
        </Field>
        <div className="sm:col-span-2">
          <Field label={t("opportunitiesPage.createModal.keywords")} hint={t("opportunitiesPage.createModal.keywordsHint")}>
            <Input value={form.kw} onChange={update("kw")} placeholder={t("opportunitiesPage.createModal.keywordsPlaceholder")} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label={t("opportunitiesPage.createModal.content")}>
            <Input value={form.content} onChange={update("content")} />
          </Field>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Btn variant="secondary" onClick={close} disabled={saving}>{t("common.cancel")}</Btn>
        <Btn onClick={submit} disabled={saving}>{saving ? t("opportunitiesPage.createModal.saving") : t("opportunitiesPage.createModal.save")}</Btn>
      </div>
    </Modal>
  );
}

function OpportunitiesPage({ navigationState = {}, onNavigate = () => {}, campaignFlow = null, setCampaignFlow = () => {} }) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const [stageFilter, setStageFilter] = useState(navigationState.stageFilter || "All");
  const [proposalOpportunity, setProposalOpportunity] = useState(null);
  const [opportunities, setOpportunities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedOpportunities, setSelectedOpportunities] = useState(campaignFlow?.selectedOpportunities || []);
  const stages = OPPORTUNITY_STAGES;
  const stageCounts = getOpportunityStageCounts(opportunities);

  const loadOpportunities = async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await opportunitiesApi.list();
      setOpportunities(asArray(data).map(normalizeOpportunity));
    } catch (err) {
      console.error(err);
      setError(t("opportunitiesPage.loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOpportunities();
  }, []);

  useEffect(() => {
    setStageFilter(navigationState.stageFilter || "All");
  }, [navigationState.stageFilter]);

  useEffect(() => {
    if (campaignFlow?.currentStep === 1) {
      setSelectedOpportunities(campaignFlow.selectedOpportunities || []);
    }
  }, [campaignFlow?.currentStep]);

  const toggleFlowOpportunity = (opportunity) => {
    if (!campaignFlow) return;
    setSelectedOpportunities((current) => {
      const exists = current.some((item) => item.id === opportunity.id);
      return exists
        ? current.filter((item) => item.id !== opportunity.id)
        : [...current, opportunity];
    });
  };

  const filtered = opportunities.filter((o) => {
    if (stageFilter !== "All" && !stageMatches(o, stageFilter)) return false;
    if (navigationState.minScore && Number(o.score || 0) < navigationState.minScore) return false;
    if (navigationState.hasContact && !o.contact) return false;
    return true;
  });
  const exportOpportunities = () => {
    if (opportunities.length === 0) return;
    exportOpportunitiesWorkbook(opportunities);
  };
  const campaignAudienceStep = campaignFlow?.currentStep === 1;

  return (
    <div className="space-y-2">
      {campaignFlow?.currentStep === 1 && (
        <div className="flow-step-banner">
          <span>👥 Step 1: Select the opportunities to target with this campaign</span>
          <button
            type="button"
            disabled={selectedOpportunities.length === 0}
            onClick={() => {
              setCampaignFlow((prev) => ({
                ...prev,
                currentStep: 2,
                completedSteps: Array.from(new Set([...(prev.completedSteps || []), 1])),
                selectedOpportunities,
              }));
              onNavigate("campaign_brief");
            }}
          >
            Continue to Brief →
          </button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("opportunitiesPage.title")}</h1>
          <p className="text-xs text-gray-500">{t("opportunitiesPage.subtitle")}</p>
        </div>
        <div className="flex gap-1">
          <Btn variant="secondary" icon={<DownloadIcon size={13} />} onClick={exportOpportunities} disabled={opportunities.length === 0}>
            {t("opportunitiesPage.exportExcel")}
          </Btn>
          <Btn icon={<PlusIcon size={14} />} onClick={() => setShowCreateModal(true)}>{t("opportunitiesPage.addManually")}</Btn>
        </div>
      </div>

      {/* Stage pipeline visualization */}
      <Card className="p-2">
        <div className="flex gap-1">
          {stages.map(s => {
            const count = stageCounts[s] || 0;
            const active = stageFilter === s;
            return (
              <button key={s} onClick={() => setStageFilter(s)}
                className={`flex-1 py-4 px-2 rounded-lg text-xs font-medium transition-colors text-center ${
                  active
                    ? "bg-indigo-600 text-white"
                    : isDark
                      ? "bg-slate-800 text-slate-300 border border-white/10 hover:bg-slate-700"
                      : "bg-gray-50 text-gray-600 hover:bg-gray-100"
                }`}>
                <span className="block">{t(`opportunitiesPage.stages.${stageTranslationKey(s)}`)}</span>
                <span className={`text-lg font-bold ${active ? "text-white" : isDark ? "text-slate-100" : "text-gray-900"}`}>{count}</span>
              </button>
            );
          })}
        </div>
      </Card>

      {/* Opportunities table */}
      <Card>
        {loading ? (
          <div className="px-4 py-10 text-center text-sm text-gray-500">{t("opportunitiesPage.loading")}</div>
        ) : error ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium text-red-600">{error}</p>
            <Btn className="mt-3" variant="secondary" small onClick={loadOpportunities}>{t("opportunitiesPage.retry")}</Btn>
          </div>
        ) : opportunities.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium text-gray-700">{t("opportunitiesPage.emptyTitle")}</p>
            <p className="mt-1 text-xs text-gray-500">{t("opportunitiesPage.emptyDescription")}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium text-gray-700">{t("opportunitiesPage.emptyFiltered")}</p>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead><tr className="bg-slate-50 text-slate-600 uppercase">
              {campaignAudienceStep && <th className="w-10 px-4 py-2.5 text-left font-medium" />}
              <th className="px-4 py-2.5 text-left font-medium">{t("opportunitiesPage.columns.company")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("opportunitiesPage.columns.opportunity")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("opportunitiesPage.columns.contact")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("opportunitiesPage.columns.stage")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("opportunitiesPage.columns.score")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("opportunitiesPage.columns.contentUsed")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("opportunitiesPage.columns.lastActivity")}</th>
              {!campaignAudienceStep && <th className="px-4 py-2.5 text-right font-medium">{t("opportunitiesPage.columns.actions")}</th>}
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((o) => {
                const selectedForFlow = campaignAudienceStep && selectedOpportunities.some((item) => item.id === o.id);
                return (
                <tr
                  key={o.id || `${o.company}-${o.job}`}
                  onClick={() => campaignAudienceStep && toggleFlowOpportunity(o)}
                  className={`hover:bg-slate-50 ${campaignAudienceStep ? "cursor-pointer border-l-4" : ""} ${selectedForFlow ? "border-l-indigo-500 bg-indigo-50/60" : campaignAudienceStep ? "border-l-transparent" : ""}`}
                >
                  {campaignAudienceStep && (
                    <td className="px-4 py-4">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        checked={selectedForFlow}
                        onChange={() => toggleFlowOpportunity(o)}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`Select ${o.company}`}
                      />
                    </td>
                  )}
                  <td className="px-4 py-4">
                    <p className="font-medium text-gray-900">{o.company}</p>
                    <div className="flex gap-1 mt-0.5">{o.kw.map(k => <span key={k} className={`px-1.5 py-0.5 rounded text-xs ${isDark ? "bg-[#0F172A] text-slate-300 border border-white/10" : "bg-indigo-50 text-indigo-600"}`}>{k}</span>)}</div>
                  </td>
                  <td className="px-4 py-4 text-indigo-600 font-medium">{o.job}</td>
                  <td className="px-4 py-4">
                    <p className="text-gray-800">{o.contact}</p>
                    <p className="text-gray-400">{o.role}</p>
                  </td>
                  <td className="px-4 py-4"><StageBadge stage={o.stage} /></td>
                  <td className="px-4 py-4"><span className={`text-xs font-bold ${o.score >= 80 ? "text-green-600" : o.score >= 70 ? "text-amber-600" : "text-gray-500"}`}>{o.score}%</span></td>
                  <td className="px-4 py-4">
                    {validContentRef(o.content) ? (
                      <span className="inline-flex items-center gap-1 text-xs text-indigo-600"><LinkIcon size={10} />{o.content}</span>
                    ) : <span className="text-gray-300">-</span>}
                  </td>
                  <td className="px-4 py-4 text-gray-500">{o.date}</td>
                  {!campaignAudienceStep && (
                    <td className="px-4 py-4 text-right">
                      <Btn small icon={<SparkIcon size={12} />} onClick={(event) => {
                        event.stopPropagation();
                        setProposalOpportunity(o);
                      }}>
                        {t("opportunitiesPage.generateProposal")}
                      </Btn>
                    </td>
                  )}
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      <CreateOpportunityModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={loadOpportunities}
      />
      {proposalOpportunity && (
        <OpportunityProposalModal
          opportunity={proposalOpportunity}
          onClose={() => setProposalOpportunity(null)}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  PAGE: CONTENT LIBRARY (merged Assets, Proposals, Templates)    */
/* ═══════════════════════════════════════════════════════════════ */
function ContentLibraryPage({ navigationState = {}, onNavigate = () => {}, campaignFlow = null, setCampaignFlow = () => {} }) {
  const { t } = useI18n();
  const { language: activeLanguage } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const [proposals, setProposals] = useState([]);
  const [libraryItems, setLibraryItems] = useState([]);
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [typeFilter, setTypeFilter] = useState(navigationState.typeFilter || "All");
  const [statusFilter, setStatusFilter] = useState(navigationState.statusFilter || "");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createType, setCreateType] = useState("Proposal");
  const [contentLanguage, setContentLanguage] = useState(getStoredPreference(PREF_KEYS.language, "en"));
  const [editingProposal, setEditingProposal] = useState(null);
  const [viewingProposal, setViewingProposal] = useState(null);
  const [viewingContentItem, setViewingContentItem] = useState(null);
  const [viewingCampaignContent, setViewingCampaignContent] = useState(null);
  const [socialPublishStatus, setSocialPublishStatus] = useState(null);
  const [contentTitle, setContentTitle] = useState("");
  const [contentDescription, setContentDescription] = useState("");
  const [detailedDescription, setDetailedDescription] = useState("");
  const [teamSizing, setTeamSizing] = useState("");
  const [proposalLength, setProposalLength] = useState("standard");
  const [proposalContentSource, setProposalContentSource] = useState("ai");
  const [proposalLanguage, setProposalLanguage] = useState(getStoredPreference(PREF_KEYS.language, "en"));
  const [proposalLanguageManuallySelected, setProposalLanguageManuallySelected] = useState(false);
  const [proposalCustomPrompt, setProposalCustomPrompt] = useState("");
  const [contentAiStep, setContentAiStep] = useState(1);
  const [contentAiForm, setContentAiForm] = useState({
    client_name: "",
    industry: "",
    region: "",
    duration_months: 3,
    challenge: "",
    solution: "",
    metric_1_label: "",
    metric_1_value: "",
    metric_2_label: "",
    metric_2_value: "",
    metric_3_label: "",
    metric_3_value: "",
    testimonial_quote: "",
    testimonial_name: "",
    testimonial_role: "",
    title: "",
    subtitle: "",
    topic: "",
    target_audience: "",
    key_sections: "",
    abstract: "",
    template_name: "",
    channel: "Email",
    category: "follow_up",
    tone: "Friendly",
    use_case: "",
    merge_variables: "first_name, company, use_case",
    product_name: "",
    tagline: "",
    features: "",
    cta_text: "",
    cta_url: "",
    platform: "LinkedIn",
    key_points: "",
  });
  const [generatedContentItem, setGeneratedContentItem] = useState(null);
  const [contentGenerating, setContentGenerating] = useState(false);
  const [structuredEditingProposalId, setStructuredEditingProposalId] = useState(null);
  const [generationModal, setGenerationModal] = useState(null);
  const [wizardStep, setWizardStep] = useState(1);
  const { toasts, setToast, removeToast, pauseToast, resumeToast } = useToastQueue();
  const [deletedContentIds, setDeletedContentIds] = useState(readDeletedContentIds);
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(0);
  const [proposalForm, setProposalForm] = useState({
    name: "BPO Proposal for Finance",
    customer: "",
    template: "NoonDalton Standard Proposal",
    date: new Date().toISOString().slice(0, 10),
    tags: [],
    tax: 0,
    discount: 0,
  });
  const [customProposalTag, setCustomProposalTag] = useState("");
  const [pricingRows, setPricingRows] = useState([
    { id: 1, service: "Discovery and Solution Design", description: "Customer context, requirements, and implementation plan.", quantity: 1, unitPrice: 1200 },
    { id: 2, service: "AI Workflow Implementation", description: "Configuration of the main automation and operational workflow.", quantity: 1, unitPrice: 3800 },
  ]);
  const [draftHtml, setDraftHtml] = useState("");
  const viewingProposalPreviewRef = useRef(null);
  const createProposalPreviewRef = useRef(null);
  const proposalEditorRef = useRef(null);
  const editorSessionRef = useRef(0);
  useEffect(() => {
    if (editingProposal && proposalEditorRef.current) {
      proposalEditorRef.current.innerHTML = editingProposal.draftContent || "";
    }
    // Only re-seed the editable DOM when a (re)opened proposal loads, never on
    // keystrokes — otherwise React's dangerouslySetInnerHTML re-render fights
    // the browser's own contentEditable mutations and crashes on delete.
    // Keyed off editSession (not proposal.id) so it still fires when the same
    // proposal is reopened or when id is missing/duplicated across drafts.
  }, [editingProposal?.editSession]);
  const resetCreateContentForm = () => {
    setWizardStep(1);
    setContentTitle("");
    setContentDescription("");
    setDetailedDescription("");
    setTeamSizing("");
    setProposalLength("standard");
    setProposalContentSource("ai");
    setProposalLanguage(platformGenerationLanguage);
    setProposalLanguageManuallySelected(false);
    setProposalCustomPrompt("");
    setContentAiStep(1);
    setContentAiForm({
      client_name: "",
      industry: "",
      region: "",
      duration_months: 3,
      challenge: "",
      solution: "",
      metric_1_label: "",
      metric_1_value: "",
      metric_2_label: "",
      metric_2_value: "",
      metric_3_label: "",
      metric_3_value: "",
      testimonial_quote: "",
      testimonial_name: "",
      testimonial_role: "",
      title: "",
      subtitle: "",
      topic: "",
      target_audience: "",
      key_sections: "",
      abstract: "",
      template_name: "",
      channel: "Email",
      category: "follow_up",
      tone: "Friendly",
      use_case: "",
      merge_variables: "first_name, company, use_case",
      product_name: "",
      tagline: "",
      features: "",
      cta_text: "",
      cta_url: "",
      platform: "LinkedIn",
      key_points: "",
    });
    setGeneratedContentItem(null);
    setContentGenerating(false);
    setStructuredEditingProposalId(null);
    setProposalForm({
      name: "BPO Proposal for Finance",
      customer: "",
      template: "NoonDalton Standard Proposal",
      date: new Date().toISOString().slice(0, 10),
      tags: [],
      tax: 0,
      discount: 0,
    });
    setCustomProposalTag("");
    setPricingRows([
      { id: 1, service: "Discovery and Solution Design", description: "Customer context, requirements, and implementation plan.", quantity: 1, unitPrice: 1200 },
      { id: 2, service: "AI Workflow Implementation", description: "Configuration of the main automation and operational workflow.", quantity: 1, unitPrice: 3800 },
    ]);
    setDraftHtml("");
  };
  const openCreateContentModal = (type = createType) => {
    resetCreateContentForm();
    setCreateType(type);
    setShowCreateModal(true);
  };
  const closeCreateContentModal = () => {
    setShowCreateModal(false);
    resetCreateContentForm();
  };

  useEffect(() => {
    if (navigationState.typeFilter) {
      setTypeFilter(navigationState.typeFilter);
      if (!navigationState.statusFilter) setStatusFilter("");
    }
    if (navigationState.statusFilter) {
      setStatusFilter(navigationState.statusFilter);
      setTypeFilter("Proposals");
    }
  }, [navigationState.typeFilter, navigationState.statusFilter]);

  useEffect(() => {
    if (navigationState.openCreateContentModal) {
      openCreateContentModal("Proposal");
    }
  }, [navigationState.openCreateContentModal]);

  useEffect(() => {
    const refreshLibrary = () => setLibraryRefreshKey((current) => current + 1);
    window.addEventListener("marketgen:content-library-updated", refreshLibrary);
    return () => window.removeEventListener("marketgen:content-library-updated", refreshLibrary);
  }, []);

  useEffect(() => {
    if (viewingCampaignContent) refreshPublishStatus();
  }, [viewingCampaignContent]);

  useEffect(() => {
    setContentLanguage(activeLanguage || getStoredPreference(PREF_KEYS.language, "en"));
    if (!proposalLanguageManuallySelected) {
      setProposalLanguage(activeLanguage || getStoredPreference(PREF_KEYS.language, "en"));
    }
  }, [activeLanguage, proposalLanguageManuallySelected]);

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const money = formatUsd;
  const publishPlatforms = [
    { platform: "facebook", label: "Facebook" },
    { platform: "twitter", label: "Twitter / X" },
    { platform: "linkedin", label: "LinkedIn" },
  ];
  const refreshPublishStatus = async () => {
    try {
      const { data } = await socialApi.status();
      setSocialPublishStatus(data);
    } catch (error) {
      console.error(error);
      setSocialPublishStatus(null);
    }
  };
  const publishSocialPost = async (platform, post, copyText) => {
    try {
      const { data } = await socialApi.publish({
        platform,
        title: post.headline || viewingCampaignContent?.title || "",
        content: copyText,
      });
      if (data?.shareUrl) {
        window.open(data.shareUrl, "_blank", "noopener,noreferrer");
      }
      setToast({ type: "success", message: `Opened ${data?.platform || platform} publisher.` });
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: error.response?.data?.detail || "Connect this social account in Settings first." });
    }
  };
  const createCopy = {
    en: {
      openCreate: "Create Content",
      modalTitle: "Create Content",
      modalSubtitle: "Add a new item to your Content Library",
      contentType: "Content Type",
      title: "Title",
      titleExample: "BPO Proposal for [Client]",
      templateTitleExample: "Follow-up after demo",
      assetTitleExample: "Marketing Automation Playbook",
      proposalDescription: "Proposal Description",
      proposalDescriptionPlaceholder: "Describe the client's challenge, goals, desired outcome, and business problem...",
      detailedDescription: "Detailed Process Description",
      detailedDescriptionPlaceholder: "Example: Receive requests by email, validate documents, enter data into the ERP, route exceptions to a supervisor, and send a daily completion report.",
      teamSizing: "Team to Quote",
      teamSizingPlaceholder: "6 back office agents + 1 supervisor, Philippines",
      length: "Length",
      brief: "Brief",
      standard: "Standard",
      extended: "Extended",
      proposalLanguage: "Proposal Language",
      detected: "detected",
      english: "English",
      spanish: "Español",
      portuguese: "Português",
      description: "Description",
      descriptionHint: "Brief summary - the AI will use this when referencing your content in outreach emails.",
      descriptionPlaceholder: "What is this content about? What value does it demonstrate?",
      proposalDetails: "Proposal Details",
      servicesPricing: "Services & Pricing",
      reviewProposal: "Review Proposal",
      step: "Step",
      customer: "Customer",
      customerPlaceholder: "Enter customer name",
      template: "Template",
      tags: "Tags",
      customTagPlaceholder: "Add custom tag...",
      contentSource: "Content Source",
      generateWithAi: "Generate with AI",
      generateWithAiHint: "Based on title and tags",
      uploadFile: "Upload file",
      uploadFileHint: "PDF, DOCX, text",
      manual: "Manual",
      manualHint: "Write draft",
      cancel: "Cancel",
      saveDraft: "Save as Draft",
      back: "Back",
      continue: "Continue",
      continuePricing: "Continue to Services & Pricing",
      generateDraft: "Generate Proposal Draft",
      regenerate: "Regenerate Proposal",
      editStructure: "Edit Structure",
      adjustmentInstructions: "Adjustment Instructions",
      adjustmentInstructionsPlaceholder: "Example: Frame it as a commercial offer and emphasize benefits instead of problems.",
      downloadDocx: "Download DOCX",
      downloadPdf: "Download PDF",
      uploadCrm: "Upload to CRM",
      crmQueued: "CRM upload queued",
      comingSoon: "Coming Soon",
      titleRequired: "Proposal title is required before continuing",
      customerRequired: "Customer is required before continuing",
      templateRequired: "Template is required before continuing",
      proposalDescriptionRequired: "Proposal Description is required before generating a proposal",
      tagLimit: "You can select up to 6 tags.",
      draftSaved: "Draft saved",
      proposalGenerated: "Proposal draft generated successfully",
      proposalRegenerated: "Proposal regenerated successfully",
      generationFailedDraftSaved: "Generation failed; your draft was saved",
      draftCreationFailed: "The proposal draft could not be saved",
      aiCreatesContent: "AI creates the content based on title and tags",
      uploadExistingFile: "Upload existing file",
      uploadExistingFileHint: "PDF, DOCX, or plain text",
      writeManually: "Write manually",
      writeManuallyHint: "Enter content directly in the editor",
      serviceUnit: "Service / Unit",
      serviceDescription: "Description",
      qty: "Qty",
      unitPrice: "Unit Price",
      subtotal: "Subtotal",
      addLineItem: "Add Line Item",
      tax: "Tax",
      discount: "Discount",
      totalAmount: "Total Amount",
      noPricing: "No pricing items added yet.",
      reviewDetails: "Proposal details",
      reviewPricing: "Services and pricing",
      notProvided: "Not provided",
      generatingProposal: "Generating proposal",
      estimatedTime: "Estimated time: 10 - 15 seconds",
      complete: "complete",
      retry: "Retry",
      proposalSteps: [
        "Analyzing customer context",
        "Loading proposal template",
        "Processing service units and pricing",
        "Calculating totals",
        "Generating executive summary",
        "Creating solution section",
        "Building pricing and ROI section",
        "Formatting proposal draft",
        "Preparing preview",
        "Completed",
      ],
    },
    es: {
      openCreate: "Crear Contenido",
      modalTitle: "Crear Contenido",
      modalSubtitle: "Agrega un nuevo elemento a tu Content Library",
      contentType: "Tipo de contenido",
      title: "Título",
      titleExample: "Propuesta BPO para [Cliente]",
      templateTitleExample: "Seguimiento después de demo",
      assetTitleExample: "Playbook de automatización de marketing",
      proposalDescription: "Descripción de la propuesta",
      proposalDescriptionPlaceholder: "Describe el desafío del cliente, objetivos, resultado esperado y problema de negocio...",
      detailedDescription: "Descripción detallada del proceso",
      detailedDescriptionPlaceholder: "Ejemplo: Recibir solicitudes por email, validar documentos, ingresar datos al ERP, derivar excepciones a un supervisor y enviar un reporte diario de finalización.",
      teamSizing: "Equipo a cotizar",
      teamSizingPlaceholder: "6 agentes back office + 1 supervisor, Filipinas",
      length: "Extensión",
      brief: "Breve",
      standard: "Estándar",
      extended: "Extensa",
      proposalLanguage: "Idioma de la propuesta",
      detected: "detectado",
      english: "English",
      spanish: "Español",
      portuguese: "Português",
      description: "Descripción",
      descriptionHint: "Resumen breve - la IA lo usará al referenciar este contenido en emails.",
      descriptionPlaceholder: "¿De qué trata este contenido? ¿Qué valor demuestra?",
      proposalDetails: "Detalles de la Propuesta",
      servicesPricing: "Servicios y Precios",
      reviewProposal: "Revisar Propuesta",
      step: "Paso",
      customer: "Cliente",
      customerPlaceholder: "Ingrese nombre del cliente",
      template: "Template",
      tags: "Etiquetas",
      customTagPlaceholder: "Agregar etiqueta personalizada...",
      contentSource: "Fuente de contenido",
      generateWithAi: "Generar con IA",
      generateWithAiHint: "Segun titulo y etiquetas",
      uploadFile: "Subir archivo",
      uploadFileHint: "PDF, DOCX, texto",
      manual: "Manual",
      manualHint: "Escribir borrador",
      cancel: "Cancelar",
      saveDraft: "Guardar borrador",
      back: "Atrás",
      continue: "Continuar",
      continuePricing: "Continuar a Servicios y Precios",
      generateDraft: "Generar borrador de propuesta",
      regenerate: "Regenerar propuesta",
      editStructure: "Editar estructura",
      adjustmentInstructions: "Instrucciones de ajuste",
      adjustmentInstructionsPlaceholder: "Ej.: enfócalo como oferta comercial, destaca beneficios en vez de problemas.",
      downloadDocx: "Descargar DOCX",
      downloadPdf: "Descargar PDF",
      uploadCrm: "Subir al CRM",
      crmQueued: "Subida al CRM en cola",
      comingSoon: "Próximamente",
      titleRequired: "El título de la propuesta es obligatorio antes de continuar",
      customerRequired: "El cliente es obligatorio antes de continuar",
      templateRequired: "El template es obligatorio antes de continuar",
      proposalDescriptionRequired: "La descripción de la propuesta es obligatoria antes de generar",
      tagLimit: "Puedes seleccionar hasta 6 etiquetas.",
      draftSaved: "Borrador guardado",
      proposalGenerated: "Borrador de propuesta generado correctamente",
      proposalRegenerated: "Propuesta regenerada correctamente",
      generationFailedDraftSaved: "La generación falló; tu borrador quedó guardado",
      draftCreationFailed: "No se pudo guardar el borrador de la propuesta",
      aiCreatesContent: "La IA crea el contenido según título y etiquetas",
      uploadExistingFile: "Subir archivo existente",
      uploadExistingFileHint: "PDF, DOCX o texto plano",
      writeManually: "Escribir manualmente",
      writeManuallyHint: "Ingresar contenido directamente en el editor",
      serviceUnit: "Servicio / Unidad",
      serviceDescription: "Descripción",
      qty: "Cant.",
      unitPrice: "Precio unitario",
      subtotal: "Subtotal",
      addLineItem: "Agregar ítem",
      tax: "Impuesto",
      discount: "Descuento",
      totalAmount: "Monto total",
      noPricing: "Aún no se agregaron servicios.",
      reviewDetails: "Detalles de la propuesta",
      reviewPricing: "Servicios y precios",
      notProvided: "No informado",
      generatingProposal: "Generando propuesta",
      estimatedTime: "Tiempo estimado: 10 - 15 segundos",
      complete: "completado",
      retry: "Reintentar",
      proposalSteps: [
        "Analizando contexto del cliente",
        "Cargando template de propuesta",
        "Procesando servicios y precios",
        "Calculando totales",
        "Generando resumen ejecutivo",
        "Creando sección de solución",
        "Construyendo precios y ROI",
        "Formateando borrador",
        "Preparando vista previa",
        "Completado",
      ],
    },
    pt: {
      openCreate: "Criar Conteudo",
      modalTitle: "Criar Conteudo",
      modalSubtitle: "Adicione um novo item a sua Content Library",
      contentType: "Tipo de conteudo",
      title: "Titulo",
      titleExample: "Proposta BPO para [Cliente]",
      templateTitleExample: "Follow-up apos demo",
      assetTitleExample: "Playbook de automacao de marketing",
      proposalDescription: "Descricao da proposta",
      proposalDescriptionPlaceholder: "Descreva o desafio do cliente, objetivos, resultado desejado e problema de negocio...",
      detailedDescription: "Descricao detalhada do processo",
      detailedDescriptionPlaceholder: "Exemplo: Receber solicitacoes por email, validar documentos, inserir dados no ERP, encaminhar excecoes a um supervisor e enviar um relatorio diario de conclusao.",
      teamSizing: "Equipe a cotar",
      teamSizingPlaceholder: "6 agentes de back office + 1 supervisor, Filipinas",
      length: "Extensao",
      brief: "Breve",
      standard: "Padrao",
      extended: "Extensa",
      proposalLanguage: "Idioma da proposta",
      detected: "detectado",
      english: "English",
      spanish: "Español",
      portuguese: "Português",
      description: "Descricao",
      descriptionHint: "Resumo breve - a IA usara isto ao referenciar seu conteudo em emails.",
      descriptionPlaceholder: "Sobre o que e este conteudo? Que valor ele demonstra?",
      proposalDetails: "Detalhes da Proposta",
      servicesPricing: "Servicos e Precos",
      reviewProposal: "Revisar Proposta",
      step: "Etapa",
      customer: "Cliente",
      customerPlaceholder: "Insira o nome do cliente",
      template: "Template",
      tags: "Etiquetas",
      customTagPlaceholder: "Adicionar etiqueta personalizada...",
      contentSource: "Fonte de conteudo",
      generateWithAi: "Gerar com IA",
      generateWithAiHint: "Com base no titulo e etiquetas",
      uploadFile: "Enviar arquivo",
      uploadFileHint: "PDF, DOCX, texto",
      manual: "Manual",
      manualHint: "Escrever rascunho",
      cancel: "Cancelar",
      saveDraft: "Salvar rascunho",
      back: "Voltar",
      continue: "Continuar",
      continuePricing: "Continuar para Servicos e Precos",
      generateDraft: "Gerar rascunho da proposta",
      regenerate: "Regenerar proposta",
      editStructure: "Editar estrutura",
      adjustmentInstructions: "Instrucoes de ajuste",
      adjustmentInstructionsPlaceholder: "Ex.: apresente como oferta comercial e destaque beneficios em vez de problemas.",
      downloadDocx: "Baixar DOCX",
      downloadPdf: "Baixar PDF",
      uploadCrm: "Enviar ao CRM",
      crmQueued: "Envio ao CRM na fila",
      comingSoon: "Em breve",
      titleRequired: "O titulo da proposta e obrigatorio antes de continuar",
      customerRequired: "O cliente e obrigatorio antes de continuar",
      templateRequired: "O template e obrigatorio antes de continuar",
      proposalDescriptionRequired: "A descricao da proposta e obrigatoria antes de gerar",
      tagLimit: "Voce pode selecionar ate 6 etiquetas.",
      draftSaved: "Rascunho salvo",
      proposalGenerated: "Rascunho da proposta gerado com sucesso",
      proposalRegenerated: "Proposta regenerada com sucesso",
      generationFailedDraftSaved: "A geração falhou; seu rascunho foi salvo",
      draftCreationFailed: "Nao foi possivel salvar o rascunho da proposta",
      aiCreatesContent: "A IA cria o conteudo com base no titulo e etiquetas",
      uploadExistingFile: "Enviar arquivo existente",
      uploadExistingFileHint: "PDF, DOCX ou texto simples",
      writeManually: "Escrever manualmente",
      writeManuallyHint: "Inserir conteudo diretamente no editor",
      serviceUnit: "Servico / Unidade",
      serviceDescription: "Descricao",
      qty: "Qtd.",
      unitPrice: "Preco unitario",
      subtotal: "Subtotal",
      addLineItem: "Adicionar item",
      tax: "Imposto",
      discount: "Desconto",
      totalAmount: "Valor total",
      noPricing: "Nenhum servico adicionado ainda.",
      reviewDetails: "Detalhes da proposta",
      reviewPricing: "Servicos e precos",
      notProvided: "Nao informado",
      generatingProposal: "Gerando proposta",
      estimatedTime: "Tempo estimado: 10 - 15 segundos",
      complete: "concluido",
      retry: "Tentar novamente",
      proposalSteps: [
        "Analisando contexto do cliente",
        "Carregando template da proposta",
        "Processando servicos e precos",
        "Calculando totais",
        "Gerando resumo executivo",
        "Criando secao de solucao",
        "Construindo precos e ROI",
        "Formatando rascunho",
        "Preparando visualizacao",
        "Concluido",
      ],
    },
  };
  const createT = createCopy[contentLanguage] || createCopy.en;
  const proposalLanguageLabels = {
    en: createT.english,
    es: createT.spanish,
    pt: createT.portuguese,
  };
  const proposalSteps = createT.proposalSteps;
  const contentTypeOptions = ["Case Study", "Proposal", "Template", "Whitepaper", "Social Post", "One-Pager"];
  const aiContentTypes = ["Case Study", "Whitepaper", "Template", "One-Pager", "Social Post"];
  const isAiContentType = aiContentTypes.includes(createType);
  const contentTypeEndpoint = {
    "Case Study": "case-study",
    Whitepaper: "whitepaper",
    Template: "template",
    "One-Pager": "one-pager",
    "Social Post": "social-post",
  };
  const contentTypeBackendType = {
    "Case Study": "case_study",
    Whitepaper: "whitepaper",
    Template: "template",
    "One-Pager": "one_pager",
    "Social Post": "social_post",
  };
  const contentTypeTitleField = {
    "Case Study": "client_name",
    Whitepaper: "title",
    Template: "template_name",
    "One-Pager": "product_name",
    "Social Post": "topic",
  };
  const maxProposalTags = 6;
  const pricingSubtotal = pricingRows.reduce((sum, row) => sum + Number(row.quantity || 0) * Number(row.unitPrice || 0), 0);
  const pricingTotal = calculateProposalTotal({
    pricingRows,
    tax: proposalForm.tax,
    discount: proposalForm.discount,
  }).totalAmount || 0;
  const defaultProposalTags = ["Lead Generation", "Email Marketing", "Outreach", "Sales Enablement", "Content Marketing", "B2B Marketing", "Marketing Automation", "CRM", "Personalization", "Campaign Strategy", "Conversion Optimization", "Analytics", "AI Content", "Proposal Automation"];
  const normalizeTags = (tags) => Array.isArray(tags)
    ? tags.map((tag) => String(tag).trim()).filter(Boolean)
    : String(tags || "").split(",").map((tag) => tag.trim()).filter(Boolean);
  const proposalTags = normalizeTags(proposalForm.tags);
  const allProposalTags = [...new Set([...defaultProposalTags, ...proposalTags])];
  const canContinueProposalSetup = proposalForm.name.trim() && proposalForm.customer.trim();
  const updateProposalForm = (field, value) => setProposalForm((current) => ({ ...current, [field]: value }));
  const updateContentAiForm = (field, value) => setContentAiForm((current) => ({ ...current, [field]: value }));
  const splitListInput = (value) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  const contentAiLabel = (key) => t(`contentLibrary.aiFields.${key}`);
  const platformGenerationLanguage = proposalLanguage || activeLanguage || contentLanguage || getStoredPreference(PREF_KEYS.language, "en") || "en";
  const backendPdfContentTypes = new Set(["Case Study", "Whitepaper", "Template", "One-Pager"]);
  const canUseBackendContentPdf = (item) => (
    item?.id
    && backendPdfContentTypes.has(item.type)
    && !String(item.id).startsWith("mock-")
    && !String(item.id).startsWith("ai-content-")
  );
  const downloadBackendContentPdf = async (item) => {
    const response = await api.get(`/content/generate/content-items/${item.id}/download`, {
      params: { format: "pdf" },
      responseType: "blob",
    });
    downloadBlob(response.data, `${sanitizeDownloadName(item.title || item.type || "content")}.pdf`);
  };
  const normalizeGeneratedContentItem = (item, type = createType) => ({
    id: item.id || `ai-content-${Date.now()}`,
    title: item.title || contentAiForm[contentTypeTitleField[type]] || type,
    type,
    assetType: item.type || contentTypeBackendType[type],
    status: "ready",
    description: stripHtml(item.content || "").slice(0, 180),
    industry: stripHtml(item.content || "").slice(0, 220) || type,
    services: ["AI"],
    uses: 0,
    date: item.updated_at || item.updatedAt || item.created_at || item.createdAt || new Date().toISOString(),
    updatedAt: item.updated_at || item.updatedAt || item.created_at || item.createdAt || new Date().toISOString(),
    content: item.content || "",
    rawContent: item.content || "",
    language: item.language || platformGenerationLanguage,
  });
  const isGeneratedContentType = (type) => ["Case Study", "Whitepaper", "Template", "One-Pager"].includes(type);
  const contentPreviewBadgeColor = (type) => ({
    "Case Study": "bg-green-100 text-green-700",
    Whitepaper: "bg-blue-100 text-blue-700",
    Template: "bg-orange-100 text-orange-700",
    "One-Pager": "bg-purple-100 text-purple-700",
  }[type] || "bg-gray-100 text-gray-600");
  const getCardPreview = (item) => {
    if (item.type === "Proposal") return item.description || "";
    const div = document.createElement("div");
    div.innerHTML = item.content || "";
    const text = div.textContent?.slice(0, 120) || "";
    return text ? `${text}${div.textContent.length > 120 ? "..." : ""}` : "";
  };
  const getRelativeDate = (dateStr) => {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return "";
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Updated just now";
    if (diffMins < 60) return `Updated ${diffMins}m ago`;
    if (diffHours < 24) return `Updated ${diffHours}h ago`;
    if (diffDays === 1) return "Updated yesterday";
    if (diffDays < 30) return `Updated ${diffDays} days ago`;
    if (diffDays < 365) return `Updated ${Math.floor(diffDays / 30)} months ago`;
    return `Updated ${Math.floor(diffDays / 365)} years ago`;
  };
  const getUpdatedDateValue = (item) => (
    item.updatedAt || item.updated_at || item.updated || item.createdAt || item.created_at || ""
  );
  const getUpdatedLabel = (item) => getRelativeDate(getUpdatedDateValue(item)) || (item.date ? `Updated ${item.date}` : "");
  const toggleProposalTag = (tag) => {
    setProposalForm((current) => {
      const currentTags = normalizeTags(current.tags);
      const exists = currentTags.some((item) => item.toLowerCase() === tag.toLowerCase());
      if (!exists && currentTags.length >= maxProposalTags) {
        setToast({ type: "warning", message: createT.tagLimit });
        return current;
      }
      return {
        ...current,
        tags: exists ? currentTags.filter((item) => item.toLowerCase() !== tag.toLowerCase()) : [...currentTags, tag],
      };
    });
  };
  const addCustomProposalTag = () => {
    const tag = customProposalTag.trim();
    if (!tag) return;
    setProposalForm((current) => {
      const currentTags = normalizeTags(current.tags);
      const exists = currentTags.some((item) => item.toLowerCase() === tag.toLowerCase());
      if (!exists && currentTags.length >= maxProposalTags) {
        setToast({ type: "warning", message: createT.tagLimit });
        return current;
      }
      return { ...current, tags: exists ? currentTags : [...currentTags, tag] };
    });
    setCustomProposalTag("");
  };
  const removeProposalTag = (tag) => {
    setProposalForm((current) => ({
      ...current,
      tags: normalizeTags(current.tags).filter((item) => item.toLowerCase() !== tag.toLowerCase()),
    }));
  };
  const goToProposalStep = (step) => {
    if (step > 1 && !proposalForm.customer.trim()) {
      setToast(createT.customerRequired);
      return;
    }
    if (step > 1 && !proposalForm.name.trim()) {
      setToast(createT.titleRequired);
      return;
    }
    setWizardStep(step);
  };
  const updatePricingRow = (id, field, value) => setPricingRows((current) => current.map((row) => row.id === id ? { ...row, [field]: value } : row));
  const addPricingRow = () => setPricingRows((current) => [...current, { id: Date.now(), service: "", description: "", quantity: 1, unitPrice: 0 }]);
  const removePricingRow = (id) => setPricingRows((current) => current.filter((row) => row.id !== id));
  const openProposalHtmlEditor = (proposal) => {
    editorSessionRef.current += 1;
    setViewingProposal(proposal);
    setEditingProposal({
      ...proposal,
      draftTitle: proposal.title || "",
      draftContent: proposalDocumentToHtml(proposal),
      editSession: editorSessionRef.current,
    });
  };
  const openStructuredProposalEditor = (proposal) => {
    const structured = proposal.structuredContent || proposal.structured_content || {};
    const sourceRows = proposal.pricingRows || proposal.pricing_rows || proposal.lineItems || structured.lineItems || structured.line_items || [];
    resetCreateContentForm();
    setStructuredEditingProposalId(proposal.id);
    setCreateType("Proposal");
    setProposalForm({
      name: proposal.title || structured.title || "",
      customer: proposal.customerName || proposal.clientName || proposal.client_name || structured.client || structured.customer || "",
      template: proposal.template || "NoonDalton Standard Proposal",
      date: proposal.date || new Date().toISOString().slice(0, 10),
      tags: normalizeTags(proposal.tags || structured.tags || []),
      tax: proposal.tax || 0,
      discount: proposal.discount || 0,
    });
    setContentDescription(proposal.proposalDescription || proposal.proposal_description || proposal.description || "");
    setDetailedDescription(proposal.detailedDescription || proposal.detailed_description || "");
    setTeamSizing(proposal.teamSizing || proposal.team_sizing || "");
    setProposalLength(proposal.length || "standard");
    setProposalLanguage(platformGenerationLanguage);
    setProposalLanguageManuallySelected(false);
    setProposalCustomPrompt(proposal.customPrompt || proposal.custom_prompt || "");
    setPricingRows(sourceRows.map((row, index) => ({
      id: row.id || `${proposal.id}-${index}`,
      service: row.service || row.name || "",
      description: row.description || "",
      quantity: row.quantity ?? row.qty ?? 1,
      unitPrice: row.unitPrice ?? row.unit_price ?? 0,
    })));
    setWizardStep(1);
    setViewingProposal(null);
    setEditingProposal(null);
    setShowCreateModal(true);
  };
  const detectProposalDomain = (context) => {
    const value = context.toLowerCase();
    if (/hospital|clinic|patient|medical|appointment|triage|clinical|healthcare|waiting list|waitlist|lista de espera|paciente|salud|medic/.test(value)) return "hospital";
    if (/restaurant|reservation|order|kitchen|menu|dining|food|chef|mesa|pedido|cocina|reserva/.test(value)) return "restaurant";
    if (/finance|financial|bank|audit|compliance|invoice|accounting|back office|data processing|financ|contab|auditor/.test(value)) return "finance";
    if (/marketing|lead|campaign|crm|outreach|email|conversion|content|sales enablement/.test(value)) return "marketing";
    return "general";
  };
  const buildContextualProposalStructure = (title = proposalForm.name) => {
    const description = contentDescription.trim();
    const customer = proposalForm.customer.trim();
    const tags = proposalTags.join(", ");
    const context = [description, customer, tags, title, proposalForm.template].filter(Boolean).join(" ");
    const domain = detectProposalDomain(context);
    const language = platformGenerationLanguage;
    const domainCopy = {
      en: {
        hospital: {
          industry: "Healthcare operations",
          problemFocus: ["patient waiting lists", "specialty appointment access", "patient prioritization", "scheduling coordination", "clinical operations visibility"],
          technologies: ["Waiting list automation", "Patient prioritization rules", "Appointment scheduling workflow", "Clinical operations dashboard", "Patient communication automation"],
          solution: "The proposed AI solution uses the proposal description as the operating brief: automate waiting list intake, classify patient priority, coordinate specialty appointment scheduling, and surface operational bottlenecks for clinical teams.",
          roi: "Expected impact includes shorter waiting times, better appointment utilization, clearer patient prioritization, fewer manual coordination tasks, and improved visibility across clinical operations.",
          nextSteps: ["Validate patient waiting list data sources and scheduling rules.", "Define triage and prioritization criteria with clinical stakeholders.", "Pilot the automated workflow for one specialty appointment queue."],
        },
        restaurant: {
          industry: "Restaurant operations",
          problemFocus: ["reservation flow", "order handling", "kitchen coordination", "customer experience", "service timing"],
          technologies: ["Reservation automation", "Order workflow orchestration", "Kitchen operations dashboard", "Customer communication automation", "Service performance analytics"],
          solution: "The proposed AI solution automates the restaurant workflow described in the proposal: coordinate reservations, orders, kitchen operations, and customer communication so staff can respond faster with better service visibility.",
          roi: "Expected impact includes faster table and order handling, fewer service bottlenecks, better kitchen coordination, and a more consistent customer experience.",
          nextSteps: ["Confirm reservation, order, and kitchen workflow data sources.", "Map peak service bottlenecks and customer communication points.", "Pilot automation on the highest-volume service workflow."],
        },
        finance: {
          industry: "Finance operations",
          problemFocus: ["back-office processing", "data quality", "compliance controls", "audit visibility", "operational reporting"],
          technologies: ["Back-office workflow automation", "Data processing controls", "Compliance rule checks", "Audit visibility dashboard", "Exception management"],
          solution: "The proposed AI solution automates the finance workflow described in the proposal: structure back-office processing, improve data quality, flag exceptions, and increase compliance and audit visibility.",
          roi: "Expected impact includes faster processing cycles, fewer manual errors, stronger compliance evidence, and clearer audit trails for operational teams.",
          nextSteps: ["Confirm source systems, control requirements, and audit evidence needs.", "Define exception rules and approval workflows.", "Pilot automation on one high-volume finance process."],
        },
        marketing: {
          industry: "Marketing automation",
          problemFocus: ["lead generation", "campaign automation", "CRM workflow", "outreach personalization", "conversion optimization"],
          technologies: ["Lead generation workflow", "Campaign automation", "CRM integration", "Outreach personalization", "Conversion analytics"],
          solution: "The proposed AI solution automates the marketing workflow described in the proposal: connect lead generation, campaign execution, CRM updates, personalized outreach, and conversion reporting.",
          roi: "Expected impact includes higher campaign throughput, faster lead follow-up, cleaner CRM activity, improved personalization, and clearer conversion measurement.",
          nextSteps: ["Confirm lead sources, CRM fields, and campaign rules.", "Define personalization and outreach approval criteria.", "Pilot automation on one priority campaign or segment."],
        },
        general: {
          industry: proposalTags[0] || "",
          problemFocus: ["the business problem described by the client", "desired operating outcomes", "manual coordination points", "data visibility gaps", "workflow accountability"],
          technologies: ["Workflow automation", "Context-aware AI assistance", "Operational dashboard", "Exception tracking", "Performance analytics"],
          solution: "The proposed AI solution is based on the proposal description: translate the client's challenge, goals, and desired outcomes into a focused automation workflow with clear operating controls.",
          roi: "Expected impact will be measured against the business problem described by the client, including cycle time, quality, visibility, and team workload.",
          nextSteps: ["Confirm the described business problem and target outcome.", "Map current workflow inputs, handoffs, and decision points.", "Pilot the focused automation workflow with measurable success criteria."],
        },
      },
      es: {
        hospital: {
          industry: "Operaciones clínicas",
          problemFocus: ["listas de espera de pacientes", "acceso a citas de especialidad", "priorización de pacientes", "coordinación de agenda médica", "visibilidad de operaciones clínicas"],
          technologies: ["Automatización de listas de espera", "Reglas de priorización de pacientes", "Flujo de programación de citas", "Panel de operaciones clínicas", "Automatización de comunicación con pacientes"],
          solution: "La solución de IA propuesta utiliza la descripción como brief operativo: automatizar el ingreso de listas de espera, clasificar prioridad de pacientes, coordinar citas de especialidad y visibilizar cuellos de botella para los equipos clínicos.",
          roi: "El impacto esperado incluye menor tiempo de espera, mejor utilización de agendas médicas, priorización más clara de pacientes, menos coordinación manual y mayor visibilidad de las operaciones clínicas.",
          nextSteps: ["Validar fuentes de datos de listas de espera y reglas de agenda médica.", "Definir criterios de triage y priorización con los equipos clínicos.", "Pilotear el flujo automatizado en una cola de citas de especialidad."],
        },
        restaurant: {
          industry: "Operaciones de restaurante",
          problemFocus: ["reservas", "gestión de pedidos", "coordinación de cocina", "experiencia del cliente", "tiempos de servicio"],
          technologies: ["Automatización de reservas", "Orquestación de pedidos", "Panel de operaciones de cocina", "Automatización de comunicación con clientes", "Analítica de desempeño del servicio"],
          solution: "La solución de IA propuesta automatiza el flujo descrito para coordinar reservas, pedidos, cocina y comunicación con clientes, permitiendo responder más rápido y con mejor visibilidad del servicio.",
          roi: "El impacto esperado incluye mayor velocidad en reservas y pedidos, menos cuellos de botella en servicio, mejor coordinación de cocina y una experiencia de cliente más consistente.",
          nextSteps: ["Confirmar fuentes de datos de reservas, pedidos y cocina.", "Mapear cuellos de botella en horarios punta y puntos de comunicación con clientes.", "Pilotear la automatización en el flujo de mayor volumen."],
        },
        finance: {
          industry: "Operaciones financieras",
          problemFocus: ["procesamiento back office", "calidad de datos", "controles de cumplimiento", "visibilidad de auditoría", "reportería operativa"],
          technologies: ["Automatización de back office", "Controles de procesamiento de datos", "Validaciones de cumplimiento", "Panel de visibilidad de auditoría", "Gestión de excepciones"],
          solution: "La solución de IA propuesta automatiza el flujo financiero descrito: estructurar procesamiento back office, mejorar calidad de datos, detectar excepciones y aumentar visibilidad de cumplimiento y auditoría.",
          roi: "El impacto esperado incluye ciclos de procesamiento más rápidos, menos errores manuales, evidencia de cumplimiento más sólida y trazabilidad clara para auditoría.",
          nextSteps: ["Confirmar sistemas fuente, requisitos de control y evidencia de auditoría.", "Definir reglas de excepción y flujos de aprobación.", "Pilotear la automatización en un proceso financiero de alto volumen."],
        },
        marketing: {
          industry: "Automatización de marketing",
          problemFocus: ["generación de leads", "automatización de campañas", "flujo CRM", "personalización de outreach", "optimización de conversión"],
          technologies: ["Flujo de generación de leads", "Automatización de campañas", "Integración CRM", "Personalización de outreach", "Analítica de conversión"],
          solution: "La solución de IA propuesta automatiza el flujo de marketing descrito: conectar generación de leads, ejecución de campañas, actualizaciones CRM, outreach personalizado y reportes de conversión.",
          roi: "El impacto esperado incluye mayor volumen de campañas, seguimiento más rápido de leads, actividad CRM más limpia, mejor personalización y medición más clara de conversión.",
          nextSteps: ["Confirmar fuentes de leads, campos CRM y reglas de campaña.", "Definir criterios de personalización y aprobación de outreach.", "Pilotear la automatización en una campaña o segmento prioritario."],
        },
        general: {
          industry: proposalTags[0] || "",
          problemFocus: ["el problema de negocio descrito por el cliente", "resultados operativos deseados", "puntos de coordinación manual", "brechas de visibilidad de datos", "responsabilidad del flujo de trabajo"],
          technologies: ["Automatización de flujos", "Asistencia de IA contextual", "Panel operativo", "Seguimiento de excepciones", "Analítica de desempeño"],
          solution: "La solución de IA propuesta se basa en la descripción: traducir el desafío, objetivos y resultado deseado del cliente en un flujo de automatización enfocado con controles operativos claros.",
          roi: "El impacto esperado se medirá contra el problema de negocio descrito, incluyendo tiempo de ciclo, calidad, visibilidad y carga operativa del equipo.",
          nextSteps: ["Confirmar el problema de negocio y resultado objetivo.", "Mapear entradas, traspasos y puntos de decisión del flujo actual.", "Pilotear el flujo automatizado con criterios de éxito medibles."],
        },
      },
      pt: {
        hospital: {
          industry: "Operações clínicas",
          problemFocus: ["listas de espera de pacientes", "acesso a consultas especializadas", "priorização de pacientes", "coordenação de agendamento", "visibilidade das operações clínicas"],
          technologies: ["Automação de listas de espera", "Regras de priorização de pacientes", "Fluxo de agendamento de consultas", "Painel de operações clínicas", "Automação de comunicação com pacientes"],
          solution: "A solução de IA proposta usa a descrição como brief operacional: automatizar a entrada de listas de espera, classificar prioridade de pacientes, coordenar consultas especializadas e expor gargalos para equipes clínicas.",
          roi: "O impacto esperado inclui menor tempo de espera, melhor utilização de agendas, priorização mais clara de pacientes, menos coordenação manual e maior visibilidade das operações clínicas.",
          nextSteps: ["Validar fontes de dados de listas de espera e regras de agendamento.", "Definir critérios de triagem e priorização com as equipes clínicas.", "Pilotar o fluxo automatizado em uma fila de consultas especializadas."],
        },
        restaurant: {
          industry: "Operações de restaurante",
          problemFocus: ["reservas", "gestão de pedidos", "coordenação de cozinha", "experiência do cliente", "tempo de serviço"],
          technologies: ["Automação de reservas", "Orquestração de pedidos", "Painel de operações de cozinha", "Automação de comunicação com clientes", "Análise de desempenho do serviço"],
          solution: "A solução de IA proposta automatiza o fluxo descrito para coordenar reservas, pedidos, cozinha e comunicação com clientes, permitindo respostas mais rápidas e melhor visibilidade do serviço.",
          roi: "O impacto esperado inclui maior velocidade em reservas e pedidos, menos gargalos no serviço, melhor coordenação da cozinha e experiência do cliente mais consistente.",
          nextSteps: ["Confirmar fontes de dados de reservas, pedidos e cozinha.", "Mapear gargalos em horários de pico e pontos de comunicação com clientes.", "Pilotar a automação no fluxo de maior volume."],
        },
        finance: {
          industry: "Operações financeiras",
          problemFocus: ["processamento back office", "qualidade dos dados", "controles de conformidade", "visibilidade de auditoria", "relatórios operacionais"],
          technologies: ["Automação de back office", "Controles de processamento de dados", "Validações de conformidade", "Painel de visibilidade de auditoria", "Gestão de exceções"],
          solution: "A solução de IA proposta automatiza o fluxo financeiro descrito: estruturar processamento back office, melhorar qualidade dos dados, sinalizar exceções e ampliar visibilidade de conformidade e auditoria.",
          roi: "O impacto esperado inclui ciclos de processamento mais rápidos, menos erros manuais, evidências de conformidade mais fortes e trilhas de auditoria claras.",
          nextSteps: ["Confirmar sistemas fonte, requisitos de controle e evidências de auditoria.", "Definir regras de exceção e fluxos de aprovação.", "Pilotar a automação em um processo financeiro de alto volume."],
        },
        marketing: {
          industry: "Automação de marketing",
          problemFocus: ["geração de leads", "automação de campanhas", "fluxo CRM", "personalização de outreach", "otimização de conversão"],
          technologies: ["Fluxo de geração de leads", "Automação de campanhas", "Integração CRM", "Personalização de outreach", "Análise de conversão"],
          solution: "A solução de IA proposta automatiza o fluxo de marketing descrito: conectar geração de leads, execução de campanhas, atualizações CRM, outreach personalizado e relatórios de conversão.",
          roi: "O impacto esperado inclui maior volume de campanhas, acompanhamento mais rápido de leads, atividade CRM mais limpa, melhor personalização e medição de conversão mais clara.",
          nextSteps: ["Confirmar fontes de leads, campos CRM e regras de campanha.", "Definir critérios de personalização e aprovação de outreach.", "Pilotar a automação em uma campanha ou segmento prioritário."],
        },
        general: {
          industry: proposalTags[0] || "",
          problemFocus: ["o problema de negócio descrito pelo cliente", "resultados operacionais desejados", "pontos de coordenação manual", "lacunas de visibilidade de dados", "responsabilidade do fluxo de trabalho"],
          technologies: ["Automação de fluxos", "Assistência de IA contextual", "Painel operacional", "Rastreamento de exceções", "Análise de desempenho"],
          solution: "A solução de IA proposta se baseia na descrição: traduzir o desafio, objetivos e resultado desejado do cliente em um fluxo de automação focado com controles operacionais claros.",
          roi: "O impacto esperado será medido contra o problema de negócio descrito, incluindo tempo de ciclo, qualidade, visibilidade e carga operacional da equipe.",
          nextSteps: ["Confirmar o problema de negócio e resultado alvo.", "Mapear entradas, passagens e pontos de decisão do fluxo atual.", "Pilotar o fluxo automatizado com critérios de sucesso mensuráveis."],
        },
      },
    }[language]?.[domain] || domainCopy?.en?.[domain];
    return {
      title,
      client: customer,
      contact: "",
      language,
      stage: "Draft",
      score: null,
      totalAmount: pricingTotal,
      industry: domainCopy.industry,
      serviceLine: proposalForm.template,
      executiveSummary: description,
      problemsIdentified: [
        language === "es" ? `Desafío actual: ${description}` : language === "pt" ? `Desafio atual: ${description}` : `Current challenge: ${description}`,
        language === "es"
          ? `${customer || "El cliente"} necesita un flujo operativo enfocado en ${domainCopy.problemFocus.slice(0, 3).join(", ")}.`
          : language === "pt"
          ? `${customer || "O cliente"} precisa de um fluxo operacional focado em ${domainCopy.problemFocus.slice(0, 3).join(", ")}.`
          : `${customer || "The client"} needs a focused operating workflow for ${domainCopy.problemFocus.slice(0, 3).join(", ")}.`,
        language === "es"
          ? `Los equipos necesitan mayor visibilidad, priorización y responsabilidad sobre ${domainCopy.problemFocus.slice(-2).join(" y ")}.`
          : language === "pt"
          ? `As equipes precisam de maior visibilidade, priorização e responsabilidade sobre ${domainCopy.problemFocus.slice(-2).join(" e ")}.`
          : `Teams need clearer visibility, prioritization, and accountability around ${domainCopy.problemFocus.slice(-2).join(" and ")}.`,
      ],
      proposedSolution: domainCopy.solution,
      technologiesUsed: domainCopy.technologies,
      lineItems: pricingRows.map(normalizeLineItem),
      expectedROI: domainCopy.roi,
      nextSteps: domainCopy.nextSteps,
    };
  };
  const buildProposalStructure = (title = proposalForm.name) => buildContextualProposalStructure(title);

  const buildProposalPersistencePayload = (title = proposalForm.name) => ({
    title,
    description: contentDescription,
    proposal_description: contentDescription,
    detailed_description: detailedDescription,
    team_sizing: teamSizing,
    length: proposalLength,
    language: platformGenerationLanguage,
    custom_prompt: proposalCustomPrompt,
    customer_name: proposalForm.customer,
    clientName: proposalForm.customer,
    template: proposalForm.template,
    tags: proposalTags,
    pricing_rows: pricingRows,
    lineItems: pricingRows.map(normalizeLineItem),
    total_amount: pricingTotal,
    structured_content: buildProposalStructure(title),
  });
  const saveCreateContentDraft = async () => {
    if (createType === "Proposal") {
      if (structuredEditingProposalId) {
        try {
          await updateProposal(structuredEditingProposalId, buildProposalPersistencePayload());
          setProposals((current) => current.map((proposal) => proposal.id === structuredEditingProposalId
            ? { ...proposal, ...buildProposalPersistencePayload(), customerName: proposalForm.customer, pricingRows, lineItems: pricingRows.map(normalizeLineItem), customPrompt: proposalCustomPrompt }
            : proposal));
          closeCreateContentModal();
          setToast(createT.draftSaved);
        } catch (error) {
          console.error(error);
          setToast(createT.draftCreationFailed);
        }
        return;
      }
      const draft = {
        id: `manual-proposal-${Date.now()}`,
        title: proposalForm.name || contentTitle || "Proposal Draft",
        type: "Proposal",
        status: "draft",
        description: contentDescription,
        proposalDescription: contentDescription,
        detailedDescription,
        teamSizing,
        length: proposalLength,
        contentSource: proposalContentSource,
        customerName: proposalForm.customer,
        template: proposalForm.template,
        tags: proposalTags,
        pricingRows,
        lineItems: pricingRows.map(normalizeLineItem),
        totalAmount: pricingTotal,
        language: platformGenerationLanguage,
        customPrompt: proposalCustomPrompt,
        date: proposalForm.date,
        content: "",
        updated: "Today",
      };
      saveLocalContentProposal(draft);
      setProposals((current) => [...current, draft]);
    }
    closeCreateContentModal();
    setToast(createT.draftSaved);
  };
  const buildAiContentPayload = () => {
    const language = platformGenerationLanguage;
    if (createType === "Case Study") {
      return {
        client_name: contentAiForm.client_name,
        industry: contentAiForm.industry,
        region: contentAiForm.region,
        duration_months: Number(contentAiForm.duration_months) || 1,
        challenge: contentAiForm.challenge,
        solution: contentAiForm.solution,
        metric_1_label: contentAiForm.metric_1_label,
        metric_1_value: contentAiForm.metric_1_value,
        metric_2_label: contentAiForm.metric_2_label,
        metric_2_value: contentAiForm.metric_2_value,
        metric_3_label: contentAiForm.metric_3_label,
        metric_3_value: contentAiForm.metric_3_value,
        testimonial_quote: contentAiForm.testimonial_quote,
        testimonial_name: contentAiForm.testimonial_name,
        testimonial_role: contentAiForm.testimonial_role,
        language,
      };
    }
    if (createType === "Whitepaper") {
      return {
        title: contentAiForm.title,
        subtitle: contentAiForm.subtitle,
        topic: contentAiForm.topic,
        target_audience: contentAiForm.target_audience,
        key_sections: splitListInput(contentAiForm.key_sections),
        abstract: contentAiForm.abstract,
        language,
      };
    }
    if (createType === "Template") {
      return {
        template_name: contentAiForm.template_name,
        channel: contentAiForm.channel,
        category: contentAiForm.category,
        tone: contentAiForm.tone,
        use_case: contentAiForm.use_case,
        merge_variables: splitListInput(contentAiForm.merge_variables),
        language,
      };
    }
    if (createType === "Social Post") {
      return {
        platform: contentAiForm.platform,
        topic: contentAiForm.topic,
        tone: contentAiForm.tone,
        target_audience: contentAiForm.target_audience,
        cta_text: contentAiForm.cta_text,
        key_points: splitListInput(contentAiForm.key_points),
        language,
      };
    }
    return {
      product_name: contentAiForm.product_name,
      tagline: contentAiForm.tagline,
      target_audience: contentAiForm.target_audience,
      features: splitListInput(contentAiForm.features),
      metric_1_label: contentAiForm.metric_1_label,
      metric_1_value: contentAiForm.metric_1_value,
      metric_2_label: contentAiForm.metric_2_label,
      metric_2_value: contentAiForm.metric_2_value,
      metric_3_label: contentAiForm.metric_3_label,
      metric_3_value: contentAiForm.metric_3_value,
      cta_text: contentAiForm.cta_text,
      cta_url: contentAiForm.cta_url,
      language,
    };
  };
  const generateAiContent = async () => {
    if (createType === "One-Pager") {
      const featuresCount = splitListInput(contentAiForm.features).length;
      if (featuresCount < 3 || featuresCount > 4) {
        setToast({ type: "error", message: t("contentLibrary.aiFields.featuresCountError") });
        return;
      }
    }
    setContentAiStep(2);
    setContentGenerating(true);
    try {
      const response = await api.post(`/content/generate/${contentTypeEndpoint[createType]}`, buildAiContentPayload(), { timeout: 90000 });
      setGeneratedContentItem(normalizeGeneratedContentItem(response.data));
      setContentAiStep(3);
    } catch (error) {
      console.error(error);
      setContentAiStep(1);
      const detail = error.response?.data?.detail;
      const message = typeof detail === "string" ? detail : t("contentLibrary.aiFields.generationFailed");
      setToast({ type: "error", message });
    } finally {
      setContentGenerating(false);
    }
  };
  const saveGeneratedContentToLibrary = () => {
    if (!generatedContentItem) return;
    // The backend already persisted this item to Firestore when it was
    // generated (POST /content/generate/{type} calls _persist_content_item
    // internally) — this just reflects it into the local grid immediately
    // instead of waiting for the next /content-library refetch.
    setLibraryItems((current) => [{ ...generatedContentItem, source: "contentItems" }, ...current]);
    closeCreateContentModal();
    setToast(t("contentLibrary.aiFields.savedToLibrary"));
  };
  const exportGeneratedContentPdf = async () => {
    if (!generatedContentItem?.content) return;
    if (canUseBackendContentPdf(generatedContentItem)) {
      try {
        await downloadBackendContentPdf(generatedContentItem);
        return;
      } catch (error) {
        console.error(error);
      }
    }
    const wrapper = document.createElement("div");
    wrapper.className = "generated-content-preview p-6 bg-white text-slate-800";
    wrapper.innerHTML = generatedContentItem.content;
    document.body.appendChild(wrapper);
    try {
      await html2pdf().set({
        margin: 0.5,
        filename: `${sanitizeDownloadName(generatedContentItem.title || "content")}.pdf`,
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "in", format: "letter", orientation: "portrait" },
      }).from(wrapper).save();
    } finally {
      document.body.removeChild(wrapper);
    }
  };
  const exportContentItemPdf = async (item) => {
    if (!item?.content) return;
    if (canUseBackendContentPdf(item)) {
      try {
        await downloadBackendContentPdf(item);
        return;
      } catch (error) {
        console.error(error);
      }
    }
    const wrapper = document.createElement("div");
    wrapper.className = "content-preview-document p-6 bg-white text-slate-800";
    wrapper.innerHTML = item.content;
    document.body.appendChild(wrapper);
    try {
      await html2pdf().set({
        margin: 0.5,
        filename: `${sanitizeDownloadName(item.title || "content")}.pdf`,
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "in", format: "letter", orientation: "portrait" },
      }).from(wrapper).save();
    } finally {
      document.body.removeChild(wrapper);
    }
  };

  const upsertGeneratedProposal = (proposal) => {
    setProposals((current) => {
      const exists = current.some((item) => item.id === proposal.id);
      return exists
        ? current.map((item) => item.id === proposal.id ? proposal : item)
        : [...current, proposal];
    });
  };
  const buildProposalGenerationPayload = (title) => ({
    title,
    description: contentDescription,
    proposalDescription: contentDescription,
    proposal_description: contentDescription,
    detailedDescription,
    teamSizing,
    length: proposalLength,
    contextPriority: ["proposalDescription", "customer", "tags", "title", "template"],
    clientName: proposalForm.customer,
    customer: proposalForm.customer,
    template: proposalForm.template,
    tags: proposalTags,
    lineItems: pricingRows.map(normalizeLineItem),
    totalAmount: pricingTotal,
    language: platformGenerationLanguage,
    customPrompt: proposalCustomPrompt,
    model: getStoredPreference(PREF_KEYS.model, "deepseek"),
  });
  const advanceProposalProgressToPreview = async () => {
    const preparingPreviewIndex = proposalSteps.length - 2;
    for (let index = 0; index < preparingPreviewIndex; index += 1) {
      setGenerationModal((current) => ({
        ...current,
        activeStep: index,
        progress: Math.round((index / preparingPreviewIndex) * 82) + 5,
      }));
      await wait(650);
      setGenerationModal((current) => ({
        ...current,
        completedSteps: [...new Set([...(current?.completedSteps || []), index])],
        progress: Math.round(((index + 1) / preparingPreviewIndex) * 85),
      }));
    }
    setGenerationModal((current) => ({
      ...current,
      activeStep: preparingPreviewIndex,
      progress: 90,
    }));
  };
  const completeProposalGeneration = async (generatedProposal, title, contextualStructure = {}) => {
    const safeGeneratedProposal = generatedProposal || {};
    const safeContextualStructure = contextualStructure || {};
    const generatedLineItems = safeGeneratedProposal.pricingRows
      || safeGeneratedProposal.pricing_rows
      || safeGeneratedProposal.lineItems
      || pricingRows;
    const proposalTotal = calculateProposalTotal({
      ...safeGeneratedProposal,
      pricingRows: generatedLineItems,
      lineItems: generatedLineItems,
      tax: safeGeneratedProposal.tax ?? proposalForm.tax,
      discount: safeGeneratedProposal.discount ?? proposalForm.discount,
    });
    const generatedStructure = normalizeProposalDocument({
      ...safeGeneratedProposal,
      structuredContent: {},
      pricingRows: generatedLineItems,
      lineItems: generatedLineItems,
      totalAmount: proposalTotal.totalAmount ?? pricingTotal,
      language: safeGeneratedProposal.language || platformGenerationLanguage,
    });
    const structuredContent = {
      ...safeContextualStructure,
      ...generatedStructure,
      title: generatedStructure.title || safeContextualStructure.title || safeGeneratedProposal.title || title,
      client: generatedStructure.client || safeContextualStructure.client || proposalForm.customer,
      contact: cleanStructuredText(generatedStructure.contact) || cleanStructuredText(safeContextualStructure.contact),
      industry: cleanStructuredText(generatedStructure.industry) || cleanStructuredText(safeContextualStructure.industry),
      serviceLine: cleanStructuredText(generatedStructure.serviceLine) || cleanStructuredText(safeContextualStructure.serviceLine) || proposalForm.template,
      lineItems: generatedStructure.lineItems?.length ? generatedStructure.lineItems : pricingRows.map(normalizeLineItem),
      totalAmount: proposalTotal.totalAmount ?? pricingTotal,
      language: safeGeneratedProposal.language || platformGenerationLanguage,
      length: proposalLength,
    };
    const professionalContent = proposalDocumentToHtml({
      ...safeGeneratedProposal,
      description: contentDescription,
      structuredContent,
      pricingRows: structuredContent.lineItems,
      lineItems: structuredContent.lineItems,
      totalAmount: structuredContent.totalAmount,
      language: structuredContent.language,
    });
    const normalizedProposal = {
      ...safeGeneratedProposal,
      title: safeGeneratedProposal.title || title,
      description: contentDescription,
      proposalDescription: contentDescription,
      detailedDescription,
      teamSizing,
      length: proposalLength,
      language: platformGenerationLanguage,
      customPrompt: proposalCustomPrompt,
      structuredContent,
      ...structuredContent,
      content: professionalContent,
      customerName: safeGeneratedProposal.customerName || proposalForm.customer,
      date: safeGeneratedProposal.date || proposalForm.date,
      template: safeGeneratedProposal.template || proposalForm.template,
      tags: normalizeTags(safeGeneratedProposal.tags || proposalTags),
      pricingRows: structuredContent.lineItems,
      lineItems: structuredContent.lineItems,
      totalAmount: proposalTotal.totalAmount ?? pricingTotal,
      status: safeGeneratedProposal.status || "generated",
    };
    const completedSteps = proposalSteps.map((_, index) => index);
    setGenerationModal((current) => ({
      ...current,
      activeStep: proposalSteps.length - 1,
      completedSteps,
      progress: 100,
      error: null,
    }));
    setDraftHtml(normalizedProposal.content);
    upsertGeneratedProposal(normalizedProposal);
    await wait(250);
    setGenerationModal(null);
    closeCreateContentModal();
    setViewingProposal(normalizedProposal);
    setToast(structuredEditingProposalId ? createT.proposalRegenerated : createT.proposalGenerated);
  };

  const runProposalGeneration = async () => {
    const title = proposalForm.name || contentTitle || "AI Generated Proposal";
    if (!proposalForm.customer.trim()) {
      setToast(createT.customerRequired);
      setWizardStep(1);
      return;
    }
    if (!proposalForm.name.trim()) {
      setToast(createT.titleRequired);
      setWizardStep(1);
      return;
    }
    const contextualStructure = buildProposalStructure(title);
    const generationPayload = buildProposalGenerationPayload(title);
    setGenerationModal({
      title,
      activeStep: 0,
      completedSteps: [],
      progress: 5,
      cancelled: false,
    });

    let draftProposal = null;
    try {
      if (structuredEditingProposalId) {
        draftProposal = { id: structuredEditingProposalId };
        setGenerationModal((current) => ({ ...current, draftId: structuredEditingProposalId }));
        await updateProposal(structuredEditingProposalId, buildProposalPersistencePayload(title));
        await advanceProposalProgressToPreview();
        const generatedProposal = await generateProposalById(structuredEditingProposalId, generationPayload);
        await completeProposalGeneration(generatedProposal, title, contextualStructure);
        return;
      }
      draftProposal = await createProposal({
        title,
        description: contentDescription,
        proposal_description: contentDescription,
        detailed_description: detailedDescription,
        team_sizing: teamSizing,
        length: proposalLength,
        language: platformGenerationLanguage,
        custom_prompt: proposalCustomPrompt,
        status: "draft",
        customer_name: proposalForm.customer,
        template: proposalForm.template,
        tags: proposalTags,
        pricing_rows: pricingRows,
        total_amount: pricingTotal,
        structured_content: contextualStructure,
      });
      upsertGeneratedProposal(draftProposal);
      setGenerationModal((current) => ({ ...current, draftId: draftProposal.id }));
      await advanceProposalProgressToPreview();
      const generatedProposal = await generateProposalById(draftProposal.id, generationPayload);
      await completeProposalGeneration(generatedProposal, title, contextualStructure);
    } catch (error) {
      console.error(error);
      setGenerationModal((current) => ({
        ...current,
        error: draftProposal ? createT.generationFailedDraftSaved : createT.draftCreationFailed,
        draftId: draftProposal?.id || current?.draftId,
      }));
    }
  };

  const retryProposalGeneration = async () => {
    const draftId = generationModal?.draftId;
    if (!draftId) {
      runProposalGeneration();
      return;
    }
    const title = generationModal.title || proposalForm.name || "AI Generated Proposal";
    const contextualStructure = buildProposalStructure(title);
    const preparingPreviewIndex = proposalSteps.length - 2;
    setGenerationModal((current) => ({
      ...current,
      error: null,
      activeStep: preparingPreviewIndex,
      completedSteps: proposalSteps.slice(0, preparingPreviewIndex).map((_, index) => index),
      progress: 90,
    }));
    try {
      const generatedProposal = await generateProposalById(draftId, buildProposalGenerationPayload(title));
      await completeProposalGeneration(generatedProposal, title, contextualStructure);
    } catch (error) {
      console.error(error);
      setGenerationModal((current) => ({
        ...current,
        error: createT.generationFailedDraftSaved,
        activeStep: preparingPreviewIndex,
        progress: 90,
      }));
    }
  };

  useEffect(() => {
    const syncLanguage = () => setContentLanguage(getStoredPreference(PREF_KEYS.language, "en"));
    syncLanguage();
    window.addEventListener("marketgen:prefs", syncLanguage);
    window.addEventListener("storage", syncLanguage);
    return () => {
      window.removeEventListener("marketgen:prefs", syncLanguage);
      window.removeEventListener("storage", syncLanguage);
    };
  }, []);

  useEffect(() => {
  async function loadProposals() {
    setLoadingLibrary(true);
    try {
      const library = await api.get("/content-library").then((r) => r.data).catch(() => null);
      const data = library?.proposals || await getProposals();
      const localProposals = readLocalContentProposals();
      const templates = (library?.templates || []).map((template) => ({
        id: template.id,
        title: template.name || "Template",
        type: template.type || "Template",
        status: template.isPublic ? "Public" : "Private",
        description: template.description || "",
        industry: template.content || template.description || "Template",
        content: template.content || "",
        rawContent: template.content || "",
        language: template.language || activeLanguage || contentLanguage,
        source: template.source,
        inputData: template.inputData || template.input_data || {},
        services: template.variables || [],
        uses: template.usageCount || 0,
        date: template.updatedAt || template.createdAt || "Today",
        updatedAt: template.updatedAt,
        createdAt: template.createdAt,
      }));
      const assets = (library?.assets || []).map((asset) => {
        let preview = asset.content || "";
        const campaignPosts = asset.type === "campaign_content"
          ? normalizeCampaignContent(asset.content, asset.channel, asset.title)
          : [];
        if (asset.type === "social_post" || asset.type === "campaign_content") {
          try {
            const posts = JSON.parse(asset.content);
            const parsedPosts = Array.isArray(posts) ? posts : posts?.posts;
            if (Array.isArray(parsedPosts) && parsedPosts.length) {
              preview = parsedPosts.map((post) => post.content).filter(Boolean).join("\n\n");
            }
          } catch {
            // content is plain text, use as-is
          }
        }
        const tags = [asset.channel, asset.objective].filter(Boolean);
        return {
          id: asset.id,
          title: asset.campaignName || asset.title || asset.type || "Asset",
          type: asset.type === "social_post" || asset.type === "campaign_content" ? "Social Post" : asset.type === "whitepaper" ? "Whitepaper" : "Case Study",
          assetType: asset.type,
          campaignId: asset.campaignId,
          rawContent: asset.content || "",
          campaignPosts,
          status: asset.status || "ready",
          description: preview,
          industry: preview || asset.title || "Asset",
          services: tags.length ? tags : ["asset"],
          uses: 0,
          date: asset.updatedAt || asset.createdAt || "Today",
          updatedAt: asset.updatedAt,
          createdAt: asset.createdAt,
        };
      });
      setLibraryItems([...templates, ...assets].filter((item) => !deletedContentIds.includes(getContentItemKey(item))));

      console.log("PROPOSALS:", data);

      if (Array.isArray(data)) {
        setProposals([...localProposals, ...data]
          .map((proposal) => {
            const total = calculateProposalTotal(proposal);
            const structuredContent = normalizeProposalDocument(proposal);
            return {
              ...proposal,
              structuredContent,
              pricingRows: proposal.pricingRows || proposal.pricing_rows || proposal.lineItems || [],
              totalAmount: total.totalAmount,
            };
          })
          .filter((proposal) => !deletedContentIds.includes(getContentItemKey({ ...proposal, type: "Proposal" }))));
      } else {
        setProposals(localProposals);
      }

    } catch (error) {
      console.error(error);
      setProposals(readLocalContentProposals());
      setLibraryItems([]);
    } finally {
      setLoadingLibrary(false);
    }
  }

  loadProposals();
}, [deletedContentIds, libraryRefreshKey]);

  const handleDeleteContentItem = async (item) => {
    const warning = item.uses > 0
      ? t("contentLibrary.deleteWarningUsed")
      : t("contentLibrary.deleteWarning");
    if (!window.confirm(warning)) return;

    const deletedKey = getContentItemKey(item);
    console.log("Deleting asset", item.id, item.title);
    const removeLocally = () => {
      setDeletedContentIds((current) => {
        const next = [...new Set([...current, deletedKey])];
        writeDeletedContentIds(next);
        console.log("Deleted IDs", next);
        return next;
      });
      setProposals((current) => {
        const updated = current.filter((proposal) => getContentItemKey({ ...proposal, type: "Proposal" }) !== deletedKey);
        console.log("Assets after delete", updated);
        return updated;
      });
      setLibraryItems((current) => current.filter((asset) => getContentItemKey(asset) !== deletedKey));
    };

    removeLocally();
    setToast({ type: "success", message: t("contentLibrary.assetDeleted") });

    try {
      if (item.id && item.type === "Proposal" && !String(item.id).startsWith("mock-")) {
        await deleteProposal(item.id);
      } else if (item.id && item.source === "contentItems" && !String(item.id).startsWith("mock-")) {
        await api.delete(`/generate/content-items/${item.id}`);
      } else if (item.id && item.type === "Template" && !String(item.id).startsWith("mock-")) {
        await api.delete(`/templates/${item.id}`);
      } else if (item.id && !String(item.id).startsWith("mock-")) {
        await api.delete(`/assets/${item.id}`);
      }
    } catch (error) {
      console.warn("Backend delete failed; asset remains deleted locally.", error);
    }
  };

  const types = ["All", "Case Studies", "Proposals", "Templates", "Whitepapers", "Social Posts", "One-Pagers"];
  const typeToItemType = {
    "Case Studies": "Case Study",
    "Proposals": "Proposal",
    "Templates": "Template",
    "Whitepapers": "Whitepaper",
    "Social Posts": "Social Post",
    "One-Pagers": "One-Pager",
  };
  const typeLabelKeys = {
    "All": "all",
    "Case Studies": "caseStudies",
    "Proposals": "proposals",
    "Templates": "templates",
    "Whitepapers": "whitepapers",
    "Social Posts": "socialPosts",
    "One-Pagers": "onePagers",
    "Case Study": "caseStudy",
    "Proposal": "proposal",
    "Template": "template",
    "Whitepaper": "whitepaper",
    "Social Post": "socialPost",
    "One-Pager": "onePager",
  };
  const statusLabelKeys = {
    Published: "published",
    Active: "active",
    Sent: "sent",
    Accepted: "accepted",
    Draft: "draft",
    draft: "draft",
    generated: "generated",
    Generated: "generated",
    "Generating...": "generating",
    ready: "ready",
    Private: "private",
    Public: "public",
  };
  const contentTypeLabel = (type) => t(`contentLibrary.types.${typeLabelKeys[type] || "all"}`);
  const contentStatusLabel = (status) => t(`contentLibrary.statuses.${statusLabelKeys[status] || "generated"}`);

  const realProposalItems = (Array.isArray(proposals) ? proposals : []).map((proposal) => {
  const total = calculateProposalTotal(proposal);
  const structuredContent = proposal.structuredContent || proposal.structured_content || normalizeProposalDocument(proposal);
  const industry = cleanStructuredText(
    structuredContent.industry
    || proposal.industryName
    || proposal.industry_name
    || proposal.opportunity?.industry
    || proposal.industry,
  ) || "AI Generated Proposal";
  return {
    ...proposal,
    id: proposal.id,
    title: proposal.title || proposal.name || "AI Generated Proposal",
    type: "Proposal",
    status: proposal.status || "generated",
    proposal_status: proposal.proposal_status || "Generada",
    description: proposal.description || "",
    content: proposal.content || proposal.description || "",
    structuredContent,
    industry,
    services: ["AI"],
    uses: 0,
    date: "Today",
    pricingRows: proposal.pricingRows || proposal.pricing_rows || proposal.lineItems || [],
    totalAmount: total.totalAmount,
    formattedTotal: total.formattedTotal,
  };
});

const allItems = [...realProposalItems, ...libraryItems];

const filtered = allItems.filter((item) => {
  if (typeFilter !== "All" && item.type !== (typeToItemType[typeFilter] || typeFilter)) return false;
  if (statusFilter) return item.type === "Proposal" && (item.proposal_status || "Generada") === statusFilter;
  return true;
});

  const campaignAssetsStep = campaignFlow?.currentStep === 4;
  const handleAssetToggle = (item) => {
    if (!campaignAssetsStep) return;
    setCampaignFlow((prev) => {
      const already = prev?.selectedAssets?.some((asset) => asset.id === item.id);
      return {
        ...prev,
        selectedAssets: already
          ? (prev?.selectedAssets || []).filter((asset) => asset.id !== item.id)
          : [...(prev?.selectedAssets || []), { id: item.id, title: item.title, type: item.type }],
      };
    });
  };

  const typeIcon = (t) => {
    const m = { "Case Study": BookIcon, "Proposal": BriefIcon, "Template": FileIcon, "Whitepaper": LayersIcon, "Social Post": Share2Icon, "One-Pager": FileIcon };
    return m[t] || FileIcon;
  };
  const typeColor = (type) => {
    if (isDark) return "bg-slate-900 text-slate-200 border border-white/10";
    const colors = { "Case Study": "text-indigo-600 bg-indigo-50", "Proposal": "text-teal-600 bg-teal-50", "Template": "text-amber-600 bg-amber-50", "Whitepaper": "text-purple-600 bg-purple-50", "Social Post": "text-pink-600 bg-pink-50", "One-Pager": "text-blue-600 bg-blue-50" };
    return colors[type] || "text-gray-600 bg-gray-50";
  };
  const statusColor = (status) => {
    if (isDark) return "bg-slate-900 text-slate-200 border border-white/10";
    const colors = { "Published": "bg-green-100 text-green-700", "Active": "bg-green-100 text-green-700", "Sent": "bg-blue-100 text-blue-700", "Accepted": "bg-green-100 text-green-700", "Draft": "bg-gray-100 text-gray-600", "draft": "bg-gray-100 text-gray-600", "generated": "bg-indigo-100 text-indigo-700", "Generated": "bg-indigo-100 text-indigo-700", "pending CRM upload": "bg-yellow-100 text-yellow-700", "uploaded": "bg-green-100 text-green-700", "Generating...": "bg-yellow-100 text-yellow-700" };
    return colors[status] || "bg-gray-100 text-gray-600";
  };
  const proposalStatusColor = (proposalStatus = "Generada") => {
    if (isDark) return "bg-slate-900 text-slate-200 border border-white/10";
    return PROPOSAL_STATUS_COLOR_CLASSES[proposalStatus] || "bg-gray-100 text-gray-600";
  };
  const proposalStatusLabel = (proposalStatus = "Generada") => {
    const statusConfig = PROPOSAL_STATUSES.find((item) => item.value === proposalStatus) || PROPOSAL_STATUSES[0];
    return t(`contentLibrary.proposalStatuses.${statusConfig.labelKey}`);
  };
  const handleProposalStatusChange = async (proposal, proposalStatus) => {
    const nextProposal = { ...proposal, proposal_status: proposalStatus };
    setViewingProposal(nextProposal);
    setProposals((current) => current.map((item) => (
      item.id === proposal.id ? { ...item, proposal_status: proposalStatus } : item
    )));
    try {
      await updateProposalStatus(proposal.id, proposalStatus);
    } catch (error) {
      console.error(error);
      setViewingProposal(proposal);
      setProposals((current) => current.map((item) => (
        item.id === proposal.id ? { ...item, proposal_status: proposal.proposal_status || "Generada" } : item
      )));
      setToast({ type: "error", message: "No se pudo actualizar el estado de la propuesta." });
    }
  };
  const duplicateItem = (item) => {
    const copy = { ...item, id: `copy-${Date.now()}`, title: `${item.title} Copy`, status: "Draft", date: "Today" };
    if (item.type === "Proposal") setProposals((current) => [...current, copy]);
    else setLibraryItems((current) => [...current, copy]);
    setToast(t("contentLibrary.assetDuplicated"));
  };
  const downloadItem = async (item, format = "pdf", sourceElementOverride = null) => {
    if (item.type === "Proposal") {
      const sourceElement = sourceElementOverride || (viewingProposal?.id === item.id
        ? viewingProposalPreviewRef.current
        : null);
      try {
        await exportProposalDocument(item, format, sourceElement);
      } catch (error) {
        console.error(error);
        setToast({ type: "error", message: t("contentLibrary.exportUnsupported") });
      }
      return;
    }
    // Book Concepts assets (One-Pager/Whitepaper/Social from /books/{id}/assets/*)
    // already carry a real signed storage URL — just open it, same as the
    // working "Download" buttons in Book Concepts.
    if (item.downloadUrl || item.url) {
      window.open(item.downloadUrl || item.url, "_blank", "noopener,noreferrer");
      return;
    }
    // Case Study / Whitepaper / Template / One-Pager generated via the AI
    // content wizard only have HTML content in Firestore, no server-rendered
    // file — render it client-side, same as the wizard's own export step.
    if (item.content) {
      try {
        await exportContentItemPdf(item);
      } catch (error) {
        console.error(error);
        setToast({ type: "error", message: t("contentLibrary.exportUnsupported") });
      }
      return;
    }
    setToast({ type: "error", message: t("contentLibrary.exportUnsupported") });
  };
  const renderAiInput = (field, textarea = false, type = "text") => (
    <Field label={contentAiLabel(field)}>
      {textarea ? (
        <textarea
          className="w-full rounded-lg border border-gray-300 px-3 py-4 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none h-24"
          value={contentAiForm[field]}
          onChange={(event) => updateContentAiForm(field, event.target.value)}
        />
      ) : (
        <Input
          type={type}
          value={contentAiForm[field]}
          onChange={(event) => updateContentAiForm(field, event.target.value)}
        />
      )}
    </Field>
  );
  const renderAiSelect = (field, options) => (
    <Field label={contentAiLabel(field)}>
      <Select value={contentAiForm[field]} onChange={(event) => updateContentAiForm(field, event.target.value)}>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </Select>
    </Field>
  );
  const renderAiContentForm = () => {
    if (createType === "Case Study") {
      return (
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            {renderAiInput("client_name")}
            {renderAiInput("industry")}
            {renderAiInput("region")}
            {renderAiInput("duration_months", false, "number")}
          </div>
          {renderAiInput("challenge", true)}
          {renderAiInput("solution", true)}
          <div className="grid grid-cols-2 gap-1.5">
            {renderAiInput("metric_1_label")}
            {renderAiInput("metric_1_value")}
            {renderAiInput("metric_2_label")}
            {renderAiInput("metric_2_value")}
            {renderAiInput("metric_3_label")}
            {renderAiInput("metric_3_value")}
            {renderAiInput("testimonial_name")}
            {renderAiInput("testimonial_role")}
          </div>
          {renderAiInput("testimonial_quote", true)}
        </div>
      );
    }
    if (createType === "Whitepaper") {
      return (
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            {renderAiInput("title")}
            {renderAiInput("subtitle")}
            {renderAiInput("topic")}
            {renderAiInput("target_audience")}
          </div>
          {renderAiInput("key_sections", true)}
          {renderAiInput("abstract", true)}
        </div>
      );
    }
    if (createType === "Template") {
      return (
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            {renderAiInput("template_name")}
            {renderAiSelect("channel", ["Email", "LinkedIn", "WhatsApp"])}
            {renderAiSelect("category", ["follow_up", "cold_outreach", "post_demo", "nurture"])}
            {renderAiSelect("tone", ["Friendly", "Formal", "Urgent"])}
          </div>
          {renderAiInput("use_case", true)}
          {renderAiInput("merge_variables")}
        </div>
      );
    }
    if (createType === "Social Post") {
      return (
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            {renderAiSelect("platform", ["LinkedIn", "Instagram", "Twitter", "Facebook"])}
            {renderAiInput("topic")}
            {renderAiSelect("tone", ["Friendly", "Formal", "Urgent"])}
            {renderAiInput("target_audience")}
            {renderAiInput("cta_text")}
          </div>
          {renderAiInput("key_points", true)}
        </div>
      );
    }
    return (
      <div className="space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          {renderAiInput("product_name")}
          {renderAiInput("tagline")}
          {renderAiInput("target_audience")}
          {renderAiInput("cta_text")}
          {renderAiInput("cta_url")}
        </div>
        {renderAiInput("features", true)}
        <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>{t("contentLibrary.aiFields.featuresHint")}</p>
        <div className="grid grid-cols-2 gap-1.5">
          {renderAiInput("metric_1_label")}
          {renderAiInput("metric_1_value")}
          {renderAiInput("metric_2_label")}
          {renderAiInput("metric_2_value")}
          {renderAiInput("metric_3_label")}
          {renderAiInput("metric_3_value")}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-2">
      {campaignFlow?.currentStep === 4 && (
        <div className="flow-step-banner">
          <span>
            📁 Step 4: Select assets for this campaign
            {campaignFlow.selectedAssets?.length > 0 && (
              <span style={{ marginLeft: 8, background: "#6366F1", color: "white", borderRadius: 12, padding: "2px 8px", fontSize: "0.8em" }}>
                {campaignFlow.selectedAssets.length} selected
              </span>
            )}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => {
                setCampaignFlow((prev) => completeCampaignFlowSteps(prev, [4], 5));
                onNavigate("outreach");
              }}
              style={{ background: "transparent", color: "#6366F1", border: "1px solid #6366F1", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: "0.85em" }}
            >
              Skip
            </button>
            <button
              type="button"
              onClick={() => {
                setCampaignFlow((prev) => completeCampaignFlowSteps(prev, [4], 5));
                onNavigate("outreach");
              }}
            >
              Continue to Review →
            </button>
          </div>
        </div>
      )}
      <ToastStack
        toasts={toasts}
        onClose={removeToast}
        onMouseEnter={pauseToast}
        onMouseLeave={resumeToast}
      />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("contentLibrary.title")}</h1>
          <p className="text-xs text-gray-500">{t("contentLibrary.subtitle")}</p>
        </div>
        <Btn icon={<PlusIcon size={14} />} onClick={() => openCreateContentModal()}>{createT.openCreate}</Btn>
      </div>

      {/* Type filter tabs */}
      <div className="flex gap-1">
        {types.map(t => (
          <button key={t} onClick={() => { setTypeFilter(t); setStatusFilter(""); }}
            className={`px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
              typeFilter === t
                ? "bg-[#4F46E5] text-white border-[#4F46E5]"
                : isDark
                  ? "bg-slate-800 text-slate-300 border-white/10 hover:bg-slate-700"
                  : "bg-gray-100 text-gray-600 border-transparent hover:bg-gray-200"
            }`}>
            {contentTypeLabel(t)}{t !== "All" && <span className="ml-1 opacity-60">{allItems.filter(i => i.type === (typeToItemType[t] || t)).length}</span>}
          </button>
        ))}
      </div>

      {/* Content grid */}
      {loadingLibrary ? (
        <div style={{ background: isDark ? '#1E293B' : '#fff', borderRadius: 14, border: `1px solid ${isDark ? '#334155' : '#eaecf3'}`, padding: '48px 24px', textAlign: 'center' }}>
          <p style={{ fontSize: 14, color: isDark ? '#64748B' : '#94a3b8', fontWeight: 500, margin: 0 }}>{t("contentLibrary.loading")}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #eaecf3", padding: "48px 24px", textAlign: "center" }}>
          <p style={{ fontSize: 14, color: "#94a3b8", fontWeight: 500, margin: 0 }}>{t("contentLibrary.emptyState")}</p>
        </div>
      ) : (
      <div className="grid grid-cols-3 gap-1.5">
        {filtered.map(item => {
          const Ic = typeIcon(item.type);
          const isSelectedAsset = campaignFlow?.selectedAssets?.some((asset) => asset.id === item.id);
          const card = (
            <Card className={`p-2 hover:border-indigo-200 cursor-pointer transition-colors group ${campaignAssetsStep && isSelectedAsset ? "!border-2 !border-[#6366F1] !bg-[#F5F3FF]" : ""}`}>
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${typeColor(item.type)}`}><Ic size={14} /></div>
                  <Badge label={contentTypeLabel(item.type)} color={typeColor(item.type)} />
                </div>
                {campaignAssetsStep ? (
                  <input
                    type="checkbox"
                    checked={Boolean(isSelectedAsset)}
                    readOnly
                    className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                  />
                ) : item.type === "Proposal" ? (
                    <Badge
                      label={proposalStatusLabel(item.proposal_status || "Generada")}
                      color={proposalStatusColor(item.proposal_status || "Generada")}
                    />
                ) : (
                  <Badge label={contentStatusLabel(item.status)} color={statusColor(item.status)} />
                )}
              </div>
              <p className="text-sm font-medium text-gray-900 mb-1">{item.title}</p>
              <p className="text-xs text-gray-400 mb-1 line-clamp-3">
                 {getCardPreview(item)} · {getUpdatedLabel(item)}
              </p>
              <div className="flex flex-wrap gap-1 mb-1.5">
                {item.services.map((s) => (
                  <span
                    key={s}
                    className={`px-1.5 py-0.5 rounded border text-xs ${
                      isDark
                        ? "bg-slate-900 text-slate-200 border-white/10"
                        : "bg-indigo-50 text-indigo-600 border-transparent"
                    }`}
                  >
                    {s}
                  </span>
                ))}
              </div>
              {item.type === "Proposal" && (
                <div className={`mb-1.5 rounded-lg border px-3 py-4 text-xs ${
                  isDark
                    ? "bg-[#0F172A] text-white border-white/10"
                    : "bg-slate-50 text-slate-500 border-transparent"
                }`}>
                  {t("contentLibrary.totalAmount")}: <span className={`font-semibold ${isDark ? "text-white" : "text-slate-800"}`}>{item.formattedTotal || calculateProposalTotal(item).formattedTotal}</span>
                </div>
              )}
              <div className="flex items-center justify-between pt-2 border-t border-gray-50">
                <span className="text-xs text-gray-400 flex items-center gap-1">
                  {item.uses > 0 ? <><LinkIcon size={10} /> {t("contentLibrary.usedInEmails").replace("{count}", item.uses)}</> : t("contentLibrary.notYetUsed")}
                </span>
                
                {!campaignAssetsStep && (
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100">

                  <button
                    onClick={() => {
                      if (item.type === "Proposal") {
                        setViewingProposal(item);
                      } else if (item.assetType === "campaign_content") {
                        setViewingCampaignContent(item);
                      } else if (item.type === "Social Post") {
                        setViewingCampaignContent({
                          ...item,
                          campaignPosts: normalizeCampaignContent(
                            item.content || item.rawContent || item.description,
                            item.inputData?.platform || item.services?.[0] || "linkedin",
                            item.title,
                          ),
                        });
                      } else {
                        console.log("Viewing content item:", item);
                        setViewingContentItem(item);
                      }
                    }}
                    title={t("contentLibrary.actions.view")}
                    className="p-1 rounded hover:bg-gray-100"
                  >
                    <EyeIcon size={11} className="text-gray-400" />
                  </button>

                  {item.type === "Proposal" && item.assetType !== "campaign_content" && (
                    <button
                      onClick={() => openProposalHtmlEditor(item)}
                      title={t("contentLibrary.actions.edit")}
                      className="p-1 rounded hover:bg-gray-100"
                    >
                      <PenIcon size={11} className="text-gray-400" />
                    </button>
                  )}

                  <button
                    onClick={() => duplicateItem(item)}
                    title={t("contentLibrary.actions.duplicate")}
                    className="p-1 rounded hover:bg-gray-100"
                  >
                    <FileIcon size={11} className="text-gray-400" />
                  </button>

                  {item.assetType !== "campaign_content" && (
                    <button
                      onClick={() => downloadItem(item, "pdf")}
                      title={t("contentLibrary.actions.download")}
                      className="p-1 rounded hover:bg-gray-100"
                    >
                      <DownloadIcon size={11} className="text-gray-400" />
                    </button>
                  )}

                  <button
                    onClick={() => handleDeleteContentItem(item)}
                    title={t("contentLibrary.actions.delete")}
                    className="p-1 rounded hover:bg-red-100"
                  >
                    <TrashIcon size={11} className="text-red-500" />
                  </button>

                </div>
                )}
              </div>
            </Card>
          );
          return campaignAssetsStep ? (
            <div
              key={item.id || item.title}
              role="button"
              tabIndex={0}
              onClick={() => handleAssetToggle(item)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  handleAssetToggle(item);
                }
              }}
              className="block w-full text-left"
            >
              {card}
            </div>
          ) : (
            card
          );
        })}
      </div>
      )}

      {/* ── Create Content Modal ── */}
{showCreateModal && (
  <div className="fixed inset-0 z-50 flex items-center justify-center">
    <div
      className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      onClick={closeCreateContentModal}
    />

    <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-4xl mx-4 max-h-[90vh] overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between p-2 border-b border-gray-100">
        <div className="flex items-center gap-1">
          <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
            <PlusIcon size={16} className="text-indigo-600" />
          </div>

          <div>
            <h2 className="text-sm font-semibold text-gray-900">{createT.modalTitle}</h2>
            <p className="text-xs text-gray-400">{createT.modalSubtitle}</p>
          </div>
        </div>

        <button
          onClick={closeCreateContentModal}
          className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <XIcon size={16} className="text-gray-400" />
        </button>
      </div>

      {/* Body */}
      <div className="p-2 space-y-1.5">
        <Field label={createT.contentType}>
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-6">
            {contentTypeOptions.map((type) => {
              const isProposal = type === "Proposal";
              const isEnabledAiType = aiContentTypes.includes(type);
              const isEnabledCreateType = isProposal || isEnabledAiType;
              return (
                <button
                  key={type}
                  type="button"
                  disabled={!isEnabledCreateType}
                  onClick={isEnabledCreateType ? () => {
                    resetCreateContentForm();
                    setCreateType(type);
                  } : undefined}
                  className={`min-h-9 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors ${
                    createType === type
                      ? "border-indigo-300 bg-indigo-600 text-white shadow-sm"
                      : isEnabledCreateType
                      ? "border-gray-200 bg-white text-gray-600 hover:border-indigo-200 hover:text-indigo-700"
                      : "cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400 opacity-75"
                  }`}
                >
                  <span className="block">{contentTypeLabel(type)}</span>
                  {!isEnabledCreateType && (
                    <span className="mt-0.5 inline-flex rounded-full bg-gray-200 px-1.5 py-0.5 text-[9px] font-semibold text-gray-500">
                      {createT.comingSoon}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </Field>

        {createType === "Proposal" && (
          <div className="grid grid-cols-3 gap-1">
            {[createT.proposalDetails, createT.servicesPricing, createT.reviewProposal].map((label, index) => (
              <button
                key={label}
                type="button"
                onClick={() => goToProposalStep(index + 1)}
                className={`rounded-lg border px-2 py-4 text-xs font-medium ${
                  wizardStep === index + 1
                    ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                    : "border-gray-100 bg-gray-50 text-gray-500"
                }`}
              >
                {createT.step} {index + 1}<br />{label}
              </button>
            ))}
          </div>
        )}

        {createType !== "Proposal" && !isAiContentType && <Field label={createT.title}>
          <Input
            placeholder={`e.g. "${
              createType === "Template"
                ? createT.templateTitleExample
                : createType === "Proposal"
                ? createT.titleExample
                : createT.assetTitleExample
            }"`}
            value={createType === "Proposal" ? proposalForm.name : contentTitle}
            onChange={(e) => createType === "Proposal" ? updateProposalForm("name", e.target.value) : setContentTitle(e.target.value)}
          />
        </Field>}

        {createType === "Proposal" && wizardStep === 1 && (
          <div className="space-y-1.5">
          <Field label={createT.title}>
            <Input
              placeholder={`e.g. "${createT.titleExample}"`}
              value={proposalForm.name}
              onChange={(e) => updateProposalForm("name", e.target.value)}
            />
          </Field>
          <Field label={createT.proposalDescription}>
            <textarea
              className="w-full border border-gray-300 rounded-lg px-3 py-4 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none h-20"
              placeholder={createT.proposalDescriptionPlaceholder}
              value={contentDescription}
              onChange={(e) => setContentDescription(e.target.value)}
            />
          </Field>
          <div className="max-w-xs">
            <Field label={createT.proposalLanguage}>
              <Select
                value={proposalLanguage}
                onChange={(e) => {
                  setProposalLanguage(e.target.value);
                  setProposalLanguageManuallySelected(true);
                }}
              >
                {Object.entries(proposalLanguageLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}{!proposalLanguageManuallySelected && proposalLanguage === value ? ` (${createT.detected})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          </div>
        )}

        {isAiContentType && createType !== "Proposal" && contentAiStep === 1 && (
          <div className="max-w-xs">
            <Field label={createT.proposalLanguage}>
              <Select
                value={proposalLanguage}
                onChange={(e) => {
                  setProposalLanguage(e.target.value);
                  setProposalLanguageManuallySelected(true);
                }}
              >
                {Object.entries(proposalLanguageLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}{!proposalLanguageManuallySelected && proposalLanguage === value ? ` (${createT.detected})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}

        {createType !== "Social Post" && createType !== "Proposal" && !isAiContentType && (
          <Field
            label={createT.description}
            hint={createT.descriptionHint}
          >
            <textarea
              className="w-full border border-gray-300 rounded-lg px-3 py-4 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none h-20"
              placeholder={createT.descriptionPlaceholder}
              value={contentDescription}
              onChange={(e) => setContentDescription(e.target.value)}
            />
          </Field>
        )}

        {createType === "Proposal" && wizardStep === 1 && (
          <div className="space-y-1.5">
                <div className="grid grid-cols-2 gap-1.5">
                <Field label={createT.customer}>
                  <Input value={proposalForm.customer} onChange={(e) => updateProposalForm("customer", e.target.value)} placeholder={createT.customerPlaceholder} />
                </Field>
                <Field label={createT.template}>
                  <Select value={proposalForm.template} onChange={(e) => updateProposalForm("template", e.target.value)}>
                    <option>NoonDalton Standard Proposal</option>
                    <option>BPO Services Proposal</option>
                    <option>AI Automation Proposal</option>
                  </Select>
                </Field>
                </div>
                <Field label={createT.tags}>
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-2.5">
                    <div className="flex flex-wrap gap-1">
                      {allProposalTags.map((tag) => {
                        const selected = proposalTags.some((item) => item.toLowerCase() === tag.toLowerCase());
                        return (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => toggleProposalTag(tag)}
                            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                              selected
                                ? "border-indigo-300 bg-indigo-600 text-white shadow-sm"
                                : "border-gray-200 bg-white text-gray-600 hover:border-indigo-200 hover:text-indigo-700"
                            }`}
                          >
                            <span>{tag}</span>
                            {selected && (
                              <span
                                role="button"
                                tabIndex={-1}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  removeProposalTag(tag);
                                }}
                                className="ml-0.5 rounded-full bg-white/20 p-0.5 hover:bg-white/30"
                                aria-label={`Remove ${tag}`}
                              >
                                <XIcon size={10} />
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <input
                      value={customProposalTag}
                      onChange={(e) => setCustomProposalTag(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addCustomProposalTag();
                        }
                      }}
                      placeholder={createT.customTagPlaceholder}
                      className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                </Field>
                <Field label={createT.detailedDescription}>
                  <textarea
                    className="w-full border border-gray-300 rounded-lg px-3 py-4 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none h-24"
                    placeholder={createT.detailedDescriptionPlaceholder}
                    value={detailedDescription}
                    onChange={(e) => setDetailedDescription(e.target.value)}
                  />
                </Field>
                <Field label={createT.teamSizing}>
                  <textarea
                    className="w-full border border-gray-300 rounded-lg px-3 py-4 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none h-20"
                    placeholder={createT.teamSizingPlaceholder}
                    value={teamSizing}
                    onChange={(e) => setTeamSizing(e.target.value)}
                  />
                </Field>
                <Field label={createT.length}>
                  <Select value={proposalLength} onChange={(e) => setProposalLength(e.target.value)}>
                    <option value="brief">{createT.brief}</option>
                    <option value="standard">{createT.standard}</option>
                    <option value="extended">{createT.extended}</option>
                  </Select>
                </Field>
                <Field label={createT.contentSource}>
                  <div className="space-y-1">
                    <label className="flex items-center gap-1 p-2.5 rounded-xl border border-indigo-200 bg-indigo-50 cursor-pointer">
                      <input type="radio" name="proposal-source" checked={proposalContentSource === "ai"} onChange={() => setProposalContentSource("ai")} className="accent-indigo-600" />
                      <SparkIcon size={14} className="text-indigo-500" />
                      <div>
                        <p className="text-xs font-medium text-gray-800">{createT.generateWithAi}</p>
                        <p className="text-[11px] text-gray-400">{createT.generateWithAiHint}</p>
                      </div>
                    </label>
                    <label className="flex items-center gap-1 p-2.5 rounded-xl border border-gray-100 bg-gray-50 cursor-pointer hover:border-indigo-200 transition-colors">
                      <input type="radio" name="proposal-source" checked={proposalContentSource === "upload"} onChange={() => setProposalContentSource("upload")} className="accent-indigo-600" />
                      <DownloadIcon size={14} className="text-gray-400" />
                      <div>
                        <p className="text-xs font-medium text-gray-800">{createT.uploadFile}</p>
                        <p className="text-[11px] text-gray-400">{createT.uploadFileHint}</p>
                      </div>
                    </label>
                    <label className="flex items-center gap-1 p-2.5 rounded-xl border border-gray-100 bg-gray-50 cursor-pointer hover:border-indigo-200 transition-colors">
                      <input type="radio" name="proposal-source" checked={proposalContentSource === "manual"} onChange={() => setProposalContentSource("manual")} className="accent-indigo-600" />
                      <PenIcon size={14} className="text-gray-400" />
                      <div>
                        <p className="text-xs font-medium text-gray-800">{createT.manual}</p>
                        <p className="text-[11px] text-gray-400">{createT.manualHint}</p>
                      </div>
                    </label>
                  </div>
                </Field>
          </div>
        )}

        {createType === "Proposal" && wizardStep === 2 && (
          <div className="space-y-1.5">
            <div className="overflow-x-auto rounded-xl border border-gray-100">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="px-2 py-4 text-left">{createT.serviceUnit}</th>
                    <th className="px-2 py-4 text-left">{createT.serviceDescription}</th>
                    <th className="px-2 py-4 text-left">{createT.qty}</th>
                    <th className="px-2 py-4 text-left">{createT.unitPrice}</th>
                    <th className="px-2 py-4 text-right">{createT.subtotal}</th>
                    <th className="px-2 py-4" />
                  </tr>
                </thead>
                <tbody>
                  {pricingRows.length === 0 && (
                    <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">{createT.noPricing}</td></tr>
                  )}
                  {pricingRows.map((row) => (
                    <tr key={row.id} className="border-t border-gray-100">
                      <td className="p-2"><Input value={row.service} onChange={(e) => updatePricingRow(row.id, "service", e.target.value)} /></td>
                      <td className="p-2"><Input value={row.description} onChange={(e) => updatePricingRow(row.id, "description", e.target.value)} /></td>
                      <td className="p-2 w-20"><Input type="number" min="0" value={row.quantity} onChange={(e) => updatePricingRow(row.id, "quantity", e.target.value)} /></td>
                      <td className="p-2 w-28"><Input type="number" min="0" value={row.unitPrice} onChange={(e) => updatePricingRow(row.id, "unitPrice", e.target.value)} /></td>
                      <td className="p-2 text-right font-semibold text-gray-700">{formatUsd(Number(row.quantity || 0) * Number(row.unitPrice || 0))}</td>
                      <td className="p-2"><button type="button" onClick={() => removePricingRow(row.id)} className="p-1 rounded hover:bg-red-50"><TrashIcon size={12} className="text-red-500" /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between">
              <Btn variant="secondary" small icon={<PlusIcon size={12} />} onClick={addPricingRow}>{createT.addLineItem}</Btn>
              <div className="text-sm text-gray-700">{createT.totalAmount}: <strong>{formatUsd(pricingTotal)}</strong></div>
            </div>
          </div>
        )}

        {createType === "Proposal" && wizardStep === 3 && (
          <div className="space-y-1.5">
            <Field label={createT.adjustmentInstructions}>
              <textarea
                value={proposalCustomPrompt}
                onChange={(event) => setProposalCustomPrompt(event.target.value)}
                placeholder={createT.adjustmentInstructionsPlaceholder}
                rows={3}
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-4 text-sm text-gray-700 outline-none transition-colors placeholder:text-gray-400 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
              />
            </Field>
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-2">
              <h3 className="mb-1.5 text-sm font-semibold text-gray-900">{createT.reviewDetails}</h3>
              <div className="grid grid-cols-2 gap-1.5 text-xs">
                <div><span className="text-gray-400">{createT.title}</span><p className="font-medium text-gray-800">{proposalForm.name}</p></div>
                <div><span className="text-gray-400">{createT.customer}</span><p className="font-medium text-gray-800">{proposalForm.customer}</p></div>
                <div><span className="text-gray-400">{createT.template}</span><p className="font-medium text-gray-800">{proposalForm.template}</p></div>
                <div><span className="text-gray-400">{createT.length}</span><p className="font-medium text-gray-800">{createT[proposalLength]}</p></div>
                <div><span className="text-gray-400">{createT.proposalLanguage}</span><p className="font-medium text-gray-800">{proposalLanguageLabels[platformGenerationLanguage]}</p></div>
                <div className="col-span-2"><span className="text-gray-400">{createT.proposalDescription}</span><p className="whitespace-pre-wrap text-gray-700">{contentDescription || createT.notProvided}</p></div>
                <div className="col-span-2"><span className="text-gray-400">{createT.detailedDescription}</span><p className="whitespace-pre-wrap text-gray-700">{detailedDescription || createT.notProvided}</p></div>
                <div className="col-span-2"><span className="text-gray-400">{createT.teamSizing}</span><p className="whitespace-pre-wrap text-gray-700">{teamSizing || createT.notProvided}</p></div>
                <div className="col-span-2"><span className="text-gray-400">{createT.tags}</span><p className="text-gray-700">{proposalTags.join(", ") || createT.notProvided}</p></div>
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 p-2">
              <div className="mb-1.5 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900">{createT.reviewPricing}</h3>
                <strong className="text-sm text-indigo-700">{createT.totalAmount}: {formatUsd(pricingTotal)}</strong>
              </div>
              <div className="space-y-1">
                {pricingRows.length === 0 && <p className="text-xs text-gray-400">{createT.noPricing}</p>}
                {pricingRows.map((row) => (
                  <div key={row.id} className="flex items-start justify-between border-t border-gray-100 pt-2 text-xs first:border-0 first:pt-0">
                    <div><p className="font-medium text-gray-800">{row.service || createT.notProvided}</p><p className="text-gray-400">{row.description}</p></div>
                    <p className="font-semibold text-gray-700">{row.quantity || 0} x {formatUsd(row.unitPrice || 0)} = {formatUsd(Number(row.quantity || 0) * Number(row.unitPrice || 0))}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {isAiContentType && contentAiStep === 1 && renderAiContentForm()}

        {isAiContentType && contentAiStep === 2 && (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-indigo-100 bg-indigo-50 text-center">
            <span className="spinner mb-1.5" />
            <p className="text-sm font-semibold text-gray-900">
              {t("contentLibrary.aiFields.generating").replace("{type}", contentTypeLabel(createType))}
            </p>
          </div>
        )}

        {isAiContentType && contentAiStep === 3 && generatedContentItem && (
          <div className="space-y-1.5">
            <div
              className="generated-content-preview max-h-[52vh] overflow-y-auto rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-700"
              dangerouslySetInnerHTML={{ __html: generatedContentItem.content }}
            />
            <div className="flex justify-end gap-1">
              <Btn variant="secondary" onClick={exportGeneratedContentPdf}>{t("contentLibrary.aiFields.exportPdf")}</Btn>
              <Btn onClick={saveGeneratedContentToLibrary}>{t("contentLibrary.aiFields.saveToLibrary")}</Btn>
            </div>
          </div>
        )}
         
        {false && (createType === "Case Study" ||
          createType === "Whitepaper" ||
          createType === "Template") && (
        <Field label={createT.contentSource}>
          <div className="space-y-1">
          <label className="flex items-center gap-1 p-2.5 rounded-xl border border-gray-100 bg-gray-50 cursor-pointer hover:border-indigo-200 transition-colors">
          <input type="radio" name="source" defaultChecked className="accent-indigo-600" />
        <SparkIcon size={14} className="text-indigo-500" />
          <div>
          <p className="text-xs font-medium text-gray-800">{createT.generateWithAi}</p>
          <p className="text-xs text-gray-400">{createT.aiCreatesContent}</p>
        </div>
      </label>

      <label className="flex items-center gap-1 p-2.5 rounded-xl border border-gray-100 bg-gray-50 cursor-pointer hover:border-indigo-200 transition-colors">
        <input type="radio" name="source" className="accent-indigo-600" />
        <DownloadIcon size={14} className="text-gray-400" />
        <div>
          <p className="text-xs font-medium text-gray-800">{createT.uploadExistingFile}</p>
          <p className="text-xs text-gray-400">{createT.uploadExistingFileHint}</p>
        </div>
      </label>

      <label className="flex items-center gap-1 p-2.5 rounded-xl border border-gray-100 bg-gray-50 cursor-pointer hover:border-indigo-200 transition-colors">
        <input type="radio" name="source" className="accent-indigo-600" />
        <PenIcon size={14} className="text-gray-400" />
        <div>
          <p className="text-xs font-medium text-gray-800">{createT.writeManually}</p>
          <p className="text-xs text-gray-400">{createT.writeManuallyHint}</p>
        </div>
      </label>
    </div>
  </Field>
)}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between p-2 border-t border-gray-100 bg-gray-50 rounded-b-2xl">
        <Btn variant="ghost" onClick={closeCreateContentModal}>
          {createT.cancel}
        </Btn>

        <div className="flex gap-1">
          {!isAiContentType && (
            <Btn
              variant="secondary"
              icon={<SaveIcon size={12} />}
              onClick={saveCreateContentDraft}
            >
              {createT.saveDraft}
            </Btn>
          )}
          {createType === "Proposal" && wizardStep > 1 && (
            <Btn variant="secondary" onClick={() => setWizardStep((current) => current - 1)}>
              {createT.back}
            </Btn>
          )}
          {createType === "Proposal" && wizardStep < 3 && (
            <Btn icon={<ArrowRightIcon size={13} />} onClick={() => goToProposalStep(wizardStep + 1)} disabled={!canContinueProposalSetup}>
              {wizardStep === 1 ? createT.continuePricing : createT.continue}
            </Btn>
          )}
          {createType === "Proposal" && wizardStep === 3 && (
            <Btn icon={<SparkIcon size={13} />} onClick={runProposalGeneration} disabled={!canContinueProposalSetup}>
              {structuredEditingProposalId ? createT.regenerate : createT.generateDraft}
            </Btn>
          )}
          {isAiContentType && contentAiStep === 1 && (
            <Btn icon={<SparkIcon size={13} />} onClick={generateAiContent} disabled={contentGenerating}>
              {t("contentLibrary.aiFields.generate")}
            </Btn>
          )}
        </div>
      </div>
    </div>
  </div>
)}

{/* ── View Proposal Modal ── */}
{false && generationModal && (
  <div className="fixed inset-0 z-[60] flex items-center justify-center">
    <div className="absolute inset-0 bg-slate-900/55 backdrop-blur-sm" />
    <div className="relative w-full max-w-md mx-4 rounded-2xl bg-white shadow-2xl border border-gray-100 overflow-hidden">
      <div className="p-3 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-900">
          Generando propuesta: {generationModal.title}
        </h2>
        <p className="text-xs text-gray-400 mt-1">Tiempo estimado: 10 - 15 segundos</p>
      </div>
      <div className="p-3 space-y-1.5">
        {proposalSteps.map((step, index) => {
          const done = generationModal.completedSteps?.includes(index);
          const active = generationModal.activeStep === index && !done;
          return (
            <div key={step} className="flex items-center gap-1.5">
              <span className={`flex h-5 w-5 items-center justify-center rounded-full border text-xs ${
                done
                  ? "border-green-200 bg-green-50 text-green-600"
                  : active
                  ? "border-indigo-200 bg-indigo-50 text-indigo-600"
                  : "border-gray-200 text-gray-400"
              }`}>
                {done ? <CheckIcon size={11} /> : active ? <RefreshIcon size={11} className="animate-spin" /> : index + 1}
              </span>
              <span className={`text-xs flex-1 ${done ? "text-gray-700" : active ? "text-indigo-700 font-medium" : "text-gray-400"}`}>
                {step}
              </span>
              {done && <CheckIcon size={13} className="text-green-500" />}
            </div>
          );
        })}
        <div className="pt-2">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>{generationModal.progress}% completado</span>
            {generationModal.error && <span className="text-red-600">{generationModal.error}</span>}
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-indigo-600 rounded-full transition-all duration-300"
              style={{ width: `${generationModal.progress}%` }}
            />
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-1 p-2 bg-gray-50 border-t border-gray-100">
        <Btn variant="ghost" small onClick={() => setGenerationModal(null)}>Cancelar</Btn>
      </div>
    </div>
  </div>
)}

<ProgressModal
  title={`${createT.generatingProposal}: ${generationModal?.title || proposalForm.name}`}
  subtitle={createT.estimatedTime}
  completeLabel={createT.complete}
  retryLabel={createT.retry}
  cancelLabel={createT.cancel}
  steps={proposalSteps}
  state={generationModal}
  onCancel={() => setGenerationModal(null)}
  onRetry={retryProposalGeneration}
/>

{viewingContentItem && isGeneratedContentType(viewingContentItem.type) && (
  <div className="fixed inset-0 z-50 flex items-center justify-center">
    <div
      className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      onClick={() => setViewingContentItem(null)}
    />
    <div className={`relative mx-4 max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl shadow-2xl ${isDark ? "border border-white/10 bg-slate-800" : "bg-white"}`}>
      <div className={`flex items-center justify-between border-b p-3 ${isDark ? "border-white/10" : "border-gray-100"}`}>
        <div>
          <div className="mb-1 flex items-center gap-1">
            <h2 className={`text-lg font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>
              {viewingContentItem.title}
            </h2>
            <Badge label={contentTypeLabel(viewingContentItem.type)} color={contentPreviewBadgeColor(viewingContentItem.type)} />
          </div>
          <p className={`text-xs ${isDark ? "text-slate-400" : "text-gray-400"}`}>
            {contentTypeLabel(viewingContentItem.type)}
          </p>
        </div>
        <button
          onClick={() => setViewingContentItem(null)}
          className={`rounded-lg p-1.5 transition-colors ${isDark ? "hover:bg-slate-700" : "hover:bg-gray-100"}`}
          aria-label={t("common.close")}
        >
          <XIcon size={16} className="text-gray-400" />
        </button>
      </div>
      <div className="p-6">
        <div
          className={`content-preview-document max-h-[66vh] overflow-y-auto rounded-xl border p-6 text-sm ${isDark ? "border-white/10 bg-slate-800 text-slate-300" : "border-gray-200 bg-white text-gray-700"}`}
          dangerouslySetInnerHTML={{ __html: viewingContentItem.content || "" }}
        />
      </div>
      <div className={`flex justify-end gap-1 border-t p-3 ${isDark ? "border-white/10 bg-[#0F172A]" : "border-gray-100 bg-gray-50"}`}>
        <Btn variant="secondary" onClick={() => exportContentItemPdf(viewingContentItem)}>
          {t("contentLibrary.aiFields.exportPdf")}
        </Btn>
        <Btn onClick={() => setViewingContentItem(null)}>
          {t("common.close")}
        </Btn>
      </div>
    </div>
  </div>
)}

{viewingCampaignContent && (
  <div className="fixed inset-0 z-50 flex items-center justify-center">
    <div
      className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      onClick={() => setViewingCampaignContent(null)}
    />
    <div className={`relative mx-4 max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl shadow-2xl ${isDark ? "border border-white/10 bg-slate-800" : "bg-white"}`}>
      <div className={`flex items-center justify-between border-b p-3 ${isDark ? "border-white/10" : "border-gray-100"}`}>
        <div>
          <h2 className={`text-lg font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>
            {viewingCampaignContent.title}
          </h2>
          <p className={`text-xs ${isDark ? "text-slate-400" : "text-gray-400"}`}>
            {t("contentLibrary.socialSummaries")}
          </p>
        </div>
        <button
          onClick={() => setViewingCampaignContent(null)}
          className={`rounded-lg p-1.5 transition-colors ${isDark ? "hover:bg-slate-700" : "hover:bg-gray-100"}`}
          aria-label={t("common.close")}
        >
          <XIcon size={16} className="text-gray-400" />
        </button>
      </div>

      <div className="space-y-2 p-6">
        {(viewingCampaignContent.campaignPosts?.length
          ? viewingCampaignContent.campaignPosts
          : normalizeCampaignContent(
              viewingCampaignContent.rawContent || viewingCampaignContent.description,
              viewingCampaignContent.services?.[0],
              viewingCampaignContent.title,
            )
        ).map((post, index) => {
          const copyText = [
            post.headline,
            post.content,
            post.hashtags.join(" "),
          ].filter(Boolean).join("\n\n");
          return (
            <div key={`${post.channel}-${index}`} className={`rounded-xl border p-3 ${isDark ? "border-white/10 bg-[#0F172A]" : "border-gray-200 bg-white"}`}>
              <div className="mb-1.5 flex items-start justify-between gap-1.5">
                <div>
                  <Badge label={post.channel || t("contentLibrary.socialPost")} color={isDark ? "border border-indigo-400/20 bg-indigo-500/10 text-indigo-200" : "bg-indigo-50 text-indigo-700"} />
                  {post.headline && <h3 className={`mt-3 text-base font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>{post.headline}</h3>}
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  {publishPlatforms.map(({ platform, label }) => {
                    const connected = Boolean(socialPublishStatus?.[platform]?.connected);
                    return (
                      <Btn
                        key={platform}
                        variant={connected ? "primary" : "secondary"}
                        small
                        onClick={() => publishSocialPost(platform, post, copyText)}
                        title={connected ? `Publish to ${label}` : `Connect ${label} in Settings`}
                      >
                        {label}
                      </Btn>
                    );
                  })}
                  <Btn
                    variant="secondary"
                    small
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(copyText);
                        setToast({ type: "success", message: t("contentLibrary.postCopied") });
                      } catch {
                        setToast({ type: "error", message: t("contentLibrary.copyFailed") });
                      }
                    }}
                  >
                    {t("contentLibrary.copyPost")}
                  </Btn>
                </div>
              </div>
              <p className={`whitespace-pre-wrap text-sm leading-relaxed ${isDark ? "text-slate-200" : "text-gray-700"}`}>{post.content}</p>
              {post.hashtags.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-1">
                  {post.hashtags.map((hashtag) => (
                    <span key={hashtag} className={`rounded-full px-2.5 py-1 text-xs font-medium ${isDark ? "bg-slate-800 text-indigo-200" : "bg-indigo-50 text-indigo-700"}`}>
                      {hashtag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className={`flex justify-end border-t p-3 ${isDark ? "border-white/10 bg-[#0F172A]" : "border-gray-100 bg-gray-50"}`}>
        <Btn variant="secondary" onClick={() => setViewingCampaignContent(null)}>
          {t("common.close")}
        </Btn>
      </div>
    </div>
  </div>
)}

{viewingProposal && (
  <div className="fixed inset-0 z-50 flex items-center justify-center">
    <div
      className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      onClick={() => {
        setViewingProposal(null);
        setEditingProposal(null);
      }}
    />

    <div className={`relative rounded-2xl shadow-2xl w-full max-w-4xl mx-4 max-h-[92vh] overflow-y-auto ${isDark ? "bg-slate-800 border border-white/10" : "bg-white"}`}>
      <div className={`flex items-center justify-between p-3 border-b ${isDark ? "border-white/10" : "border-gray-100"}`}>
        <div>
          {editingProposal ? (
            <Input
              value={editingProposal.draftTitle || ""}
              onChange={(event) => setEditingProposal((current) => ({ ...current, draftTitle: event.target.value }))}
              placeholder={t("contentLibrary.proposalTitle")}
            />
          ) : (
            <h2 className={`text-lg font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>{viewingProposal.title}</h2>
          )}
          <p className={`text-xs ${isDark ? "text-slate-400" : "text-gray-400"}`}>
            {editingProposal ? t("contentLibrary.editProposal") : t("contentLibrary.proposalPreview")}
          </p>
          {!editingProposal && (
            <div className={`mt-3 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium shadow-sm ${proposalStatusColor(viewingProposal.proposal_status || "Generada")}`}>
              <select
                value={viewingProposal.proposal_status || "Generada"}
                onChange={(event) => handleProposalStatusChange(viewingProposal, event.target.value)}
                className="cursor-pointer appearance-none border-0 bg-transparent pr-5 text-xs font-medium text-current outline-none"
              >
                {PROPOSAL_STATUSES.map((proposalStatus) => (
                  <option key={proposalStatus.value} value={proposalStatus.value} className="bg-white text-slate-900">
                    {t(`contentLibrary.proposalStatuses.${proposalStatus.labelKey}`)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <button
          onClick={() => {
            setViewingProposal(null);
            setEditingProposal(null);
          }}
          className={`p-1.5 rounded-lg transition-colors ${isDark ? "hover:bg-slate-700" : "hover:bg-gray-100"}`}
        >
          <XIcon size={16} className="text-gray-400" />
        </button>
      </div>

      <div className={`p-6 ${isDark ? "text-slate-200" : "text-gray-700"}`}>
        {editingProposal ? (
          <div
            ref={proposalEditorRef}
            className="min-h-[62vh] max-h-[68vh] w-full overflow-y-auto rounded-xl border border-gray-200 bg-white p-6 text-left text-sm text-gray-700 shadow-sm prose prose-slate max-w-none"
            contentEditable
            suppressContentEditableWarning
            onInput={(event) => {
              const html = event.currentTarget?.innerHTML ?? "";
              setEditingProposal((current) => (current ? { ...current, draftContent: html } : current));
            }}
          />
        ) : (
          <ProposalDocumentPreview
            proposal={viewingProposal}
            exportRef={viewingProposalPreviewRef}
            className={`min-h-[62vh] max-h-[68vh] overflow-y-auto rounded-xl border p-6 shadow-sm ${isDark ? "border-white/10 bg-slate-800" : "border-gray-200 bg-white"}`}
          />
        )}
      </div>
      <div className={`flex justify-end gap-1 p-3 border-t rounded-b-2xl ${isDark ? "border-white/10 bg-[#0F172A]" : "border-gray-100 bg-gray-50"}`}>
        {editingProposal ? (
          <>
            <Btn variant="ghost" onClick={() => setEditingProposal(null)}>{t("common.cancel")}</Btn>
            <Btn onClick={async () => {
              try {
                // Drop the proposal's previous structuredContent before re-deriving
                // it: normalizeProposalDocument() prefers structuredContent.* over
                // re-parsing `content`, so keeping the stale structure here would
                // make it ignore everything just typed in the HTML editor.
                const { structuredContent: _staleStructured, structured_content: _staleStructuredSnake, ...editedProposalBase } = editingProposal;
                const draftContent = editingProposal.draftContent || editingProposal.content || "";
                // The big <h1> inside the editable canvas is what users actually
                // see and edit; the small title Input above it is easy to miss.
                // If they typed a new title into the document body, that wins —
                // otherwise fall back to the separate title field.
                const finalTitle = extractH1Text(draftContent) || editingProposal.draftTitle;
                const editedProposal = { ...editedProposalBase, title: finalTitle, content: draftContent };
                const structuredContent = normalizeProposalDocument(editedProposal);
                const professionalContent = proposalDocumentToHtml({ ...editedProposal, structuredContent });
                const updatedTotal = calculateProposalTotal({ ...editedProposal, structuredContent });
                await updateProposal(editingProposal.id, {
                  title: finalTitle,
                  description: editingProposal.description || "",
                  content: professionalContent,
                  structured_content: structuredContent,
                  status: editingProposal.status,
                  total_amount: updatedTotal.totalAmount,
                });
                const nextProposal = { ...viewingProposal, title: finalTitle, content: professionalContent, structuredContent, totalAmount: updatedTotal.totalAmount };
                setProposals((current) => current.map((proposal) => proposal.id === editingProposal.id ? nextProposal : proposal));
                setViewingProposal(nextProposal);
                setEditingProposal(null);
              } catch (error) {
                console.error(error);
                setToast({ type: "error", message: t("contentLibrary.saveChangesFailed") });
              }
            }}>{t("contentLibrary.saveChanges")}</Btn>
          </>
        ) : (
          <>
            <Btn variant="secondary" onClick={() => setViewingProposal(null)}>{t("common.close")}</Btn>
            <Btn variant="secondary" icon={<PenIcon size={12} />} onClick={() => openProposalHtmlEditor(viewingProposal)}>{t("contentLibrary.editProposal")}</Btn>
            <Btn variant="secondary" icon={<PenIcon size={12} />} onClick={() => openStructuredProposalEditor(viewingProposal)}>{createT.editStructure}</Btn>
            <Btn variant="secondary" onClick={() => downloadItem(viewingProposal, "docx")}>{createT.downloadDocx}</Btn>
            <Btn onClick={() => downloadItem(viewingProposal, "pdf")}>{createT.downloadPdf}</Btn>
            <Btn variant="teal" icon={<PlugIcon size={12} />} onClick={() => setToast(t("contentLibrary.crmUploadQueued"))}>{createT.uploadCrm}</Btn>
          </>
        )}
      </div>
    </div>
  </div>
)}
{/* ── Edit Proposal Modal ── */}
{false && editingProposal && (
  <div className="fixed inset-0 z-50 flex items-center justify-center">
    <div
      className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      onClick={() => setEditingProposal(null)}
    />

    <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-3">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        {t("contentLibrary.editProposal")}
      </h2>

      <div className="space-y-1.5">
        <Input
          value={editingProposal.draftTitle || ""}
          onChange={(e) =>
            setEditingProposal({
            ...editingProposal,
            draftTitle: e.target.value,
            })
         }
        placeholder={t("contentLibrary.proposalTitle")}
    />
      <div
        className="w-full border border-gray-300 rounded-lg px-4 py-4 text-sm text-left max-h-80 min-h-64 overflow-y-auto bg-white prose prose-slate max-w-none"
        contentEditable
        suppressContentEditableWarning
        dangerouslySetInnerHTML={{
           __html: editingProposal.draftContent || "",
        }}
          onBlur={(e) =>
          setEditingProposal({
          ...editingProposal,
          draftContent: e.currentTarget.innerHTML,
        })
      }
        placeholder={t("contentLibrary.editProposalContent")}
      />
        <div className="flex justify-end gap-1 pt-3">
          <Btn variant="ghost" onClick={() => setEditingProposal(null)}>
            {t("common.cancel")}
          </Btn>

        <Btn
          onClick={async () => {
            const editedProposal = {
              ...editingProposal,
              title: editingProposal.draftTitle,
              content: editingProposal.draftContent || editingProposal.content || "",
            };
            const structuredContent = normalizeProposalDocument(editedProposal);
            const professionalContent = proposalDocumentToHtml({ ...editedProposal, structuredContent });
            const updatedTotal = calculateProposalTotal({ ...editedProposal, structuredContent });
            try {
              const updatedProposal = await updateProposal(editingProposal.id, {
                title: editingProposal.draftTitle,
                description: editingProposal.description || "",
                content: professionalContent,
                structured_content: structuredContent,
                status: editingProposal.status,
                total_amount: updatedTotal.totalAmount,
                });

                 const refreshed = await getProposals().catch(() => null);
                 if (Array.isArray(refreshed)) {
                   setProposals(refreshed);
                 } else {
                   setProposals((prev) =>
                     prev.map((proposal) =>
                       proposal.id === editingProposal.id
                         ? {
                             ...proposal,
                             title: editingProposal.draftTitle,
                             content: professionalContent,
                             structuredContent,
                             description: editingProposal.description || proposal.description,
                             status: editingProposal.status || proposal.status,
                             totalAmount: updatedTotal.totalAmount,
                           }
                         : proposal,
                     ),
                   );
                 }

                 setEditingProposal(null);
                } catch (error) {
                  console.error(error);
                  setProposals((prev) =>
                    prev.map((proposal) =>
                      proposal.id === editingProposal.id
                        ? {
                            ...proposal,
                            title: editingProposal.draftTitle,
                            content: professionalContent,
                            structuredContent,
                            description: editingProposal.description || proposal.description,
                            status: editingProposal.status || proposal.status,
                            totalAmount: updatedTotal.totalAmount,
                          }
                        : proposal,
                    ),
                  );
                  setEditingProposal(null);
                }
              }}
            >
              {t("contentLibrary.saveChanges")}
          </Btn>
        </div>
      </div>
    </div>
  </div>
)}
  </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  PAGE: OUTREACH (merged Review Queue + Outreach History)        */
/* ═══════════════════════════════════════════════════════════════ */
function OutreachPageLegacy({ navigationState = {} }) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const [tab, setTab] = useState(navigationState.tab || "review");
  const [historyFilter, setHistoryFilter] = useState(navigationState.statusFilter || "all");
  const [selected, setSelected] = useState(0);

  const reviewEmails = DEMO_REVIEW_EMAILS;
  const history = DEMO_OUTREACH_HISTORY;

  useEffect(() => {
    if (navigationState.tab) setTab(navigationState.tab);
    if (navigationState.statusFilter) setHistoryFilter(navigationState.statusFilter);
  }, [navigationState.tab, navigationState.statusFilter]);

  const filteredHistory = historyFilter === "all"
    ? history
    : history.filter((item) => normalizeStageName(item.st) === normalizeStageName(historyFilter));

  const historyStatusLabel = (status) => ({
    Sent: t("outreachPage.filters.sent"),
    Opened: t("outreachPage.filters.opened"),
    Replied: t("outreachPage.filters.replied"),
    Bounced: t("outreachPage.filters.bounced"),
  }[status] || status);

  const e = reviewEmails[selected];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("outreachPage.title")}</h1>
          <p className="text-xs text-gray-500">{t("outreachPage.subtitle")}</p>
        </div>
        {tab === "review" && (
          <div className="flex gap-2">
            <Btn variant="destructive" small icon={<XIcon size={12} />}>{t("outreachPage.rejectAll")}</Btn>
            <Btn variant="teal" small icon={<CheckIcon size={12} />}>{t("outreachPage.approveAll")}</Btn>
          </div>
        )}
      </div>

      {/* Tab switcher */}
      <div className={`flex gap-1 p-1 rounded-xl w-fit ${isDark ? "bg-slate-800 border border-white/10" : "bg-gray-100"}`}>
        <button onClick={() => setTab("review")} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${tab === "review" ? isDark ? "bg-slate-700 text-white" : "bg-white text-gray-900 shadow-sm" : isDark ? "text-slate-300 hover:text-white" : "text-gray-500"}`}>
          <InboxIcon size={13} />{t("outreachPage.reviewQueue")}
          <span className="bg-amber-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">{reviewEmails.length}</span>
        </button>
        <button onClick={() => setTab("history")} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${tab === "history" ? isDark ? "bg-slate-700 text-white" : "bg-white text-gray-900 shadow-sm" : isDark ? "text-slate-300 hover:text-white" : "text-gray-500"}`}>
          <ClockIcon size={13} />{t("outreachPage.sentHistory")}
        </button>
      </div>

      {tab === "review" && (
        <div className="grid gap-4" style={{gridTemplateColumns:"2fr 3fr"}}>
          {/* Email list */}
          <div className="space-y-2">
            {reviewEmails.map((em, i) => (
              <div key={i} onClick={() => setSelected(i)}
                className={`p-3 rounded-xl border cursor-pointer transition-colors ${selected === i ? isDark ? "border-indigo-500/40 bg-slate-900" : "border-indigo-300 bg-indigo-50" : isDark ? "border-white/10 bg-slate-800 hover:border-white/20" : "border-gray-100 bg-white hover:border-gray-200"}`}>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs font-semibold text-gray-900">{em.to}</p>
                  <span className={`text-xs font-bold ${em.score >= 80 ? "text-green-600" : "text-amber-600"}`}>{t("outreachPage.confidenceShort")}: {em.score}%</span>
                </div>
                <p className="text-xs text-gray-500">{em.role} · {em.company}</p>
                <p className="text-xs text-gray-400 mt-1 truncate">{em.subject}</p>
                <div className="flex items-center gap-2 mt-1.5">
                  {em.score >= 80 && <Badge label={t("outreachPage.highScore")} color={isDark ? "bg-green-500/10 text-green-200 border border-green-400/20" : "bg-green-100 text-green-700"} />}
                  <span className="text-xs text-indigo-500 flex items-center gap-0.5"><LinkIcon size={9} />{em.contentRef}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Email preview */}
          <Card className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-semibold text-gray-900">{e.to}</p>
                <p className="text-xs text-gray-500">{e.role} @ {e.company}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-sm font-bold ${e.score >= 80 ? "text-green-600" : "text-amber-600"}`}>{t("outreachPage.confidenceShort")}: {e.score}%</span>
                <Badge label={e.score >= 80 ? t("outreachPage.highConfidence") : t("outreachPage.reviewSuggested")} color={isDark ? e.score >= 80 ? "bg-green-500/10 text-green-200 border border-green-400/20" : "bg-amber-500/10 text-amber-200 border border-amber-400/20" : e.score >= 80 ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"} />
              </div>
            </div>
            <div className="flex gap-3 mb-3">
              <div className={`flex-1 p-2 rounded-lg ${isDark ? "bg-[#0F172A] border border-white/10" : "bg-gray-50"}`}>
                <p className="text-xs text-gray-500">{t("outreachPage.opportunity")}</p>
                <p className="text-xs font-medium text-gray-800">{e.vacancy} @ {e.company}</p>
              </div>
              <div className={`flex-1 p-2 rounded-lg ${isDark ? "bg-[#0F172A] border border-white/10" : "bg-indigo-50"}`}>
                <p className="text-xs text-indigo-400">{t("outreachPage.contentReferenced")}</p>
                <p className="text-xs font-medium text-indigo-700 flex items-center gap-1"><LinkIcon size={10} />{e.contentRef}</p>
              </div>
            </div>
            <div className="mb-[18px]">
              <p className="text-xs text-gray-500 mb-1">{t("outreachPage.subject")}</p>
              <p className="text-xs font-semibold text-gray-900">{e.subject}</p>
            </div>
            <div className={`mb-4 p-3 rounded-lg ${isDark ? "bg-[#0F172A] border border-white/10" : "bg-white border border-gray-200"}`}>
              <pre className={`text-xs whitespace-pre-wrap font-sans leading-relaxed ${isDark ? "text-slate-200" : "text-gray-700"}`}>{e.preview}</pre>
            </div>
            <div className="flex gap-2 justify-end">
              <Btn variant="ghost" small icon={<RefreshIcon size={12} />}>{t("outreachPage.regenerate")}</Btn>
              <Btn variant="secondary" small icon={<PenIcon size={12} />}>{t("outreachPage.edit")}</Btn>
              <Btn variant="destructive" small icon={<XIcon size={12} />}>{t("outreachPage.reject")}</Btn>
              <Btn variant="teal" icon={<CheckIcon size={13} />}>{t("outreachPage.approveSend")}</Btn>
            </div>
          </Card>
        </div>
      )}

      {tab === "history" && (
        <>
          <div className="flex gap-2">{["all","sent","opened","replied","bounced"].map((filterKey,i)=>(
            <button
              key={filterKey}
              onClick={() => setHistoryFilter(filterKey)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium ${historyFilter === filterKey ? "bg-indigo-600 text-white" : isDark ? "bg-slate-800 text-slate-300 border border-white/10 hover:bg-slate-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              {t(`outreachPage.filters.${filterKey}`)}
            </button>
          ))}</div>
          <Card>
            <table className="w-full text-xs">
              <thead><tr className="bg-slate-50 text-slate-600 uppercase">
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.contact")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.company")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.subject")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.contentUsed")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.status")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.sent")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.score")}</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {filteredHistory.map((o) => (
                  <tr key={o.name} className="hover:bg-slate-50 cursor-pointer">
                    <td className="px-4 py-3 font-medium text-gray-900">{o.name}</td>
                    <td className="px-4 py-3 text-gray-600">{o.co}</td>
                    <td className="px-4 py-3 text-gray-500 truncate max-w-[180px]">{o.subj}</td>
                    <td className="px-4 py-3"><span className="text-xs text-indigo-600 flex items-center gap-1"><LinkIcon size={10} />{o.content}</span></td>
                    <td className="px-4 py-3"><Badge label={historyStatusLabel(o.st)} color={o.stc} /></td>
                    <td className="px-4 py-3 text-gray-500">{o.date}</td>
                    <td className="px-4 py-3 font-semibold text-indigo-600">{o.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

function OutreachPage({ navigationState = {}, onNavigate = () => {}, onOutreachBadgeChange = () => {}, campaignFlow = null, setCampaignFlow = () => {} }) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const [tab, setTab] = useState(navigationState.tab || "review");
  const [historyFilter, setHistoryFilter] = useState(navigationState.statusFilter || "all");
  const [selected, setSelected] = useState(null);
  const [reviewEmails, setReviewEmails] = useState([]);
  const [history, setHistory] = useState([]);
  const [loadingOutreach, setLoadingOutreach] = useState(true);
  const [outreachBusy, setOutreachBusy] = useState(false);
  const [generatingResponse, setGeneratingResponse] = useState(false);
  const [generatingCampaignMessages, setGeneratingCampaignMessages] = useState(false);
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [simulateForm, setSimulateForm] = useState({
    contact_message: "Thanks for reaching out. Can you send more detail about pricing and what an AI marketing automation rollout would look like for us?",
    name: "Jordan Lee",
    company: "Acme Growth",
    role: "VP Marketing",
  });

  useEffect(() => {
    if (navigationState.tab) setTab(navigationState.tab);
    if (navigationState.statusFilter) setHistoryFilter(navigationState.statusFilter);
  }, [navigationState.tab, navigationState.statusFilter]);

  useEffect(() => {
    let cancelled = false;
    setLoadingOutreach(true);
    fetchOptional("/outreach", null).then((data) => {
      if (cancelled) return;
      const nextReviewEmails = data !== null ? (data.reviewQueue ?? []) : [];
      const nextHistory = data !== null ? (data.history ?? []) : [];
      setReviewEmails(nextReviewEmails);
      setHistory(nextHistory);
      setSelected(nextReviewEmails.length ? 0 : null);
      onOutreachBadgeChange(nextReviewEmails.length);
      setLoadingOutreach(false);
    });
    return () => {
      cancelled = true;
    };
  }, [onOutreachBadgeChange]);

  useEffect(() => {
    if (!reviewEmails.length) {
      setSelected(null);
    } else if (selected === null || selected >= reviewEmails.length) {
      setSelected(0);
    }
  }, [reviewEmails.length, selected]);

  const filteredHistory = historyFilter === "all"
    ? history
    : history.filter((item) => normalizeStageName(item.st || item.status) === normalizeStageName(historyFilter));
  const historyStatusLabel = (status) => ({
    Sent: t("outreachPage.filters.sent"),
    Opened: t("outreachPage.filters.opened"),
    Replied: t("outreachPage.filters.replied"),
    Bounced: t("outreachPage.filters.bounced"),
    sent: t("outreachPage.filters.sent"),
    rejected: t("outreachPage.reject"),
  }[status] || status);
  const historyStatusColor = (item) => item.stc || (item.status === "rejected" ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-600");
  const reviewName = (item = {}) => item.name || item.to || "";
  const reviewContent = (item = {}) => item.content || item.preview || "";
  const reviewContentRef = (item = {}) => item.contentRef || item.response_type || "AI response";
  const reviewScore = (item = {}) => Number.parseInt(item.score, 10) || 0;
  const syncBadge = (items) => onOutreachBadgeChange(items.length);
  const campaignApprovedMessages = campaignFlow?.currentStep === 5 && history.some((item) => (
    (!campaignFlow.campaignId || item.campaign_id === campaignFlow.campaignId)
    && (item.status === "sent" || item.st === "Sent")
  ));
  const generateCampaignOutreach = async () => {
    if (!campaignFlow?.selectedOpportunities?.length || campaignFlow?.autoGenerated) return;
    setGeneratingCampaignMessages(true);
    try {
      await api.post("/outreach/generate-from-campaign", {
        campaign_id: campaignFlow.campaignId,
        campaign_name: campaignFlow.campaignName,
        objective: campaignFlow.brief?.objective || "lead_generation",
        channels: campaignFlow.brief?.channels || ["email_outreach"],
        context: campaignFlow.brief?.context || "",
        opportunities: campaignFlow.selectedOpportunities.map((opportunity) => ({
          id: opportunity.id,
          company: opportunity.company || opportunity.name,
          contact: opportunity.contactName || opportunity.contact || "",
          role: opportunity.contactRole || opportunity.role || "",
          industry: opportunity.industry || "",
          score: opportunity.score || 0,
          stage: opportunity.stage || "",
        })),
        assets: campaignFlow.selectedAssets || [],
      });

      setCampaignFlow((prev) => ({ ...prev, autoGenerated: true }));

      const updated = await api.get("/outreach/review-queue").then((response) => response.data);
      setReviewEmails(updated);
      syncBadge(updated);
      setSelected(updated.length ? 0 : null);
      setTab("review");
    } catch (e) {
      console.error("Error generating campaign outreach:", e);
    } finally {
      setGeneratingCampaignMessages(false);
    }
  };

  useEffect(() => {
    if (
      campaignFlow?.currentStep === 5
      && campaignFlow?.selectedOpportunities?.length > 0
      && !campaignFlow?.autoGenerated
    ) {
      generateCampaignOutreach();
    }
  }, [campaignFlow?.currentStep]);
  const removeFromReview = (item) => {
    setReviewEmails((prev) => {
      const next = prev.filter((email) => email !== item && email.id !== item.id);
      syncBadge(next);
      return next;
    });
    setSelected(null);
  };
  const activateCampaignFlow = async () => {
    if (!campaignFlow?.campaignId) return;
    setOutreachBusy(true);
    try {
      await campaignsApi.update(campaignFlow.campaignId, { status: "active" });
      setCampaignFlow((prev) => completeCampaignFlowSteps(prev, [5, 6], 7));
      window.dispatchEvent(new CustomEvent("marketgen:campaigns-updated"));
      onNavigate("reports");
    } finally {
      setOutreachBusy(false);
    }
  };

  const handleApprove = async (item) => {
    if (!item) return;
    setOutreachBusy(true);
    try {
      let updated = { ...item, status: "sent", sent_at: new Date().toISOString() };
      if (item.id) {
        const res = await api.patch(`/outreach/review-queue/${item.id}/approve`);
        updated = res.data || updated;
      }
      removeFromReview(item);
      setHistory((prev) => [updated, ...prev]);
      if (campaignFlow?.currentStep === 5) {
        setCampaignFlow((prev) => completeCampaignFlowSteps(prev, [5], 6));
      }
    } finally {
      setOutreachBusy(false);
    }
  };
  const handleReject = async (item) => {
    if (!item) return;
    setOutreachBusy(true);
    try {
      if (item.id) await api.patch(`/outreach/review-queue/${item.id}/reject`);
      removeFromReview(item);
    } finally {
      setOutreachBusy(false);
    }
  };
  const handleRegenerate = async (item) => {
    if (!item?.id) return;
    setOutreachBusy(true);
    try {
      const res = await api.patch(`/outreach/review-queue/${item.id}/regenerate`);
      setReviewEmails((prev) => prev.map((email) => email.id === item.id ? { ...email, content: res.data.content } : email));
    } finally {
      setOutreachBusy(false);
    }
  };
  const handleApproveAll = async () => {
    setOutreachBusy(true);
    try {
      await Promise.all(reviewEmails.filter((email) => email.id).map((email) => api.patch(`/outreach/review-queue/${email.id}/approve`)));
      setHistory((prev) => [...reviewEmails.map((email) => ({ ...email, status: "sent", sent_at: new Date().toISOString() })), ...prev]);
      setReviewEmails([]);
      syncBadge([]);
      setSelected(null);
      if (campaignFlow?.currentStep === 5) {
        setCampaignFlow((prev) => completeCampaignFlowSteps(prev, [5], 6));
      }
    } finally {
      setOutreachBusy(false);
    }
  };
  const handleRejectAll = async () => {
    setOutreachBusy(true);
    try {
      await Promise.all(reviewEmails.filter((email) => email.id).map((email) => api.patch(`/outreach/review-queue/${email.id}/reject`)));
      setReviewEmails([]);
      syncBadge([]);
      setSelected(null);
    } finally {
      setOutreachBusy(false);
    }
  };
  const handleRestoreOutreach = async (item) => {
    if (!item?.id) return;
    setOutreachBusy(true);
    try {
      await api.patch(`/outreach/history/${item.id}/restore`);
      setHistory((prev) => prev.filter((email) => email.id !== item.id));
      setReviewEmails((prev) => {
        const next = [{ ...item, status: "pending", sent_at: null }, ...prev];
        syncBadge(next);
        return next;
      });
      setSelected(0);
    } finally {
      setOutreachBusy(false);
    }
  };
  const handleDeleteOutreach = async (item) => {
    if (!item?.id) return;
    setOutreachBusy(true);
    try {
      await api.delete(`/outreach/history/${item.id}`);
      setHistory((prev) => prev.filter((email) => email.id !== item.id));
    } finally {
      setOutreachBusy(false);
    }
  };
  const generateSimulatedResponse = async () => {
    setOutreachBusy(true);
    setGeneratingResponse(true);
    try {
      const res = await api.post("/outreach/review-queue/generate-response", simulateForm);
      const item = res.data;
      setReviewEmails((prev) => {
        const next = [item, ...prev];
        syncBadge(next);
        return next;
      });
      setSelected(0);
      setSimulateOpen(false);
    } finally {
      setOutreachBusy(false);
      setGeneratingResponse(false);
    }
  };

  const e = selected === null ? null : reviewEmails[selected];

  return (
    <div className="space-y-2 relative">
      {campaignFlow?.currentStep === 5 && (
        <div className="flow-step-banner">
          <span>✏️ Step 5: Review and approve AI-generated outreach messages</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => setCampaignFlow((prev) => completeCampaignFlowSteps(prev, [5], 6))}
              style={{ background: "transparent", color: "#6366F1", border: "1px solid #6366F1", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: "0.85em" }}
            >
              Skip to Activate
            </button>
            {campaignApprovedMessages && (
              <button
                type="button"
                onClick={async () => {
                  setCampaignFlow((prev) => completeCampaignFlowSteps(prev, [5, 6], 7));
                  if (campaignFlow.campaignId) {
                    campaignsApi.update(campaignFlow.campaignId, { status: "active" })
                      .catch((e) => console.error(e));
                  }
                  onNavigate("reports");
                }}
              >
                Activate Campaign →
              </button>
            )}
          </div>
        </div>
      )}
      {campaignFlow?.currentStep === 6 && (
        <div className="flow-step-banner">
          <span>🚀 Step 6: Activate the campaign</span>
          <button type="button" onClick={activateCampaignFlow} disabled={outreachBusy || !campaignFlow.campaignId}>
            Activate Campaign
          </button>
        </div>
      )}
      {generatingCampaignMessages && (
        <div style={{
          position: "absolute", inset: 0, background: "rgba(255,255,255,0.9)",
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", gap: 16, zIndex: 10, borderRadius: 8,
        }}>
          <div className="spinner" style={{ width: 32, height: 32, borderWidth: 3 }} />
          <p style={{ color: "#6366F1", fontWeight: 600 }}>
            Generating personalized messages for {campaignFlow?.selectedOpportunities?.length} prospects...
          </p>
          <p style={{ color: "#94A3B8", fontSize: "0.85em" }}>
            AI is crafting messages based on your campaign brief and selected assets
          </p>
        </div>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("outreachPage.title")}</h1>
          <p className="text-xs text-gray-500">{t("outreachPage.subtitle")}</p>
        </div>
        {tab === "review" && (
          <div className="flex gap-1">
            <Btn variant="secondary" small icon={<SparkIcon size={12} />} onClick={() => setSimulateOpen(true)}>Simulate Contact Response</Btn>
            <Btn variant="destructive" small icon={<XIcon size={12} />} onClick={handleRejectAll} disabled={outreachBusy || reviewEmails.length === 0}>{t("outreachPage.rejectAll")}</Btn>
            <Btn variant="teal" small icon={<CheckIcon size={12} />} onClick={handleApproveAll} disabled={outreachBusy || reviewEmails.length === 0}>{t("outreachPage.approveAll")}</Btn>
          </div>
        )}
      </div>

      {loadingOutreach && (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #eaecf3", padding: "48px 24px", textAlign: "center" }}>
          <p style={{ fontSize: 14, color: "#94a3b8", fontWeight: 500, margin: 0 }}>Loading outreach queue...</p>
        </div>
      )}

      <div className={`flex gap-1 p-1 rounded-xl w-fit ${isDark ? "bg-slate-800 border border-white/10" : "bg-gray-100"}`}>
        <button onClick={() => setTab("review")} className={`flex items-center gap-1 px-4 py-4 rounded-lg text-xs font-medium transition-colors ${tab === "review" ? isDark ? "bg-slate-700 text-white" : "bg-white text-gray-900 shadow-sm" : isDark ? "text-slate-300 hover:text-white" : "text-gray-500"}`}>
          <InboxIcon size={13} />{t("outreachPage.reviewQueue")}
          <span className="bg-amber-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">{reviewEmails.length}</span>
        </button>
        <button onClick={() => setTab("history")} className={`flex items-center gap-1 px-4 py-4 rounded-lg text-xs font-medium transition-colors ${tab === "history" ? isDark ? "bg-slate-700 text-white" : "bg-white text-gray-900 shadow-sm" : isDark ? "text-slate-300 hover:text-white" : "text-gray-500"}`}>
          <ClockIcon size={13} />{t("outreachPage.sentHistory")}
        </button>
      </div>

      {tab === "review" && (
        <div className="grid gap-2" style={{gridTemplateColumns:"2fr 3fr"}}>
          <div className="space-y-1">
            {!loadingOutreach && reviewEmails.length === 0 && (
              <Card className="p-3 text-center">
                <p className="text-sm font-semibold text-gray-900">No responses pending review</p>
                <p className="mb-1.5 text-xs text-gray-500">Simulate a contact reply to generate an AI response.</p>
                <Btn variant="secondary" small icon={<SparkIcon size={12} />} onClick={() => setSimulateOpen(true)}>Simulate Contact Response</Btn>
              </Card>
            )}
            {reviewEmails.map((em, i) => (
              <div key={em.id || i} onClick={() => setSelected(i)}
                className={`p-2 rounded-xl border cursor-pointer transition-colors ${selected === i ? isDark ? "border-indigo-500/40 bg-slate-900" : "border-indigo-300 bg-indigo-50" : isDark ? "border-white/10 bg-slate-800 hover:border-white/20" : "border-gray-100 bg-white hover:border-gray-200"}`}>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs font-semibold text-gray-900">{reviewName(em)}</p>
                  <span className={`text-xs font-bold ${reviewScore(em) >= 80 ? "text-green-600" : "text-amber-600"}`}>{t("outreachPage.confidenceShort")}: {reviewScore(em)}%</span>
                </div>
                <p className="text-xs text-gray-500">{em.role} · {em.company}</p>
                <p className="text-xs text-gray-400 mt-1 truncate">{em.subject}</p>
                <div className="flex items-center gap-1 mt-1.5">
                  {reviewScore(em) >= 80 && <Badge label={t("outreachPage.highScore")} color={isDark ? "bg-green-500/10 text-green-200 border border-green-400/20" : "bg-green-100 text-green-700"} />}
                  <span className="text-xs text-indigo-500 flex items-center gap-0.5"><LinkIcon size={9} />{reviewContentRef(em)}</span>
                </div>
              </div>
            ))}
          </div>

          <Card className="p-3">
            {!e ? (
              <div className="py-10 text-center">
                <p className="text-sm font-semibold text-gray-900">Select or generate a response</p>
                <p className="text-xs text-gray-500">The AI response preview will appear here.</p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{reviewName(e)}</p>
                    <p className="text-xs text-gray-500">{e.role} @ {e.company}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className={`text-sm font-bold ${reviewScore(e) >= 80 ? "text-green-600" : "text-amber-600"}`}>{t("outreachPage.confidenceShort")}: {reviewScore(e)}%</span>
                    <Badge label={reviewScore(e) >= 80 ? t("outreachPage.highConfidence") : t("outreachPage.reviewSuggested")} color={isDark ? reviewScore(e) >= 80 ? "bg-green-500/10 text-green-200 border border-green-400/20" : "bg-amber-500/10 text-amber-200 border border-amber-400/20" : reviewScore(e) >= 80 ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"} />
                  </div>
                </div>
                <div className="flex gap-1.5 mb-1.5">
                  <div className={`flex-1 p-2 rounded-lg ${isDark ? "bg-[#0F172A] border border-white/10" : "bg-gray-50"}`}>
                    <p className="text-xs text-gray-500">{t("outreachPage.opportunity")}</p>
                    <p className="text-xs font-medium text-gray-800">{e.vacancy || e.contact_message || "Contact response"} @ {e.company}</p>
                  </div>
                  <div className={`flex-1 p-2 rounded-lg ${isDark ? "bg-[#0F172A] border border-white/10" : "bg-indigo-50"}`}>
                    <p className="text-xs text-indigo-400">{t("outreachPage.contentReferenced")}</p>
                    <p className="text-xs font-medium text-indigo-700 flex items-center gap-1"><LinkIcon size={10} />{reviewContentRef(e)}</p>
                  </div>
                </div>
                <div className="mb-[18px]">
                  <p className="text-xs text-gray-500 mb-1">{t("outreachPage.subject")}</p>
                  <p className="text-xs font-semibold text-gray-900">{e.subject}</p>
                </div>
                <div className={`mb-4 p-2 rounded-lg ${isDark ? "bg-[#0F172A] border border-white/10" : "bg-white border border-gray-200"}`}>
                  <pre className={`text-xs whitespace-pre-wrap font-sans leading-relaxed ${isDark ? "text-slate-200" : "text-gray-700"}`}>{reviewContent(e)}</pre>
                </div>
                <div className="flex gap-1 justify-end">
                  <Btn variant="ghost" small icon={<RefreshIcon size={12} />} onClick={() => handleRegenerate(e)} disabled={outreachBusy || !e.id}>{t("outreachPage.regenerate")}</Btn>
                  <Btn variant="secondary" small icon={<PenIcon size={12} />}>{t("outreachPage.edit")}</Btn>
                  <Btn variant="destructive" small icon={<XIcon size={12} />} onClick={() => handleReject(e)} disabled={outreachBusy}>{t("outreachPage.reject")}</Btn>
                  <Btn variant="teal" icon={<CheckIcon size={13} />} onClick={() => handleApprove(e)} disabled={outreachBusy}>{t("outreachPage.approveSend")}</Btn>
                </div>
              </>
            )}
          </Card>
        </div>
      )}

      {tab === "history" && (
        <>
          <div className="flex gap-1">{["all","sent","opened","replied","bounced"].map((filterKey)=>(
            <button
              key={filterKey}
              onClick={() => setHistoryFilter(filterKey)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium ${historyFilter === filterKey ? "bg-indigo-600 text-white" : isDark ? "bg-slate-800 text-slate-300 border border-white/10 hover:bg-slate-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              {t(`outreachPage.filters.${filterKey}`)}
            </button>
          ))}</div>
          <Card>
            <table className="w-full text-xs">
              <thead><tr className="bg-slate-50 text-slate-600 uppercase">
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.contact")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.company")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.subject")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.contentUsed")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.status")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.approvedBy")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.sent")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.score")}</th>
                <th className="px-4 py-2.5 text-right font-medium">Actions</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {filteredHistory.map((o) => (
                  <tr key={o.id || o.name} className="group hover:bg-slate-50 cursor-pointer">
                    <td className="px-4 py-4 font-medium text-gray-900">{o.name || o.to}</td>
                    <td className="px-4 py-4 text-gray-600">{o.co || o.company}</td>
                    <td className="px-4 py-4 text-gray-500 truncate max-w-[180px]">{o.subj || o.subject}</td>
                    <td className="px-4 py-4"><span className="text-xs text-indigo-600 flex items-center gap-1"><LinkIcon size={10} />{o.contentRef || o.response_type || o.content}</span></td>
                    <td className="px-4 py-4"><Badge label={historyStatusLabel(o.st || o.status)} color={historyStatusColor(o)} /></td>
                    <td className="px-4 py-4">
                      {o.approvedByName ? (
                        <Badge label={`✓ ${o.approvedByName}`} color="bg-green-100 text-green-700" />
                      ) : o.rejectedByName ? (
                        <Badge label={`✗ ${o.rejectedByName}`} color="bg-red-100 text-red-700" />
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-gray-500">{o.date || String(o.sent_at || "").slice(0, 10)}</td>
                    <td className="px-4 py-4 font-semibold text-indigo-600">{String(o.score || "").includes("%") ? o.score : `${o.score || 0}%`}</td>
                    <td className="px-4 py-4">
                      <div className="flex justify-end gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                        {o.status === "rejected" && (
                          <button
                            type="button"
                            onClick={() => handleRestoreOutreach(o)}
                            disabled={outreachBusy}
                            className="rounded-md border border-indigo-300 bg-transparent px-2.5 py-1 text-xs font-medium text-indigo-600 transition hover:border-indigo-400 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            ↩ Restore
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDeleteOutreach(o)}
                          disabled={outreachBusy}
                          className="rounded-md border border-red-200 bg-transparent px-2.5 py-1 text-xs font-medium text-red-600 transition hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label="Delete outreach history item"
                        >
                          🗑
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {simulateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <style>{`
            .spinner {
              display: inline-block;
              width: 14px;
              height: 14px;
              border: 2px solid rgba(255,255,255,0.3);
              border-top-color: white;
              border-radius: 50%;
              animation: spin 0.7s linear infinite;
              margin-right: 6px;
            }
            @keyframes spin {
              to { transform: rotate(360deg); }
            }
          `}</style>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setSimulateOpen(false)} />
          <div className={`relative w-full max-w-lg rounded-2xl shadow-2xl ${isDark ? "bg-slate-800 border border-white/10" : "bg-white"}`}>
            <div className={`flex items-center justify-between p-3 border-b ${isDark ? "border-white/10" : "border-gray-100"}`}>
              <div>
                <p className={`text-sm font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>Simulate Contact Response</p>
                <p className="text-xs text-gray-500">Generate an AI response into the review queue.</p>
              </div>
              <button onClick={() => setSimulateOpen(false)} className={`p-1.5 rounded-lg transition-colors ${isDark ? "hover:bg-slate-700" : "hover:bg-gray-100"}`}>
                <XIcon size={16} className="text-gray-400" />
              </button>
            </div>
            <div className="space-y-1.5 p-3">
              <Field label="Contact message">
                <textarea
                  className="min-h-28 w-full rounded-lg border border-gray-200 px-3 py-4 text-sm outline-none focus:border-indigo-400"
                  value={simulateForm.contact_message}
                  onChange={(event) => setSimulateForm((current) => ({ ...current, contact_message: event.target.value }))}
                />
              </Field>
              <div className="grid grid-cols-3 gap-1.5">
                <Field label="Name"><Input value={simulateForm.name} onChange={(event) => setSimulateForm((current) => ({ ...current, name: event.target.value }))} /></Field>
                <Field label="Company"><Input value={simulateForm.company} onChange={(event) => setSimulateForm((current) => ({ ...current, company: event.target.value }))} /></Field>
                <Field label="Role"><Input value={simulateForm.role} onChange={(event) => setSimulateForm((current) => ({ ...current, role: event.target.value }))} /></Field>
              </div>
            </div>
            <div className={`flex justify-end gap-1 p-3 border-t ${isDark ? "border-white/10 bg-[#0F172A]" : "border-gray-100 bg-gray-50"}`}>
              <Btn variant="ghost" onClick={() => setSimulateOpen(false)} disabled={outreachBusy}>{t("common.cancel")}</Btn>
              <Btn onClick={generateSimulatedResponse} disabled={generatingResponse || outreachBusy || !simulateForm.contact_message.trim() || !simulateForm.name.trim() || !simulateForm.company.trim()}>
                {generatingResponse
                  ? <><span className="spinner" /> Generating...</>
                  : <><span>✦</span> Generate AI Response</>}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  PAGE: AI ASSISTANT (contextual)                                */
/* ═══════════════════════════════════════════════════════════════ */
function AssistantPage({ navigationState = {}, onNavigate = () => {}, campaignFlow = null, setCampaignFlow = () => {} }) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const { language: currentLanguage } = useLanguage();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const [assistantMessages, setAssistantMessages] = useState([]);
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantLoading, setAssistantLoading] = useState(false);

  const assistantEndRef = useRef(null); useEffect(() => {
  assistantEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [assistantMessages, assistantLoading]);

  const suggestions = [
    { icon: BriefIcon, text: t("chat.suggestions.summarize"), color: "text-indigo-600 bg-indigo-50" },
    { icon: TargetIcon, text: t("chat.suggestions.close"), color: "text-teal-600 bg-teal-50" },
    { icon: Share2Icon, text: t("chat.suggestions.linkedin"), color: "text-purple-600 bg-purple-50" },
    { icon: BookIcon, text: t("chat.suggestions.compare"), color: "text-amber-600 bg-amber-50" },
  ];

  const assistantLanguageCopy = {
    en: {
      name: "English",
      noReply: "No response",
      fallback: "I can help with existing proposals, opportunity prioritization, and marketing ideas. The live AI endpoint is not available right now, but this assistant area is ready for DeepSeek-backed responses.",
    },
    es: {
      name: "Spanish",
      noReply: "Sin respuesta",
      fallback: "Puedo ayudarte con propuestas existentes, priorización de oportunidades e ideas de marketing. El endpoint de IA no está disponible en este momento, pero esta área está lista para respuestas respaldadas por DeepSeek.",
    },
    pt: {
      name: "Portuguese",
      noReply: "Sem resposta",
      fallback: "Posso ajudar com propostas existentes, priorização de oportunidades e ideias de marketing. O endpoint de IA não está disponível no momento, mas esta área está pronta para respostas com suporte do DeepSeek.",
    },
  };

  const sendAssistantMessage = async (overrideMessage = "") => {
    const message = (overrideMessage || assistantInput).trim();
    if (!message) return;
    const language = detectProposalLanguage(message);
    const languageCopy = assistantLanguageCopy[language] || assistantLanguageCopy.en;
    const responseInstruction = `Respond strictly in ${languageCopy.name}. Match the language used by the user's message. Do not switch languages unless the user asks you to.`;

    setAssistantInput("");
    setAssistantMessages((prev) => [
      ...prev,
      { role: "user", content: message },
    ]);

    setAssistantLoading(true);

    try {
      const { data } = await api.post("/assistant/chat", {
        message: `${responseInstruction}\n\nUser message:\n${message}`,
        originalMessage: message,
        language,
        responseLanguage: languageCopy.name,
        instruction: responseInstruction,
      });

      setAssistantMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply || languageCopy.noReply },
      ]);
    } catch (error) {
      setAssistantMessages((prev) => [
        ...prev,
        { role: "assistant", content: languageCopy.fallback },
      ]);
    } finally {
      setAssistantLoading(false);
    }
  };

  const saveAssistantNote = async (content) => {
    if (!content || content.trim() === "") return;

    if (campaignFlow) {
      const existingNote = campaignFlow.savedNotes?.find(
        (note) => note.campaignId === campaignFlow.campaignId
      );
      if (existingNote) {
        const replace = window.confirm("A note already exists for this campaign. Replace it?");
        if (!replace) return;
      }

      try {
        console.log("Saving note content:", content);
        await api.post("/content/generate/template", {
          template_name: `AI Note — ${campaignFlow.campaignName}`,
          channel: "Email",
          category: "campaign_note",
          tone: "Professional",
          use_case: content,
          merge_variables: ["first_name", "company"],
          language: currentLanguage || "en",
        });
        setCampaignFlow((prev) => ({
          ...prev,
          savedNotes: [
            ...(prev?.savedNotes || []).filter((note) => note.campaignId !== campaignFlow.campaignId),
            {
              content: content,
              campaignId: campaignFlow.campaignId,
              timestamp: new Date().toISOString(),
            },
          ],
        }));
        window.dispatchEvent(new Event("marketgen:content-library-updated"));
        alert(t("chat.noteSaved"));
      } catch (e) {
        console.error("Error saving campaign note:", e);
        alert("Error saving note. Please try again.");
      }
    } else {
      alert(t("chat.noteSaved"));
    }
  };

  return (
    <div className="flex flex-col h-full">
      {campaignFlow?.currentStep === 3 && (
        <>
          <div className="flow-step-banner">
            <span>✦ Step 3: Use the AI Assistant to shape your campaign content (optional)</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  setCampaignFlow((prev) => completeCampaignFlowSteps(prev, [3], 4));
                  onNavigate("content");
                }}
                style={{ background: "transparent", color: "#6366F1", border: "1px solid #6366F1", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: "0.85em" }}
              >
                Skip
              </button>
              <button
                type="button"
                onClick={() => {
                  setCampaignFlow((prev) => completeCampaignFlowSteps(prev, [3], 4));
                  onNavigate("content");
                }}
              >
                Continue to Assets →
              </button>
            </div>
          </div>
          {campaignFlow?.savedNotes?.length > 0 && (
            <div style={{ fontSize: "0.8em", color: "#6366F1", marginBottom: 8 }}>
              ✓ {campaignFlow.savedNotes.length} note(s) saved for this campaign
            </div>
          )}
        </>
      )}
      <div className="p-2 border-b border-gray-100 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <SparkIcon size={16} className="text-indigo-600" />
          <h2 className="text-sm font-semibold text-gray-900">{t("chat.title")}</h2>
        </div>
        <Badge label={t("chat.contextAware")} color={isDark ? "bg-[#0F172A] text-slate-300 border border-white/10" : "bg-indigo-100 text-indigo-700"} />
      </div>

      <div className="flex-1 p-2 space-y-2 overflow-y-auto">
        <div className={`rounded-xl p-2 ${isDark ? "bg-[#0F172A]/40 border border-white/10" : "bg-gray-50"}`}>
          <p className="text-xs font-medium text-gray-500 mb-1">
            {t("chat.suggestedActions")}
          </p>

          <div className="grid grid-cols-2 gap-1">
            {suggestions.map((s, i) => (
              <button
                key={i}
                onClick={() => {
                  setAssistantInput(s.text);
                  sendAssistantMessage(s.text);
              }}
                className={`flex items-center gap-1 p-2.5 rounded-lg border transition-colors text-left ${isDark ? "bg-slate-800 border-white/10 hover:bg-slate-700 hover:border-white/20" : "bg-white border-gray-100 hover:border-indigo-200"}`}
              >
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${isDark ? `${s.color.replace(/\bbg-\S+/g, "bg-[#0F172A]")} border border-white/10` : s.color}`}>
                  <s.icon size={12} />
                </div>
                <span className={`text-xs ${isDark ? "text-slate-200" : "text-gray-700"}`}>{s.text}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-1 max-w-[80%]">
          <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${isDark ? "bg-[#0F172A] border border-white/10" : "bg-indigo-100"}`}>
            <BotIcon size={13} className="text-indigo-600" />
          </div>
          <div className={`border rounded-2xl rounded-tl-sm p-2 text-xs ${isDark ? "bg-slate-800 border-white/10 text-slate-200" : "bg-white border-gray-200 text-gray-700"}`}>
            {t("chat.greeting")}
          </div>
        </div>

        {assistantMessages.map((msg, index) => (
          <div
            key={index}
            className={`flex gap-1 ${
              msg.role === "user" ? "justify-end" : "max-w-[80%]"
            }`}
          >
            

            <div
              className={`rounded-2xl p-2 text-xs leading-relaxed ${
                msg.role === "user"
                  ? "bg-indigo-600 text-white rounded-tr-sm max-w-[75%]"
                  : isDark
                    ? "bg-slate-800 border border-white/10 text-slate-200 rounded-tl-sm"
                    : "bg-white border border-gray-200 text-gray-700 rounded-tl-sm"
              }`}
            >
              <ReactMarkdown>
                {msg.content}
              </ReactMarkdown>

          {msg.role === "assistant" && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <Btn
              small
              variant="secondary"
              icon={<SaveIcon size={12} />}
              onClick={() => saveAssistantNote(msg.content)}
            >
              {t("chat.saveAsNote")}
             </Btn>
            </div>
            )}
            </div>
          </div>
        ))}

        {assistantLoading && (
          <div className="flex gap-1 max-w-[80%]">
            <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${isDark ? "bg-[#0F172A] border border-white/10" : "bg-indigo-100"}`}>
              <BotIcon size={13} className="text-indigo-600" />
            </div>
            <div className={`border rounded-2xl rounded-tl-sm p-2 text-xs ${isDark ? "bg-slate-800 border-white/10 text-slate-400" : "bg-white border-gray-200 text-gray-400"}`}>
              {t("chat.thinking")}
            </div>
          </div>
        )}
        <div ref={assistantEndRef} />
      </div>

      <div className="p-2 border-t border-gray-100 flex gap-1">
        <input
          value={assistantInput}
          onChange={(e) => setAssistantInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && assistantInput.trim()) {
              e.preventDefault();
              sendAssistantMessage();
            }
          }}
          className="flex-1 border border-gray-300 rounded-xl px-4 py-4 text-xs"
          placeholder={t("chat.placeholder")}
        />

        <Btn
          icon={<SendIcon size={14} />}
          disabled={assistantLoading || !assistantInput.trim()}
          onClick={sendAssistantMessage}
        >
          {t("chat.send")}
        </Btn>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  PAGE: REPORTS                                                  */
/* ═══════════════════════════════════════════════════════════════ */
function ReportsPage({ onNavigate = () => {}, campaignFlow = null, setCampaignFlow = () => {} }) {
  const { t } = useI18n();
  const { language } = useLanguage();
  const [proposalStatusPeriod, setProposalStatusPeriod] = useState("30d");
  const [winRateData, setWinRateData] = useState({ rate: null, detail: "" });
  const [reportsState, setReportsState] = useState({
    overview: null,
    dashboard: null,
    proposals: null,
    loading: true,
    error: "",
    exporting: false,
  });

  const loadReports = async () => {
    setReportsState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const [overviewResponse, dashboardData, proposalsResponse] = await Promise.all([
        reportsApi.overview(),
        getDashboardData(),
        reportsApi.proposals(),
      ]);
      setReportsState({
        overview: overviewResponse.data || null,
        dashboard: dashboardData || null,
        proposals: proposalsResponse.data || null,
        loading: false,
        error: "",
        exporting: false,
      });
      setWinRateData({
        rate: overviewResponse.data?.win_rate,
        detail: overviewResponse.data?.win_rate_detail,
      });
    } catch {
      setReportsState((current) => ({
        ...current,
        loading: false,
        error: t("reports.loadError"),
      }));
    }
  };

  useEffect(() => {
    loadReports();
  }, []);

  const fetchWinRate = async (period) => {
    const days = period === "30d" ? 30 : period === "90d" ? 90 : null;
    const params = days ? `?days=${days}` : "";
    const res = await api.get(`/reports/overview${params}`).then((r) => r.data);
    setWinRateData({
      rate: res.win_rate,
      detail: res.win_rate_detail,
    });
  };

  const handlePeriodChange = (period) => {
    setProposalStatusPeriod(period);
    fetchWinRate(period);
  };

  useEffect(() => {
    const handleRefresh = () => loadReports();

    window.addEventListener("marketgen:proposal-updated", handleRefresh);
    window.addEventListener("marketgen:campaign-updated", handleRefresh);
    window.addEventListener("marketgen:opportunity-updated", handleRefresh);
    window.addEventListener("marketgen:content-library-updated", handleRefresh);

    return () => {
      window.removeEventListener("marketgen:proposal-updated", handleRefresh);
      window.removeEventListener("marketgen:campaign-updated", handleRefresh);
      window.removeEventListener("marketgen:opportunity-updated", handleRefresh);
      window.removeEventListener("marketgen:content-library-updated", handleRefresh);
    };
  }, []);

  const exportBooksPdf = async () => {
    setReportsState((current) => ({ ...current, exporting: true, error: "" }));
    try {
      const response = await reportsApi.export({ format: "pdf" });
      const url = window.URL.createObjectURL(new Blob([response.data], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "marketgen-books-report.pdf";
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      setReportsState((current) => ({ ...current, error: t("reports.exportError") }));
    } finally {
      setReportsState((current) => ({ ...current, exporting: false }));
    }
  };

  const reportsData = reportsState.overview || {};
  const overviewKpis = reportsData.kpis || {};
  const dashboard = reportsState.dashboard || {};
  const translateProposalStatus = (status, lang) => {
    const translations = {
      Generada: { en: "Generated", pt: "Gerada" },
      Entregada: { en: "Delivered", pt: "Entregue" },
      "En Negociación": { en: "In Negotiation", pt: "Em Negociação" },
      Cerrada: { en: "Closed", pt: "Fechada" },
      "En Contrato": { en: "Under Contract", pt: "Em Contrato" },
      Perdida: { en: "Lost", pt: "Perdida" },
    };
    if (lang === "es") return status;
    return translations[status]?.[lang] || status;
  };
  const statusColors = {
    Generada: "#6366F1",
    Entregada: "#3B82F6",
    "En Negociación": "#F59E0B",
    Cerrada: "#16A34A",
    "En Contrato": "#047857",
    Perdida: "#F43F5E",
  };
  const proposalStatusOrder = ["Generada", "Entregada", "En Negociación", "Cerrada", "En Contrato", "Perdida"];
  const rawProposalRows = Array.isArray(reportsState.proposals?.data) ? reportsState.proposals.data : [];
  const rawProposalRowsByStatus = rawProposalRows.reduce((map, row) => {
    const status = row.name || row.label || "Generada";
    map[status] = row;
    return map;
  }, {});
  const proposalRows = proposalStatusOrder.map((status) => {
    const row = rawProposalRowsByStatus[status] || {};
    const value = Number(row.value ?? row.count) || 0;
    const totalValue = Number(row.totalValue) || 0;
    return {
      ...row,
      status,
      name: translateProposalStatus(status, language),
      value,
      totalValue,
      fill: statusColors[status] || "#6366F1",
    };
  }).filter((row) => row.value > 0 || rawProposalRows.length === 0);
  const totalProposalValue = rawProposalRows.reduce((sum, row) => sum + (Number(row.totalValue) || 0), 0);
  const totalProposalCount = proposalRows.reduce((sum, row) => sum + row.value, 0);
  const winRateValue = Number(winRateData.rate ?? overviewKpis.winRate ?? dashboard?.totals?.winRate);
  const winRate = Number.isFinite(winRateValue) ? winRateValue : 0;
  let donutStart = -90;
  const donutStops = proposalRows.length && totalProposalCount > 0
    ? proposalRows.map((row) => {
        const deg = (row.value / totalProposalCount) * 360;
        const stop = `${row.fill} ${donutStart}deg ${donutStart + deg}deg`;
        donutStart += deg;
        return stop;
      }).join(", ")
    : "#1E2740 0deg 360deg";
  const donutStyle = { background: `conic-gradient(${donutStops})` };
  const proposalDisplayRows = proposalRows.map((row) => {
    const percent = Math.round((row.value / Math.max(totalProposalCount, 1)) * 100);
    return {
      ...row,
      percent,
    };
  });
  const funnelRows = [
    { label: t("reports.detected"), value: Number(dashboard.detected) || 0, color: "bg-blue-500", stageFilter: "Detected" },
    { label: t("reports.contacted"), value: Number(dashboard.contacted) || 0, color: "bg-indigo-500", stageFilter: "Contacted" },
    { label: t("reports.replied"), value: Number(dashboard.replied) || 0, color: "bg-purple-500", stageFilter: "Replied" },
    { label: t("reports.won"), value: Number(dashboard.won) || 0, color: "bg-green-500", stageFilter: "Won" },
  ];
  const maxFunnelValue = Math.max(0, ...funnelRows.map((row) => row.value));
  const formatCurrency = (value) => new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
  const formatPercent = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "0%";
    return `${numeric.toFixed(numeric % 1 === 0 ? 0 : 1)}%`;
  };
  const formatCompactCurrency = (amount) => {
    if (!amount || amount === 0) return '$0';
    if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`;
    if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}K`;
    return `$${amount}`;
  };
  return (
    <div className="space-y-2">
      {campaignFlow?.currentStep === 7 && (
        <div style={{
          background: 'linear-gradient(135deg, #F0FDF4, #ECFDF5)',
          border: '1px solid #BBF7D0',
          borderLeft: '4px solid #16A34A',
          borderRadius: 10, padding: 24, marginBottom: 24
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h2 style={{ color: '#166534', fontSize: '1.2em', fontWeight: 700, marginBottom: 4 }}>
                🎉 Campaign activated: {campaignFlow.campaignName}
              </h2>
              <p style={{ color: '#16A34A', fontSize: '0.9em' }}>
                Tracking results in real time below
              </p>
            </div>
            <button
              onClick={() => setCampaignFlow(null)}
              style={{ background: '#16A34A', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 6, cursor: 'pointer' }}
            >
              Finish
            </button>
          </div>

          {/* Resumen de la campaña */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 20 }}>
            <div style={{ background: 'white', borderRadius: 8, padding: 16, textAlign: 'center', border: '1px solid #D1FAE5' }}>
              <div style={{ fontSize: '1.8em', fontWeight: 700, color: '#6366F1' }}>
                {campaignFlow.selectedOpportunities?.length || 0}
              </div>
              <div style={{ fontSize: '0.8em', color: '#64748B', marginTop: 4 }}>Prospects targeted</div>
            </div>
            <div style={{ background: 'white', borderRadius: 8, padding: 16, textAlign: 'center', border: '1px solid #D1FAE5' }}>
              <div style={{ fontSize: '1.8em', fontWeight: 700, color: '#6366F1' }}>
                {campaignFlow.selectedAssets?.length || 0}
              </div>
              <div style={{ fontSize: '0.8em', color: '#64748B', marginTop: 4 }}>Assets attached</div>
            </div>
            <div style={{ background: 'white', borderRadius: 8, padding: 16, textAlign: 'center', border: '1px solid #D1FAE5' }}>
              <div style={{ fontSize: '1.8em', fontWeight: 700, color: '#10B981' }}>
                {campaignFlow.brief?.channels?.length || 0}
              </div>
              <div style={{ fontSize: '0.8em', color: '#64748B', marginTop: 4 }}>Channels active</div>
            </div>
            <div style={{ background: 'white', borderRadius: 8, padding: 16, textAlign: 'center', border: '1px solid #D1FAE5' }}>
              <div style={{ fontSize: '1.2em', fontWeight: 700, color: '#F59E0B' }}>Tracking...</div>
              <div style={{ fontSize: '0.8em', color: '#64748B', marginTop: 4 }}>Response rate</div>
            </div>
          </div>

          {/* KPIs del brief */}
          {campaignFlow.brief?.kpis && (
            <div style={{ marginTop: 16, padding: 12, background: 'white', borderRadius: 8, border: '1px solid #D1FAE5' }}>
              <span style={{ fontSize: '0.85em', fontWeight: 600, color: '#166534' }}>📊 Expected KPIs: </span>
              <span style={{ fontSize: '0.85em', color: '#374151' }}>{campaignFlow.brief.kpis}</span>
            </div>
          )}
        </div>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("reports.title")}</h1>
          <p className="text-xs text-gray-500">{t("reports.subtitle")}</p>
        </div>
        <div className="flex gap-1">
          <Btn
            variant="secondary"
            icon={<RefreshIcon size={13} className={reportsState.loading ? "animate-spin" : ""} />}
            onClick={loadReports}
            disabled={reportsState.loading}
          >
            {t("reports.refresh")}
          </Btn>
          <Btn
            variant="secondary"
            icon={<DownloadIcon size={14} />}
            onClick={exportBooksPdf}
            disabled={reportsState.exporting}
            title={t("reports.exportBooksCsvHint")}
          >
            {reportsState.exporting ? t("reports.exporting") : t("reports.exportBooksCsv")}
          </Btn>
        </div>
      </div>

      {reportsState.loading && (
        <Card className="p-6 text-center">
          <p className="text-sm font-medium text-gray-700">{t("reports.loading")}</p>
        </Card>
      )}

      {!reportsState.loading && reportsState.error && (
        <Card className="p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-red-600">{reportsState.error}</p>
            <Btn variant="secondary" icon={<RefreshIcon size={13} />} onClick={loadReports}>{t("reports.retry")}</Btn>
          </div>
        </Card>
      )}

      {!reportsState.loading && !reportsState.error && (
        <>
          <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2 xl:grid-cols-4">
            <KpiCard icon={BriefIcon} label={t("reports.totalProposalsGenerated")} value={Number(overviewKpis.proposalsSent) || 0} sub={t("reports.backendData")} color="bg-indigo-50 text-indigo-600" onClick={() => onNavigate("content", { typeFilter: "Proposals" })} />
            <KpiCard icon={TrendIcon} label={t("reports.totalProposalValue")} value={formatCompactCurrency(totalProposalValue)} sub={t("reports.fromProposals")} color="bg-green-50 text-green-600" onClick={() => onNavigate("content", { typeFilter: "Proposals" })} />
            <KpiCard icon={BookIcon} label={t("reports.bookConceptsCreated")} value={Number(overviewKpis.totalBooks) || 0} sub={t("reports.fromBooks")} color="bg-purple-50 text-purple-600" onClick={() => onNavigate("books")} />
            <KpiCard
              icon={TargetIcon}
              label={t("reports.winRate")}
              value={formatPercent(winRate)}
              sub={t("reports.fromPipeline")}
              detail={winRateData.detail || reportsData.win_rate_detail || 'No qualified opportunities yet'}
              color="bg-green-50 text-green-600"
              onClick={() => onNavigate("opportunities", { stageFilter: "Won" })}
            />
          </div>

          {proposalRows.length > 0 ? (
            <Card className="p-2">
                <div className="mb-4 flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex items-center gap-1">
                      <p className="text-xs font-semibold text-gray-700">{t("reports.proposalsByStatus")}</p>
                      <Badge label={t("reports.live")} color="bg-green-100 text-green-700" />
                    </div>
                    <p className="mt-1 text-xs text-gray-400">{t("reports.distributionPipelineValue")}</p>
                  </div>
                  <div className="flex rounded-lg bg-gray-100 p-1">
                    {["30d", "90d", "all"].map((period) => (
                      <button
                        key={period}
                        onClick={() => handlePeriodChange(period)}
                        className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${proposalStatusPeriod === period ? "bg-white text-indigo-700 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
                      >
                        {period === "all" ? t("reports.all") : period}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 items-center gap-2.5 md:grid-cols-[170px_1fr]">
                  <div className="relative mx-auto h-36 w-36">
                    <div className="h-full w-full rounded-full" style={donutStyle} />
                    <div className="absolute inset-5 flex flex-col items-center justify-center rounded-full bg-white">
                      <p className="text-3xl font-bold leading-none text-gray-900">{totalProposalCount}</p>
                      <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">{t("reports.proposals")}</p>
                      <p className="mt-2 text-xs font-bold text-indigo-600">{formatCompactCurrency(totalProposalValue)}</p>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    {proposalDisplayRows.map((row) => (
                      <div
                        key={row.status}
                        onClick={() => onNavigate("content", { statusFilter: row.status })}
                        className="cursor-pointer rounded-md hover:bg-[#F8FAFC]"
                      >
                        <div className="mb-1 flex items-center gap-1">
                          <span className="h-2.5 w-2.5 flex-none rounded-[3px]" style={{ background: row.fill }} />
                          <span className="min-w-0 flex-1 text-xs font-semibold text-gray-700">{row.name}</span>
                          <span className="text-xs font-bold text-gray-900">{row.value}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                            <div className="h-full rounded-full" style={{ width: `${row.percent}%`, background: row.fill }} />
                          </div>
                          <span className="w-8 text-right text-[11px] font-medium text-gray-400">{row.percent}%</span>
                          <span className="w-12 text-right text-[11px] font-medium text-gray-500">{formatCompactCurrency(row.totalValue)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

            </Card>
          ) : (
            <Card className="p-6 text-center">
              <p className="text-xs font-medium text-gray-400">{t("reports.noProposalStatusData")}</p>
            </Card>
          )}

          <Card className="p-2">
            <p className="text-xs font-semibold text-gray-700 mb-1.5">{t("reports.funnel")}</p>
            <div className="space-y-1.5">
              {funnelRows.map((row) => {
                const width = maxFunnelValue > 0 ? Math.max(4, Math.round((row.value / maxFunnelValue) * 100)) : 0;
                return (
                  <div
                    key={row.label}
                    onClick={() => onNavigate("opportunities", { stageFilter: row.stageFilter })}
                    className="group cursor-pointer"
                  >
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="font-medium text-gray-600 group-hover:underline">{row.label}</span>
                      <span className="font-bold text-gray-900">{row.value}</span>
                    </div>
                    <div className="h-2 rounded-full bg-gray-100">
                      <div className={`h-full rounded-full ${row.color}`} style={{ width: `${width}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

const SettingsSection = ({ title, IconComp, desc, badge, isDark, children }) => (
  <Card className="p-3">
    <div className="flex items-center justify-between mb-2 pb-3 border-b border-gray-100">
      <div className="flex items-center gap-1">
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${isDark ? "bg-slate-900 text-slate-200 border border-white/10" : "bg-indigo-50 text-indigo-600"}`}>
          <IconComp size={14} />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          {desc && <p className="text-xs text-gray-400">{desc}</p>}
        </div>
      </div>
      {badge}
    </div>
    {children}
  </Card>
);

function SettingsPage({ navigationState = {} }) {
  const { t } = useI18n();
  const { language, changeLanguage } = useLanguage();
  const { theme, changeTheme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const [tab, setTab] = useState(navigationState.tab || "general");
  const [pipelineOn, setPipelineOn] = useState(true);
  const [socialModal, setSocialModal] = useState(null); // null or channel object
  const [socialConnectionForm, setSocialConnectionForm] = useState({ email: "", handle: "", accessToken: "" });
  const [model, setModel] = useState(getStoredPreference(PREF_KEYS.model, "deepseek"));
  const [timezone, setTimezone] = useState(getStoredPreference(PREF_KEYS.timezone, getBrowserTimezone()));
  const [dateFormat, setDateFormat] = useState(getStoredPreference(PREF_KEYS.dateFormat, "DD/MM/YYYY"));
  const [socialStatus, setSocialStatus] = useState(null);
  const [socialBusy, setSocialBusy] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [crmApiKey, setCrmApiKey] = useState("");
  const [crmProvider, setCrmProvider] = useState("hubspot");
  const [crmTestStatus, setCrmTestStatus] = useState(null);
  const [crmTestMessage, setCrmTestMessage] = useState("");
  const [settingsTemplates, setSettingsTemplates] = useState([]);
  const [editingTemplateId, setEditingTemplateId] = useState(null);
  const [templateNameDraft, setTemplateNameDraft] = useState("");
  const [templateEditorContent, setTemplateEditorContent] = useState(
    "# Proposal for {{customer_name}}\n\n## Executive Summary\n\n## Pricing\n{{line_item_table}}\n\nTotal: {{total_amount}}\n\nDate: {{date}}"
  );
  const [templateSaving, setTemplateSaving] = useState(false);
  const [templateUploading, setTemplateUploading] = useState(false);
  const { toasts, setToast, removeToast, pauseToast, resumeToast } = useToastQueue();

  const loadSettingsTemplates = () => {
    api.get("/templates", { suppressPermissionToast: true })
      .then(({ data }) => setSettingsTemplates(data?.items || []))
      .catch((error) => console.error(error));
  };

  useEffect(() => {
    loadSettingsTemplates();
  }, []);

  const getApiErrorMessage = (error, fallback) => {
    const detail = error?.response?.data?.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (Array.isArray(detail)) {
      const firstMessage = detail
        .map((item) => item?.msg || item?.message || (typeof item === "string" ? item : ""))
        .find(Boolean);
      if (firstMessage) return firstMessage;
    }
    return error?.message || fallback;
  };

  const resetTemplateEditor = () => {
    setEditingTemplateId(null);
    setTemplateNameDraft("");
    setTemplateEditorContent(
      "# Proposal for {{customer_name}}\n\n## Executive Summary\n\n## Pricing\n{{line_item_table}}\n\nTotal: {{total_amount}}\n\nDate: {{date}}"
    );
  };

  const saveSettingsTemplate = async () => {
    if (!templateNameDraft.trim()) {
      setToast({ type: "error", message: t("settings.templateNameRequired") });
      return;
    }
    setTemplateSaving(true);
    try {
      const payload = {
        name: templateNameDraft.trim(),
        type: "proposal",
        content: templateEditorContent,
      };
      const { data } = editingTemplateId
        ? await api.put(`/templates/${editingTemplateId}`, payload, { suppressPermissionToast: true })
        : await api.post("/templates", payload, { suppressPermissionToast: true });
      setSettingsTemplates((current) => {
        if (editingTemplateId) {
          return current.map((template) => template.id === editingTemplateId ? data : template);
        }
        return [data, ...current.filter((template) => template.id !== data.id)];
      });
      resetTemplateEditor();
      setToast({ type: "success", message: t("settings.templateSaved") });
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: getApiErrorMessage(error, t("settings.templateSaveFailed")) });
    } finally {
      setTemplateSaving(false);
    }
  };

  const uploadTemplateFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setTemplateUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const { data } = await api.post("/templates/extract", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        suppressPermissionToast: true,
      });
      setEditingTemplateId(null);
      setTemplateNameDraft(data?.name || file.name.replace(/\.[^.]+$/, ""));
      setTemplateEditorContent(data?.content || "");
      setToast({ type: "success", message: "Template content loaded. Review it before saving." });
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: getApiErrorMessage(error, "Could not read the uploaded template.") });
    } finally {
      setTemplateUploading(false);
      event.target.value = "";
    }
  };

  const refreshSocialStatus = async () => {
    try {
      const { data } = await socialApi.status();
      setSocialStatus(data);
    } catch (error) {
      console.error(error);
    }
  };

  useEffect(() => {
    refreshSocialStatus();
  }, []);

  useEffect(() => {
    let mounted = true;
    settingsApi.get()
      .then(({ data }) => {
        if (!mounted) return;
        const savedTimezone = data?.timezone || getStoredPreference(PREF_KEYS.timezone, getBrowserTimezone());
        const savedDateFormat = data?.dateFormat || getStoredPreference(PREF_KEYS.dateFormat, "DD/MM/YYYY");
        setTimezone(savedTimezone);
        setDateFormat(savedDateFormat);
        localStorage.setItem(PREF_KEYS.timezone, savedTimezone);
        localStorage.setItem(PREF_KEYS.dateFormat, savedDateFormat);
        if (data?.crm?.provider) setCrmProvider(data.crm.provider);
      })
      .catch((error) => console.error(error));
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (navigationState.tab) setTab(navigationState.tab);
  }, [navigationState.tab]);

  const connectFacebook = async () => {
    setSocialBusy(true);
    try {
      const { data } = await socialApi.connectFacebook();
      if (data?.authUrl) {
        window.location.assign(data.authUrl);
      } else {
        setToast({ type: "error", message: t("settings.socialConnectFailed") });
      }
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: error.response?.data?.detail || t("settings.socialConnectFailed") });
    } finally {
      setSocialBusy(false);
    }
  };

  const openSocialModal = (channel) => {
    setSocialModal(channel);
    setSocialConnectionForm({
      email: "",
      handle: channel.user && channel.user !== "Configured token" ? channel.user : "",
      accessToken: "",
    });
  };

  const saveManualSocialConnection = async () => {
    if (!socialModal?.platform) return;
    setSocialBusy(true);
    try {
      await socialApi.connectManual(socialModal.platform, socialConnectionForm);
      await refreshSocialStatus();
      setSocialModal(null);
      setToast({ type: "success", message: `${socialModal.l} connected.` });
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: error.response?.data?.detail || t("settings.socialConnectFailed") });
    } finally {
      setSocialBusy(false);
    }
  };

  const disconnectSocialPlatform = async (platform = socialModal?.platform || "facebook") => {
    setSocialBusy(true);
    try {
      await socialApi.disconnect(platform);
      setSocialModal(null);
      await refreshSocialStatus();
      setToast({ type: "success", message: t("settings.socialDisconnected") });
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: t("settings.socialConnectFailed") });
    } finally {
      setSocialBusy(false);
    }
  };

  const savePreference = (key, value, setter) => {
    setter(value);
    localStorage.setItem(key, value);
    window.dispatchEvent(new CustomEvent("marketgen:prefs"));
  };

  const saveLanguagePreference = (value) => {
    changeLanguage(value);
    window.dispatchEvent(new CustomEvent("marketgen:prefs"));
  };

  const saveThemePreference = (value) => {
    changeTheme(value);
    window.dispatchEvent(new CustomEvent("marketgen:prefs"));
  };

  const handleSaveSettings = async () => {
    setSettingsSaving(true);
    try {
      await settingsApi.update({
        language,
        theme,
        timezone,
        dateFormat,
        llm: { model },
        crm: { provider: crmProvider },
      });
      setToast({ type: "success", message: t("settings.saved") });
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: "Could not save settings." });
    } finally {
      setSettingsSaving(false);
    }
  };

  const testCrmConnection = async () => {
    setCrmTestStatus("testing");
    setCrmTestMessage("");
    try {
      const { data } = await api.post("/settings/crm/test-connection", {
        apiKey: crmApiKey,
        provider: crmProvider,
      });
      setCrmTestStatus("connected");
      setCrmTestMessage(data.message || "Conexión exitosa");
    } catch (err) {
      setCrmTestStatus("error");
      setCrmTestMessage(err.response?.data?.detail || "Error al conectar");
    }
  };

  const socialChannels = [
    { platform: "linkedin", l: "LinkedIn", c: "bg-blue-600", ok: Boolean(socialStatus?.linkedin?.connected), user: socialStatus?.linkedin?.user || "" },
    { platform: "facebook", l: "Facebook", c: "bg-blue-500", ok: Boolean(socialStatus?.facebook?.connected), user: socialStatus?.facebook?.user || socialStatus?.facebook?.pageName || "" },
    { platform: "twitter", l: "Twitter / X", c: "bg-gray-900", ok: Boolean(socialStatus?.twitter?.connected), user: socialStatus?.twitter?.user || "" },
    { l: "Instagram", c: "bg-gradient-to-tr from-yellow-400 via-pink-500 to-purple-600", ok: Boolean(socialStatus?.instagram?.connected), user: socialStatus?.instagram?.username || "", linkedToFacebook: true },
  ];
  const settingsControlClass = isDark
    ? "w-full border border-white/10 rounded-lg px-3 py-1.5 text-xs bg-slate-800 text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 file:mr-3 file:rounded-md file:border-0 file:bg-slate-700 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-white"
    : "w-full border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500";
  const settingsPanelClass = isDark
    ? "rounded-xl border border-white/10 bg-slate-800 p-2"
    : "rounded-xl border border-gray-100 bg-gray-50 p-2";
  const settingsTabClass = (active) => `flex-1 flex items-center justify-center gap-1 px-3 py-4 rounded-lg text-xs font-medium transition-colors ${
    active
      ? isDark ? "bg-slate-700 text-white" : "bg-white text-gray-900 shadow-sm"
      : isDark ? "bg-transparent text-slate-300 hover:bg-slate-700/60" : "text-gray-500"
  }`;
  const settingsOptionClass = (active) => `px-3 py-4 rounded-lg border text-xs font-medium capitalize transition-colors ${
    active
      ? isDark ? "border-white/10 bg-slate-700 text-white" : "border-indigo-300 bg-indigo-50 text-indigo-700"
      : isDark ? "border-white/10 bg-slate-800 text-slate-300 hover:bg-slate-700" : "border-gray-200 text-gray-600"
  }`;
  const settingsStatusBadgeColor = (status) => {
    const normalized = String(status || "").toLowerCase();
    if (!isDark) {
      if (normalized.includes("connect") && !normalized.includes("not")) return "bg-green-100 text-green-700";
      if (normalized.includes("default")) return "bg-indigo-100 text-indigo-700";
      if (normalized.includes("draft")) return "bg-gray-100 text-gray-600";
      return "bg-gray-100 text-gray-400";
    }
    if (normalized.includes("connect") && !normalized.includes("not")) return "bg-green-500/10 text-green-200 border border-green-400/20";
    if (normalized.includes("default")) return "bg-indigo-500/10 text-indigo-200 border border-indigo-400/20";
    if (normalized.includes("draft")) return "bg-slate-900 text-slate-300 border border-white/10";
    if (normalized.includes("not")) return "bg-slate-900 text-slate-400 border border-white/10";
    return "bg-slate-900 text-slate-300 border border-white/10";
  };
  return (
    <div className="space-y-2">
      <ToastStack
        toasts={toasts}
        onClose={removeToast}
        onMouseEnter={pauseToast}
        onMouseLeave={resumeToast}
      />
      <div>
        <h1 className="text-xl font-bold text-gray-900">{t("settings.title")}</h1>
        <p className="text-xs text-gray-500">{t("settings.subtitle")}</p>
      </div>
      <div className={`flex gap-1 rounded-xl p-1 ${isDark ? "bg-slate-800 border border-white/10" : "bg-gray-100"}`}>
        <button onClick={() => setTab("general")} className={settingsTabClass(tab === "general")}><BotIcon size={13} />{t("settings.general")}</button>
        <button onClick={() => setTab("templates")} className={settingsTabClass(tab === "templates")}><FileIcon size={13} />{t("settings.templates")}</button>
        <button onClick={() => setTab("integrations")} className={settingsTabClass(tab === "integrations")}><PlugIcon size={13} />{t("settings.integrations")}</button>
      </div>

      {tab === "general" && (<>
        <SettingsSection isDark={isDark} title={t("settings.appearance")} IconComp={SlidersIcon} desc={t("settings.appearanceDescription")}>
          <Field label={t("settings.theme")}>
            <div className="grid grid-cols-3 gap-1">
              {["light", "dark", "system"].map((option) => (
                <button
                  key={option}
                  onClick={() => saveThemePreference(option)}
                  className={settingsOptionClass(theme === option)}
                >
                  {t(`settings.${option}Mode`)}
                </button>
              ))}
            </div>
          </Field>
          <Field label={t("settings.applicationLanguage")}>
            <Select
              className={settingsControlClass}
              value={language}
              onChange={(event) => saveLanguagePreference(event.target.value)}
            >
              <option value="en">English (Default)</option>
              <option value="es">Español</option>
              <option value="pt">Português</option>
            </Select>
          </Field>
          <p className="text-xs text-gray-400">{t("settings.generatedDocumentsLanguage")}</p>
          <div className="grid grid-cols-2 gap-1.5 mt-3">
            <Field label={t("settings.timezone")}>
              <Select
                className={settingsControlClass}
                value={timezone}
                onChange={(event) => savePreference(PREF_KEYS.timezone, event.target.value, setTimezone)}
              >
                {!TIMEZONE_OPTIONS.some((option) => option.value === timezone) && (
                  <option value={timezone}>{timezone}</option>
                )}
                {TIMEZONE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
            </Field>
            <Field label={t("settings.dateFormat")}>
              <Select
                className={settingsControlClass}
                value={dateFormat}
                onChange={(event) => savePreference(PREF_KEYS.dateFormat, event.target.value, setDateFormat)}
              >
                {DATE_FORMAT_OPTIONS.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </Select>
            </Field>
          </div>
        </SettingsSection>
        <SettingsSection isDark={isDark} title={t("settings.aiModel")} IconComp={BotIcon}>
          <Field label={t("settings.defaultModel")}>
            <Select
              className={settingsControlClass}
              value={model}
              onChange={(event) => savePreference(PREF_KEYS.model, event.target.value, setModel)}
            >
              <option value="deepseek">DeepSeek (default)</option>
              <option value="deepseek-reasoner">DeepSeek Reasoner</option>
            </Select>
          </Field>
          <p style={{ fontSize: 12.5, color: "#94a3b8", marginTop: 6 }}>
            {t("settings.aiModelNote")}
          </p>
        </SettingsSection>
        <SettingsSection isDark={isDark} title={t("settings.integrations")} IconComp={PlugIcon}>
          <Field label={t("settings.crmProvider")}><Select className={settingsControlClass}><option>{t("settings.noCRM")}</option><option>HubSpot</option><option>Salesforce</option></Select></Field>
          <p className="text-xs text-gray-400 mt-1">{t("settings.integrationDescription")}</p>
        </SettingsSection>
        <SettingsSection isDark={isDark} title={t("settings.socialConnections")} IconComp={Share2Icon} desc={t("settings.socialDescription")}>
          <div className="grid grid-cols-2 gap-1">
            {socialChannels.map(n => (
              <div key={n.l} className={`flex items-center justify-between group transition-colors ${settingsPanelClass}`}>
                <div className="flex items-center gap-1.5">
                  <div className={`w-7 h-7 rounded-lg ${n.c} flex items-center justify-center`}>
                    <span className="text-white text-xs font-bold">{n.l[0]}</span>
                  </div>
                  <div>
                    <span className={`text-xs font-medium ${isDark ? "text-slate-200" : "text-gray-800"}`}>{n.l}</span>
                    {n.ok && <p className="text-xs text-gray-400">@{n.user}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Badge label={n.ok ? t("settings.connected") : t("settings.notConnected")} color={settingsStatusBadgeColor(n.ok ? "Connected" : "Not connected")} />
                  <button onClick={() => openSocialModal(n)} className={`p-1.5 rounded-lg border border-transparent transition-colors ${isDark ? "hover:bg-slate-700 hover:border-white/10" : "hover:bg-white hover:border-gray-200"}`}>
                    <GearIcon size={12} className="text-gray-400" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </SettingsSection>
        <div className="flex justify-end">
          <Btn icon={<SaveIcon size={13} />} onClick={handleSaveSettings} disabled={settingsSaving}>
            {settingsSaving ? "Saving..." : t("settings.saveSettings")}
          </Btn>
        </div>

        {/* ── Social Channel Credentials Modal ── */}
        {socialModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setSocialModal(null)} />
            <div className={`relative rounded-2xl shadow-2xl w-full max-w-md mx-4 ${isDark ? "bg-slate-800 border border-white/10" : "bg-white"}`}>
              {/* Header */}
              <div className={`flex items-center justify-between p-3 border-b ${isDark ? "border-white/10" : "border-gray-100"}`}>
                <div className="flex items-center gap-1.5">
                  <div className={`w-9 h-9 rounded-xl ${socialModal.c} flex items-center justify-center`}>
                    <span className="text-white text-sm font-bold">{socialModal.l[0]}</span>
                  </div>
                  <div>
                    <h2 className={`text-sm font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>{socialModal.l}</h2>
                    <p className="text-xs text-gray-400">{socialModal.ok ? "Edit connection settings" : "Connect your account"}</p>
                  </div>
                </div>
                <button onClick={() => setSocialModal(null)} className={`p-1.5 rounded-lg transition-colors ${isDark ? "hover:bg-slate-700" : "hover:bg-gray-100"}`}><XIcon size={16} className="text-gray-400" /></button>
              </div>

              {/* Body */}
              <div className="p-3 space-y-2">
                {socialModal.ok && (
                  <div className={`flex items-center gap-1 p-2.5 rounded-xl border ${isDark ? "bg-green-500/10 border-green-400/20" : "bg-green-50 border-green-100"}`}>
                    <CheckIcon size={14} className="text-green-600" />
                    <span className="text-xs text-green-700 font-medium">{t("settings.socialConnectedAs").replace("{name}", socialModal.user || socialModal.l)}</span>
                  </div>
                )}

                {socialModal.l === "Facebook" && (
                  <>
                    <div className={`p-2 rounded-xl border ${isDark ? "bg-[#0F172A] border-white/10" : "bg-blue-50 border-blue-100"}`}>
                      <div className="flex items-start gap-1">
                        <ShieldIcon size={14} className="text-blue-500 mt-0.5 shrink-0" />
                        <div className="text-xs text-blue-700">
                          <p className="font-medium mb-0.5">{t("settings.socialOauthRecommended")}</p>
                          <p>{t("settings.socialFacebookOauthHint")}</p>
                        </div>
                      </div>
                    </div>
                    {!socialModal.ok && (
                      <Btn variant="primary" className="w-full justify-center" icon={<KeyIcon size={13} />} onClick={connectFacebook} disabled={socialBusy}>
                        {t("settings.socialConnectWithFacebook")}
                      </Btn>
                    )}
                  </>
                )}

                {["facebook", "linkedin", "twitter"].includes(socialModal.platform) && (
                  <div className="space-y-1.5">
                    <div className={`p-2 rounded-xl border text-xs ${isDark ? "bg-[#0F172A] border-white/10 text-slate-300" : "bg-gray-50 border-gray-100 text-gray-600"}`}>
                      Add an email/handle to enable publishing from generated social posts. If you have a provider token, you can store it here; tokens are never shown back in the UI.
                    </div>
                    <Field label="Account email">
                      <Input
                        className={settingsControlClass}
                        value={socialConnectionForm.email}
                        onChange={(event) => setSocialConnectionForm((current) => ({ ...current, email: event.target.value }))}
                        placeholder="name@company.com"
                      />
                    </Field>
                    <Field label="Handle or page name">
                      <Input
                        className={settingsControlClass}
                        value={socialConnectionForm.handle}
                        onChange={(event) => setSocialConnectionForm((current) => ({ ...current, handle: event.target.value }))}
                        placeholder={socialModal.platform === "twitter" ? "@company" : "Company page"}
                      />
                    </Field>
                    <Field label="Access token (optional)">
                      <Input
                        className={settingsControlClass}
                        type="password"
                        value={socialConnectionForm.accessToken}
                        onChange={(event) => setSocialConnectionForm((current) => ({ ...current, accessToken: event.target.value }))}
                        placeholder="Paste token only if you want this account-specific connection"
                      />
                    </Field>
                  </div>
                )}

                {socialModal.l === "Instagram" && (
                  <div className={`p-2 rounded-xl border text-xs ${isDark ? "bg-[#0F172A] border-white/10 text-slate-300" : "bg-gray-50 border-gray-100 text-gray-600"}`}>
                    {t("settings.socialInstagramHint")}
                  </div>
                )}

                {socialModal.comingSoon && (
                  <div className={`p-2 rounded-xl border text-xs ${isDark ? "bg-[#0F172A] border-white/10 text-slate-300" : "bg-gray-50 border-gray-100 text-gray-600"}`}>
                    {t("settings.socialComingSoon")}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className={`flex items-center justify-between p-3 border-t rounded-b-2xl ${isDark ? "border-white/10 bg-[#0F172A]" : "border-gray-100 bg-gray-50"}`}>
                <div>
                  {socialModal.l === "Facebook" && socialModal.ok && (
                    <Btn variant="ghost" className="text-red-500 hover:text-red-700 hover:bg-red-50" icon={<TrashIcon size={12} />} onClick={() => disconnectSocialPlatform("facebook")} disabled={socialBusy}>
                      {t("settings.disconnect")}
                    </Btn>
                  )}
                  {["linkedin", "twitter"].includes(socialModal.platform) && socialModal.ok && (
                    <Btn variant="ghost" className="text-red-500 hover:text-red-700 hover:bg-red-50" icon={<TrashIcon size={12} />} onClick={() => disconnectSocialPlatform(socialModal.platform)} disabled={socialBusy}>
                      {t("settings.disconnect")}
                    </Btn>
                  )}
                </div>
                <div className="flex gap-1">
                  <Btn variant="secondary" onClick={() => setSocialModal(null)}>{t("common.cancel")}</Btn>
                  {["facebook", "linkedin", "twitter"].includes(socialModal.platform) && (
                    <Btn icon={<SaveIcon size={12} />} onClick={saveManualSocialConnection} disabled={socialBusy}>
                      {socialModal.ok ? "Save connection" : "Connect"}
                    </Btn>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </>)}

      {tab === "templates" && (<>
        <SettingsSection isDark={isDark} title="Proposal Templates" IconComp={FileIcon} desc="Reusable commercial document structures with placeholders">
          <div className="grid grid-cols-3 gap-1.5 mb-4">
            {settingsTemplates.length === 0 && (
              <p className="col-span-3 text-xs text-gray-400">{t("settings.noTemplatesYet")}</p>
            )}
            {settingsTemplates.map((template, index) => (
              <div key={template.id} className={settingsPanelClass}>
                <div className="flex items-center justify-between">
                  <p className={`text-xs font-semibold ${isDark ? "text-slate-200" : "text-gray-800"}`}>{template.name}</p>
                  <Badge label={index === 0 ? "Default" : "Draft"} color={settingsStatusBadgeColor(index === 0 ? "Default" : "Draft")} />
                </div>
                <p className="mt-2 text-xs text-gray-400">{template.description || "Uses customer, pricing table, ROI, timeline, and next steps sections."}</p>
                <div className="flex gap-1 mt-3">
                  <Btn small variant="secondary" icon={<PenIcon size={11} />} onClick={() => {
                    setTemplateNameDraft(template.name || template.title || "");
                    setTemplateEditorContent(template.content || "");
                    setEditingTemplateId(template.id);
                  }}>Edit</Btn>
                  <Btn small variant="secondary" icon={<DownloadIcon size={11} />} onClick={() => {
                    const blob = new Blob([template.content || ""], { type: "text/plain" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${template.name || template.title || "template"}.txt`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}>Export</Btn>
                </div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <Field label="Upload template">
              <Input
                className={settingsControlClass}
                type="file"
                accept=".txt,.md,.html,.htm,.docx,.pdf"
                onChange={uploadTemplateFile}
                disabled={templateUploading}
              />
            </Field>
            <Field label="Create proposal template"><Input className={settingsControlClass} placeholder="Template name" value={templateNameDraft} onChange={(event) => setTemplateNameDraft(event.target.value)} /></Field>
          </div>
          <Field label="Template editor placeholders">
            <div className="flex flex-wrap gap-1 mb-1">
              {["{{customer_name}}", "{{total_amount}}", "{{line_item_table}}", "{{date}}"].map((token) => <span key={token} className={`rounded border px-2 py-1 text-xs font-medium ${isDark ? "bg-slate-900 text-slate-200 border-white/10" : "bg-indigo-50 text-indigo-700 border-transparent"}`}>{token}</span>)}
            </div>
            <textarea className={`${settingsControlClass} min-h-36`} value={templateEditorContent} onChange={(event) => setTemplateEditorContent(event.target.value)} />
          </Field>
          <div className="flex items-center justify-between gap-2">
            {editingTemplateId ? (
              <Btn variant="secondary" icon={<XIcon size={13} />} onClick={resetTemplateEditor} disabled={templateSaving}>New Template</Btn>
            ) : <span />}
            <Btn icon={<SaveIcon size={13} />} onClick={saveSettingsTemplate} disabled={templateSaving}>
              {editingTemplateId ? "Update Template" : "Save Template"}
            </Btn>
          </div>
        </SettingsSection>
      </>)}

      {tab === "integrations" && (<>
        <SettingsSection isDark={isDark} title="CRM Integration" IconComp={PlugIcon} desc="Connect proposal upload and opportunity sync">
          <div className="grid grid-cols-2 gap-1.5">
            <Field label="CRM Provider"><Select className={settingsControlClass} value={crmProvider} onChange={(event) => setCrmProvider(event.target.value)}><option value="hubspot">HubSpot</option><option value="salesforce">Salesforce</option><option value="custom">Custom CRM</option></Select></Field>
            <Field label="Connection status"><Badge label="Not connected" color={isDark ? "bg-amber-500/10 text-amber-200 border border-amber-400/20" : "bg-yellow-100 text-yellow-700"} /></Field>
            <Field label="CRM API key"><Input className={settingsControlClass} type="password" value={crmApiKey} onChange={(event) => setCrmApiKey(event.target.value)} placeholder="Paste CRM API key" /></Field>
            <Field label="CRM endpoint"><Input className={settingsControlClass} placeholder="https://api.crm.com/v1" /></Field>
          </div>
          <div className="flex items-center justify-end gap-1">
            {crmTestStatus === "connected" && (
              <span style={{ color: "#16a34a", fontSize: 13, fontWeight: 600 }}>✓ {crmTestMessage}</span>
            )}
            {crmTestStatus === "error" && (
              <span style={{ color: "#dc2626", fontSize: 13, fontWeight: 600 }}>✗ {crmTestMessage}</span>
            )}
            <Btn variant="secondary" icon={crmTestStatus === "testing" ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <PlayIcon size={12} />} onClick={testCrmConnection} disabled={!crmApiKey.trim() || crmTestStatus === "testing"}>{crmTestStatus === "testing" ? "Testing..." : "Test Connection"}</Btn><Btn icon={<SaveIcon size={12} />}>Save Integration</Btn>
          </div>
        </SettingsSection>
        <SettingsSection isDark={isDark} title="Social Connections" IconComp={Share2Icon} desc="Publishing destinations for generated social assets">
          <div className="grid grid-cols-3 gap-1">
            {socialChannels.map((channel) => (
              <div key={channel.l} className={`flex items-center justify-between ${settingsPanelClass}`}>
                <div>
                  <span className={`text-xs font-medium ${isDark ? "text-slate-200" : "text-gray-800"}`}>{channel.l}</span>
                  {channel.ok && channel.user && <p className="text-xs text-gray-400">{channel.user}</p>}
                </div>
                <div className="flex items-center gap-1">
                  <Badge label={channel.ok ? "Connected" : "Not connected"} color={settingsStatusBadgeColor(channel.ok ? "Connected" : "Not connected")} />
                  <button onClick={() => openSocialModal(channel)} className={`p-1.5 rounded-lg border border-transparent transition-colors ${isDark ? "hover:bg-slate-700 hover:border-white/10" : "hover:bg-white hover:border-gray-200"}`}>
                    <GearIcon size={12} className="text-gray-400" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </SettingsSection>
      </>)}

      {tab === "integrations" && socialModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setSocialModal(null)} />
          <div className={`relative rounded-2xl shadow-2xl w-full max-w-md mx-4 ${isDark ? "bg-slate-800 border border-white/10" : "bg-white"}`}>
            <div className={`flex items-center justify-between p-3 border-b ${isDark ? "border-white/10" : "border-gray-100"}`}>
              <div>
                <h2 className={`text-sm font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>{socialModal.l}</h2>
                <p className="text-xs text-gray-400">{socialModal.ok ? "Edit connection settings" : "Connect your account"}</p>
              </div>
              <button onClick={() => setSocialModal(null)} className={`p-1.5 rounded-lg transition-colors ${isDark ? "hover:bg-slate-700" : "hover:bg-gray-100"}`}><XIcon size={16} className="text-gray-400" /></button>
            </div>
            <div className="p-3 space-y-1.5">
              {socialModal.ok && (
                <div className={`flex items-center gap-1 p-2.5 rounded-xl border ${isDark ? "bg-green-500/10 border-green-400/20" : "bg-green-50 border-green-100"}`}>
                  <CheckIcon size={14} className="text-green-600" />
                  <span className="text-xs text-green-700 font-medium">{t("settings.socialConnectedAs").replace("{name}", socialModal.user || socialModal.l)}</span>
                </div>
              )}
              {socialModal.platform ? (
                <>
                  <Field label="Account email">
                    <Input className={settingsControlClass} value={socialConnectionForm.email} onChange={(event) => setSocialConnectionForm((current) => ({ ...current, email: event.target.value }))} placeholder="name@company.com" />
                  </Field>
                  <Field label="Handle or page name">
                    <Input className={settingsControlClass} value={socialConnectionForm.handle} onChange={(event) => setSocialConnectionForm((current) => ({ ...current, handle: event.target.value }))} placeholder={socialModal.platform === "twitter" ? "@company" : "Company page"} />
                  </Field>
                  <Field label="Access token (optional)">
                    <Input className={settingsControlClass} type="password" value={socialConnectionForm.accessToken} onChange={(event) => setSocialConnectionForm((current) => ({ ...current, accessToken: event.target.value }))} placeholder="Paste token only if needed" />
                  </Field>
                  {socialModal.platform === "facebook" && !socialModal.ok && (
                    <Btn variant="secondary" className="w-full justify-center" icon={<KeyIcon size={13} />} onClick={connectFacebook} disabled={socialBusy}>
                      {t("settings.socialConnectWithFacebook")}
                    </Btn>
                  )}
                </>
              ) : (
                <div className={`p-2 rounded-xl border text-xs ${isDark ? "bg-[#0F172A] border-white/10 text-slate-300" : "bg-gray-50 border-gray-100 text-gray-600"}`}>
                  {socialModal.linkedToFacebook ? t("settings.socialInstagramHint") : t("settings.socialComingSoon")}
                </div>
              )}
            </div>
            <div className={`flex items-center justify-between p-3 border-t rounded-b-2xl ${isDark ? "border-white/10 bg-[#0F172A]" : "border-gray-100 bg-gray-50"}`}>
              <div>
                {socialModal.platform && socialModal.ok && (
                  <Btn variant="ghost" className="text-red-500 hover:text-red-700 hover:bg-red-50" icon={<TrashIcon size={12} />} onClick={() => disconnectSocialPlatform(socialModal.platform)} disabled={socialBusy}>
                    {t("settings.disconnect")}
                  </Btn>
                )}
              </div>
              <div className="flex gap-1">
                <Btn variant="secondary" onClick={() => setSocialModal(null)}>{t("common.cancel")}</Btn>
                {socialModal.platform && (
                  <Btn icon={<SaveIcon size={12} />} onClick={saveManualSocialConnection} disabled={socialBusy}>
                    {socialModal.ok ? "Save connection" : "Connect"}
                  </Btn>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "pipeline" && (<>
        <div className={`flex items-center justify-between p-3.5 rounded-2xl border ${pipelineOn ? "border-green-200 bg-green-50" : "border-gray-200 bg-gray-50"}`}>
          <div className="flex items-center gap-1.5">
            <RadarIcon size={18} className={pipelineOn ? "text-green-600" : "text-gray-400"} />
            <div><p className="text-xs font-semibold text-gray-900">Prospecting Pipeline</p><p className="text-xs text-gray-500">{pipelineOn ? "Active — scanning every 24 hours" : "Inactive — enable to start"}</p></div>
          </div>
          <button onClick={() => setPipelineOn(!pipelineOn)} className="relative w-11 h-6 rounded-full transition-colors" style={{backgroundColor: pipelineOn ? "#16a34a" : "#d1d5db"}}>
            <span className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform" style={{transform: pipelineOn ? "translateX(20px)" : "translateX(0)"}} />
          </button>
        </div>

        <SettingsSection isDark={isDark} title="Specializations & Keywords" IconComp={SearchIcon} desc="Define NoonDalton's services and target industries">
          <Field label="Service keywords" hint="Press Enter or comma to add"><TagInput tags={["BPO","outsourcing","data entry","back office","customer support","accounting"]} /></Field>
          <Field label="Target industries" hint="Leave empty for all industries"><TagInput tags={["finance","healthcare","retail"]} /></Field>
          <Field label="Excluded companies" hint="Competitors or orgs to skip"><TagInput tags={["Acme BPO","CompetitorCorp"]} /></Field>
        </SettingsSection>

        <SettingsSection isDark={isDark} title="Job Sources" IconComp={GlobeIcon} desc="Where job postings are fetched from" badge={<Btn small icon={<PlusIcon size={12} />}>Add Source</Btn>}>
          <div className="space-y-1">
            {[
              {name:"LinkedIn via JSearch", type:"API", url:"jsearch.p.rapidapi.com", c:"text-violet-600 bg-violet-50", ic:CodeIcon},
              {name:"Indeed RSS Feed", type:"RSS", url:"indeed.com/rss/q=outsourcing", c:"text-orange-600 bg-orange-50", ic:RssIcon},
              {name:"Remote.co Careers", type:"SCRAPER", url:"remote.co/remote-jobs", c:"text-cyan-600 bg-cyan-50", ic:GlobeIcon},
            ].map(s => (
              <div key={s.name} className="flex items-center justify-between p-2 rounded-xl border border-gray-100 bg-gray-50 group hover:border-indigo-200">
                <div className="flex items-center gap-1.5">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${s.c}`}><s.ic size={14} /></div>
                  <div><p className="text-xs font-medium text-gray-800">{s.name}</p><p className="text-xs text-gray-400">{s.type} · {s.url}</p></div>
                </div>
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100"><button className="p-1.5 rounded hover:bg-gray-100"><PenIcon size={11} className="text-gray-400" /></button><button className="p-1.5 rounded hover:bg-red-50"><TrashIcon size={11} className="text-gray-400" /></button></div>
              </div>
            ))}
          </div>
        </SettingsSection>

        <SettingsSection isDark={isDark} title="SMTP Configuration" IconComp={MailIcon} desc="Mail server for sending outreach emails">
          <div className="grid grid-cols-2 gap-1.5"><Field label="SMTP Server"><Input defaultValue="smtp.gmail.com" /></Field><Field label="Port"><Input defaultValue="587" /></Field></div>
          <div className="grid grid-cols-2 gap-1.5"><Field label="Username"><Input defaultValue="sales@noondalton.com" /></Field><Field label="Password"><Input type="password" defaultValue="secret" /></Field></div>
          <div className="grid grid-cols-2 gap-1.5"><Field label="Sender Email"><Input defaultValue="sales@noondalton.com" /></Field><Field label="Sender Name"><Input defaultValue="NoonDalton Sales" /></Field></div>
          <div className="flex justify-end"><Btn variant="secondary" small>Test Connection</Btn></div>
        </SettingsSection>

        <div className="flex justify-end pb-2"><Btn icon={<SaveIcon size={13} />}>Save Pipeline</Btn></div>
      </>)}

      {tab === "content" && (<>
        <SettingsSection isDark={isDark} title="Auto-Tagging Rules" IconComp={TagIcon} desc="Define how content is tagged so agents can match it to opportunities">
          <p className="text-xs text-gray-500 mb-1.5">Content is automatically tagged by industry and service line. The email composer uses these tags to find the most relevant case studies, proposals, and templates for each opportunity.</p>
          <Field label="Industry tags"><TagInput tags={["finance","healthcare","retail","technology","logistics"]} placeholder="Add industry..." /></Field>
          <Field label="Service line tags"><TagInput tags={["data entry","customer support","accounting","back office","outsourcing","virtual assistant"]} placeholder="Add service..." /></Field>
        </SettingsSection>
        <SettingsSection isDark={isDark} title="Content Matching" IconComp={ZapIcon} desc="How the email composer selects content for personalization">
          <Field label="Matching strategy">
            <Select>
              <option>Best match (industry + service + recency)</option>
              <option>Industry match only</option>
              <option>Service match only</option>
              <option>Manual only (no auto-matching)</option>
            </Select>
          </Field>
          <Field label="Minimum relevance score" hint="Content below this score won't be included in emails">
            <Input defaultValue="0.6" />
          </Field>
          <div className="mt-2 p-2 rounded-xl bg-blue-50 border border-blue-100">
            <p className="text-xs text-blue-800 font-medium mb-1">How it works</p>
            <div className="space-y-1 text-xs text-blue-700">
              <p>1. Scout detects a job posting and extracts industry + service keywords</p>
              <p>2. The system searches your Content Library for items with matching tags</p>
              <p>3. Composer weaves the best-matching content into the personalized email</p>
              <p>4. You see which content was used in the Review Queue and Outreach History</p>
            </div>
          </div>
        </SettingsSection>
        <div className="flex justify-end"><Btn icon={<SaveIcon size={13} />}>Save Content Settings</Btn></div>
      </>)}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════ */
/*  MAIN APP — SIDEBAR + ROUTING                                   */
/* ═══════════════════════════════════════════════════════════════ */

function AsyncJobCard({ title, job, statusLabel = "Estado" }) {
  const progress = Math.max(0, Math.min(100, Number(job?.progress || 0)));
  const status = job?.status || "idle";
  const failed = status === "failed" || status === "error";
  const completed = status === "completed";

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="text-sm font-semibold text-gray-900">{title}</p>
          <p className={`text-xs ${failed ? "text-red-600" : completed ? "text-green-600" : "text-gray-500"}`}>
            {statusLabel}: {status}
          </p>
        </div>
        <span className="text-xs font-semibold text-gray-600">{progress}%</span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${failed ? "bg-red-500" : completed ? "bg-green-500" : "bg-indigo-600"}`}
          style={{ width: `${progress}%` }}
        />
      </div>
      {job?.error && <p className="mt-2 text-xs text-red-600">{job.error}</p>}
    </Card>
  );
}

const ASSET_REGENERATION_TYPES = [
  { key: "whitepaper", path: "assets/whitepaper", forceRegenerate: true, labelKey: "assetTypeWhitepaper" },
  { key: "onePager", path: "assets/one-pager", labelKey: "assetTypeOnePager" },
  { key: "socialPosts", path: "assets/social-posts", labelKey: "assetTypeSocialPosts" },
  { key: "infographic", path: "assets/infographic", labelKey: "assetTypeInfographic" },
];

const ASSET_REGENERATION_VARIATION_INSTRUCTION =
  "Generate a fresh alternative version, different in wording and angle from the previous one.";

function ContentGeneratorPage() {
  const { t, language } = useI18n();
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const defaultBookForm = {
    title: t("books.defaultTitle"),
    description: t("books.defaultDescription"),
    keywords: t("books.defaultKeywords"),
    chapterCount: 5,
  };
  const previousBookDefaultsRef = useRef(defaultBookForm);
  const [bookView, setBookView] = useState("creating");
  const [savedBooks, setSavedBooks] = useState([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [book, setBook] = useState(null);
  const [chapters, setChapters] = useState([]);
  const [activeBookStep, setActiveBookStep] = useState(1);
  const [job, setJob] = useState(null);
  const [jobTitle, setJobTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [editableChapters, setEditableChapters] = useState([]);
  const [contentDrafts, setContentDrafts] = useState({});
  const [refineText, setRefineText] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPage, setPreviewPage] = useState(0);
  const [toast, setToast] = useState("");
  const [activeChapterId, setActiveChapterId] = useState(null);
  const [assets, setAssets] = useState([]);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [loadingRefine, setLoadingRefine] = useState(false);
  const [regenerateStatus, setRegenerateStatus] = useState(null);
  const [deletedChapterIds, setDeletedChapterIds] = useState([]);
  const [form, setForm] = useState(defaultBookForm);
  const [bookLanguage, setBookLanguage] = useState(language || getStoredPreference(PREF_KEYS.language, "en"));
  const [bookLanguageManuallySelected, setBookLanguageManuallySelected] = useState(false);

  const updateForm = (field) => (event) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
  };

  useEffect(() => {
    if (!bookLanguageManuallySelected) {
      setBookLanguage(language || getStoredPreference(PREF_KEYS.language, "en"));
    }
  }, [language, bookLanguageManuallySelected]);

  useEffect(() => {
    const previousDefaults = previousBookDefaultsRef.current;
    setForm((current) => ({
      ...current,
      title: current.title === previousDefaults.title ? defaultBookForm.title : current.title,
      description: current.description === previousDefaults.description ? defaultBookForm.description : current.description,
      keywords: current.keywords === previousDefaults.keywords ? defaultBookForm.keywords : current.keywords,
    }));
    previousBookDefaultsRef.current = defaultBookForm;
  }, [language]);

  const toastTimer = useRef(null);
  function showToast(message) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2200);
  }

  async function loadLibrary() {
    setLoadingLibrary(true);
    try {
      const { data } = await api.get("/books", { suppressPermissionToast: true });
      setSavedBooks(data.books || data.data || data || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingLibrary(false);
    }
  }

  useEffect(() => {
    if (bookView === "library") loadLibrary();
  }, [bookView]);

  const formatRelativeBookDate = (value) => {
    if (!value) return "Recently";
    const raw = value?._seconds ? value._seconds * 1000 : value;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return "Recently";
    const diffMs = Date.now() - date.getTime();
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays <= 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 30) return `${diffDays} days ago`;
    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths === 1) return "1 month ago";
    if (diffMonths < 12) return `${diffMonths} months ago`;
    const diffYears = Math.floor(diffMonths / 12);
    return diffYears === 1 ? "1 year ago" : `${diffYears} years ago`;
  };

  const bookStatusColor = (status = "draft") => {
    if (status === "published") return "bg-green-100 text-green-700";
    return "bg-yellow-100 text-yellow-700";
  };

  const openSavedBook = async (bookId) => {
    await loadBook(bookId);
    setBookView("creating");
  };

  const deleteSavedBook = async (bookId) => {
    try {
      await api.delete(`/books/${bookId}`, { suppressPermissionToast: true });
      await loadLibrary();
    } catch (e) {
      console.error(e);
    }
  };

  async function loadAssets() {
    if (!book?.id) return;
    setLoadingAssets(true);
    try {
      const { data } = await api.get("/assets", { params: { book_id: book.id }, suppressPermissionToast: true });
      setAssets(data.items || data.assets || data.data || data || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingAssets(false);
    }
  }

  const demoChapters = () => Array.from({ length: Number(form.chapterCount) || 5 }, (_, index) => ({
    id: `demo-chapter-${index + 1}`,
    title: [
      "Fundamentos del Marketing con IA",
      "Automatización de Campañas",
      "Creación de Contenido con IA",
      "Segmentación y Personalización",
      "Medición, Análisis y Optimización",
    ][index] || `${t("books.chapter")} ${index + 1}`,
    description: [
      "Introducción al rol de la IA en marketing: casos de uso, beneficios y mitos. Tono divulgativo para un lector B2B.",
      "Cómo diseñar flujos automatizados de email, anuncios y nurturing. Incluir ejemplos de triggers y segmentos dinámicos.",
      "Frameworks para generar borradores, mantener la voz de marca y editar con IA. Tono práctico, orientado a producción.",
      "Modelos de segmentación dinámica y personalización 1:1 a escala. Explicar datos necesarios y privacidad.",
      "KPIs, atribución y ciclos de experimentación. Cerrar el libro con un plan de mejora continua.",
    ][index] || t("books.noPreviewContent"),
    orderIndex: index,
    status: "generated",
  }));

  const normalizeBookChapters = (items = []) => [...items].sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0));

  const applyBookChapters = (items = []) => {
    const sortedChapters = normalizeBookChapters(items);
    setChapters(sortedChapters);
    setEditableChapters(sortedChapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title || "",
      description: chapter.description || "",
    })));
    setContentDrafts(Object.fromEntries(sortedChapters.map((chapter) => [chapter.id, stripHtml(chapter.content || "")])));
    return sortedChapters;
  };

  const runDemoJob = (title, onComplete) => {
    const jobId = `demo-${Date.now()}`;
    setJobTitle(title);
    setJob({ id: jobId, status: "processing", progress: 10 });

    [35, 65, 100].forEach((progress, index) => {
      setTimeout(() => {
        setJob({
          id: jobId,
          status: progress === 100 ? "completed" : "processing",
          progress,
        });
        if (progress === 100) onComplete?.();
      }, (index + 1) * 650);
    });
  };

  const loadBook = async (bookId) => {
    const { data } = await api.get(`/books/${bookId}`, { suppressPermissionToast: true });
    let sortedChapters = normalizeBookChapters(data.chapters || []);
    if (sortedChapters.length === 0) {
      try {
        const chaptersResponse = await api.get(`/books/${bookId}/chapters`, { suppressPermissionToast: true });
        const chapterData = chaptersResponse.data?.chapters || chaptersResponse.data?.data || chaptersResponse.data || [];
        sortedChapters = normalizeBookChapters(Array.isArray(chapterData) ? chapterData : []);
      } catch (error) {
        if (![401, 403, 404, 500].includes(error.response?.status)) throw error;
      }
    }
    setBook(data);
    applyBookChapters(sortedChapters);
    return { ...data, chapters: sortedChapters };
  };

  useEffect(() => {
    if (!job?.id || ["completed", "failed", "error"].includes(job.status)) return undefined;

    const timer = setInterval(async () => {
      try {
        const { data } = await api.get(`/jobs/${job.id}`, { suppressPermissionToast: true });
        setJob(prev => ({ ...data, _kind: prev?._kind || '' }));
        if (data.status === "completed" && book?.id) {
          const kind = job?._kind || '';
          await loadBook(book.id);
          setContentDrafts((prev) => {
            const cleaned = {};
            Object.entries(prev).forEach(([key, value]) => { cleaned[key] = stripHtml(value); });
            return cleaned;
          });
          if (kind === 'chapters') setActiveBookStep(2);
            if (kind === 'content') {
              setActiveBookStep(3);
              // after content is generated, trigger marketing assets generation
              try {
                await exportBook();
              } catch (e) {
                console.error('[BookConcepts] export after content error', e);
              }
            }
          if (kind === 'export') {
            setActiveBookStep(4);
            await loadAssets();
          }
          setJob(prev => ({ ...data, _kind: prev?._kind || '' }));
        }
      } catch (error) {
        console.error(error);
      }
    }, 2000);

    return () => clearInterval(timer);
  }, [job?.id, job?.status, book?.id]);

  useEffect(() => {
    if (!activeChapterId || !chapters.some((chapter) => chapter.id === activeChapterId)) {
      if (chapters.length > 0) setActiveChapterId(chapters[0].id);
    }
  }, [activeChapterId, chapters]);

  useEffect(() => {
    if (activeBookStep === 4 && book?.id) loadAssets();
  }, [activeBookStep, book?.id]);

  const createDraftBook = async (forceNew = false) => {
    if (book?.id && !forceNew) return book;
    const { data } = await api.post("/books", {
        title: form.title,
        description: form.description,
        keywords: form.keywords.split(",").map((item) => item.trim()).filter(Boolean),
    }, { suppressPermissionToast: true });
    setBook(data);
    setChapters([]);
    setEditableChapters([]);
    setContentDrafts({});
    setJob(null);
    return data;
  };

  const createBook = async () => {
    setLoading(true);
    try {
      const data = await createDraftBook(true);
      await startJob(
        t("books.jobs.chapters"),
        `/books/${data.id}/chapters/generate`,
        { chapterCount: Number(form.chapterCount) || 5, language: bookLanguage, sync: true },
        "chapters",
        { bookId: data.id },
      );
      const latestBook = await loadBook(data.id);
      if (latestBook.chapters.length > 0) {
        await startJob(
          t("books.jobs.content"),
          `/books/${data.id}/content/generate`,
          { contentType: "long", style: "professional", language: bookLanguage, sync: true },
          "content",
          { bookId: data.id },
        );
      }
      await loadBook(data.id);
    } catch (error) {
      if (![401, 403].includes(error.response?.status)) throw error;
      const demo = demoChapters();
      setBook({
        id: `demo-book-${Date.now()}`,
        title: form.title,
        description: form.description,
        keywords: form.keywords.split(",").map((item) => item.trim()).filter(Boolean),
        status: "generated",
      });
      setChapters(demo.map((chapter) => ({ ...chapter, status: "generated", content: `<h2>${chapter.title}</h2><p>${chapter.description}</p>` })));
      setEditableChapters(demo.map((chapter) => ({ id: chapter.id, title: chapter.title, description: chapter.description || "" })));
      setContentDrafts(Object.fromEntries(demo.map((chapter) => [chapter.id, stripHtml(`<h2>${chapter.title}</h2><p>${chapter.description}</p>`)])));
      setJob(null);
      setActiveBookStep(3);
    } finally {
      setLoading(false);
    }
  };

  const startJob = async (title, endpoint, payload = {}, jobKind = "", options = {}) => {
    const targetBookId = options.bookId || book?.id;
    if (!targetBookId) return null;
    setLoading(true);
    try {
      const { data } = await api.post(endpoint, payload, { suppressPermissionToast: true, timeout: 180000 });
      const jobId = data.job_id || data.jobId || data.id;
      setJobTitle(title);
      setJob({ id: jobId, status: data.status || "pending", progress: 0, _kind: jobKind });
      if (payload.sync && jobId) {
        const jobResponse = await api.get(`/jobs/${jobId}`, { suppressPermissionToast: true });
        const jobData = { ...jobResponse.data, _kind: jobKind };
        setJob(jobData);
        if (jobData.status === 'completed') {
          const latestBook = await loadBook(targetBookId);
          if (jobKind === 'chapters') {
            if ((latestBook?.chapters || []).length === 0) applyBookChapters(demoChapters());
            setActiveBookStep(2);
          }
          if (jobKind === 'content') {
            setContentDrafts((prev) => {
              const cleaned = {};
              Object.entries(prev).forEach(([k, v]) => { cleaned[k] = stripHtml(v); });
              return cleaned;
            });
              setActiveBookStep(3);
              // trigger marketing assets generation after content completes (sync path)
              try {
                await exportBook();
              } catch (e) {
                console.error('[BookConcepts] export after content (sync) error', e);
              }
          }
          if (jobKind === 'export') {
            setActiveBookStep(4);
            await loadAssets();
          }
        }
        // Si no completó, el useEffect de polling detectará _kind y avanzará cuando termine
      }
      return data;
    } catch (error) {
      if (![401, 403, 404, 500].includes(error.response?.status)) throw error;
      if (jobKind === "chapters") {
        runDemoJob(title, () => {
          const demo = demoChapters();
          setChapters(demo);
          setEditableChapters(demo.map((chapter) => ({ id: chapter.id, title: chapter.title, description: chapter.description || "" })));
          setContentDrafts(Object.fromEntries(demo.map((chapter) => [chapter.id, stripHtml(chapter.content || "")])));
          setBook((current) => ({ ...current, status: "outlined" }));
          setActiveBookStep(2);
        });
      } else if (jobKind === "content") {
        runDemoJob(title, () => {
          setChapters((current) => {
            const next = current.map((chapter) => ({ ...chapter, status: "generated", content: chapter.content || `<h2>${chapter.title}</h2><p>${chapter.description || ""}</p>` }));
            setContentDrafts(Object.fromEntries(next.map((chapter) => [chapter.id, stripHtml(chapter.content || "")])));
            return next;
          });
          setBook((current) => ({ ...current, status: "generated" }));
          setActiveBookStep(3);
        });
      } else {
        runDemoJob(title, () => setActiveBookStep(4));
      }
      return null;
    } finally {
      setLoading(false);
    }
  };

  const generateChapters = async () => {
    let targetBook = book;
    if (!targetBook?.id) {
      setLoading(true);
      try {
        targetBook = await createDraftBook();
      } catch (error) {
        if (![401, 403].includes(error.response?.status)) throw error;
        const demoBook = {
          id: `demo-book-${Date.now()}`,
          title: form.title,
          description: form.description,
          keywords: form.keywords.split(",").map((item) => item.trim()).filter(Boolean),
          status: "draft",
        };
        setBook(demoBook);
        targetBook = demoBook;
      } finally {
        setLoading(false);
      }
    }
    return startJob(
      t("books.jobs.chapters"),
      `/books/${targetBook.id}/chapters/generate`,
      { chapterCount: Number(form.chapterCount) || 5, language: bookLanguage, sync: true },
      "chapters",
      { bookId: targetBook.id },
    );
  };

  const generateContent = () => startJob(
    t("books.jobs.content"),
    `/books/${book.id}/content/generate`,
    { contentType: "long", style: "professional", language: bookLanguage, sync: true },
    "content",
  );

  const exportBook = () => {
    setActiveBookStep(4);
    return startJob(
      t("books.jobs.export"),
      `/books/${book.id}/assets/whitepaper`,
      { bookId: book.id, chapterIds: chapters.map((chapter) => chapter.id), language: bookLanguage },
      "export",
    );
  };

  const generateOnePager = () => startJob(
    "Generating one-pager...",
    `/books/${book.id}/assets/one-pager`,
    {
      bookId: book.id,
      style: "professional",
      language: bookLanguage,
    },
    "export",
  );

  const generateSocialPosts = () => startJob(
    "Generating social posts...",
    `/books/${book.id}/assets/social-posts`,
    {
      bookId: book.id,
      chapterId: activeChapterId && !String(activeChapterId).startsWith("local-") && !String(activeChapterId).startsWith("demo-chapter-")
        ? activeChapterId
        : undefined,
      platforms: ["linkedin", "twitter", "facebook"],
      tone: "professional",
      language: bookLanguage,
    },
    "export",
  );

  const generateInfographic = () => startJob(
    "Generating infographic...",
    `/books/${book.id}/assets/infographic`,
    {
      bookId: book.id,
      chapterId: activeChapterId && !String(activeChapterId).startsWith("local-") && !String(activeChapterId).startsWith("demo-chapter-")
        ? activeChapterId
        : undefined,
      style: "modern",
      language: bookLanguage,
    },
    "export",
  );

  const regenerateAllAssets = async () => {
    if (!book?.id) return;
    setRegenerateStatus(Object.fromEntries(ASSET_REGENERATION_TYPES.map((asset) => [asset.key, "pending"])));

    const results = await Promise.allSettled(
      ASSET_REGENERATION_TYPES.map((asset) => api.post(
        `/books/${book.id}/${asset.path}`,
        {
          bookId: book.id,
          ...(asset.key === "whitepaper" ? { chapterIds: chapters.map((chapter) => chapter.id) } : {}),
          language: bookLanguage,
          ...(asset.forceRegenerate ? { forceRegenerate: true } : {}),
          variationInstruction: ASSET_REGENERATION_VARIATION_INSTRUCTION,
        },
        { suppressPermissionToast: true, timeout: 180000 },
      )),
    );

    const nextStatus = {};
    const failed = [];
    results.forEach((result, index) => {
      const asset = ASSET_REGENERATION_TYPES[index];
      nextStatus[asset.key] = result.status === "fulfilled" ? "success" : "error";
      if (result.status === "rejected") {
        failed.push(asset);
        console.error(`regenerateAllAssets: ${asset.key} failed`, result.reason);
      }
    });
    setRegenerateStatus(nextStatus);

    await loadAssets();

    if (failed.length === 0) {
      showToast(t("books.regenerateAllSuccess"));
    } else {
      showToast(`${t("books.regenerateAllPartialError")}: ${failed.map((asset) => t(`books.${asset.labelKey}`)).join(", ")}`);
    }
  };

  const saveChapterChanges = async () => {
    if (!book?.id) return;
    setLoading(true);
    try {
      if (editableChapters.some((chapter) => String(chapter.id).startsWith("demo-chapter-"))) {
        const nextChapters = editableChapters.map((chapter, index) => {
          const existing = chapters.find((item) => item.id === chapter.id) || {};
          return {
            ...existing,
            ...chapter,
            orderIndex: index,
            status: existing.status || "generated",
          };
        });
        applyBookChapters(nextChapters);
        setActiveBookStep(2);
        return;
      }

      const localChapterIds = editableChapters
        .filter((chapter) => String(chapter.id).startsWith("local-"))
        .map((chapter) => chapter.id);

      const serverDeleteIds = deletedChapterIds.filter((id) => !String(id).startsWith("local-"));
      for (const chapterId of serverDeleteIds) {
        try {
          await api.delete(`/books/${book.id}/chapters/${chapterId}`, { suppressPermissionToast: true });
        } catch (e) {
          console.error('[BookConcepts] delete chapter error', e, chapterId);
        }
      }
      if (serverDeleteIds.length) setDeletedChapterIds([]);

      const idMap = {};
      for (const chapter of editableChapters) {
        if (localChapterIds.includes(chapter.id)) {
          try {
            const { data } = await api.post(
              `/books/${book.id}/chapters`,
              { title: chapter.title, description: chapter.description },
              { suppressPermissionToast: true },
            );
            if (data?.id) idMap[chapter.id] = data.id;
          } catch (e) {
            console.error('[BookConcepts] create local chapter error', e, chapter.id);
          }
        }
      }

      const updatePromises = editableChapters.map((chapter) => {
        const serverId = idMap[chapter.id] || chapter.id;
        if (String(serverId).startsWith("local-")) return Promise.resolve();
        return api.put(
          `/books/${book.id}/chapters/${serverId}`,
          { title: chapter.title, description: chapter.description },
          { suppressPermissionToast: true },
        );
      });
      await Promise.all(updatePromises);

      const orderIds = editableChapters
        .map((chapter) => idMap[chapter.id] || chapter.id)
        .filter((id) => !String(id).startsWith("local-"));
      const existingServerIds = chapters.filter((chapter) => !String(chapter.id).startsWith("local-")).map((chapter) => chapter.id);
      if (orderIds.length && orderIds.length === existingServerIds.length) {
        try {
          await api.put(
            `/books/${book.id}/chapters/reorder`,
            { chapterIds: orderIds },
            { suppressPermissionToast: true },
          );
        } catch (e) {
          console.error('[BookConcepts] reorder error', e);
        }
      }

      await loadBook(book.id);
      setActiveBookStep(2);
    } finally {
      setLoading(false);
    }
  };

  function stripHtml(html) {
    if (!html) return "";
    return html
      .replace(/<h[1-6][^>]*>/gi, "\n\n")
      .replace(/<\/h[1-6]>/gi, "\n")
      .replace(/<p[^>]*>/gi, "")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const saveContentChanges = async () => {
    if (!book?.id) return;
    setLoading(true);
    try {
      await Promise.all(chapters.map((chapter) => api.put(
        `/books/${book.id}/chapters/${chapter.id}/content`,
        { content: contentDrafts[chapter.id] || "" },
        { suppressPermissionToast: true },
      )));
      await loadBook(book.id);
      setActiveBookStep(3);
    } finally {
      setLoading(false);
    }
  };

  async function refineActiveChapter() {
    const chapter = editableChapters?.find((item) => item.id === activeChapterId)
      || chapters.find((item) => item.id === activeChapterId);
    if (!book?.id || !chapter?.id || !refineText.trim()) return;
    setLoadingRefine(true);
    try {
      const { data } = await api.post(
        `/books/${book.id}/chapters/${chapter.id}/content/refine`,
        { instruction: refineText, language: bookLanguage },
        { suppressPermissionToast: true },
      );
      const refined = data.content || data.refinedContent || data.result || "";
      if (refined) {
        setContentDrafts((current) => ({ ...current, [chapter.id]: stripHtml(refined) }));
        showToast("Sección refinada");
      }
      setRefineText("");
    } catch (error) {
      console.error(error);
    } finally {
      setLoadingRefine(false);
    }
  }

  const canOpenStep = (step) => {
    if (step === 1) return true;
    if (step === 2) return Boolean(book?.id);
    if (step === 3) return chapters.length > 0;
    return Boolean(book?.id && chapters.length > 0);
  };

  const goToBookStep = (step) => {
    if (canOpenStep(step)) setActiveBookStep(step);
  };

  if (bookView === "library") {
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold" style={{ color: isDark ? '#F1F5F9' : '#0F172A' }}>{t("books.libraryTitle")}</h1>
            <p className="text-xs" style={{ color: isDark ? '#94A3B8' : '#64748B' }}>{t("books.subtitle")}</p>
          </div>
          <Btn onClick={() => setBookView("creating")}>{t("books.newBook")}</Btn>
        </div>

        {loadingLibrary ? (
          <div style={{ background: isDark ? '#1E293B' : '#fff', borderRadius: 14, border: `1px solid ${isDark ? '#334155' : '#eaecf3'}`, padding: '48px 24px', textAlign: 'center' }}>
            <p style={{ fontSize: 14, color: isDark ? '#94A3B8' : '#64748B', fontWeight: 500, margin: 0 }}>Loading books...</p>
          </div>
        ) : savedBooks.length === 0 ? (
          <div className="rounded-2xl border p-10 text-center shadow-sm" style={{ background: isDark ? '#1E293B' : '#fff', borderColor: isDark ? '#334155' : '#eaecf3' }}>
            <p className="text-sm font-medium" style={{ color: isDark ? '#94A3B8' : '#64748B' }}>{t("books.noBooksYet")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {savedBooks.map((savedBook) => (
              <div key={savedBook.id} className="rounded-2xl border p-5 shadow-sm" style={{ background: isDark ? '#1E293B' : '#fff', borderColor: isDark ? '#334155' : '#eaecf3' }}>
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold" style={{ color: isDark ? '#F1F5F9' : '#0F172A' }}>{savedBook.title}</p>
                    <p className="mt-1 text-xs" style={{ color: isDark ? '#94A3B8' : '#64748B' }}>{formatRelativeBookDate(savedBook.createdAt)}</p>
                  </div>
                  <Badge label={savedBook.status || "draft"} color={bookStatusColor(savedBook.status)} />
                </div>
                <p className="mb-4 line-clamp-2 text-xs" style={{ color: isDark ? '#94A3B8' : '#64748B' }}>{savedBook.description}</p>
                <div className="flex justify-end gap-2">
                  <Btn small variant="secondary" onClick={() => openSavedBook(savedBook.id)}>{t("books.open")}</Btn>
                  <Btn small variant="ghost" className="text-red-500 hover:bg-red-50 hover:text-red-700" onClick={() => deleteSavedBook(savedBook.id)}>{t("books.delete")}</Btn>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const stepLabels = [
    t("books.defineConcept"),
    t("books.defineChapters"),
    t("books.generateEditContent"),
    t("books.generateMarketingAssets"),
  ];
  const chaptersForOutline = editableChapters.length ? editableChapters : chapters;
  const activeChapter = chapters.find((chapter) => chapter.id === activeChapterId) || chapters[0];
  const activeChapterIndex = activeChapter ? chapters.findIndex((chapter) => chapter.id === activeChapter.id) : -1;
  const activeContent = activeChapter ? (contentDrafts[activeChapter.id] || activeChapter.content || "") : "";
  const generatedChapters = chapters.filter((chapter) => contentDrafts[chapter.id] || chapter.content).length;
  const totalWords = chapters.reduce((sum, chapter) => {
    const text = (contentDrafts[chapter.id] || chapter.content || "").replace(/<[^>]+>/g, " ");
    return sum + text.trim().split(/\s+/).filter(Boolean).length;
  }, 0);
  const previewPages = chapters.filter((chapter) => contentDrafts[chapter.id] || chapter.content);
  const currentPreviewChapter = previewPages[previewPage] || previewPages[0];

  return (
    <BookConceptsExperience
      activeBookStep={activeBookStep}
      activeChapterId={activeChapterId}
      setActiveChapterId={setActiveChapterId}
      assets={assets}
      book={book}
      bookLanguage={bookLanguage}
      bookLanguageManuallySelected={bookLanguageManuallySelected}
      chapters={chapters}
      chaptersForOutline={chaptersForOutline}
      contentDrafts={contentDrafts}
      createBook={createBook}
      exportBook={exportBook}
      form={form}
      generatedChapters={generatedChapters}
      generateChapters={generateChapters}
      generateContent={generateContent}
      generateInfographic={generateInfographic}
      generateOnePager={generateOnePager}
      generateSocialPosts={generateSocialPosts}
      goToBookStep={goToBookStep}
      isDark={isDark}
      job={job}
      jobTitle={jobTitle}
      language={language}
      loadAssets={loadAssets}
      loadBook={loadBook}
      loadLibrary={loadLibrary}
      loading={loading}
      loadingAssets={loadingAssets}
      previewOpen={previewOpen}
      previewPage={previewPage}
      refineActiveChapter={refineActiveChapter}
      refineText={refineText}
      regenerateAllAssets={regenerateAllAssets}
      regenerateStatus={regenerateStatus}
      saveChapterChanges={saveChapterChanges}
      saveContentChanges={saveContentChanges}
      setActiveBookStep={setActiveBookStep}
      setBookLanguage={setBookLanguage}
      setBookLanguageManuallySelected={setBookLanguageManuallySelected}
      setBookView={setBookView}
      setChapters={setChapters}
      setContentDrafts={setContentDrafts}
      setDeletedChapterIds={setDeletedChapterIds}
      setEditableChapters={setEditableChapters}
      setPreviewOpen={setPreviewOpen}
      setPreviewPage={setPreviewPage}
      setRefineText={setRefineText}
      showToast={showToast}
      t={t}
      toast={toast}
      totalWords={totalWords}
      updateForm={updateForm}
    />
  );

  return (
    <div className="space-y-5">
      <Btn variant="secondary" small onClick={() => { setBookView("library"); loadLibrary(); }}>
        ← Mis libros
      </Btn>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-500">Book Concepts</p>
          <h1 className="text-xl font-bold text-gray-900">{book?.title || t("sidebar.books")}</h1>
          <p className="text-xs text-gray-500">{book?.id ? `ID: ${book.id}` : t("books.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          {book && <Badge label={book.status || "draft"} color="bg-indigo-100 text-indigo-700" />}
          {book?.id && (
            <Btn variant="ghost" small onClick={() => loadBook(book.id)} icon={<RefreshIcon size={12} />}>
              {t("books.reload")}
            </Btn>
          )}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {stepLabels.map((label, index) => {
          const step = index + 1;
          const active = activeBookStep === step;
          return (
            <button
              key={label}
              onClick={() => goToBookStep(step)}
              disabled={!canOpenStep(step)}
              className={`rounded-xl border px-3 py-2 text-left text-xs transition-colors ${active ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-gray-100 bg-white text-gray-500 hover:bg-gray-50"} ${!canOpenStep(step) ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <span className="font-bold">{t("books.step")} {step}</span>
              <span className="block truncate">{label}</span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4">
          <Card className="p-5 space-y-3">
            <div>
              <p className="text-sm font-semibold text-gray-900">Concepto</p>
              <p className="text-xs text-gray-500">Define la base del libro y avanza por el flujo.</p>
            </div>
            <Field label={t("books.titleField")}>
              <Input value={form.title} onChange={updateForm("title")} />
            </Field>
            <Field label={t("books.description")}>
              <textarea
                rows={4}
                value={form.description}
                onChange={updateForm("description")}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </Field>
            <Field label={t("books.keywords")}>
              <Input value={form.keywords} onChange={updateForm("keywords")} />
            </Field>
            <Field label={t("books.chapterCount")}>
              <Input type="number" min={1} max={15} value={form.chapterCount} onChange={updateForm("chapterCount")} />
            </Field>
            <div className="grid grid-cols-1 gap-2 pt-2">
              <Btn onClick={createBook} disabled={loading} icon={<PlusIcon size={13} />}>
                {t("books.createBook")}
              </Btn>
              <Btn variant="teal" onClick={generateChapters} disabled={loading} icon={<SparkIcon size={13} />}>
                {t("books.generateChapters")}
              </Btn>
              <Btn variant="secondary" onClick={generateContent} disabled={!book || chapters.length === 0 || loading} icon={<PenIcon size={13} />}>
                {t("books.generateContent")}
              </Btn>
              <Btn variant="secondary" onClick={exportBook} disabled={!book || chapters.length === 0 || loading} icon={<DownloadIcon size={13} />}>
                {t("books.exportBook")}
              </Btn>
            </div>
          </Card>

          <Card className="p-5">
            <p className="text-sm font-semibold text-gray-900">Resumen</p>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                <p className="text-lg font-bold text-gray-900">{chapters.length}</p>
                <p className="text-[11px] text-gray-500">Capítulos</p>
              </div>
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                <p className="text-lg font-bold text-gray-900">{generatedChapters}</p>
                <p className="text-[11px] text-gray-500">Con texto</p>
              </div>
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                <p className="text-lg font-bold text-gray-900">{totalWords}</p>
                <p className="text-[11px] text-gray-500">Palabras</p>
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          {job?.id && <AsyncJobCard title={jobTitle} job={job} />}

          <Card className="p-5">
            {activeBookStep === 1 && (
              <div className="rounded-xl border border-dashed border-gray-200 p-6">
                <p className="text-sm font-semibold text-gray-900">Define the book concept</p>
                <p className="mt-1 text-xs text-gray-500">
                  Use Create Book for the fast path, or Generate Chapters to start the step-by-step review flow.
                </p>
                {book?.id && (
                  <div className="mt-4 rounded-lg bg-indigo-50 p-3 text-xs text-indigo-700">
                    Current book is saved. Continue with Step 2 to review chapters.
                  </div>
                )}
              </div>
            )}

            {activeBookStep === 2 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">Review and edit chapters</p>
                    <p className="text-xs text-gray-500">Ajusta títulos y descripciones antes de generar contenido.</p>
                  </div>
                  <Btn small onClick={saveChapterChanges} disabled={!book || chapters.length === 0 || loading}>
                    Save changes
                  </Btn>
                </div>
                {chaptersForOutline.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-200 py-12 text-center text-sm text-gray-400">
                    {t("books.emptyChapters")}
                  </div>
                ) : (
                  chaptersForOutline.map((chapter, index) => (
                    <div key={chapter.id} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="flex h-6 w-6 items-center justify-center rounded bg-indigo-100 text-xs font-bold text-indigo-700">
                          {index + 1}
                        </span>
                        <Input
                          value={chapter.title}
                          onChange={(event) => setEditableChapters((current) => current.map((item) => (
                            item.id === chapter.id ? { ...item, title: event.target.value } : item
                          )))}
                        />
                      </div>
                      <textarea
                        rows={3}
                        value={chapter.description || ""}
                        onChange={(event) => setEditableChapters((current) => current.map((item) => (
                          item.id === chapter.id ? { ...item, description: event.target.value } : item
                        )))}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  ))
                )}
              </div>
            )}

            {activeBookStep === 3 && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">Generate and edit content</p>
                    <p className="text-xs text-gray-500">Selecciona un capítulo, edita el contenido y refínalo con instrucciones.</p>
                  </div>
                  <div className="flex gap-2">
                    <Btn small variant="secondary" onClick={generateContent} disabled={!book || chapters.length === 0 || loading} icon={<PenIcon size={12} />}>
                      {t("books.generateContent")}
                    </Btn>
                    <Btn small onClick={saveContentChanges} disabled={!book || chapters.length === 0 || loading}>
                      Save changes
                    </Btn>
                    <Btn small variant="secondary" onClick={() => setPreviewOpen(true)} disabled={previewPages.length === 0} icon={<EyeIcon size={12} />}>
                      Preview
                    </Btn>
                  </div>
                </div>

                {chapters.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-200 py-12 text-center text-sm text-gray-400">
                    Generate and validate chapters before editing content.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
                    <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Índice</p>
                      <div className="space-y-1">
                        {chapters.map((chapter, index) => {
                          const selected = (activeChapter?.id || activeChapterId) === chapter.id;
                          const hasContent = Boolean(contentDrafts[chapter.id] || chapter.content);
                          return (
                            <button
                              key={chapter.id}
                              type="button"
                              onClick={() => setActiveChapterId(chapter.id)}
                              className={`w-full rounded-lg px-3 py-2 text-left text-xs transition-colors ${selected ? "bg-indigo-600 text-white" : "text-gray-600 hover:bg-white"}`}
                            >
                              <span className="block font-semibold">{index + 1}. {chapter.title}</span>
                              <span className={selected ? "text-indigo-100" : "text-gray-400"}>
                                {hasContent ? "Contenido generado" : "Pendiente"}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="rounded-xl border border-gray-100 bg-white p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                              Capítulo {activeChapterIndex + 1}
                            </p>
                            <p className="text-sm font-semibold text-gray-900">{activeChapter?.title || "Selecciona un capítulo"}</p>
                          </div>
                          {activeChapter && <Badge label={activeContent ? "generated" : "draft"} color={activeContent ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"} />}
                        </div>
                        <textarea
                          rows={16}
                          value={activeChapter ? activeContent : ""}
                          onChange={(event) => {
                            if (!activeChapter) return;
                            setContentDrafts((current) => ({ ...current, [activeChapter.id]: event.target.value }));
                          }}
                          className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          placeholder="Generated chapter HTML will appear here."
                        />
                      </div>

                      <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-4">
                        <div className="mb-2 flex items-center justify-between">
                          <p className="text-sm font-semibold text-indigo-900">✨ Refinar con IA</p>
                          <Btn small variant="secondary" onClick={refineActiveChapter} disabled={!activeChapter || !activeContent || !refineText.trim() || loadingRefine}>
                            {loadingRefine ? "Refinando..." : "Aplicar"}
                          </Btn>
                        </div>
                        <textarea
                          rows={3}
                          value={refineText}
                          onChange={(event) => setRefineText(event.target.value)}
                          className="w-full rounded-lg border border-indigo-100 bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          placeholder="Ej: Mejora la claridad, agrega tono profesional y resume los párrafos largos."
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeBookStep === 4 && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">Generate marketing assets</p>
                    <p className="text-xs text-gray-500">Crea, previsualiza y descarga los materiales asociados al libro.</p>
                  </div>
                  <div className="flex gap-2">
                    <Btn small variant="secondary" onClick={loadAssets} disabled={!book || loadingAssets} icon={<RefreshIcon size={12} />}>
                      Refresh
                    </Btn>
                    <Btn small onClick={exportBook} disabled={!book || chapters.length === 0 || loading} icon={<SparkIcon size={12} />}>
                      {t("books.generate")}
                    </Btn>
                  </div>
                </div>

                {loadingAssets ? (
                  <div className="rounded-xl border border-dashed border-gray-200 py-12 text-center">
                    <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
                  </div>
                ) : assets.length > 0 ? (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {assets.map((asset) => (
                      <div key={asset.id || asset.url || asset.name} className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                        <div className="mb-3 flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-gray-900">{asset.title || asset.name || asset.type || "Marketing asset"}</p>
                            <p className="mt-1 text-xs text-gray-500">{asset.format || asset.contentType || "Generated asset"}</p>
                          </div>
                          <Badge label={asset.status || "ready"} color="bg-green-100 text-green-700" />
                        </div>
                        <div className="flex gap-2">
                          <Btn small variant="secondary" icon={<EyeIcon size={12} />} disabled={!asset.url} onClick={() => asset.url && window.open(asset.url, "_blank", "noopener,noreferrer")}>
                            {t("books.preview")}
                          </Btn>
                          <Btn small variant="secondary" icon={<DownloadIcon size={12} />} disabled={!asset.url} onClick={() => asset.url && window.open(asset.url, "_blank", "noopener,noreferrer")}>
                            {t("books.download")}
                          </Btn>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    {["One-Pager", "Whitepaper", "Social Summaries", "Infographic"].map((asset) => (
                      <div key={asset} className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <p className="text-sm font-semibold text-gray-900">{asset}</p>
                          <Badge label={t("books.readyToGenerate")} color="bg-indigo-100 text-indigo-700" />
                        </div>
                        <Field label={t("books.template")}>
                          <Select>
                            <option>{t("books.defaultTemplate")} {asset}</option>
                            <option>{t("books.salesStyle")}</option>
                          </Select>
                        </Field>
                        <div className="flex gap-2">
                          <Btn small icon={<SparkIcon size={12} />} onClick={asset === "One-Pager" ? generateOnePager : asset === "Social Summaries" ? generateSocialPosts : asset === "Infographic" ? generateInfographic : exportBook} disabled={!book || loading}>{t("books.generate")}</Btn>
                          <Btn small variant="secondary" icon={<EyeIcon size={12} />} disabled>{t("books.preview")}</Btn>
                          <Btn small variant="secondary" icon={<DownloadIcon size={12} />} disabled>{t("books.download")}</Btn>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 rounded-lg bg-gray-900 px-4 py-2 text-xs font-semibold text-white shadow-lg">
          {toast}
        </div>
      )}

      {previewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/50 p-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <div>
                <p className="text-sm font-semibold text-gray-900">{book?.title || "Preview"}</p>
                <p className="text-xs text-gray-500">
                  {currentPreviewChapter ? `${previewPage + 1} / ${previewPages.length}` : "No content"}
                </p>
              </div>
              <Btn small variant="ghost" onClick={() => setPreviewOpen(false)}>
                ✕
              </Btn>
            </div>
            <div className="max-h-[68vh] overflow-y-auto p-6">
              {currentPreviewChapter ? (
                <div>
                  <h2 className="mb-4 text-lg font-bold text-gray-900">{currentPreviewChapter.title}</h2>
                  <div
                    className="prose prose-sm max-w-none text-gray-700"
                    dangerouslySetInnerHTML={{ __html: contentDrafts[currentPreviewChapter.id] || currentPreviewChapter.content || "" }}
                  />
                </div>
              ) : (
                <p className="text-sm text-gray-400">No hay contenido para previsualizar.</p>
              )}
            </div>
            <div className="flex items-center justify-between border-t border-gray-100 px-5 py-4">
              <Btn small variant="secondary" disabled={previewPage <= 0} onClick={() => setPreviewPage((current) => Math.max(current - 1, 0))}>
                Anterior
              </Btn>
              <Btn small variant="secondary" disabled={previewPage >= previewPages.length - 1} onClick={() => setPreviewPage((current) => Math.min(current + 1, previewPages.length - 1))}>
                Siguiente
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-5">
      <Btn variant="secondary" small onClick={() => { setBookView("library"); loadLibrary(); }}>
        ← Mis libros
      </Btn>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("sidebar.books")}</h1>
          <p className="text-xs text-gray-500">{t("books.subtitle")}</p>
        </div>
        {book && <Badge label={book.status || "draft"} color="bg-indigo-100 text-indigo-700" />}
      </div>
      <div className="grid grid-cols-4 gap-2">
        {[t("books.defineConcept"), t("books.defineChapters"), t("books.generateEditContent"), t("books.generateMarketingAssets")].map((label, index) => (
          <button
            key={label}
            onClick={() => goToBookStep(index + 1)}
            disabled={!canOpenStep(index + 1)}
            className={`rounded-xl border px-3 py-2 text-left text-xs ${activeBookStep === index + 1 ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-gray-100 bg-white text-gray-500"} ${!canOpenStep(index + 1) ? "cursor-not-allowed opacity-50" : ""}`}
          >
            <span className="font-bold">{t("books.step")} {index + 1}</span>
            <span className="block">{label}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
        <Card className="p-5 space-y-3">
          <Field label={t("books.titleField")}>
            <Input value={form.title} onChange={updateForm("title")} />
          </Field>
          <Field label={t("books.description")}>
            <textarea
              rows={4}
              value={form.description}
              onChange={updateForm("description")}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </Field>
          <Field label={t("books.keywords")}>
            <Input value={form.keywords} onChange={updateForm("keywords")} />
          </Field>
          <Field label={t("books.chapterCount")}>
            <Input type="number" min={1} max={15} value={form.chapterCount} onChange={updateForm("chapterCount")} />
          </Field>

          <div className="grid grid-cols-1 gap-2 pt-2">
            <Btn onClick={createBook} disabled={loading} icon={<PlusIcon size={13} />}>
              {t("books.createBook")}
            </Btn>
            <Btn variant="teal" onClick={generateChapters} disabled={loading} icon={<SparkIcon size={13} />}>
              {t("books.generateChapters")}
            </Btn>
            <Btn variant="secondary" onClick={generateContent} disabled={!book || chapters.length === 0 || loading} icon={<PenIcon size={13} />}>
              {t("books.generateContent")}
            </Btn>
            <Btn variant="secondary" onClick={exportBook} disabled={!book || chapters.length === 0 || loading} icon={<DownloadIcon size={13} />}>
              {t("books.exportBook")}
            </Btn>
          </div>
        </Card>

        <div className="space-y-4">
          {job?.id && <AsyncJobCard title={jobTitle} job={job} />}

          <Card className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-semibold text-gray-900">{book?.title || t("books.noBook")}</p>
                <p className="text-xs text-gray-500">{book?.id ? `ID: ${book.id}` : t("books.createHint")}</p>
              </div>
              {book?.id && (
                <Btn variant="ghost" small onClick={() => loadBook(book.id)} icon={<RefreshIcon size={12} />}>
                  {t("books.reload")}
                </Btn>
              )}
            </div>

            {activeBookStep === 1 && (
              <div className="rounded-xl border border-dashed border-gray-200 p-6">
                <p className="text-sm font-semibold text-gray-900">Define the book concept</p>
                <p className="mt-1 text-xs text-gray-500">
                  Use Create Book for the fast path, or Generate Chapters to start the step-by-step review flow.
                </p>
                {book?.id && (
                  <div className="mt-4 rounded-lg bg-indigo-50 p-3 text-xs text-indigo-700">
                    Current book is saved. Continue with Step 2 to review chapters.
                  </div>
                )}
              </div>
            )}

            {activeBookStep === 2 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-900">Review and edit chapters</p>
                  <Btn small onClick={saveChapterChanges} disabled={!book || chapters.length === 0 || loading}>
                    Save changes
                  </Btn>
                </div>
                {editableChapters.length === 0 ? (
                  <div className="py-12 text-center text-sm text-gray-400 border border-dashed border-gray-200 rounded-xl">
                    {t("books.emptyChapters")}
                  </div>
                ) : (
                  editableChapters.map((chapter, index) => (
                    <div key={chapter.id} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="w-6 h-6 rounded bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
                          {index + 1}
                        </span>
                        <Input
                          value={chapter.title}
                          onChange={(event) => setEditableChapters((current) => current.map((item) => (
                            item.id === chapter.id ? { ...item, title: event.target.value } : item
                          )))}
                        />
                      </div>
                      <textarea
                        rows={3}
                        value={chapter.description}
                        onChange={(event) => setEditableChapters((current) => current.map((item) => (
                          item.id === chapter.id ? { ...item, description: event.target.value } : item
                        )))}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  ))
                )}
              </div>
            )}

            {activeBookStep === 3 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-900">Generate and edit content</p>
                  <div className="flex gap-2">
                    <Btn small variant="secondary" onClick={generateContent} disabled={!book || chapters.length === 0 || loading} icon={<PenIcon size={12} />}>
                      {t("books.generateContent")}
                    </Btn>
                    <Btn small onClick={saveContentChanges} disabled={!book || chapters.length === 0 || loading}>
                      Save changes
                    </Btn>
                  </div>
                </div>
                {chapters.length === 0 ? (
                  <div className="py-12 text-center text-sm text-gray-400 border border-dashed border-gray-200 rounded-xl">
                    Generate and validate chapters before editing content.
                  </div>
                ) : (
                  chapters.map((chapter, index) => (
                    <div key={chapter.id} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <p className="text-xs font-semibold text-gray-700">{index + 1}. {chapter.title}</p>
                        {(contentDrafts[chapter.id] || chapter.content) && (
                          <Btn small variant="secondary" onClick={() => refineChapterWithAi(chapter)} disabled={loading}>
                            ✨ Refinar con IA
                          </Btn>
                        )}
                      </div>
                      <textarea
                        rows={8}
                        value={contentDrafts[chapter.id] || ""}
                        onChange={(event) => setContentDrafts((current) => ({ ...current, [chapter.id]: event.target.value }))}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="Generated chapter HTML will appear here."
                      />
                    </div>
                  ))
                )}
              </div>
            )}

            {activeBookStep === 4 && (
              <div className="space-y-3">
                <p className="text-sm font-semibold text-gray-900">Generate marketing assets</p>
                <div className="grid grid-cols-3 gap-3">
                  {["One-Pager", "Whitepaper", "Social Summaries", "Infographic"].map((asset) => (
                    <div key={asset} className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-sm font-semibold text-gray-900">{asset}</p>
                        <Badge label={t("books.readyToGenerate")} color="bg-indigo-100 text-indigo-700" />
                      </div>
                      <Field label={t("books.template")}><Select><option>{t("books.defaultTemplate")} {asset}</option><option>{t("books.salesStyle")}</option></Select></Field>
                      <div className="flex gap-2">
                        <Btn small icon={<SparkIcon size={12} />} onClick={asset === "One-Pager" ? generateOnePager : asset === "Social Summaries" ? generateSocialPosts : asset === "Infographic" ? generateInfographic : exportBook} disabled={!book || loading}>{t("books.generate")}</Btn>
                        <Btn small variant="secondary" icon={<EyeIcon size={12} />} disabled>{t("books.preview")}</Btn>
                        <Btn small variant="secondary" icon={<DownloadIcon size={12} />} disabled>{t("books.download")}</Btn>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function BookConceptsExperience({
  activeBookStep,
  activeChapterId,
  setActiveChapterId,
  assets,
  book,
  bookLanguage,
  bookLanguageManuallySelected,
  chapters,
  chaptersForOutline,
  contentDrafts,
  createBook,
  exportBook,
  form,
  generatedChapters,
  generateChapters,
  generateContent,
  generateInfographic,
  generateOnePager,
  generateSocialPosts,
  goToBookStep,
  isDark,
  job,
  jobTitle,
  language,
  loadAssets,
  loadBook,
  loadLibrary,
  loading,
  loadingAssets,
  previewOpen,
  previewPage,
  refineActiveChapter,
  refineText,
  regenerateAllAssets,
  regenerateStatus,
  saveChapterChanges,
  saveContentChanges,
  setActiveBookStep,
  setBookLanguage,
  setBookLanguageManuallySelected,
  setBookView,
  setChapters,
  setContentDrafts,
  setDeletedChapterIds,
  setEditableChapters,
  setPreviewOpen,
  setPreviewPage,
  setRefineText,
  showToast,
  t,
  toast,
  totalWords,
  updateForm,
}) {
  const bt = (key) => t(`books.${key}`);
  const bookInputStyle = { background: isDark ? '#0F172A' : '#fff', color: isDark ? '#F1F5F9' : '#0F172A', borderColor: isDark ? '#334155' : '#e3e6ee' };
  const bookPanelStyle = { background: isDark ? '#1E293B' : '#fff', borderColor: isDark ? '#334155' : '#eaecf3' };
  const bookTextPrimary = isDark ? '#F1F5F9' : '#0F172A';
  const bookTextSecondary = isDark ? '#94A3B8' : '#64748B';
  const keywordsLabel = language === "es" ? "Palabras clave" : language === "pt" ? "Palavras-chave" : bt("keywordsLabel");
  const bookLanguageLabels = {
    en: "English",
    es: "Español",
    pt: "Português",
  };
  const keywords = form.keywords.split(",").map((item) => item.trim()).filter(Boolean);
  const previewChapters = chapters.length ? chapters : chaptersForOutline;
  const completedSteps = [
    false,
    Boolean(book?.id && activeBookStep > 1),
    Boolean(chapters.length && activeBookStep > 2),
    Boolean(generatedChapters && activeBookStep > 3),
    false,
  ];
  const previewCount = previewChapters.filter((chapter) => contentDrafts[chapter.id] || chapter.content).length || generatedChapters;
  const previewItems = [
    { type: "cover", label: bt("cover") },
    { type: "index", label: bt("index") },
    ...previewChapters.map((chapter, index) => ({ type: "chapter", chapter, index, label: chapter.title || `${bt("chapter")} ${index + 1}` })),
  ];
  const currentPreview = previewItems[Math.min(previewPage, Math.max(previewItems.length - 1, 0))] || previewItems[0];

  const plainText = (value = "") => String(value)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const sanitizeAssetHtml = (html = "") => String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript:/gi, "");

  const parseAssetJson = (value) => {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const truncatePreviewText = (value = "", maxLength = 520) => {
    const text = plainText(value);
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength).replace(/\s+\S*$/, "").trim()}...`;
  };

  const buildHtmlAssetPreview = (html = "") => {
    const safeHtml = sanitizeAssetHtml(html);
    if (typeof document === "undefined") {
      return truncatePreviewText(safeHtml);
    }
    const container = document.createElement("div");
    container.innerHTML = safeHtml;
    const nodes = Array.from(container.querySelectorAll("h1, h2, h3, p, li, blockquote")).filter((node) => plainText(node.textContent));
    if (!nodes.length) {
      return truncatePreviewText(safeHtml);
    }

    const preview = document.createElement("div");
    let usedChars = 0;
    for (const node of nodes.slice(0, 7)) {
      const text = plainText(node.textContent);
      if (!text) continue;
      if (usedChars > 0 && usedChars + text.length > 620) break;
      const clone = node.cloneNode(true);
      preview.appendChild(clone);
      usedChars += text.length;
    }
    return preview.innerHTML || truncatePreviewText(safeHtml);
  };

  const buildMarketingAssetPreview = (content, type, fallback) => {
    const raw = typeof content === "string" ? content.trim() : content;
    const normalizedType = String(type || "").toLowerCase();
    if (normalizedType === "social_post" || normalizedType === "infographic") {
      return {
        body: raw || fallback,
        isHtml: false,
        isFallback: !raw,
      };
    }
    if (!raw) {
      return {
        body: fallback,
        isHtml: false,
        isFallback: true,
      };
    }
    if (typeof raw === "string" && /<\/?[a-z][\s\S]*>/i.test(raw)) {
      return {
        body: buildHtmlAssetPreview(raw),
        isHtml: true,
        isFallback: false,
      };
    }
    return {
      body: truncatePreviewText(raw),
      isHtml: false,
      isFallback: false,
    };
  };

  const marketingAssets = assets.length ? assets.map((asset) => ({
    ...(() => {
      const preview = buildMarketingAssetPreview(asset.content, asset.type, asset.description || bt("assetGenericBody"));
      return {
        id: asset.id,
        type: asset.type,
        badge: asset.type || asset.format || "Asset",
        title: asset.title || asset.name || bt("assetGenericTitle"),
        body: preview.body,
        isHtmlPreview: preview.isHtml,
        isFallbackPreview: preview.isFallback,
        downloadUrl: asset.downloadUrl || asset.url || null,
        tone: "indigo",
      };
    })(),
  })) : [
    {
      badge: "LinkedIn",
      title: bt("assetLinkedInTitle"),
      body: bt("assetLinkedInBody"),
      tone: "indigo",
    },
    {
      badge: "Email",
      title: bt("assetEmailTitle"),
      body: bt("assetEmailBody"),
      tone: "purple",
    },
    {
      badge: "Landing",
      title: bt("assetLandingTitle"),
      body: bt("assetLandingBody"),
      tone: "green",
    },
    {
      badge: "Ads",
      title: bt("assetAdTitle"),
      body: bt("assetAdBody"),
      tone: "orange",
    },
  ];

  const fallbackChapterText = (chapter) => chapter?.description || bt("noPreviewContent");
  const escapeRegExp = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const previewChapterText = (chapter, index) => {
    let text = plainText(contentDrafts[chapter.id] || chapter.content) || fallbackChapterText(chapter);
    const title = plainText(chapter.title);
    if (title && text.toLowerCase().startsWith(title.toLowerCase())) {
      text = text.slice(title.length).replace(/^[:\s\-\u2013\u2014]+/, "").trim();
    }
    text = text.replace(/^(?:chapter|cap[ií]tulo|capitulo)\s*\d+\s*[:.\-–—]?\s*/i, "").trim();
    if (title) {
      text = text.replace(new RegExp(`^${escapeRegExp(title)}\\s*[:.\\-\\u2013\\u2014]?\\s*`, "i"), "").trim();
    }
    return text || fallbackChapterText(chapter);
  };
  const copyText = async (text) => {
    try {
      await navigator.clipboard?.writeText(text);
      showToast(bt("copied"));
    } catch {
      showToast(bt("copyFailed"));
    }
  };

  // Chapter actions: add, move, delete (client-first, persist on save)
  const addChapter = async () => {
    // optimistic UI: add a local empty chapter immediately so user can edit
    const newId = `local-${Date.now()}`;
    const newChapter = { id: newId, title: "", description: "", orderIndex: (editableChapters.length || chapters.length) };
    setEditableChapters((cur) => [...cur, { id: newId, title: newChapter.title, description: newChapter.description }]);
    setChapters((cur) => [...cur, newChapter]);
    setActiveChapterId(newId);
    showToast(bt("added") || "Capítulo añadido");
    console.debug('[BookConcepts] addChapter local id', newId);

    // If we have a server book, try to persist in background and refresh
    if (!book?.id) return;
    setLoading(true);
    try {
      const { data } = await api.post(
        `/books/${book.id}/chapters`,
        { title: newChapter.title, description: newChapter.description },
        { suppressPermissionToast: true },
      );
      if (data && data.id) {
        await loadBook(book.id);
        setActiveChapterId(data.id);
      }
    } catch (e) {
      console.error('[BookConcepts] addChapter error', e);
      showToast(bt("addFailed") || "No se pudo agregar capítulo en el servidor");
    } finally {
      setLoading(false);
    }
  };

  const moveChapter = (fromIndex, toIndex) => {
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    setEditableChapters((current) => {
      const copy = [...current];
      const [item] = copy.splice(fromIndex, 1);
      if (!item) return current;
      copy.splice(toIndex, 0, item);
      return copy;
    });
    setChapters((current) => {
      const copy = [...current];
      const [item] = copy.splice(fromIndex, 1);
      if (!item) return current;
      copy.splice(toIndex, 0, item);
      return copy;
    });
  };

  const deleteChapter = async (chapterId) => {
    // optimistic removal from UI
    setEditableChapters((current) => current.filter((c) => c.id !== chapterId));
    setChapters((current) => current.filter((c) => c.id !== chapterId));
    setDeletedChapterIds((cur) => {
      if (cur.includes(chapterId)) return cur;
      return [...cur, chapterId];
    });
    showToast(bt("deleted") || "Capítulo eliminado");
    console.debug('[BookConcepts] deleteChapter queued id', chapterId);

    // If local/demo id, nothing to call on server
    if (!book?.id || String(chapterId).startsWith("demo-chapter-") || String(chapterId).startsWith("local-")) {
      return;
    }

    setLoading(true);
    try {
      await api.delete(`/books/${book.id}/chapters/${chapterId}`, { suppressPermissionToast: true });
      // ensure server state matches
      await loadBook(book.id);
      // remove from deleted list
      setDeletedChapterIds((cur) => cur.filter((id) => id !== chapterId));
      showToast(bt("deleted") || "Capítulo borrado");
    } catch (e) {
      console.error('[BookConcepts] deleteChapter error', e);
      showToast(bt("deleteFailed") || "No se pudo borrar capítulo en el servidor");
      // reload to restore state from server
      try { await loadBook(book.id); } catch (_) {}
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1440px] space-y-4 px-2 pb-10 lg:px-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => { setBookView("library"); loadLibrary(); }}
            className="inline-flex h-11 items-center gap-2 rounded-xl border px-5 text-sm font-semibold shadow-sm"
            style={{
              background: isDark ? '#1E293B' : '#fff',
              borderColor: isDark ? '#334155' : '#e5e7eb',
              color: isDark ? '#F1F5F9' : '#374151',
            }}
          >
            <span className="text-lg leading-none">&larr;</span>
            {bt("backToBooks")}
          </button>

          <header>
            <h1 className="text-[17px] font-bold tracking-[-0.02em]" style={{ color: isDark ? '#F1F5F9' : '#0f172a' }}>{t("sidebar.books")}</h1>
            <p className="mt-1 text-[12.5px]" style={{ color: isDark ? '#94A3B8' : '#64748b' }}>{bt("workflowSubtitle")}</p>
          </header>
        </div>

        <div className="flex flex-col items-end gap-5">
          <button
            type="button"
            onClick={() => { setPreviewPage(0); setPreviewOpen(true); }}
            disabled={previewItems.length <= 2}
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#0f172a] px-6 text-sm font-bold text-white shadow-sm hover:bg-[#111827] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <EyeIcon size={16} />
            {bt("bookPreviewTitle")}
          </button>
          {book && (
            <span className="rounded-full bg-emerald-50 px-5 py-2 text-sm font-semibold text-emerald-600">
              {bt("generatedContent")}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-[14px] lg:grid-cols-4">
        {[bt("defineConcept"), bt("defineChapters"), bt("generateEditContent"), bt("generateMarketingAssets")].map((label, index) => {
          const step = index + 1;
          const active = activeBookStep === step;
          const done = completedSteps[step];
          return (
            <button
              key={label}
              type="button"
              onClick={() => goToBookStep(step)}
              disabled={step > 1 && !book?.id}
              className={`min-h-[88px] rounded-xl border px-5 py-4 text-left shadow-sm transition-colors ${step > 1 && !book?.id ? "cursor-not-allowed opacity-70" : ""}`}
              style={
                active
                  ? { borderColor: isDark ? '#3730A3' : '#c7d2fe', background: isDark ? 'rgba(55,48,163,0.18)' : '#eef2ff', color: isDark ? '#A5B4FC' : '#4f46e5' }
                  : { borderColor: isDark ? '#334155' : '#f3f4f6', background: isDark ? '#1E293B' : '#fff', color: isDark ? '#94A3B8' : '#94a3b8' }
              }
            >
              <div className="flex items-start gap-3">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-black"
                  style={
                    done
                      ? { background: isDark ? 'rgba(16,185,129,0.15)' : '#ecfdf5', color: '#10b981' }
                      : active
                        ? { background: isDark ? '#3730A3' : '#4f46e5', color: '#fff' }
                        : { background: isDark ? '#334155' : '#f1f5f9', color: isDark ? '#94A3B8' : '#94a3b8' }
                  }
                >
                  {done ? <CheckIcon size={16} /> : step}
                </span>
                <span>
                  <span
                    className="block text-base font-bold"
                    style={{ color: active ? (isDark ? '#A5B4FC' : '#4f46e5') : done ? (isDark ? '#CBD5E1' : '#334155') : (isDark ? '#94A3B8' : '#94a3b8') }}
                  >
                    {bt("step")} {step}
                  </span>
                  <span className="mt-1 block text-sm">{label}</span>
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="rounded-2xl border p-5 shadow-sm" style={bookPanelStyle}>
          <div className="space-y-3">
            <div className="mb-[18px]">
              <label className="block text-xs font-medium mb-1" style={{ color: bookTextSecondary }}>{bt("titleField")}</label>
              <input value={form.title} onChange={updateForm("title")} className="w-full h-10 rounded-lg border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" style={bookInputStyle} />
            </div>
            <div className="mb-[18px]">
              <label className="block text-xs font-medium mb-1" style={{ color: bookTextSecondary }}>{bt("description")}</label>
              <textarea
                rows={4}
                value={form.description}
                onChange={updateForm("description")}
                className="w-full rounded-xl border px-4 py-3 text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                style={bookInputStyle}
              />
            </div>
            <div className="mb-[18px]">
              <label className="block text-xs font-medium mb-1" style={{ color: bookTextSecondary }}>{keywordsLabel}</label>
              <input value={form.keywords} onChange={updateForm("keywords")} className="w-full h-10 rounded-lg border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" style={bookInputStyle} />
            </div>
            <div className="mb-[18px]">
              <label className="block text-xs font-medium mb-1" style={{ color: bookTextSecondary }}>{bt("chapterCount")}</label>
              <input type="number" min={1} max={15} value={form.chapterCount} onChange={updateForm("chapterCount")} className="w-full h-10 rounded-lg border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" style={bookInputStyle} />
            </div>
            <div className="mb-[18px]">
              <label className="block text-xs font-medium mb-1" style={{ color: bookTextSecondary }}>
                {language === "es" ? "Idioma de creación" : language === "pt" ? "Idioma de criação" : "Creation language"}
              </label>
              <select
                value={bookLanguage}
                onChange={(event) => {
                  setBookLanguage(event.target.value);
                  setBookLanguageManuallySelected(true);
                }}
                className="w-full h-10 rounded-lg border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                style={bookInputStyle}
              >
                {Object.entries(bookLanguageLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}{!bookLanguageManuallySelected && bookLanguage === value ? ` (${language === "es" ? "predeterminado" : language === "pt" ? "padrão" : "default"})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-1 gap-2 pt-1">
              <button type="button" onClick={createBook} disabled={loading} title={bt("createBookHint")} className="flex h-11 items-center justify-center gap-3 rounded-xl bg-indigo-600 px-4 text-sm font-bold text-white shadow-md shadow-indigo-600/20 hover:bg-indigo-700 disabled:opacity-60">
                <PlusIcon size={17} /> {bt("createBook")}
              </button>
              <button type="button" onClick={generateChapters} disabled={loading} title={bt("generateChaptersHint")} className="flex h-11 items-center justify-center gap-3 rounded-xl bg-emerald-500 px-4 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-60">
                <SparkIcon size={16} /> {bt("generateChapters")}
              </button>
              <button type="button" onClick={generateContent} disabled={!book || chapters.length === 0 || loading} title={bt("generateContentHint")} className="flex h-11 items-center justify-center gap-3 rounded-xl border px-4 text-sm font-bold hover:bg-gray-50 disabled:opacity-50" style={{ borderColor: isDark ? '#334155' : '#e5e7eb', background: isDark ? '#0F172A' : '#fff', color: isDark ? '#F1F5F9' : '#334155' }}>
                <PenIcon size={16} /> {bt("generateContent")}
              </button>
              <button type="button" onClick={exportBook} disabled={!book || chapters.length === 0 || loading} title={bt("exportBookHint")} className="flex h-11 items-center justify-center gap-3 rounded-xl border px-4 text-sm font-bold hover:bg-gray-50 disabled:opacity-50" style={{ borderColor: isDark ? '#334155' : '#e5e7eb', background: isDark ? '#0F172A' : '#fff', color: isDark ? '#F1F5F9' : '#334155' }}>
                <DownloadIcon size={16} /> {bt("exportBook")}
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border p-6 shadow-sm" style={bookPanelStyle}>
          <div className="mb-5 flex items-start justify-between gap-4 border-b pb-5" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
            <div>
              <h2 className="text-[14px] font-bold" style={{ color: bookTextPrimary }}>{book?.title || form.title}</h2>
              <p className="mt-1 text-[11.5px]" style={{ color: bookTextSecondary }}>ID: {book?.id || "f32d04c4-7b29-421a-abec-c4bf93617326"}</p>
            </div>
            {book?.id && (
              <button type="button" onClick={() => loadBook(book.id)} className="inline-flex items-center gap-2 text-sm font-bold text-indigo-500 hover:text-indigo-700">
                <RefreshIcon size={16} /> {bt("reload")}
              </button>
            )}
          </div>

          {job?.id && <AsyncJobCard title={jobTitle} job={job} statusLabel={bt("status")} />}

          {activeBookStep === 1 && (
            <div className="space-y-4">
              <div className="rounded-2xl border p-5" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
                <h3 className="text-[14px] font-bold" style={{ color: bookTextPrimary }}>{bt("defineConceptTitle")}</h3>
                <p className="mt-2 text-[13px] leading-[1.6]" style={{ color: bookTextSecondary }}>
                  {bt("defineConceptPrefix")} <strong style={{ color: bookTextPrimary }}>{bt("createBook")}</strong> {bt("defineConceptMiddle")} <strong style={{ color: bookTextPrimary }}>{bt("generateChapters")}</strong> {bt("defineConceptSuffix")}
                </p>
                {book?.id && (
                  <div className="mt-4 flex items-center gap-3 rounded-xl px-5 py-3 text-sm font-bold" style={{ background: isDark ? 'rgba(79,70,229,0.15)' : '#eef2ff', color: isDark ? '#A5B4FC' : '#4338ca' }}>
                    <CheckIcon size={18} />
                    {bt("savedMessage")}
                  </div>
                )}
              </div>
              {(loading || (job && job.status !== 'completed' && job.status !== 'failed')) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: '#eef0fe', border: '1px solid #dfe2fc', borderRadius: 11, marginBottom: 14 }}>
                  <span style={{ width: 16, height: 16, border: '2.4px solid rgba(99,102,241,.3)', borderTopColor: '#6366f1', borderRadius: '50%', display: 'inline-block', animation: 'spin .7s linear infinite', flexShrink: 0 }} />
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: '#4f46e5' }}>
                    {jobTitle || bt("processing")}
                  </span>
                  {job?.progress != null && job?.status !== 'completed' && job?.status !== 'failed' && (
                    <span style={{ marginLeft: 'auto', fontSize: 12.5, color: '#6366f1', fontWeight: 600 }}>
                      {Math.round(job.progress)}%
                    </span>
                  )}
                </div>
              )}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                {[
                  [bt("chapters").toUpperCase(), chapters.length || Number(form.chapterCount) || 0],
                  [bt("withContent").toUpperCase(), generatedChapters],
                  [bt("words").toUpperCase(), totalWords],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border p-4" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
                    <p className="text-[11px] font-bold" style={{ color: bookTextSecondary }}>{label}</p>
                    <p className="mt-[6px] text-[18px] font-bold" style={{ color: bookTextPrimary }}>{value}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeBookStep === 2 && (
            <div className="space-y-5">
              {(loading || (job && job.status !== 'completed' && job.status !== 'failed')) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: '#eef0fe', border: '1px solid #dfe2fc', borderRadius: 11, marginBottom: 14 }}>
                  <span style={{ width: 16, height: 16, border: '2.4px solid rgba(99,102,241,.3)', borderTopColor: '#6366f1', borderRadius: '50%', display: 'inline-block', animation: 'spin .7s linear infinite', flexShrink: 0 }} />
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: '#4f46e5' }}>
                    {jobTitle || bt("processing")}
                  </span>
                  {job?.progress != null && job?.status !== 'completed' && job?.status !== 'failed' && (
                    <span style={{ marginLeft: 'auto', fontSize: 12.5, color: '#6366f1', fontWeight: 600 }}>
                      {Math.round(job.progress)}%
                    </span>
                  )}
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-black" style={{ color: bookTextPrimary }}>{bt("reviewEditChapters")}</h3>
                <div className="flex gap-2">
                  <button type="button" onClick={addChapter} className="inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-bold" style={{ background: isDark ? '#334155' : '#f1f5f9', color: isDark ? '#F1F5F9' : '#334155' }}>
                    <PlusIcon size={15} /> {bt("add")}
                  </button>
                  <button type="button" onClick={saveChapterChanges} disabled={!book || chaptersForOutline.length === 0 || loading} className="h-10 rounded-lg bg-indigo-600 px-5 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50">
                    {bt("saveChanges")}
                  </button>
                </div>
              </div>
              {chaptersForOutline.length === 0 ? (
                <div className="rounded-2xl border border-dashed py-16 text-center text-sm" style={{ borderColor: isDark ? '#334155' : '#e5e7eb', color: bookTextSecondary }}>
                  {t("books.emptyChapters")}
                </div>
              ) : (
                <div className="space-y-4">
                  {chaptersForOutline.map((chapter, index) => (
                    <div key={chapter.id} className="grid grid-cols-[26px_1fr_34px] gap-3 rounded-2xl border p-4" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
                      <div className="flex flex-col items-center gap-3 pt-1">
                        <span style={{ color: isDark ? '#475569' : '#cbd5e1' }}>::</span>
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg text-xs font-black" style={{ background: isDark ? 'rgba(79,70,229,0.15)' : '#eef2ff', color: isDark ? '#A5B4FC' : '#4f46e5' }}>{index + 1}</span>
                      </div>
                      <div className="space-y-2">
                        <input
                          value={chapter.title}
                          onChange={(event) => setEditableChapters((current) => current.map((item) => (
                            item.id === chapter.id ? { ...item, title: event.target.value } : item
                          )))}
                          className="w-full h-10 rounded-lg border px-3 py-1.5 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          style={bookInputStyle}
                        />
                        <textarea
                          rows={2}
                          value={chapter.description || ""}
                          onChange={(event) => setEditableChapters((current) => current.map((item) => (
                            item.id === chapter.id ? { ...item, description: event.target.value } : item
                          )))}
                          className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          style={bookInputStyle}
                        />
                      </div>
                      <div className="flex flex-col items-center gap-2">
                        <button type="button" onClick={() => moveChapter(index, index - 1)} disabled={index === 0} className="flex h-8 w-8 items-center justify-center rounded-lg border" style={{ borderColor: isDark ? '#334155' : '#f3f4f6', color: isDark ? '#475569' : '#cbd5e1' }}>⌃</button>
                        <button type="button" onClick={() => moveChapter(index, index + 1)} disabled={index === (chaptersForOutline.length - 1)} className="flex h-8 w-8 items-center justify-center rounded-lg border" style={{ borderColor: isDark ? '#334155' : '#f3f4f6', color: isDark ? '#475569' : '#cbd5e1' }}>⌄</button>
                        <button type="button" onClick={() => deleteChapter(chapter.id)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-red-100 text-red-400"><TrashIcon size={14} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex justify-end pt-1">
                <button type="button" onClick={async () => {
                  try {
                    await saveChapterChanges();
                    await generateContent();
                  } catch(e) {
                    console.error('[BookConcepts] Error en confirm chapters:', e?.message, e?.response?.status);
                  }
                }} disabled={!book || chaptersForOutline.length === 0 || loading} className="rounded-xl bg-emerald-500 px-7 py-3 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-50">
                  {bt("confirmChapters")} &rarr;
                </button>
              </div>
            </div>
          )}

          {activeBookStep === 3 && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-black" style={{ color: bookTextPrimary }}>{bt("generateEditContentTitle")}</h3>
                  <p className="text-sm" style={{ color: bookTextSecondary }}>{bt("generateEditContentHelp")}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={saveContentChanges} disabled={!book || chapters.length === 0 || loading} className="h-10 rounded-lg bg-indigo-600 px-5 text-sm font-bold text-white disabled:opacity-50">{bt("saveChanges")}</button>
                  <button type="button" onClick={() => setActiveBookStep(4)} disabled={chapters.length === 0} className="h-10 rounded-lg bg-emerald-500 px-5 text-sm font-bold text-white disabled:opacity-50">{bt("marketingAssetsTitle")}</button>
                </div>
              </div>
              {(loading || (job && job.status !== 'completed' && job.status !== 'failed')) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: '#eef0fe', border: '1px solid #dfe2fc', borderRadius: 11, marginBottom: 14 }}>
                  <span style={{ width: 16, height: 16, border: '2.4px solid rgba(99,102,241,.3)', borderTopColor: '#6366f1', borderRadius: '50%', display: 'inline-block', animation: 'spin .7s linear infinite', flexShrink: 0 }} />
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: '#4f46e5' }}>
                    {jobTitle || bt("processing")}
                  </span>
                  {job?.progress != null && (
                    <span style={{ marginLeft: 'auto', fontSize: 12.5, color: '#6366f1', fontWeight: 600 }}>
                      {Math.round(job.progress)}%
                    </span>
                  )}
                </div>
              )}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
                <div className="space-y-2 rounded-xl border p-3" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
                  {chapters.map((chapter, index) => {
                    const selected = (activeChapterId || chapters[0]?.id) === chapter.id;
                    return (
                      <button
                        key={chapter.id}
                        type="button"
                        onClick={() => setActiveChapterId(chapter.id)}
                        className="w-full rounded-lg px-3 py-2 text-left text-sm font-semibold transition-colors"
                        style={selected ? { background: isDark ? '#1E3A5F' : '#eef0fe', color: isDark ? '#F1F5F9' : '#4338ca' } : { color: bookTextSecondary }}
                      >
                        {index + 1}. {chapter.title}
                      </button>
                    );
                  })}
                </div>
                <div className="space-y-3">
                  {(chapters.length ? chapters : [{ id: "empty", title: bt("contentLabel"), content: "" }]).map((chapter) => {
                    const isActive = chapters.length === 0 || (activeChapterId || chapters[0]?.id) === chapter.id;
                    return (
                      <div key={chapter.id} className={isActive ? "" : "hidden"}>
                        <p className="mb-2 text-sm font-bold" style={{ color: bookTextPrimary }}>{chapter.title}</p>
                        <textarea
                          rows={14}
                          value={contentDrafts[chapter.id] || chapter.content || ""}
                          onChange={(event) => setContentDrafts((current) => ({ ...current, [chapter.id]: event.target.value }))}
                          className="w-full rounded-xl border px-4 py-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          style={bookInputStyle}
                          placeholder={bt("emptyChapters")}
                        />
                      </div>
                    );
                  })}
                  <div className="rounded-xl border p-4" style={{ borderColor: isDark ? 'rgba(99,102,241,0.3)' : '#e0e7ff', background: isDark ? 'rgba(99,102,241,0.1)' : '#eef2ff' }}>
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-sm font-bold" style={{ color: isDark ? '#A5B4FC' : '#312e81' }}>{bt("refineWithAi")}</p>
                      <button type="button" onClick={refineActiveChapter} disabled={!refineText.trim()} className="rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-50" style={{ background: isDark ? '#1E293B' : '#fff', color: isDark ? '#A5B4FC' : '#4f46e5' }}>{bt("apply")}</button>
                    </div>
                    <textarea rows={3} value={refineText} onChange={(event) => setRefineText(event.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm" style={bookInputStyle} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeBookStep === 4 && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-xl font-black" style={{ color: bookTextPrimary }}>{bt("marketingAssetsTitle")}</h3>
                  <p className="mt-1 text-sm" style={{ color: bookTextSecondary }}>{bt("marketingAssetsHelp")}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={loadAssets} disabled={!book || loadingAssets} className="inline-flex h-11 items-center gap-2 rounded-xl border px-4 text-sm font-bold disabled:opacity-50" style={{ borderColor: isDark ? '#334155' : '#e5e7eb', color: bookTextSecondary }}>
                    <RefreshIcon size={15} /> {bt("reload")}
                  </button>
                  <button type="button" onClick={regenerateAllAssets} disabled={!book || chapters.length === 0 || loading || Object.values(regenerateStatus || {}).includes("pending")} className="inline-flex h-11 items-center gap-2 rounded-xl bg-emerald-500 px-5 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-50">
                    <SparkIcon size={15} /> {bt("regenerateAll")}
                  </button>
                </div>
              </div>
              {regenerateStatus && (
                <div className="flex flex-wrap gap-2">
                  {ASSET_REGENERATION_TYPES.map((asset) => {
                    const status = regenerateStatus[asset.key];
                    const color = status === "success" ? { background: isDark ? 'rgba(16,185,129,0.15)' : '#ecfdf5', color: '#059669' }
                      : status === "error" ? { background: isDark ? 'rgba(239,68,68,0.15)' : '#fef2f2', color: '#dc2626' }
                      : { background: isDark ? 'rgba(99,102,241,0.15)' : '#eef2ff', color: '#4f46e5' };
                    return (
                      <span key={asset.key} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold" style={color}>
                        {status === "pending" && <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
                        {bt(asset.labelKey)}
                      </span>
                    );
                  })}
                </div>
              )}
              {loadingAssets ? (
                <div className="rounded-xl border border-dashed py-12 text-center" style={{ borderColor: isDark ? '#334155' : '#e5e7eb' }}>
                  <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                  {marketingAssets.map((asset) => (
                    <div key={asset.id || `${asset.badge}-${asset.title}`} className="rounded-2xl border p-5" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
                      <div className="mb-4 flex items-center justify-between">
                        <span className={`rounded-lg px-3 py-1 text-xs font-bold ${
                          asset.tone === "green" ? "bg-emerald-50 text-emerald-600" : asset.tone === "orange" ? "bg-orange-50 text-orange-600" : asset.tone === "purple" ? "bg-purple-50 text-purple-600" : "bg-indigo-50 text-indigo-600"
                        }`}>{asset.badge}</span>
                        {asset.downloadUrl ? (
                          <a href={asset.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-bold text-indigo-600 hover:text-indigo-700">
                            <DownloadIcon size={15} /> {bt("download")}
                          </a>
                        ) : (
                          <button type="button" onClick={() => copyText(asset.body)} className="inline-flex items-center gap-2 text-sm font-bold text-slate-400 hover:text-indigo-600">
                            <FileIcon size={15} /> {bt("copy")}
                          </button>
                        )}
                      </div>
                      <h4 className="text-lg font-black" style={{ color: bookTextPrimary }}>{asset.title}</h4>
                      {asset.isHtmlPreview ? (
                        <div
                          className="mt-3 max-h-44 overflow-hidden text-sm leading-6 [&_blockquote]:mt-2 [&_blockquote]:border-l-2 [&_blockquote]:border-indigo-300 [&_blockquote]:pl-3 [&_h1]:text-base [&_h1]:font-black [&_h2]:mt-2 [&_h2]:text-sm [&_h2]:font-bold [&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-bold [&_li]:mt-1 [&_ol]:mt-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mt-2 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5 [&_.cta]:mt-3 [&_.cta]:inline-block [&_.cta]:rounded-lg [&_.cta]:bg-[#4f46e5] [&_.cta]:px-3 [&_.cta]:py-2 [&_.cta]:font-bold [&_.cta]:text-white"
                          style={{ color: bookTextSecondary }}
                          dangerouslySetInnerHTML={{ __html: asset.body }}
                        />
                      ) : asset.type === "social_post" ? (
                        <div className="mt-3 space-y-2">
                          {(parseAssetJson(asset.body) || []).map((post, index) => (
                            <div key={`${post.platform}-${index}`} className="rounded-xl border p-3" style={{ borderColor: isDark ? '#334155' : '#e5e7eb', background: isDark ? '#0F172A' : '#fff' }}>
                              <div className="mb-1.5 flex items-center justify-between gap-2">
                                <span className="rounded-lg px-2 py-0.5 text-[11px] font-bold uppercase" style={{ background: isDark ? 'rgba(79,70,229,0.15)' : '#eef2ff', color: isDark ? '#A5B4FC' : '#4f46e5' }}>
                                  {post.platform}
                                </span>
                                <span className="text-[11px]" style={{ color: bookTextSecondary }}>{post.characterCount ?? (post.content || "").length} {bt("characters")}</span>
                              </div>
                              <p className="whitespace-pre-line text-sm leading-6" style={{ color: bookTextPrimary }}>{post.content}</p>
                            </div>
                          ))}
                        </div>
                      ) : asset.type === "infographic" && parseAssetJson(asset.body) ? (
                        (() => {
                          const data = parseAssetJson(asset.body);
                          return (
                            <div className="mt-3 space-y-3">
                              {(data.title || data.subtitle) && (
                                <div>
                                  {data.title && <p className="text-base font-black" style={{ color: bookTextPrimary }}>{data.title}</p>}
                                  {data.subtitle && <p className="text-sm" style={{ color: bookTextSecondary }}>{data.subtitle}</p>}
                                </div>
                              )}
                              {(data.sections || []).map((section, index) => (
                                <div key={index} className="rounded-xl border p-3" style={{ borderColor: isDark ? '#334155' : '#e5e7eb' }}>
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="text-sm font-bold" style={{ color: bookTextPrimary }}>{section.heading}</p>
                                    {section.stat && <span className="text-sm font-black" style={{ color: '#4f46e5' }}>{section.stat}</span>}
                                  </div>
                                  {section.description && <p className="mt-1 text-xs leading-5" style={{ color: bookTextSecondary }}>{section.description}</p>}
                                </div>
                              ))}
                              {Array.isArray(data.keyPoints) && data.keyPoints.length > 0 && (
                                <ul className="list-disc space-y-1 pl-5 text-sm" style={{ color: bookTextSecondary }}>
                                  {data.keyPoints.map((point, index) => <li key={index}>{point}</li>)}
                                </ul>
                              )}
                              {data.callToAction && (
                                <p className="rounded-lg px-3 py-2 text-sm font-bold text-white" style={{ background: '#4f46e5' }}>
                                  {data.callToAction}
                                </p>
                              )}
                              {asset.downloadUrl && (
                                <a href={asset.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-bold text-indigo-600 hover:text-indigo-700">
                                  <DownloadIcon size={15} /> {bt("download")}
                                </a>
                              )}
                            </div>
                          );
                        })()
                      ) : (
                        <p className={`mt-3 whitespace-pre-line text-sm leading-6 ${asset.isFallbackPreview ? "line-clamp-2" : "line-clamp-6"}`} style={{ color: bookTextSecondary }}>{asset.body}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-5 right-5 z-[60] rounded-lg bg-gray-900 px-4 py-2 text-xs font-semibold text-white shadow-lg">
          {toast}
        </div>
      )}

      {previewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 backdrop-blur-sm" style={{ background: 'rgba(0,0,0,0.75)' }}>
          <div className="flex h-[86vh] w-full max-w-[1320px] flex-col overflow-hidden rounded-3xl shadow-2xl" style={{ background: isDark ? '#1E293B' : '#fff' }}>
            <div className="flex items-center justify-between border-b px-[18px] py-3" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
              <div className="flex items-center gap-3">
                <EyeIcon size={20} className="text-indigo-600" />
                <h3 className="text-[13.5px] font-black" style={{ color: bookTextPrimary }}>{bt("bookPreviewTitle")}</h3>
                <span className="text-sm" style={{ color: bookTextSecondary }}>· {previewCount}/{previewChapters.length || form.chapterCount} {bt("withContent").toLowerCase()}</span>
              </div>
              <button type="button" onClick={() => setPreviewOpen(false)} className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: isDark ? '#334155' : '#f1f5f9', color: isDark ? '#F1F5F9' : '#64748b' }}>
                <XIcon size={26} />
              </button>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr]" style={{ background: isDark ? '#0F172A' : '#f1f5f9' }}>
              <aside className="overflow-y-auto px-[10px] py-[14px]" style={{ background: isDark ? 'rgba(30,41,59,0.7)' : 'rgba(255,255,255,0.7)' }}>
                {previewItems.map((item, index) => {
                  const active = previewPage === index;
                  return (
                    <button
                      key={`${item.type}-${item.label}-${index}`}
                      type="button"
                      onClick={() => setPreviewPage(index)}
                      className="mb-2 flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left text-[12.5px] font-bold"
                      style={active ? { background: isDark ? '#1E3A5F' : '#eef0fe', color: isDark ? '#F1F5F9' : '#4f46e5' } : { color: bookTextSecondary }}
                    >
                      {item.type === "chapter" && (
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-black" style={active ? { background: isDark ? '#3730A3' : '#4f46e5', color: '#fff' } : { background: isDark ? '#334155' : '#f1f5f9', color: isDark ? '#94A3B8' : '#94a3b8' }}>
                          {item.index + 1}
                        </span>
                      )}
                      <span className="line-clamp-2">{item.label}</span>
                    </button>
                  );
                })}
              </aside>
              <main className="overflow-auto px-10 py-12">
                {currentPreview?.type === "cover" && (
                  <section className="mx-auto flex min-h-[700px] w-[560px] flex-col justify-center rounded-md bg-[#111827] px-16 py-16 text-white shadow-2xl shadow-slate-400/50">
                    <p className="mb-36 text-center text-[13px] font-bold uppercase tracking-[0.24em] text-emerald-300">NoonDalton · AI Marketing</p>
                    <h2 className="text-[44px] font-black leading-tight">{form.title}</h2>
                    <p className="mt-6 text-[15.5px] leading-8 text-slate-300">{form.description}</p>
                    <div className="mt-8 flex flex-wrap gap-3">
                      {keywords.map((keyword) => (
                        <span key={keyword} className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm font-bold text-slate-200">{keyword}</span>
                      ))}
                    </div>
                    <div className="mt-12 border-t border-white/10 pt-8 text-[13.5px] text-slate-400">{previewChapters.length || form.chapterCount} {bt("chapters").toLowerCase()} · {bt("writtenWithAi")}</div>
                  </section>
                )}
                {currentPreview?.type === "index" && (
                  <section className="mx-auto min-h-[700px] w-[560px] rounded-md bg-white px-16 py-16 shadow-xl shadow-slate-300/50">
                    <h2 className="font-serif text-[30px] font-black" style={{ color: bookTextPrimary }}>{bt("index")}</h2>
                    <div className="mt-4 h-1 w-16 rounded bg-indigo-600" />
                    <div className="mt-14 space-y-0">
                      {previewChapters.map((chapter, index) => (
                        <div key={chapter.id} className="grid grid-cols-[40px_1fr_74px] items-center gap-4 border-b border-gray-100 py-3.5">
                          <span className="font-serif text-[15px] font-black text-indigo-600">{index + 1}</span>
                          <span className="font-serif text-[16px] text-gray-900">{chapter.title}</span>
                          <span className="rounded-full bg-emerald-50 px-3 py-1 text-center text-sm font-bold text-emerald-600">{bt("ready")}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                {currentPreview?.type === "chapter" && (
                  <section className="mx-auto min-h-[700px] w-[560px] rounded-md bg-white px-16 py-16 shadow-xl shadow-slate-300/50">
                    <p className="text-[13px] font-black uppercase tracking-[0.22em] text-indigo-600">{bt("chapter")} {currentPreview.index + 1}</p>
                    <h2 className="mt-2.5 font-serif text-[30px] font-black leading-tight" style={{ color: bookTextPrimary }}>{currentPreview.chapter.title}</h2>
                    <div className="my-6 h-1 w-16 rounded bg-indigo-600" />
                    <div className="font-serif text-[16px] leading-[1.78] text-slate-700">
                      {previewChapterText(currentPreview.chapter, currentPreview.index)
                        .split(/\n{2,}|(?<=\.)\s+(?=[A-ZÁÉÍÓÚÑ])/)
                        .slice(0, 3)
                        .map((paragraph, index) => <p key={index} className="mb-[18px]">{paragraph}</p>)}
                    </div>
                  </section>
                )}
              </main>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AuditLogsPage() {
  const [logs, setLogs] = useState([]);
  const [userId, setUserId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const currentUser = authTokenStore.getUser() || {};

  const fetchLogs = async (filterUserId = userId) => {
    setLoading(true);
    setError("");
    try {
      const params = { limit: 50 };
      if (filterUserId.trim()) params.userId = filterUserId.trim();
      const { data } = await api.get("/admin/audit-logs", { params });
      setLogs(Array.isArray(data?.logs) ? data.logs : []);
    } catch (err) {
      setError(err.response?.data?.detail || "Unable to load audit logs.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (canViewAuditLogs(currentUser)) fetchLogs("");
  }, []);

  if (!canViewAuditLogs(currentUser)) {
    return null;
  }

  const formatTimestamp = (value) => {
    if (!value) return "-";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  };
  const methodColor = (method) => ({
    POST: "bg-indigo-100 text-indigo-700",
    GET: "bg-green-100 text-green-700",
    PUT: "bg-orange-100 text-orange-700",
    PATCH: "bg-orange-100 text-orange-700",
    DELETE: "bg-red-100 text-red-700",
  }[String(method || "").toUpperCase()] || "bg-gray-100 text-gray-600");
  const statusColor = (status) => Number(status || 0) >= 400
    ? "bg-red-100 text-red-700"
    : "bg-green-100 text-green-700";

  return (
    <div className="space-y-2.5">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Audit Logs</h1>
          <p className="text-xs text-gray-500">Security and activity trail from backend requests.</p>
        </div>
        <Btn variant="secondary" icon={<RefreshIcon size={14} />} onClick={() => fetchLogs()} disabled={loading}>
          Refresh
        </Btn>
      </div>

      <Card className="p-2">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end">
          <Field label="Filter by userId">
            <Input value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="anonymous or user id" />
          </Field>
          <Btn className="mb-[18px]" icon={<SearchIcon size={14} />} onClick={() => fetchLogs(userId)} disabled={loading}>
            Buscar
          </Btn>
        </div>
        {error && <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-4 text-xs text-red-700">{error}</div>}
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-100 text-left text-xs">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-4 font-semibold">Timestamp</th>
                <th className="px-4 py-4 font-semibold">Usuario</th>
                <th className="px-4 py-4 font-semibold">Acción</th>
                <th className="px-4 py-4 font-semibold">Método</th>
                <th className="px-4 py-4 font-semibold">Path</th>
                <th className="px-4 py-4 font-semibold">Status</th>
                <th className="px-4 py-4 font-semibold">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {loading && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-gray-400">Loading audit logs...</td>
                </tr>
              )}
              {!loading && logs.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-gray-400">No audit logs found.</td>
                </tr>
              )}
              {!loading && logs.map((log) => (
                <tr key={log.id} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-4 text-gray-700">{formatTimestamp(log.timestamp)}</td>
                  <td className="whitespace-nowrap px-4 py-4 font-medium text-gray-900">{log.userId || "-"}</td>
                  <td className="px-4 py-4 text-gray-700">{log.action || "-"}</td>
                  <td className="whitespace-nowrap px-4 py-4">
                    <Badge label={log.method || "-"} color={methodColor(log.method)} />
                  </td>
                  <td className="max-w-[260px] truncate px-4 py-4 font-mono text-[11px] text-gray-600" title={log.path || ""}>{log.path || "-"}</td>
                  <td className="whitespace-nowrap px-4 py-4">
                    <Badge label={String(log.statusCode ?? "-")} color={statusColor(log.statusCode)} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 text-gray-600">{log.ip || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

const MAIN_NAV = ["dashboard", "books", "opportunities", "content", "outreach", "assistant", "reports", "auditLogs"];
const BOTTOM_NAV = ["settings"];

const PATH_TO_PAGE = {
  "/": "dashboard",
  "/dashboard": "dashboard",
  "/books": "books",
  "/opportunities": "opportunities",
  "/content": "content",
  "/campaign_brief": "campaign_brief",
  "/outreach": "outreach",
  "/assistant": "assistant",
  "/reports": "reports",
  "/auditLogs": "auditLogs",
  "/audit-logs": "auditLogs",
  "/settings": "settings",
};

export default function App() {
  const { t } = useI18n();
  const { theme } = useTheme();
  const [outreachBadge, setOutreachBadge] = useState(0);
  const [campaignFlow, setCampaignFlow] = useState(null);
  const currentUser = authTokenStore.getUser();
  const displayName = currentUser?.name || currentUser?.preferred_username || currentUser?.email || "User";
  const displayEmail = currentUser?.email || currentUser?.preferred_username || "";
  const showAuditLogs = canViewAuditLogs(currentUser || {});
  
  const PAGES = {
    dashboard:  { label: t("sidebar.dashboard"),        icon: GridIcon,    component: DashboardPage },
    books:      { label: t("sidebar.books"),    icon: BookIcon,    component: ContentGeneratorPage },
    opportunities: { label: t("sidebar.opportunities"),  icon: TargetIcon,  component: OpportunitiesPage },
    campaign_brief: { label: "Campaign Brief", icon: TargetIcon, component: CampaignBriefPage },
    content:    { label: t("sidebar.contentLibrary"),   icon: FolderIcon,  component: ContentLibraryPage },
    outreach:   { label: t("sidebar.outreach"),          icon: SendIcon,    component: OutreachPage, badge: outreachBadge },
    assistant: { label: t("sidebar.chat"), icon: SparkIcon, component: AssistantPage },
    reports:    { label: t("sidebar.reports"),           icon: ChartIcon,   component: ReportsPage },
    auditLogs: { label: "Audit Logs", icon: ShieldIcon, component: AuditLogsPage, visible: showAuditLogs },
    settings:   { label: t("sidebar.settings"),          icon: GearIcon,    component: SettingsPage },
  };

  const [page, setPage] = useState(() => PATH_TO_PAGE[window.location.pathname] || "dashboard");
  const [navigationState, setNavigationState] = useState({});
  const [collapsed, setCollapsed] = useState(false);
  const PageComp = PAGES[page]?.visible === false ? DashboardPage : (PAGES[page]?.component || DashboardPage);

  useEffect(() => {
    const onPopState = () => {
      setPage(PATH_TO_PAGE[window.location.pathname] || "dashboard");
      setNavigationState({});
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const darkBySystem = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const useDark = theme === "dark" || (theme === "system" && darkBySystem);
    document.documentElement.classList.toggle("theme-dark", useDark);
  }, [theme]);

  useEffect(() => {
    fetchOptional("/outreach/review-queue", null).then((items) => {
      if (Array.isArray(items)) setOutreachBadge(items.length);
    });
  }, []);

  const goToPage = (key, state = {}) => {
    setPage(key);
    setNavigationState(state);
    const path = key === "dashboard" ? "/dashboard" : `/${key}`;
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
  };

  const navLink = (key) => {
    const p = PAGES[key];
    if (!p || p.visible === false) return null;
    const active = page === key;
    return (
      <button key={key} onClick={() => goToPage(key)}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
          active ? "bg-indigo-600 text-white" : "text-slate-300 hover:bg-slate-700 hover:text-white"
        } ${collapsed ? "justify-center" : ""}`}
        title={collapsed ? p.label : undefined}>
        <p.icon size={16} className="shrink-0" />
        {!collapsed && (
          <span className="flex-1 text-left">{p.label}</span>
        )}
        {!collapsed && p.badge && (
          <span className="bg-amber-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">{p.badge}</span>
        )}
      </button>
    );
  };

  return (
    <div className="app-shell flex h-screen bg-gray-50 rounded-xl overflow-hidden border border-gray-200" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Sidebar */}
      <aside className={`${collapsed ? "w-14" : "w-52"} bg-slate-800 flex flex-col h-full shrink-0 transition-all duration-200 rounded-l-xl`}>
        <div className={`flex items-center h-14 px-3 border-b border-slate-700 ${collapsed ? "justify-center" : "justify-between"}`}>
          {!collapsed && <div><p className="text-white font-bold text-sm leading-tight">NoonDalton</p><p className="text-teal-400 text-xs">AI Marketing Suite</p></div>}
          <button onClick={() => setCollapsed(!collapsed)} className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-700">
            {collapsed ? <ArrowRightIcon size={14} /> : <XIcon size={14} />}
          </button>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
          {MAIN_NAV.map(navLink)}
        </nav>

        <div className="mx-2 border-t border-slate-700" />
        <nav className="px-2 py-2 space-y-0.5">
          {BOTTOM_NAV.map(navLink)}
          <button
            onClick={async () => {
              await authApi.logout();
              window.location.assign("/login");
            }}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-slate-300 hover:bg-red-700/30 hover:text-red-300 ${collapsed ? "justify-center" : ""}`}
          >
            <LogOutIcon size={16} />{!collapsed && t("sidebar.logout")}
          </button>
        </nav>
        {!collapsed && (
          <div className="px-3 py-2.5 border-t border-slate-700">
            <p className="text-white text-xs font-medium truncate">{displayName}</p>
            {displayEmail && <p className="text-slate-400 text-xs truncate">{displayEmail}</p>}
          </div>
        )}
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto p-5">
        {campaignFlow && (
          <div className="campaign-flow-bar">
            <div className="campaign-flow-bar-inner">
              <span className="campaign-flow-name">📣 {campaignFlow.campaignName}</span>
              <div className="campaign-flow-steps">
                {CAMPAIGN_FLOW_STEPS.map((step) => (
                  <div key={step.id} className={`campaign-flow-step ${
                    campaignFlow.completedSteps.includes(step.id) ? "done" :
                    campaignFlow.currentStep === step.id ? "active" : ""
                  }`}>
                    <span className="campaign-flow-step-num">
                      {campaignFlow.completedSteps.includes(step.id) ? "✓" : step.id}
                    </span>
                    <span className="campaign-flow-step-label">{step.label}</span>
                  </div>
                ))}
              </div>
              <button onClick={() => setCampaignFlow(null)} className="campaign-flow-exit">
                Exit flow
              </button>
            </div>
          </div>
        )}
        <div className={page === "books" ? "mx-auto max-w-[1540px]" : "max-w-5xl mx-auto"}>
          <PageComp
            navigationState={navigationState}
            onNavigate={goToPage}
            onOutreachBadgeChange={setOutreachBadge}
            campaignFlow={campaignFlow}
            setCampaignFlow={setCampaignFlow}
          />
        </div>
      </main>
    </div>
  );
}

