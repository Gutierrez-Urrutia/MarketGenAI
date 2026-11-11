/**
 * RF-VTA-16 — pure helpers of the prospecting emails (no API, no DOM).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import {
  DEFAULT_EMAIL_LANGUAGE, EMAIL_ERROR_CODES, EMAIL_LANGUAGES,
  copyText, copyToClipboard, describeEmailError, isActive, languageLabel,
} from "@/features/outreach/prospectingEmails";

const apiError = (status, code) => ({ response: { status, data: { detail: code ? { code } : "x" } } });

describe("email languages", () => {
  it("are English, Español and Português, each written in its own language", () => {
    expect(EMAIL_LANGUAGES).toEqual([
      { code: "en", label: "English" },
      { code: "es", label: "Español" },
      { code: "pt", label: "Português" },
    ]);
  });

  it("default to English", () => {
    expect(DEFAULT_EMAIL_LANGUAGE).toBe("en");
    expect(EMAIL_LANGUAGES[0].code).toBe(DEFAULT_EMAIL_LANGUAGE);
  });

  it("show the native name for a code", () => {
    expect(languageLabel("pt")).toBe("Português");
    expect(languageLabel("fr")).toBe("fr");
    expect(languageLabel(undefined)).toBe("");
  });
});

describe("describeEmailError", () => {
  it.each(EMAIL_ERROR_CODES)("maps the backend code %s to its message", (code) => {
    const described = describeEmailError(apiError(422, code));
    expect(described).toEqual({ key: `outreachPage.prospecting.errors.${code}`, code, timedOut: false });
  });

  it.each(["ECONNABORTED", "ETIMEDOUT"])("a %s is the timeout message, not a generic error", (code) => {
    expect(describeEmailError({ code, message: "timeout of 120000ms exceeded" })).toEqual({
      key: "outreachPage.prospecting.errors.timeout", code: "timeout", timedOut: true,
    });
  });

  it("a 429 is rate limited", () => {
    expect(describeEmailError(apiError(429)).code).toBe("rateLimited");
  });

  it("an unknown code, a bare 403 and a network error", () => {
    expect(describeEmailError(apiError(500, "something_new")).code).toBe("generic");
    expect(describeEmailError(apiError(403)).code).toBe("forbidden");
    expect(describeEmailError(new Error("Network Error")).code).toBe("generic");
  });
});

describe("copy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("copies the subject, a blank line and the body", () => {
    expect(copyText({ subject: "Hi Ana", body: "Line 1\nLine 2" })).toBe("Hi Ana\n\nLine 1\nLine 2");
  });

  it("resolves true when the clipboard accepts the text", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyToClipboard("x")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("x");
  });

  it("resolves false (never throws) when the clipboard refuses or is missing", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(() => Promise.reject(new Error("denied"))) } });
    await expect(copyToClipboard("x")).resolves.toBe(false);
    vi.stubGlobal("navigator", {});
    await expect(copyToClipboard("x")).resolves.toBe(false);
  });

  it("only pending_review and approved are active", () => {
    expect(["pending_review", "approved", "sent", "rejected"].map((status) => isActive({ status })))
      .toEqual([true, true, false, false]);
  });
});
