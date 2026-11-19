/**
 * RF-VTA-16, envío real: timeouts y cuerpos de las llamadas nuevas. Captura
 * la config que queda después de los interceptores; nada sale a la red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import api, {
  MAILBOX_TIMEOUT_MS, READ_TIMEOUT_MS, SEND_TIMEOUT_MS, mailConnectionApi, outreachEmailsApi, pipelineApi,
} from "@/api/axios";

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
  it("el límite del envío es 90 s (varias llamadas a Graph de 20 s); el del buzón, 60 s", () => {
    expect(SEND_TIMEOUT_MS).toBe(90_000);
    expect(MAILBOX_TIMEOUT_MS).toBe(60_000);
  });

  it("ya no existe la prueba de conexión SMTP", () => {
    expect(pipelineApi.testSmtp).toBeUndefined();
  });

  it("las llamadas del buzón: rutas exactas, sin cuerpo y sin avisos genéricos de error", async () => {
    await mailConnectionApi.start();
    expect(captured.data).toBeUndefined();
    // Con proveedor: el cuerpo lleva solo el nombre (outlook = microsoft, gmail = google), nunca un dato del usuario.
    await mailConnectionApi.start("google");
    expect(JSON.parse(captured.data)).toEqual({ provider: "google" });
    expect(captured.url).toBe("/mail-connection/start");
    expect(captured.suppressServerErrorToast).toBe(true);
    expect(captured.suppressPermissionToast).toBe(true);
    await mailConnectionApi.delete();
    expect(captured.method).toBe("delete");
    expect(captured.url).toBe("/mail-connection");
  });

  it.each([
    ["POST .../send", () => outreachEmailsApi.send("e1", { confirmToEmail: "ana@example.com" }), "post", "/outreach-emails/e1/send", SEND_TIMEOUT_MS],
    ["GET /send-status", () => outreachEmailsApi.sendStatus(), "get", "/outreach-emails/send-status", READ_TIMEOUT_MS],
    ["GET /do-not-contact", () => outreachEmailsApi.listDoNotContact(), "get", "/outreach-emails/do-not-contact", READ_TIMEOUT_MS],
    ["POST /do-not-contact", () => outreachEmailsApi.addDoNotContact({ emailId: "e1" }), "post", "/outreach-emails/do-not-contact", READ_TIMEOUT_MS],
    ["DELETE /do-not-contact/:id", () => outreachEmailsApi.removeDoNotContact("d1"), "delete", "/outreach-emails/do-not-contact/d1", READ_TIMEOUT_MS],
    ["POST /mail-connection/start", () => mailConnectionApi.start(), "post", "/mail-connection/start", MAILBOX_TIMEOUT_MS],
    ["GET /mail-connection/status", () => mailConnectionApi.status(), "get", "/mail-connection/status", READ_TIMEOUT_MS],
    ["POST /mail-connection/test", () => mailConnectionApi.test(), "post", "/mail-connection/test", MAILBOX_TIMEOUT_MS],
    ["DELETE /mail-connection", () => mailConnectionApi.delete(), "delete", "/mail-connection", READ_TIMEOUT_MS],
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
