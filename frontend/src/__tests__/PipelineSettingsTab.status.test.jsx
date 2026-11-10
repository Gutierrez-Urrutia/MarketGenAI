import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

vi.mock("@/api/axios", () => ({
  pipelineApi: {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    createSource: vi.fn(),
    updateSource: vi.fn(),
    deleteSource: vi.fn(),
    testSource: vi.fn(),
  },
}));
vi.mock("@/hooks/useI18n", () => ({ useI18n: () => ({ t: (key) => key }) }));
vi.mock("react-hot-toast", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast };
});

import toast from "react-hot-toast";
import { pipelineApi } from "@/api/axios";
import PipelineSettingsTab from "@/pages/settings/PipelineSettingsTab";
import { translations } from "@/i18n/translations";

const flush = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
  vi.clearAllMocks();
});

// RF14-D-008: there is no automatic scan yet (RF-VTA-17 is deferred), so the
// status must not promise one "every N hours".
describe("PipelineSettingsTab status text", () => {
  it.each(["en", "es", "pt"])("the active status in %s says the scan is manual, with no hours", (lang) => {
    const tab = translations[lang].settings.pipelineTab;
    expect(tab.statusActive).not.toContain("{hours}");
    expect(tab.statusActive).not.toMatch(/\d/);
  });

  it("uses the manual scan texts", () => {
    expect(translations.es.settings.pipelineTab.statusActive).toBe("Escaneo manual");
    expect(translations.en.settings.pipelineTab.statusActive).toBe("Manual scan");
    expect(translations.pt.settings.pipelineTab.statusActive).toBe("Varredura manual");
  });

  // RF14-D-009: the toggle does not affect the scan button, so "inactive" invites nothing.
  it("uses the plain inactive texts", () => {
    expect(translations.es.settings.pipelineTab.statusInactive).toBe("Inactivo");
    expect(translations.en.settings.pipelineTab.statusInactive).toBe("Inactive");
    expect(translations.pt.settings.pipelineTab.statusInactive).toBe("Inativo");
  });

  it("keeps the toggle", async () => {
    pipelineApi.getConfig.mockResolvedValue({ data: { sources: [], is_active: true } });
    pipelineApi.updateConfig.mockImplementation(async (payload) => ({ data: payload }));
    render(<PipelineSettingsTab />);
    await flush();

    expect(screen.getByText("settings.pipelineTab.statusActive")).toBeTruthy();

    const status = screen.getByText("settings.pipelineTab.statusTitle").closest("div.flex.items-center.justify-between");
    await act(async () => { fireEvent.click(status.querySelector("button")); });
    expect(screen.getByText("settings.pipelineTab.statusInactive")).toBeTruthy();
  });
});

// The toggle is saved right away, like the tag lists: only is_active is sent,
// quick clicks coalesce (the last one wins) and a failure restores it.
describe("PipelineSettingsTab toggle saves right away", () => {
  const flushAll = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
  const toggle = () => screen.getByText("settings.pipelineTab.statusTitle")
    .closest("div.flex.items-center.justify-between").querySelector("button");
  const renderTab = async (config = {}) => {
    pipelineApi.getConfig.mockResolvedValue({
      data: { sources: [], is_active: true, smtp_host: "smtp.ejemplo.test", smtp_port: 587, ...config },
    });
    render(<PipelineSettingsTab />);
    await flushAll();
  };

  beforeEach(() => {
    pipelineApi.updateConfig.mockImplementation(async (payload) => ({ data: { is_active: true, ...payload } }));
  });

  it("sends only is_active and shows «Saved»", async () => {
    await renderTab();
    await act(async () => { fireEvent.click(toggle()); });
    await flushAll();

    expect(pipelineApi.updateConfig.mock.calls).toEqual([[{ is_active: false }]]);
    expect(screen.getByText("settings.pipelineTab.statusInactive")).toBeTruthy();
    expect(screen.getByText("settings.pipelineTab.autoSaved")).toBeTruthy();
  });

  it("does not send other cards' unsaved edits, and keeps them", async () => {
    await renderTab();
    fireEvent.change(screen.getByDisplayValue("smtp.ejemplo.test"), { target: { value: "smtp.otro.test" } });
    await act(async () => { fireEvent.click(toggle()); });
    await flushAll();

    expect(pipelineApi.updateConfig.mock.calls).toEqual([[{ is_active: false }]]);
    expect(screen.getByDisplayValue("smtp.otro.test")).toBeTruthy();
  });

  it("restores the previous value and shows an error when the save fails", async () => {
    pipelineApi.updateConfig.mockRejectedValue(Object.assign(new Error("HTTP 500"), { response: { status: 500 } }));
    await renderTab();
    await act(async () => { fireEvent.click(toggle()); });
    await flushAll();

    expect(screen.getByText("settings.pipelineTab.statusActive")).toBeTruthy();
    expect(toast.error).toHaveBeenCalledWith("settings.pipelineTab.statusSaveError");
    expect(screen.queryByText("settings.pipelineTab.autoSaved")).toBeNull();
  });

  it("quick clicks are saved one at a time and the last value wins", async () => {
    let release;
    const first = new Promise((resolve) => { release = resolve; });
    let inFlight = 0;
    let maxInFlight = 0;
    pipelineApi.updateConfig.mockImplementation(async (payload) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (pipelineApi.updateConfig.mock.calls.length === 1) await first;
        return { data: payload };
      } finally {
        inFlight -= 1;
      }
    });
    await renderTab();

    await act(async () => { fireEvent.click(toggle()); }); // → off (sent, waiting)
    await act(async () => { fireEvent.click(toggle()); }); // → on
    await act(async () => { fireEvent.click(toggle()); }); // → off
    await flushAll();
    expect(pipelineApi.updateConfig).toHaveBeenCalledTimes(1);
    expect(screen.getByText("settings.pipelineTab.autoSaving")).toBeTruthy();

    await act(async () => { release(); });
    await flushAll();

    const sent = pipelineApi.updateConfig.mock.calls.map(([payload]) => payload);
    expect(sent[0]).toEqual({ is_active: false });
    expect(sent.at(-1)).toEqual({ is_active: false });
    expect(maxInFlight).toBe(1);
    expect(screen.getByText("settings.pipelineTab.statusInactive")).toBeTruthy();
  });

  it.each(["en", "es", "pt"])("has the error text and keeps the indicator texts in %s", (lang) => {
    const tab = translations[lang].settings.pipelineTab;
    expect(tab.statusSaveError).toBeTruthy();
    expect(tab).not.toHaveProperty("tagsSaving");
    expect(tab).not.toHaveProperty("tagsSaved");
    expect({ es: ["Guardando…", "Guardado"], en: ["Saving…", "Saved"], pt: ["Salvando…", "Salvo"] }[lang])
      .toEqual([tab.autoSaving, tab.autoSaved]);
  });
});

// The "automation thresholds" section had no effect (nothing auto-approved,
// capped emails or scheduled scans), so it was removed from the tab.
describe("PipelineSettingsTab without the automation thresholds section", () => {
  const SECTION_KEYS = [
    "thresholdsTitle", "thresholdsDesc", "autoSendThresholdLabel",
    "autoSendThresholdHint", "maxEmailsLabel", "scanFrequencyLabel",
  ];

  it("does not render the section or its fields", async () => {
    pipelineApi.getConfig.mockResolvedValue({
      data: { sources: [], is_active: true, auto_send_threshold: 0.8, max_emails_per_day: 50, scan_frequency_hours: 12 },
    });
    render(<PipelineSettingsTab />);
    await flush();

    expect(screen.getByText("settings.pipelineTab.statusTitle")).toBeTruthy();
    for (const key of SECTION_KEYS) {
      expect(screen.queryByText(`settings.pipelineTab.${key}`)).toBeNull();
    }
    expect(screen.queryByDisplayValue("0.8")).toBeNull();
    expect(screen.queryByDisplayValue("50")).toBeNull();
    expect(screen.queryByDisplayValue("12")).toBeNull();
  });

  it("does not send the removed fields when saving", async () => {
    pipelineApi.getConfig.mockResolvedValue({ data: { sources: [], is_active: true } });
    pipelineApi.updateConfig.mockResolvedValue({ data: {} });
    render(<PipelineSettingsTab />);
    await flush();

    await act(async () => { fireEvent.click(screen.getByText("settings.pipelineTab.saveButton")); });
    const payload = pipelineApi.updateConfig.mock.calls[0][0];
    expect(payload).not.toHaveProperty("auto_send_threshold");
    expect(payload).not.toHaveProperty("max_emails_per_day");
    expect(payload).not.toHaveProperty("scan_frequency_hours");
  });

  it.each(["en", "es", "pt"])("has no texts for the section in %s", (lang) => {
    const tab = translations[lang].settings.pipelineTab;
    for (const key of SECTION_KEYS) {
      expect(tab).not.toHaveProperty(key);
    }
  });
});
