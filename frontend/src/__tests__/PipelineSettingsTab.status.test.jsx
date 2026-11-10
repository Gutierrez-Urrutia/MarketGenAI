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

import { pipelineApi } from "@/api/axios";
import PipelineSettingsTab from "@/pages/settings/PipelineSettingsTab";
import { translations } from "@/i18n/translations";

const flush = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
  vi.clearAllMocks();
});

// The «Prospecting Pipeline» on/off toggle had no effect (scanning is manual;
// RF-VTA-17, the scheduled scan, is deferred), so its card was removed. Its
// RF14-D-008/D-009 texts («Manual scan», «Inactive») went with it.
describe("PipelineSettingsTab without the pipeline toggle", () => {
  const TOGGLE_KEYS = ["statusTitle", "statusActive", "statusInactive", "statusSaveError"];

  it("does not render the toggle card, whatever is_active is stored", async () => {
    pipelineApi.getConfig.mockResolvedValue({ data: { sources: [], is_active: false } });
    render(<PipelineSettingsTab />);
    await flush();

    expect(screen.getByText("settings.pipelineTab.keywordsTitle")).toBeTruthy();
    for (const key of TOGGLE_KEYS) {
      expect(screen.queryByText(`settings.pipelineTab.${key}`)).toBeNull();
    }
    expect(document.querySelector("button.w-11.h-6.rounded-full")).toBeNull();
    expect(pipelineApi.updateConfig).not.toHaveBeenCalled();
  });

  it.each(["en", "es", "pt"])("has no toggle texts left in %s", (lang) => {
    const tab = translations[lang].settings.pipelineTab;
    for (const key of TOGGLE_KEYS) {
      expect(tab).not.toHaveProperty(key);
    }
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

    expect(screen.getByText("settings.pipelineTab.keywordsTitle")).toBeTruthy();
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

    await act(async () => { fireEvent.click(screen.getByText("settings.pipelineTab.smtpSaveButton")); });
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

// Each card saves on its own, so the global «Save pipeline» button is gone.
describe("PipelineSettingsTab without a global save button", () => {
  it("renders no global button, and each card keeps its own way to save", async () => {
    pipelineApi.getConfig.mockResolvedValue({ data: { sources: [], is_active: true } });
    render(<PipelineSettingsTab />);
    await flush();

    expect(screen.queryByText("settings.pipelineTab.saveButton")).toBeNull();
    expect(screen.getByRole("button", { name: "settings.pipelineTab.smtpSaveButton" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "settings.pipelineTab.hunterSaveButton" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /settings\.pipelineTab\.addSourceButton/ })).toBeTruthy();
  });

  it.each(["en", "es", "pt"])("has no texts left for the global button in %s", (lang) => {
    const tab = translations[lang].settings.pipelineTab;
    for (const key of ["saveButton", "toastSaved", "toastSaveError"]) {
      expect(tab).not.toHaveProperty(key);
    }
    expect(tab.savingButton).toBeTruthy(); // still used by the cards' buttons
  });
});
