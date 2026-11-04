/**
 * No secret ever reaches the browser console (RF15 follow-up).
 *
 * Every endpoint that sends or returns a secret is marked logBody: false: its
 * request and response are logged without a body, on success and on error,
 * and the error handed to the caller no longer carries the session token,
 * the request body nor the XHR. Requests without secrets are logged as before.
 * No network: a fake adapter answers; synthetic values only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios, { AxiosError } from "axios";

import api, {
  authApi, authTokenStore, booksApi, crmApi, pipelineApi, settingsApi, socialApi,
} from "@/api/axios";
import { describeApiError, logApiError, redactSecrets } from "@/api/apiLogging";

const SECRET = "secret-value-0000";
const TOKEN = "session-token-0000";

let respond;
let captured;
let log;
let err;
let warn;
const originalAdapter = api.defaults.adapter;

// Every string reachable from what was printed — like expanding it in devtools.
function everything(value, seen = new Set()) {
  if (value === null || value === undefined) return "";
  if (typeof value === "function") return "";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "";
  seen.add(value);
  let out = "";
  for (const key of Reflect.ownKeys(value)) {
    try { out += ` ${String(key)} ${everything(value[key], seen)}`; } catch { /* getter that throws */ }
  }
  if (typeof value.toJSON === "function") {
    try { out += everything(value.toJSON(), seen); } catch { /* ignore */ }
  }
  return out;
}
const printed = () => [...log.mock.calls, ...err.mock.calls, ...warn.mock.calls].map((args) => everything(args)).join("\n");
const ok = (data) => (config) => ({ data, status: 200, statusText: "OK", headers: {}, config });
const fail = (status, data) => (config) => {
  throw new AxiosError("Request failed", "ERR_BAD_REQUEST", config, { responseText: JSON.stringify(data) }, {
    status, statusText: "Error", headers: {}, config, data, request: { responseText: JSON.stringify(data) },
  });
};
// FastAPI-style 422 that echoes the submitted secret, plus a secret-named field.
const echo = (field) => ({
  detail: [{ type: "string_too_short", loc: ["body", field], msg: "Mensaje sintético", input: SECRET }],
  echo: { api_key: SECRET, access_token: SECRET },
});

beforeEach(() => {
  captured = [];
  api.defaults.adapter = async (config) => {
    captured.push(config);
    return respond(config);
  };
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  err = vi.spyOn(console, "error").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // Guard: /auth/refresh uses bare axios; it must never go out.
  vi.spyOn(axios, "post").mockRejectedValue(new Error("no network in tests"));
  sessionStorage.clear();
  localStorage.clear();
  authTokenStore.setTokens({ accessToken: TOKEN, refreshToken: "refresh-sintetico", expiresIn: 3600 });
});
afterEach(() => {
  api.defaults.adapter = originalAdapter;
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

const SECRET_ENDPOINTS = [
  ["authApi.register", "/auth/register", "password",
    () => authApi.register({ email: "ana@example.com", password: SECRET }, { noSession: true }),
    { access_token: SECRET, refresh_token: SECRET }],
  ["authApi.login", "/auth/login", "password",
    () => authApi.login({ usernameOrEmail: "ana@example.com", password: SECRET }),
    { access_token: SECRET, refresh_token: SECRET, expires_in: 3600 }],
  ["authApi.logout", "/auth/logout", "refreshToken",
    () => {
      authTokenStore.setTokens({ accessToken: TOKEN, refreshToken: SECRET, expiresIn: 3600 });
      return authApi.logout();
    },
    { ok: true }],
  ["authApi.forgotPassword", "/auth/forgot-password", "email",
    () => authApi.forgotPassword({ email: "ana@example.com" }),
    { reset_hint: SECRET }],
  ["authApi.resetPassword", "/auth/reset-password", "password",
    () => authApi.resetPassword({ token: SECRET, password: SECRET }),
    { ok: true }],
  ["settingsApi.update", "/settings", "apiKey",
    () => settingsApi.update({ crm: { provider: "hubspot", apiKey: SECRET } }),
    { crm: { apiKey: SECRET } }],
  ["settingsApi.put", "/settings", "apiKey",
    () => settingsApi.put({ crm: { provider: "hubspot", apiKey: SECRET } }),
    { crm: { apiKey: SECRET } }],
  ["crmApi.testConnection", "/settings/crm/test-connection", "apiKey",
    () => crmApi.testConnection({ provider: "hubspot", apiKey: SECRET }),
    { ok: true, apiKeyLast4: "0000" }],
  ["crmApi.connect", "/settings/crm/salesforce/connect", "consumerSecret",
    () => crmApi.connect("salesforce", { consumerKey: SECRET, consumerSecret: SECRET, loginUrl: "https://login.example.com" }),
    { connected: true }],
  ["socialApi.connectManual", "/settings/social/linkedin/manual", "accessToken",
    () => socialApi.connectManual("linkedin", { email: "ana@example.com", handle: "ana", accessToken: SECRET }),
    { connected: true }],
  ["socialApi.connectFacebook", "/settings/social/facebook/connect", "state",
    () => socialApi.connectFacebook(),
    { authUrl: `https://www.facebook.example.com/dialog/oauth?state=${SECRET}` }],
  ["pipelineApi.createSource", "/pipeline/config/sources", "api_key",
    () => pipelineApi.createSource({ name: "JSearch", source_type: "jsearch", config: { api_key: SECRET } }),
    { sources: [{ id: "src-1", config: { api_key: SECRET } }] }],
  ["pipelineApi.updateSource", "/pipeline/config/sources/src-1", "api_key",
    () => pipelineApi.updateSource("src-1", { name: "JSearch", source_type: "jsearch", config: { api_key: SECRET } }),
    { sources: [{ id: "src-1", config: { api_key: SECRET } }] }],
  ["pipelineApi.updateConfig", "/pipeline/config", "hunter_api_key",
    () => pipelineApi.updateConfig({ smtp_password: SECRET, hunter_api_key: SECRET }),
    { smtp_password_configured: true, hunter_api_key_configured: true }],
];

// The interceptor's own lines for `url`: [label, body] pairs.
const linesFor = (spy, url) => spy.mock.calls.filter((args) => String(args[0]).includes(` ${url}`));

describe.each(SECRET_ENDPOINTS)("%s", (_name, url, field, call, successData) => {
  it("on success, logs method and URL but no body, and never the secret", async () => {
    respond = ok(successData);
    await call();
    const lines = linesFor(log, url);
    expect(lines.length).toBeGreaterThanOrEqual(2); // request + response
    for (const [, body] of lines) expect(body).toBe("");
    expect(printed()).not.toContain(SECRET);
    expect(printed()).not.toContain(TOKEN);
  });

  it("on error, the secret is neither logged nor printable from the error, and the message stays", async () => {
    respond = fail(422, echo(field));
    const caught = await call().then(() => null, (error) => error);
    expect(caught).toBeTruthy();
    // What a component does today with a failed call:
    console.error(caught);
    logApiError("Component", caught);

    expect(printed()).not.toContain(SECRET);
    expect(printed()).not.toContain(TOKEN);
    const [, body] = linesFor(err, url)[0];
    expect(body).toBe("ERR_BAD_REQUEST");
    // Callers still read the validation message.
    expect(caught.response.status).toBe(422);
    expect(caught.response.data.detail[0].msg).toBe("Mensaje sintético");
  });
});

describe("requests without secrets", () => {
  it("are still logged with their request and response bodies, as before", async () => {
    respond = ok({ id: "book-1", title: "Libro sintético" });
    await booksApi.create({ title: "Libro sintético", topic: "BPO" });
    const [request, response] = linesFor(log, "/books");
    expect(request[1]).toEqual({ title: "Libro sintético", topic: "BPO" });
    expect(response[1]).toEqual({ id: "book-1", title: "Libro sintético" });
  });

  it("a secret-named field slipped into any other body is still hidden", async () => {
    respond = ok({ id: "book-1", api_key: SECRET });
    await booksApi.create({ title: "Libro sintético", api_key: SECRET });
    expect(printed()).toContain("Libro sintético");
    expect(printed()).not.toContain(SECRET);
  });

  it("a failed call printed by a component shows neither the session token nor secret fields", async () => {
    respond = fail(500, { detail: "Error sintético", token: SECRET });
    const caught = await booksApi.get("book-1").then(() => null, (error) => error);
    console.error(caught);
    expect(printed()).not.toContain(TOKEN);
    expect(printed()).not.toContain(SECRET);
    expect(caught.response.data.detail).toBe("Error sintético");
    expect(caught.request).toBeUndefined();
  });
});

describe("helpers", () => {
  it("redactSecrets hides secret-named fields and echoed inputs of secret fields only", () => {
    const out = redactSecrets({
      title: "Libro", nested: { password: SECRET, list: [{ apiKey: SECRET, name: "ok" }] },
      detail: [
        { loc: ["body", "password"], msg: "corta", input: SECRET },
        { loc: ["body", "title"], msg: "vacío", input: "Libro" },
      ],
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.title).toBe("Libro");
    expect(out.nested.list[0].name).toBe("ok");
    expect(out.detail[0].msg).toBe("corta");
    expect(out.detail[1].input).toBe("Libro");
  });

  it("logApiError prints only method, URL and status", () => {
    const error = {
      config: { method: "post", url: "/pipeline/config/sources", data: JSON.stringify({ api_key: SECRET }), headers: { Authorization: `Bearer ${TOKEN}` } },
      response: { status: 400, data: { detail: SECRET } },
    };
    logApiError("PipelineSettings", error);
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]).toHaveLength(1);
    expect(err.mock.calls[0][0]).toMatch(/^❌ \[PipelineSettings\] POST \/pipeline\/config\/sources \(\) - Status: 400$/);
    expect(printed()).not.toContain(SECRET);
    expect(printed()).not.toContain(TOKEN);
    expect(describeApiError(new TypeError("x is undefined"))).toBe("TypeError: x is undefined");
  });
});
