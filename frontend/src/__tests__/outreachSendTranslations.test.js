/**
 * RF-VTA-16, envío real — textos en en, es y pt:
 * - cada código de EMAIL_ERROR_CODES y cada motivo de SEND_BLOCK_REASONS
 *   tiene su texto en los tres idiomas (se arman con `${code}` en
 *   ProspectingEmailDetail.jsx / prospectingEmails.js, así que el test de
 *   outreachTranslations no los ve);
 * - toda clave `${KP}.…` literal de ProspectingEmailDetail.jsx existe;
 * - las claves nuevas de settings.pipelineTab existen y no están rotas;
 * - los marcadores ({to}, {reason}…) son los mismos en los tres idiomas;
 * - ningún texto de la interfaz dice «SMTP» (el envío es por Microsoft 365).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { translations } from "@/i18n/translations";
import { EMAIL_ERROR_CODES, SEND_BLOCK_REASONS } from "@/features/outreach/prospectingEmails";
import { MAILBOX_ERROR_CODES } from "@/pages/settings/PipelineSettingsTab";

const LANGS = ["en", "es", "pt"];
const KP = "outreachPage.prospecting";
const lookup = (lang, dotted) => dotted.split(".").reduce((node, part) => node?.[part], translations[lang]);
const detailSource = readFileSync(path.resolve(__dirname, "../features/outreach/ProspectingEmailDetail.jsx"), "utf8");
const settingsSource = readFileSync(path.resolve(__dirname, "../pages/settings/PipelineSettingsTab.jsx"), "utf8");

const SEND_KEYS = [
  ...EMAIL_ERROR_CODES.map((code) => `${KP}.errors.${code}`),
  ...SEND_BLOCK_REASONS.map((reason) => `${KP}.send.blocked.${reason}`),
  ...["send", "retrySend", "sending", "doNotContact"].map((key) => `${KP}.actions.${key}`),
  ...["confirmTitle", "toLabel", "fromLabel", "subjectLabel", "confirmWarning", "confirmButton", "retryTitle", "retryWarning", "retryButton",
    "cancel", "uncertain", "lastError", "openSettings", "reconnectInSettings", "sentBySystem", "markedSent"].map((key) => `${KP}.send.${key}`),
  ...["confirmTitle", "confirmMessage", "confirmButton"].map((key) => `${KP}.doNotContact.${key}`),
  `${KP}.detail.unsubscribeLabel`, `${KP}.detail.onDoNotContactList`,
  `${KP}.messages.sentBySystem`, `${KP}.messages.doNotContactAdded`,
  `${KP}.history.actions.send`, `${KP}.history.sendError`,
];
const SETTINGS_KEYS = [
  "mailboxTitle", "mailboxDesc", "mailboxStatusLoading", "mailboxStatusUnknown", "mailboxNotConnected",
  "mailboxNeedsReconnect", "mailboxConnected", "mailboxLoadError", "mailboxOauthNotConfigured", "mailboxAccountLabel",
  "mailboxReconnectNote", "mailboxConsent", "mailboxConnectButton", "mailboxReconnectButton", "mailboxTestButton",
  "mailboxTesting", "mailboxTestOk", "mailboxDisconnectButton", "mailboxDisconnectTitle", "mailboxDisconnectMessage",
  "mailboxDisconnected", "mailboxDisconnectError", "mailboxConnectedNotice", "mailboxConnectFailed",
  "realSendLabel", "realSendHint", "realSendServerOff", "realSendSaved", "realSendSaveError",
  "dailyLimitLabel", "dailyLimitHint", "dailyLimitInvalid", "dailyLimitSaveButton", "dailyLimitSaved", "dailyLimitSaveError",
  ...MAILBOX_ERROR_CODES.map((code) => `mailboxErrors.${code}`),
].map((key) => `settings.pipelineTab.${key}`);

// Every string of one language, with its dotted path.
const allTexts = (node, prefix = "") => Object.entries(node || {}).flatMap(([key, value]) => {
  const at = prefix ? `${prefix}.${key}` : key;
  if (typeof value === "string") return [[at, value]];
  return value && typeof value === "object" ? allTexts(value, at) : [];
});

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

  // Detalle en solo lectura (Historial): textos neutros respecto del transporte.
  const READ_ONLY_KEYS = ["title", "openAria", "sentBySystem", "markedSent", "rejected", "from"].map((key) => `${KP}.readOnly.${key}`);

  it.each(LANGS)("los textos del detalle en solo lectura existen en %s, sin vacíos ni «SMTP»", (lang) => {
    for (const key of READ_ONLY_KEYS) {
      const value = lookup(lang, key);
      expect(typeof value, `${lang}.${key}`).toBe("string");
      expect(value.trim(), `${lang}.${key}`).not.toBe("");
      expect(value, `${lang}.${key}`).not.toMatch(/smtp/i);
      expect(value, `${lang}.${key}`).not.toMatch(/\p{L}\?+\p{L}/u);
      expect(value, `${lang}.${key}`).not.toContain("�");
    }
  });

  it("los marcadores del detalle en solo lectura coinciden en los tres idiomas", () => {
    for (const key of READ_ONLY_KEYS) {
      const en = placeholders(lookup("en", key));
      expect(placeholders(lookup("es", key)), `es.${key}`).toEqual(en);
      expect(placeholders(lookup("pt", key)), `pt.${key}`).toEqual(en);
    }
    for (const key of ["sentBySystem", "markedSent", "rejected"]) {
      expect(placeholders(lookup("en", `${KP}.readOnly.${key}`))).toEqual(["date", "name"]);
    }
  });

  it("el estado «sent» dice «Enviado» (también cubre el envío desde la plataforma), no «Marcado»", () => {
    for (const lang of LANGS) {
      expect(lookup(lang, `${KP}.status.sent`)).not.toMatch(/marcad|marked/i);
    }
  });

  it.each(LANGS)("ningún texto de la interfaz en %s contiene «SMTP»", (lang) => {
    const texts = allTexts(translations[lang]);
    expect(texts.length).toBeGreaterThan(100);
    const withSmtp = texts.filter(([, value]) => /smtp/i.test(value)).map(([at]) => at);
    expect(withSmtp).toEqual([]);
  });

  it("ni las claves de texto ni el código de la pestaña ni del detalle mencionan SMTP", () => {
    for (const lang of LANGS) {
      expect(allTexts(translations[lang]).map(([at]) => at).filter((at) => /smtp/i.test(at))).toEqual([]);
    }
    expect(settingsSource).not.toMatch(/smtp/i);
    expect(detailSource).not.toMatch(/smtp/i);
  });

  it("los textos retirados ya no existen", () => {
    for (const lang of LANGS) {
      expect(lookup(lang, `${KP}.send.sentBySmtp`)).toBeUndefined();
      expect(lookup(lang, `${KP}.send.fields`)).toBeUndefined();
      expect(lookup(lang, `${KP}.messages.smtpSent`)).toBeUndefined();
      expect(lookup(lang, "settings.pipelineTab.testConnectionErrors")).toBeUndefined();
      // «Marcar como enviado» conserva su propio texto.
      expect(typeof lookup(lang, `${KP}.messages.sent`)).toBe("string");
    }
  });
});
