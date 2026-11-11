/**
 * Textos de la pestaña «Alcance» (outreachPage.*) en en, es y pt.
 *
 * - Los tres idiomas tienen exactamente el mismo árbol de claves.
 * - Ningún valor trae un «?» entre letras (caracteres acentuados perdidos al
 *   guardar con otra codificación) ni el carácter de reemplazo U+FFFD.
 * - Toda clave t("outreachPage.…") usada en OutreachPage.jsx existe en los
 *   tres idiomas, también las de los tipos de respuesta que se arman con
 *   `outreachPage.responseTypes.${type}`.
 * - translations.js y OutreachPage.jsx son UTF-8 válido y sin BOM.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { translations } from "@/i18n/translations";

const LANGS = ["en", "es", "pt"];
const SECTION = "outreachPage";
const RESPONSE_TYPES = ["email", "proposal", "whitepaper", "followup"];

const readBytes = (relative) => readFileSync(path.resolve(__dirname, relative));
const pageSource = readBytes("../views/OutreachPage.jsx").toString("utf8");

const flatten = (node, prefix = "") => Object.entries(node).flatMap(([key, value]) => (
  value && typeof value === "object"
    ? flatten(value, `${prefix}${key}.`)
    : [[`${prefix}${key}`, value]]
));

const sectionOf = (lang) => translations[lang][SECTION];
const keysOf = (lang) => flatten(sectionOf(lang)).map(([key]) => key).sort();
const lookup = (lang, dotted) => dotted.split(".").reduce((node, part) => node?.[part], translations[lang]);

const usedKeys = () => {
  const found = new Set();
  for (const match of pageSource.matchAll(/\bt\(\s*["'`](outreachPage\.[A-Za-z0-9_.]+)["'`]/g)) {
    found.add(match[1]);
  }
  for (const type of RESPONSE_TYPES) found.add(`${SECTION}.responseTypes.${type}`);
  return [...found].sort();
};

describe("textos de Alcance (outreachPage)", () => {
  it("los tres idiomas tienen el mismo árbol de claves", () => {
    const en = keysOf("en");
    expect(en.length).toBeGreaterThan(0);
    expect(keysOf("es")).toEqual(en);
    expect(keysOf("pt")).toEqual(en);
  });

  it.each(LANGS)("ningún valor en %s está vacío, roto con «?» ni trae U+FFFD", (lang) => {
    for (const [key, value] of flatten(sectionOf(lang))) {
      expect(typeof value, `${lang}.${key}`).toBe("string");
      expect(value.trim(), `${lang}.${key}`).not.toBe("");
      expect(value, `${lang}.${key}`).not.toMatch(/\p{L}\?+\p{L}/u);
      expect(value, `${lang}.${key}`).not.toContain("�");
    }
  });

  it("pt conserva las tildes reparadas", () => {
    const pt = sectionOf("pt");
    expect(pt.subtitle).toBe("Revise e-mails pendentes e acompanhe comunicações enviadas");
    expect(pt.reviewQueue).toBe("Fila de revisão");
    expect(pt.sentHistory).toBe("Histórico enviado");
    expect(pt.confidenceShort).toBe("Confiança");
    expect(pt.columns.contentUsed).toBe("Conteúdo usado");
  });

  it("toda clave usada en OutreachPage.jsx existe en en, es y pt", () => {
    const used = usedKeys();
    expect(used.length).toBeGreaterThan(30);
    for (const lang of LANGS) {
      for (const key of used) {
        expect(typeof lookup(lang, key), `${lang}: ${key}`).toBe("string");
      }
    }
  });

  it("el estado rechazado se muestra como estado, no como el verbo del botón", () => {
    expect(pageSource).toContain('rejected: t("outreachPage.history.statusRejected")');
    expect(sectionOf("es").history.statusRejected).toBe("Rechazado");
    expect(sectionOf("es").reject).toBe("Rechazar");
  });

  it("la interpolación de {count} está presente en los tres idiomas", () => {
    for (const lang of LANGS) expect(sectionOf(lang).campaign.generatingMessages).toContain("{count}");
  });

  it.each(["../i18n/translations.js", "../views/OutreachPage.jsx"])("%s es UTF-8 válido sin BOM", (file) => {
    const bytes = readBytes(file);
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).not.toThrow();
  });
});
