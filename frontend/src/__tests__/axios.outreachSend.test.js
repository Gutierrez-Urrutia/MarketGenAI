/**
 * RF-VTA-16, envío real: timeouts y cuerpos de las llamadas nuevas. Captura
 * la config que queda después de los interceptores; nada sale a la red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import api, { outreachEmailsApi, pipelineApi, READ_TIMEOUT_MS, SEND_TIMEOUT_MS } from "@/api/axios";

let captured;
const originalAdapter = api.defaults.adapter;
beforeEach(() => {
  captured = null;
  api.defaults.adapter = async (config) => {
    captured = config;
    return { data: {}, status: 200, statusText: "OK", headers: {}, config };
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  api.defaults.adapter = originalAdapter;
  vi.restoreAllMocks();
});

describe("envío real de correos (API)", () => {
  it("el límite del envío es 45 s, sobre los 20 s del backend", () => {
    expect(SEND_TIMEOUT_MS).toBe(45_000);
  });

  it.each([
    ["POST .../send", () => outreachEmailsApi.send("e1", { confirmToEmail: "ana@example.com" }), "post", "/outreach-emails/e1/send", SEND_TIMEOUT_MS],
    ["GET /send-status", () => outreachEmailsApi.sendStatus(), "get", "/outreach-emails/send-status", READ_TIMEOUT_MS],
    ["GET /do-not-contact", () => outreachEmailsApi.listDoNotContact(), "get", "/outreach-emails/do-not-contact", READ_TIMEOUT_MS],
    ["POST /do-not-contact", () => outreachEmailsApi.addDoNotContact({ emailId: "e1" }), "post", "/outreach-emails/do-not-contact", READ_TIMEOUT_MS],
    ["DELETE /do-not-contact/:id", () => outreachEmailsApi.removeDoNotContact("d1"), "delete", "/outreach-emails/do-not-contact/d1", READ_TIMEOUT_MS],
    ["POST /pipeline/config/smtp/test", () => pipelineApi.testSmtp(), "post", "/pipeline/config/smtp/test", SEND_TIMEOUT_MS],
  ])("%s conserva su timeout (no 0) y no registra el cuerpo", async (_name, call, method, url, timeout) => {
    await call();
    expect(captured.method).toBe(method);
    expect(captured.url).toBe(url);
    expect(captured.timeout).toBe(timeout);
    expect(captured.timeout).not.toBe(0);
    expect(captured.logBody).toBe(false);
  });

  it("force_retry va solo cuando se pide", async () => {
    await outreachEmailsApi.send("e1", { confirmToEmail: "ana@example.com" });
    expect(JSON.parse(captured.data)).toEqual({ confirm_to_email: "ana@example.com" });
    await outreachEmailsApi.send("e1", { confirmToEmail: "ana@example.com", forceRetry: true });
    expect(JSON.parse(captured.data)).toEqual({ confirm_to_email: "ana@example.com", force_retry: true });
  });

  it("«no contactar» manda solo el id del correo, nunca la dirección", async () => {
    await outreachEmailsApi.addDoNotContact({ emailId: "e1" });
    expect(JSON.parse(captured.data)).toEqual({ email_id: "e1" });
  });
});
