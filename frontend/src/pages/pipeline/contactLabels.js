/**
 * Pure helpers for the contact search of a lead (RF15): which leads can be
 * searched, how a contact's role / verification / confidence are shown, and
 * which message (translation key + params + action) each backend outcome
 * gets. No React and no I/O, so every rule is testable on its own. Messages
 * never carry a contact's data nor a raw backend code.
 */
import { toDate } from "@/utils/dates";

// Must match backend CONTACT_SEARCH_SEARCHABLE_STATUSES. "researching" stays
// searchable: the backend answers 409 search_in_progress while it is live.
export const SEARCHABLE_STATUSES = ["new", "researching", "contacts_found", "error"];

export const CONFIDENCE_HIGH = 0.8;
export const CONFIDENCE_MEDIUM = 0.5;

const K = "leads.contacts";

const ROLES = ["hiring_manager", "hr_recruiter", "department_head", "procurement", "executive", "unknown"];
const SEARCH_STATES = ["running", "contacts_found", "no_domain", "no_contacts", "error"];
const NO_CONTACTS_REASONS = [
  "no_results", "no_deliverable_contacts", "company_name_unmatched", "not_a_company", "reused_contacts_unusable",
];
const ERROR_REASONS = ["invalid_api_key", "rate_limited", "no_credits", "timeout", "provider_error", "internal_error"];

export function canSearchLead(lead) {
  return SEARCHABLE_STATUSES.includes(lead?.status || "new");
}

export function roleKey(role) {
  return `${K}.role.${ROLES.includes(role) ? role : "unknown"}`;
}

// "verified" (valid), "risky" (accept_all, and defensively invalid /
// disposable, which the backend never delivers) or "unverified" (anything else).
export function verificationOf(status) {
  const value = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (value === "valid") return "verified";
  if (value === "accept_all" || value === "invalid" || value === "disposable") return "risky";
  return "unverified";
}

export function confidenceOf(score) {
  const value = typeof score === "number" && Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
  const level = value >= CONFIDENCE_HIGH ? "high" : value >= CONFIDENCE_MEDIUM ? "medium" : "low";
  return { level, percent: Math.round(value * 100) };
}

const reasonKey = (reason, allowed, fallback) => (allowed.includes(reason) ? `${K}.reason.${reason}` : fallback);

/** Message for a finished search (HTTP 200). */
export function describeSearchResult(data) {
  const state = data?.state;
  if (state === "contacts_found") {
    return {
      tone: "success",
      key: `${K}.result.contactsFound`,
      params: { n: data.contacts?.length ?? 0 },
      reused: Boolean(data.reused),
      credits: { used: data.credits_used ?? 0, remaining: data.credits_remaining ?? null },
    };
  }
  if (state === "no_domain") return { tone: "info", key: `${K}.result.noDomain` };
  if (state === "no_contacts") {
    return { tone: "info", key: reasonKey(data.reason, NO_CONTACTS_REASONS, `${K}.reason.no_results`) };
  }
  if (state === "error") {
    const key = reasonKey(data.reason, ERROR_REASONS, `${K}.reason.internal_error`);
    return {
      tone: "error",
      key,
      action: data.reason === "invalid_api_key" ? "settings" : "retry",
    };
  }
  return { tone: "error", key: `${K}.reason.internal_error`, action: "retry" };
}

/** Message for a refused or failed search request. */
export function describeSearchError(error) {
  const status = error?.response?.status;
  const detail = error?.response?.data?.detail;
  const code = detail && typeof detail === "object" ? detail.code : null;

  if (!error?.response) {
    // The browser gave up (or the network failed): the server may still finish.
    return { tone: "warning", key: `${K}.error.clientTimeout`, action: "refresh" };
  }
  if (status === 409) {
    if (code === "cooldown") {
      const next = toDate(detail.next_search_allowed_at);
      return {
        tone: "warning",
        key: next ? `${K}.error.cooldown` : `${K}.error.cooldownNoDate`,
        params: next ? { date: next } : {},
        action: "forceCooldown",
      };
    }
    if (code === "reuse_area_mismatch") return { tone: "warning", key: `${K}.error.reuseAreaMismatch`, action: "forceArea" };
    if (code === "search_superseded") return { tone: "info", key: `${K}.error.superseded`, action: "reload" };
    return { tone: "info", key: `${K}.error.inProgress`, action: "refresh" };
  }
  if (status === 422 && code === "hunter_not_configured") {
    return { tone: "warning", key: `${K}.error.notConfigured`, action: "settings" };
  }
  if (status === 422 && code === "lead_not_searchable") return { tone: "info", key: `${K}.error.notSearchable` };
  if (status === 403) return { tone: "error", key: `${K}.error.forbidden` };
  if (status === 404) return { tone: "error", key: `${K}.error.notFound` };
  if (status === 429) return { tone: "warning", key: `${K}.error.rateLimited` };
  return { tone: "error", key: `${K}.error.serverError`, action: "retry" };
}

/** The last search of a lead, read from lead.contacts_search (never lead.status). */
export function lastSearchOf(lead) {
  const search = lead?.contacts_search;
  if (!search || !SEARCH_STATES.includes(search.state)) return null;
  const when = toDate(search.searched_at) || toDate(search.started_at);
  let detailKey = null;
  if (search.state === "no_contacts") detailKey = reasonKey(search.reason, NO_CONTACTS_REASONS, null);
  if (search.state === "error") detailKey = reasonKey(search.reason, ERROR_REASONS, `${K}.reason.internal_error`);
  return {
    state: search.state,
    stateKey: `${K}.stateLabel.${search.state}`,
    detailKey,
    when,
    isError: search.state === "error",
    reused: Boolean(search.reused_from_lead_id),
  };
}

// Every translation key this module can produce (for the 3-language test).
export const ALL_MESSAGE_KEYS = [
  ...ROLES.map((role) => `${K}.role.${role}`),
  ...SEARCH_STATES.map((state) => `${K}.stateLabel.${state}`),
  ...NO_CONTACTS_REASONS.map((reason) => `${K}.reason.${reason}`),
  ...ERROR_REASONS.map((reason) => `${K}.reason.${reason}`),
  `${K}.result.contactsFound`, `${K}.result.noDomain`,
  ...["clientTimeout", "cooldown", "cooldownNoDate", "reuseAreaMismatch", "superseded", "inProgress",
    "notConfigured", "notSearchable", "forbidden", "notFound", "rateLimited", "serverError"].map((k) => `${K}.error.${k}`),
];
