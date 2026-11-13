/**
 * RF-VTA-16, envío real — textos en en, es y pt:
 * - cada código de EMAIL_ERROR_CODES y cada motivo de SEND_BLOCK_REASONS
 *   tiene su texto en los tres idiomas (se arman con `${code}` en
 *   ProspectingEmailDetail.jsx / prospectingEmails.js, así que el test de
 *   outreachTranslations no los ve);
 * - toda clave `${KP}.…` literal de ProspectingEmailDetail.jsx existe;
 * - las claves nuevas de settings.pipelineTab existen y no están rotas;
 * - los marcadores ({to}, {fields}…) son los mismos en los tres idiomas.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { translations } from "@/i18n/translations";
import { EMAIL_ERROR_CODES, SEND_BLOCK_REASONS } from "@/features/outreach/prospectingEmails";

const LANGS = ["en", "es", "pt"];
const KP = "outreachPage.prospecting";
const lookup = (lang, dotted) => dotted.split(".").reduce((node, part) => node?.[part], translations[lang]);
const detailSource = readFileSync(path.resolve(__dirname, "../features/outreach/ProspectingEmailDetail.jsx"), "utf8");
const settingsSource = readFileSync(path.resolve(__dirname, "../pages/settings/PipelineSettingsTab.jsx"), "utf8");

const SMTP_FIELDS = ["smtp_host", "smtp_port", "smtp_user", "smtp_password", "sender_email"];
const SEND_KEYS = [
  ...EMAIL_ERROR_CODES.map((code) => `${KP}.errors.${code}`),
  ...SEND_BLOCK_REASONS.map((reason) => `${KP}.send.blocked.${reason}`),
  ...SMTP_FIELDS.map((field) => `${KP}.send.fields.${field}`),
  ...["send", "retrySend", "sending", "doNotContact"].map((key) => `${KP}.actions.${key}`),
  ...["confirmTitle", "confirmMessage", "confirmWarning", "confirmButton", "retryTitle", "retryWarning", "retryButton",
    "cancel", "uncertain", "lastError", "openSettings", "sentBySmtp", "markedSent"].map((key) => `${KP}.send.${key}`),
  ...["confirmTitle", "confirmMessage", "confirmButton"].map((key) => `${KP}.doNotContact.${key}`),
  `${KP}.detail.unsubscribeLabel`, `${KP}.detail.onDoNotContactList`,
  `${KP}.messages.smtpSent`, `${KP}.messages.doNotContactAdded`,
  `${KP}.history.actions.send`, `${KP}.history.sendError`,
];
const SETTINGS_KEYS = [
  "smtpConfigured", "smtpIncomplete", "smtpMissing", "realSendLabel", "realSendHint", "realSendServerOff",
  "realSendSaved", "realSendSaveError", "dailyLimitLabel", "dailyLimitHint", "dailyLimitInvalid",
  "testConnectionButton", "testingConnection", "testConnectionOk",
  ...SMTP_FIELDS.map((field) => `smtpFields.${field}`),
  ...["smtp_not_configured", "smtp_auth_failed", "smtp_unavailable", "smtp_host_blocked", "smtp_host_unresolvable",
    "smtp_credentials_unreadable", "encryption_not_configured", "generic"].map((code) => `testConnectionErrors.${code}`),
].map((key) => `settings.pipelineTab.${key}`);

const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("textos del envío real", () => {
  it.each(LANGS)("todas las claves existen en %s, sin vacíos ni caracteres rotos", (lang) => {
    for (const key of [...SEND_KEYS, ...SETTINGS_KEYS]) {
      const value = lookup(lang, key);
      expect(typeof value, `${lang}.${key}`).toBe("string");
      expect(value.trim(), `${lang}.${key}`).not.toBe("");
      expect(value, `${lang}.${key}`).not.toMatch(/\p{L}\?+\p{L}/u);
      expect(value, `${lang}.${key}`).not.toContain("�");
    }
  });

  it("los marcadores coinciden en los tres idiomas", () => {
    for (const key of [...SEND_KEYS, ...SETTINGS_KEYS]) {
      const en = placeholders(lookup("en", key));
      expect(placeholders(lookup("es", key)), `es.${key}`).toEqual(en);
      expect(placeholders(lookup("pt", key)), `pt.${key}`).toEqual(en);
    }
  });

  it("cada clave literal del detalle del correo existe en los tres idiomas", () => {
    const used = [...detailSource.matchAll(/t\(`\$\{KP\}\.([A-Za-z0-9_.]+)`\)/g)].map((m) => `${KP}.${m[1]}`);
    expect(used.length).toBeGreaterThan(10);
    for (const key of used) {
      for (const lang of LANGS) expect(typeof lookup(lang, key), `${lang}.${key}`).toBe("string");
    }
  });

  it("cada clave literal de Configuración › Pipeline existe en los tres idiomas", () => {
    const used = [...settingsSource.matchAll(/["'`](settings\.pipelineTab\.[A-Za-z0-9_.]+)["'`]/g)].map((m) => m[1]);
    for (const key of used) {
      for (const lang of LANGS) expect(typeof lookup(lang, key), `${lang}.${key}`).toBe("string");
    }
  });

  it("el estado «sent» dice «Enviado» (también cubre el envío por SMTP), no «Marcado»", () => {
    for (const lang of LANGS) {
      expect(lookup(lang, `${KP}.status.sent`)).not.toMatch(/marcad|marked/i);
    }
  });
});
