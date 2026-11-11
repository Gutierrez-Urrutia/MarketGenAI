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

// ── RF-VTA-16: prospecting emails (outreachPage.prospecting, leads.contacts.compose)
import { EMAIL_ERROR_CODES, EMAIL_ERROR_EXTRA } from "@/features/outreach/prospectingEmails";

const SOURCES = {
  OutreachPage: "../views/OutreachPage.jsx",
  ProspectingEmailDetail: "../features/outreach/ProspectingEmailDetail.jsx",
  LeadContactsPanel: "../pages/pipeline/LeadContactsPanel.jsx",
};

// Keys used in a file: literal t("a.b") and template t(`${K}.a.b`), with the
// file's own `const NAME = "prefix"` constants substituted. A template that
// still has a ${…} part is dynamic: it is returned separately as a prefix.
function keysUsedIn(source) {
  const constants = Object.fromEntries(
    [...source.matchAll(/^const ([A-Z]{1,3}) = "([a-zA-Z.]+)";$/gm)].map((m) => [m[1], m[2]]),
  );
  const fixed = new Set();
  const dynamic = new Set();
  for (const match of source.matchAll(/\bt\(\s*(["'`])((?:(?!\1).)+)\1/g)) {
    const expanded = match[2].replace(/\$\{([A-Z]{1,3})\}/g, (whole, name) => constants[name] ?? whole);
    if (!/^[a-zA-Z]+\./.test(expanded)) continue;
    if (expanded.includes("${")) dynamic.add(expanded.slice(0, expanded.indexOf("${")));
    else fixed.add(expanded);
  }
  return { fixed: [...fixed], dynamic: [...dynamic] };
}

const composeOf = (lang) => translations[lang].leads.contacts.compose;
const prospectingOf = (lang) => translations[lang].outreachPage.prospecting;

describe("textos de los correos de prospección (RF-VTA-16)", () => {
  it("leads.contacts.compose y outreachPage.prospecting tienen el mismo árbol en en, es y pt", () => {
    for (const of of [composeOf, prospectingOf]) {
      const en = flatten(of("en")).map(([key]) => key).sort();
      expect(en.length).toBeGreaterThan(5);
      expect(flatten(of("es")).map(([key]) => key).sort()).toEqual(en);
      expect(flatten(of("pt")).map(([key]) => key).sort()).toEqual(en);
    }
  });

  it.each(LANGS)("ningún texto nuevo en %s está vacío, roto con «?» ni trae U+FFFD", (lang) => {
    for (const [key, value] of [...flatten(composeOf(lang)), ...flatten(prospectingOf(lang))]) {
      expect(typeof value, `${lang}.${key}`).toBe("string");
      expect(value.trim(), `${lang}.${key}`).not.toBe("");
      expect(value, `${lang}.${key}`).not.toMatch(/\p{L}\?+\p{L}/u);
      expect(value, `${lang}.${key}`).not.toContain("�");
    }
  });

  it.each(Object.entries(SOURCES))("toda clave fija usada en %s existe en en, es y pt", (_name, file) => {
    const { fixed } = keysUsedIn(readBytes(file).toString("utf8"));
    expect(fixed.length).toBeGreaterThan(3);
    for (const lang of LANGS) {
      for (const key of fixed) expect(typeof lookup(lang, key), `${lang}: ${key}`).toBe("string");
    }
  });

  it("las claves armadas en tiempo de ejecución existen para cada valor posible", () => {
    const dynamicValues = {
      "outreachPage.prospecting.status.": ["pending_review", "approved", "sent", "rejected"],
      "outreachPage.prospecting.history.actions.": ["generate", "regenerate", "approve", "reject", "mark_sent"],
      "leads.contacts.compose.active.": ["pending_review", "approved"],
      "outreachPage.prospecting.errors.": [...EMAIL_ERROR_CODES, ...EMAIL_ERROR_EXTRA],
    };
    const used = new Set(Object.values(SOURCES).flatMap((file) => keysUsedIn(readBytes(file).toString("utf8")).dynamic));
    for (const prefix of Object.keys(dynamicValues).slice(0, 3)) expect(used.has(prefix), prefix).toBe(true);
    for (const [prefix, values] of Object.entries(dynamicValues)) {
      for (const lang of LANGS) {
        for (const value of values) expect(typeof lookup(lang, `${prefix}${value}`), `${lang}: ${prefix}${value}`).toBe("string");
      }
    }
  });

  it("el mensaje de timeout es claro en los tres idiomas (no un error genérico)", () => {
    for (const lang of LANGS) {
      const { timeout, generic } = prospectingOf(lang).errors;
      expect(timeout).not.toBe(generic);
      expect(timeout).toMatch(/2/);
    }
  });

  it("auto_approved ya no tiene etiqueta en leads.status", () => {
    for (const lang of LANGS) expect(translations[lang].leads.status.auto_approved).toBeUndefined();
  });

  it.each(Object.values(SOURCES))("%s es UTF-8 válido sin BOM", (file) => {
    const bytes = readBytes(file);
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).not.toThrow();
  });
});
