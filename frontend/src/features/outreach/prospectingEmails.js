/**
 * Prospecting emails (RF-VTA-16, Agente 3): pure helpers shared by the lead's
 * contact panel and the «Alcance» page. No API calls here.
 */

// Language of the email's subject and body. Each name is written in its own
// language on purpose (not translated with the interface).
export const EMAIL_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
];
export const DEFAULT_EMAIL_LANGUAGE = "en";

export const languageLabel = (code) => EMAIL_LANGUAGES.find((item) => item.code === code)?.label || code || "";

export const ACTIVE_EMAIL_STATUSES = ["pending_review", "approved"];
export const isActive = (email) => ACTIVE_EMAIL_STATUSES.includes(email?.status);

// Error codes the backend returns in detail.code (routers/outreach_emails.py).
export const EMAIL_ERROR_CODES = [
  "invalid_language",
  "contact_rejected",
  "contact_without_email",
  "contact_not_found",
  "lead_not_found",
  "lead_not_composable",
  "compose_in_progress",
  "email_already_active",
  "generation_failed",
  "invalid_model_output",
  "contact_not_approved",
  "invalid_email_transition",
  "email_not_found",
  "forbidden",
  // Real send by SMTP (POST /outreach-emails/{id}/send) and its list.
  "real_send_disabled",
  "smtp_not_configured",
  "smtp_credentials_unreadable",
  "encryption_not_configured",
  "recipient_mismatch",
  "recipient_changed",
  "invalid_recipient",
  "do_not_contact",
  "smtp_host_blocked",
  "smtp_host_unresolvable",
  "send_in_progress",
  "send_uncertain",
  "send_state_changed",
  "daily_limit_reached",
  "smtp_auth_failed",
  "smtp_sender_refused",
  "smtp_recipient_refused",
  "smtp_message_refused",
  "smtp_unavailable",
  "smtp_timeout",
  "invalid_do_not_contact",
  "do_not_contact_not_found",
];
// Codes after which the email itself changed (send lock, last error): reload it.
export const SEND_RELOAD_CODES = [
  "smtp_timeout", "send_uncertain", "send_in_progress", "send_state_changed", "smtp_auth_failed",
  "smtp_sender_refused", "smtp_recipient_refused", "smtp_message_refused", "smtp_unavailable",
  "smtp_host_blocked", "smtp_host_unresolvable", "invalid_email_transition", "email_not_found",
];
// Client-side cases: the request timed out, was rate limited, or anything else.
export const EMAIL_ERROR_EXTRA = ["timeout", "rateLimited", "generic"];

const ERRORS_KEY = "outreachPage.prospecting.errors";

/**
 * { key, code, timedOut } for an API error: the translation key of its
 * message. A timeout gets its own message (the email may still appear).
 */
export function describeEmailError(error) {
  if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT") {
    return { key: `${ERRORS_KEY}.timeout`, code: "timeout", timedOut: true };
  }
  const status = error?.response?.status;
  const code = error?.response?.data?.detail?.code;
  // A code first: a 429 may be the daily SMTP quota, not the rate limiter.
  if (EMAIL_ERROR_CODES.includes(code)) return { key: `${ERRORS_KEY}.${code}`, code, timedOut: false };
  if (status === 429) return { key: `${ERRORS_KEY}.rateLimited`, code: "rateLimited", timedOut: false };
  if (status === 403) return { key: `${ERRORS_KEY}.forbidden`, code: "forbidden", timedOut: false };
  return { key: `${ERRORS_KEY}.generic`, code: "generic", timedOut: false };
}

/** Subject, a blank line and the body: what «Copiar» puts on the clipboard. */
export const copyText = (email) => `${email?.subject || ""}\n\n${email?.body || ""}`;

/**
 * Copy `text` with the Clipboard API. Resolves true when it was copied and
 * false when the API is missing or refuses (never throws).
 */
export async function copyToClipboard(text) {
  try {
    if (!navigator?.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ── Real send by SMTP (RF-VTA-16) ────────────────────────────────────────────
export const normalizeAddress = (value) => String(value || "").trim().toLowerCase();

/** The do-not-contact entry blocking the email's recipient (address or domain), or null. */
export function blockingEntry(email, entries = []) {
  const address = normalizeAddress(email?.to_email);
  if (!address) return null;
  const domain = address.includes("@") ? address.split("@").pop() : "";
  return entries.find((entry) => (
    (entry?.kind === "email" && normalizeAddress(entry.value) === address)
    || (entry?.kind === "domain" && domain && normalizeAddress(entry.value) === domain)
  )) || null;
}
export const isBlockedRecipient = (email, entries) => Boolean(blockingEntry(email, entries));

/** True when the last SMTP send may have gone out (timeout during DATA). */
export const isUncertain = (email) => Boolean(email?.send_lock?.uncertain);

// Why «Enviar» is disabled, in this order (the first that applies wins).
export const SEND_BLOCK_REASONS = [
  "loading", "smtp_not_configured", "server_disabled", "user_disabled",
  "contact_not_reviewed", "do_not_contact", "daily_limit",
];

/**
 * Why the approved `email` cannot be sent now, or null. `status` is GET
 * /outreach-emails/send-status (null while loading or if it failed). An
 * uncertain send is not a block: «Enviar» becomes «Reintentar envío».
 */
export function sendBlockReason(status, email, blocked = false) {
  if (!status) return "loading";
  if (!status.smtp_configured) return "smtp_not_configured";
  if (!status.server_send_enabled) return "server_disabled";
  if (!status.user_send_enabled) return "user_disabled";
  if (["pending", "rejected"].includes(email?.contact_review_status)) return "contact_not_reviewed";
  if (blocked) return "do_not_contact";
  if (Number(status.sent_today) >= Number(status.daily_limit)) return "daily_limit";
  return null;
}
