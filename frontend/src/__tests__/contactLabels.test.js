/** RF15 — pure helpers of the contact search: dates, labels, messages, translations. */
import { describe, it, expect } from "vitest";

import { toDate, formatDateTime } from "@/utils/dates";
import {
  ALL_MESSAGE_KEYS,
  SEARCHABLE_STATUSES,
  canSearchLead,
  confidenceOf,
  describeSearchError,
  describeSearchResult,
  lastSearchOf,
  roleKey,
  verificationOf,
} from "@/pages/pipeline/contactLabels";
import { translations } from "@/i18n/translations";

const ISO = "2026-10-01T12:00:05.000Z";
const MS = Date.parse(ISO);
const apiError = (status, detail) => ({ response: { status, data: { detail } } });

describe("toDate reads every date shape", () => {
  it.each([
    ["ISO text", ISO],
    ["ISO text with offset", "2026-10-01T12:00:05+00:00"],
    ["Date", new Date(MS)],
    ["epoch ms", MS],
    ["{seconds, nanoseconds}", { seconds: MS / 1000, nanoseconds: 0 }],
    ["{_seconds, _nanoseconds}", { _seconds: MS / 1000, _nanoseconds: 0 }],
    ["toDate()", { toDate: () => new Date(MS) }],
  ])("%s", (_, value) => {
    expect(toDate(value).getTime()).toBe(MS);
  });

  it("keeps the milliseconds of a Firestore timestamp", () => {
    expect(toDate({ seconds: MS / 1000, nanoseconds: 250_000_000 }).getTime()).toBe(MS + 250);
  });

  it.each([null, undefined, "", "not a date", {}, { seconds: "x" }, { toDate: () => { throw new Error("x"); } }, NaN])(
    "returns null for %p", (value) => {
      expect(toDate(value)).toBeNull();
    },
  );

  it("formatDateTime falls back for a missing value and formats a present one", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined, "-")).toBe("-");
    expect(formatDateTime(ISO)).toBe(formatDateTime({ _seconds: MS / 1000 }));
    expect(formatDateTime(ISO)).not.toBe("—");
  });
});

describe("labels", () => {
  it("searchable statuses", () => {
    expect(SEARCHABLE_STATUSES).toEqual(["new", "researching", "contacts_found", "error"]);
    expect(canSearchLead({ status: "researching" })).toBe(true);
    expect(canSearchLead({})).toBe(true); // a lead without status is new
    expect(canSearchLead({ status: "sent" })).toBe(false);
  });

  it("roles, with unknown for anything else", () => {
    for (const role of ["hiring_manager", "hr_recruiter", "department_head", "procurement", "executive", "unknown"]) {
      expect(roleKey(role)).toBe(`leads.contacts.role.${role}`);
    }
    expect(roleKey("ceo")).toBe("leads.contacts.role.unknown");
    expect(roleKey(undefined)).toBe("leads.contacts.role.unknown");
  });

  it.each([
    ["valid", "verified"], ["VALID", "verified"], ["accept_all", "risky"], ["invalid", "risky"], ["disposable", "risky"],
    ["unknown", "unverified"], ["webmail", "unverified"], [null, "unverified"], ["", "unverified"],
  ])("verification %p → %s", (status, kind) => {
    expect(verificationOf(status)).toBe(kind);
  });

  it.each([
    [1, "high", 100], [0.8, "high", 80], [0.79, "medium", 79], [0.5, "medium", 50], [0.49, "low", 49],
    [0, "low", 0], [undefined, "low", 0], [1.7, "high", 100],
  ])("confidence %p → %s %d%%", (score, level, percent) => {
    expect(confidenceOf(score)).toEqual({ level, percent });
  });
});

describe("messages", () => {
  it("never show a raw code nor contact data", () => {
    const outcomes = [
      describeSearchResult({ state: "contacts_found", contacts: [{ full_name: "Ana Ficticia" }] }),
      describeSearchResult({ state: "error", reason: "brand_new_reason" }),
      describeSearchResult({ state: "weird" }),
      describeSearchError(apiError(409, { code: "brand_new_code" })),
      describeSearchError(apiError(418, "I'm a teapot")),
    ];
    for (const outcome of outcomes) {
      expect(outcome.key.startsWith("leads.contacts.")).toBe(true);
      expect(JSON.stringify(outcome)).not.toMatch(/Ficticia|brand_new|teapot/);
    }
  });

  it("cooldown carries the date; without one, a text without it", () => {
    const withDate = describeSearchError(apiError(409, { code: "cooldown", next_search_allowed_at: ISO }));
    expect(withDate).toMatchObject({ key: "leads.contacts.error.cooldown", action: "forceCooldown", tone: "warning" });
    expect(withDate.params.date.getTime()).toBe(MS);
    expect(describeSearchError(apiError(409, { code: "cooldown" })).key).toBe("leads.contacts.error.cooldownNoDate");
  });

  it("errors map to their codes and actions", () => {
    expect(describeSearchError(apiError(409, { code: "reuse_area_mismatch" })).action).toBe("forceArea");
    expect(describeSearchError(apiError(409, { code: "search_in_progress" })).tone).toBe("info");
    expect(describeSearchError(apiError(409, { code: "search_superseded" })).action).toBe("reload");
    expect(describeSearchError(apiError(422, { code: "hunter_not_configured" })).action).toBe("settings");
    expect(describeSearchError(apiError(422, { code: "lead_not_searchable" })).key).toBe("leads.contacts.error.notSearchable");
    expect(describeSearchError({ code: "ECONNABORTED" }).action).toBe("refresh");
    expect(describeSearchResult({ state: "error", reason: "invalid_api_key" }).action).toBe("settings");
    expect(describeSearchResult({ state: "error", reason: "timeout" }).action).toBe("retry");
  });

  it("the last search is read from contacts_search, not from lead.status", () => {
    expect(lastSearchOf({ status: "error" })).toBeNull();
    expect(lastSearchOf({ status: "error", contacts_search: { state: "contacts_found" } }).isError).toBe(false);
    const failed = lastSearchOf({ status: "new", contacts_search: { state: "error", reason: "no_credits", searched_at: ISO } });
    expect(failed).toMatchObject({ isError: true, detailKey: "leads.contacts.reason.no_credits" });
    expect(failed.when.getTime()).toBe(MS);
  });
});

// Every new key exists in en, es and pt (no silent fallback to English).
const get = (obj, path) => path.split(".").reduce((value, key) => value?.[key], obj);
const leafPaths = (obj, prefix = "") => Object.entries(obj).flatMap(([key, value]) => (
  value && typeof value === "object" ? leafPaths(value, `${prefix}${key}.`) : [`${prefix}${key}`]
));

const HUNTER_KEYS = [
  "hunterTitle", "hunterDesc", "hunterKeyLabel", "hunterStatusConfigured", "hunterStatusNotConfigured",
  "hunterConfiguredHint", "hunterNotConfiguredHint", "hunterKeyPlaceholder", "hunterClear", "hunterClearPending",
  "hunterUndoClear", "toastEncryptionUnavailable",
].map((key) => `settings.pipelineTab.${key}`);

const PANEL_KEYS = [
  "column", "show", "hide", "panelTitle", "search", "searching", "searchingHint", "blockedByOther", "notSearchable",
  "lastSearch", "lastSearchNoDate", "result.reused", "result.creditsUsed", "result.creditsRemaining",
  "action.forceCooldown", "action.forceCooldownHint", "action.forceArea", "action.forceAreaHint", "action.retry",
  "action.refresh", "action.goToSettings", "list.loading", "list.loadError", "list.empty", "list.showRejected",
  "list.copied", "list.noEmail", "verification.verified", "verification.verifiedOn", "verification.risky",
  "verification.riskyHint", "verification.unverified", "confidence.high", "confidence.medium", "confidence.low",
  "review.pending", "review.approved", "review.rejected", "review.approve", "review.reject", "review.restore",
  "review.invalidTransition", "review.error",
].map((key) => `leads.contacts.${key}`);

describe("translations", () => {
  it.each(["en", "es", "pt"])("every new key exists in %s", (lang) => {
    for (const key of [...ALL_MESSAGE_KEYS, ...PANEL_KEYS, ...HUNTER_KEYS]) {
      const value = get(translations[lang], key);
      expect(typeof value === "string" && value.trim().length > 0, `${lang}: ${key}`).toBe(true);
    }
  });

  it("the three languages have the same contact keys", () => {
    const en = leafPaths(translations.en.leads.contacts).sort();
    expect(leafPaths(translations.es.leads.contacts).sort()).toEqual(en);
    expect(leafPaths(translations.pt.leads.contacts).sort()).toEqual(en);
  });

  it("placeholders match across languages", () => {
    const placeholders = (text) => (text.match(/\{\w+\}/g) || []).sort().join();
    for (const path of leafPaths(translations.en.leads.contacts)) {
      const en = placeholders(get(translations.en.leads.contacts, path));
      expect(placeholders(get(translations.es.leads.contacts, path)), `es ${path}`).toBe(en);
      expect(placeholders(get(translations.pt.leads.contacts, path)), `pt ${path}`).toBe(en);
    }
  });

  it("the force texts warn about up to 1.5 credits", () => {
    for (const lang of ["en", "es", "pt"]) {
      const { forceCooldownHint, forceAreaHint } = translations[lang].leads.contacts.action;
      expect(forceCooldownHint).toMatch(/1[,.]5/);
      expect(forceAreaHint).toMatch(/1[,.]5/);
    }
  });
});
