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
  if (status === 429) return { key: `${ERRORS_KEY}.rateLimited`, code: "rateLimited", timedOut: false };
  const code = error?.response?.data?.detail?.code;
  if (EMAIL_ERROR_CODES.includes(code)) return { key: `${ERRORS_KEY}.${code}`, code, timedOut: false };
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
