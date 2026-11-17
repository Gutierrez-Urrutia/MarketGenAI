/**
 * Mailbox connection (RF-VTA-16): the result the backend's OAuth callback
 * sends the browser back with — /?mail_connection=connected or
 * /?mail_connection_error=<code> (routers/mail_connection.py, always a 303).
 *
 * App.jsx sends "/" on to "/dashboard" and drops the query before the
 * dashboard mounts, so the result is captured first
 * (captureMailConnectionRedirect), kept in sessionStorage — only the code,
 * nothing else — and read once by the Settings › Pipeline mailbox card
 * (takeMailConnectionResult), which removes it. Without sessionStorage
 * (blocked, full, private mode) the app works the same, without the notice.
 */
export const MAIL_CONNECTION_RESULT_KEY = "marketgen_mail_connection_result";
export const MAIL_CONNECTION_CONNECTED = "connected";
// A result that is neither "connected" nor a well-formed code.
export const MAIL_CONNECTION_UNKNOWN = "generic";

const PARAMS = ["mail_connection", "mail_connection_error"];
const CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

function storage() {
  try {
    return window.sessionStorage || null;
  } catch {
    return null;
  }
}

/**
 * Go to Microsoft's consent page (the authorize_url of POST
 * /mail-connection/start), in this tab. False, without navigating, when the
 * URL is not http(s).
 */
export function openAuthorizeUrl(url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
  window.location.assign(url);
  return true;
}

/** The code a redirect query stands for, or null when it has none. */
export function resultFromQuery(search) {
  const params = new URLSearchParams(search || "");
  if (!PARAMS.some((name) => params.has(name))) return null;
  const error = params.get("mail_connection_error");
  if (error !== null) return CODE_PATTERN.test(error) ? error : MAIL_CONNECTION_UNKNOWN;
  return params.get("mail_connection") === MAIL_CONNECTION_CONNECTED ? MAIL_CONNECTION_CONNECTED : MAIL_CONNECTION_UNKNOWN;
}

/**
 * Keep the redirect's result (if the URL has one) and take its parameters
 * out of the URL. Returns true when there was one. Never throws.
 */
export function captureMailConnectionRedirect() {
  let result;
  try {
    result = resultFromQuery(window.location.search);
  } catch {
    return false;
  }
  if (!result) return false;
  try {
    storage()?.setItem(MAIL_CONNECTION_RESULT_KEY, result);
  } catch {
    // No sessionStorage: no notice, everything else works.
  }
  try {
    const params = new URLSearchParams(window.location.search);
    PARAMS.forEach((name) => params.delete(name));
    const remaining = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${remaining ? `?${remaining}` : ""}`);
  } catch {
    // The URL keeps its parameters; the result was already captured.
  }
  return true;
}

/** The pending result, without removing it (null when there is none). */
export function peekMailConnectionResult() {
  try {
    const value = storage()?.getItem(MAIL_CONNECTION_RESULT_KEY) ?? null;
    return value !== null && CODE_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** The pending result, removed so that it is shown only once. */
export function takeMailConnectionResult() {
  const value = peekMailConnectionResult();
  try {
    storage()?.removeItem(MAIL_CONNECTION_RESULT_KEY);
  } catch {
    // Nothing to clean up.
  }
  return value;
}
