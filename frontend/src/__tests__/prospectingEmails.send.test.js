/**
 * RF-VTA-16, envío real — helpers puros: motivo para desactivar «Enviar»,
 * lista «no contactar», envío incierto y códigos de error nuevos.
 */
import { describe, it, expect } from "vitest";

import {
  EMAIL_ERROR_CODES, SEND_BLOCK_REASONS, blockingEntry, describeEmailError, isBlockedRecipient,
  isUncertain, sendBlockReason,
} from "@/features/outreach/prospectingEmails";

const READY = {
  smtp_configured: true, smtp_missing_fields: [], server_send_enabled: true, user_send_enabled: true,
  real_send_enabled: true, daily_limit: 50, sent_today: 0,
};
const EMAIL = { id: "e1", status: "approved", to_email: "Ana@Example.com", contact_review_status: "not_required" };
const apiError = (status, code) => ({ response: { status, data: { detail: { code } } } });

describe("sendBlockReason", () => {
  it("es null con todo en orden", () => {
    expect(sendBlockReason(READY, EMAIL, false)).toBeNull();
  });

  it.each([
    ["loading", null, EMAIL, false],
    ["smtp_not_configured", { ...READY, smtp_configured: false }, EMAIL, false],
    ["server_disabled", { ...READY, server_send_enabled: false }, EMAIL, false],
    ["user_disabled", { ...READY, user_send_enabled: false }, EMAIL, false],
    ["contact_not_reviewed", READY, { ...EMAIL, contact_review_status: "pending" }, false],
    ["contact_not_reviewed", READY, { ...EMAIL, contact_review_status: "rejected" }, false],
    ["do_not_contact", READY, EMAIL, true],
    ["daily_limit", { ...READY, sent_today: 50 }, EMAIL, false],
  ])("%s", (reason, status, email, blocked) => {
    expect(sendBlockReason(status, email, blocked)).toBe(reason);
  });

  it("respeta la prioridad: cuenta incompleta antes que interruptores, lista y cupo", () => {
    const everything = { ...READY, smtp_configured: false, server_send_enabled: false, user_send_enabled: false, sent_today: 99 };
    expect(sendBlockReason(everything, { ...EMAIL, contact_review_status: "pending" }, true)).toBe("smtp_not_configured");
    expect(sendBlockReason({ ...everything, smtp_configured: true }, EMAIL, true)).toBe("server_disabled");
    expect(SEND_BLOCK_REASONS[0]).toBe("loading");
  });

  it("un envío incierto no bloquea (se ofrece reintentar)", () => {
    const uncertain = { ...EMAIL, send_lock: { id: "l", uncertain: true } };
    expect(sendBlockReason(READY, uncertain, false)).toBeNull();
    expect(isUncertain(uncertain)).toBe(true);
    expect(isUncertain({ ...EMAIL, send_lock: { id: "l", uncertain: false } })).toBe(false);
    expect(isUncertain(EMAIL)).toBe(false);
  });
});

describe("lista «no contactar»", () => {
  it("bloquea por dirección sin distinguir mayúsculas", () => {
    const entries = [{ id: "d1", kind: "email", value: "ana@example.com" }];
    expect(isBlockedRecipient(EMAIL, entries)).toBe(true);
    expect(blockingEntry(EMAIL, entries).id).toBe("d1");
  });

  it("bloquea por dominio", () => {
    expect(isBlockedRecipient(EMAIL, [{ id: "d2", kind: "domain", value: "EXAMPLE.com" }])).toBe(true);
  });

  it("no bloquea otras direcciones ni dominios parecidos", () => {
    const entries = [
      { kind: "email", value: "otra@example.com" },
      { kind: "domain", value: "mail.example.com" },
      { kind: "domain", value: "ana@example.com" },
    ];
    expect(isBlockedRecipient(EMAIL, entries)).toBe(false);
    expect(isBlockedRecipient({ to_email: "" }, [{ kind: "email", value: "" }])).toBe(false);
  });
});

describe("códigos del envío", () => {
  it.each([
    "real_send_disabled", "smtp_not_configured", "recipient_mismatch", "do_not_contact", "send_in_progress",
    "send_uncertain", "smtp_auth_failed", "smtp_timeout", "smtp_host_blocked", "invalid_recipient",
  ])("%s tiene su propio mensaje", (code) => {
    expect(EMAIL_ERROR_CODES).toContain(code);
    expect(describeEmailError(apiError(422, code))).toEqual({
      key: `outreachPage.prospecting.errors.${code}`, code, timedOut: false,
    });
  });

  it("un 429 del cupo diario no se confunde con el límite de peticiones", () => {
    expect(describeEmailError(apiError(429, "daily_limit_reached")).code).toBe("daily_limit_reached");
    expect(describeEmailError({ response: { status: 429, data: {} } }).code).toBe("rateLimited");
  });
});

import { decidedByName } from "@/features/outreach/prospectingEmails";

describe("decidedByName", () => {
  it.each([
    ["SMTP", { status: "sent", send_method: "smtp", sent_by: "u1", sent_by_name: "Ana", sent_marked_by_name: "Otro" }, "Ana"],
    ["manual", { status: "sent", send_method: "manual", sent_marked_by: "u2", sent_marked_by_name: "Beto", sent_by_name: "Otro" }, "Beto"],
    ["sin send_method", { status: "sent", sent_marked_by: "u2", sent_marked_by_name: "Beto" }, "Beto"],
    ["rechazado", { status: "rejected", rejected_by: "u3", rejected_by_name: "Caro" }, "Caro"],
    ["SMTP sin nombre", { status: "sent", send_method: "smtp", sent_by: "u1" }, null],
    ["nombre = id", { status: "sent", send_method: "smtp", sent_by: "local-dev-admin", sent_by_name: "local-dev-admin" }, null],
    ["solo espacios", { status: "rejected", rejected_by: "u3", rejected_by_name: "  " }, null],
    ["correo activo", { status: "approved", approved_by_name: "Ana" }, null],
  ])("%s", (_name, email, expected) => {
    expect(decidedByName(email)).toBe(expected);
  });
});
