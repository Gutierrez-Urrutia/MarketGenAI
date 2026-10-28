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

  it("keeps the toggle and the scan frequency field", async () => {
    pipelineApi.getConfig.mockResolvedValue({ data: { sources: [], is_active: true, scan_frequency_hours: 12 } });
    render(<PipelineSettingsTab />);
    await flush();

    expect(screen.getByText("settings.pipelineTab.statusActive")).toBeTruthy();
    expect(screen.getByDisplayValue("12")).toBeTruthy();

    const status = screen.getByText("settings.pipelineTab.statusTitle").closest("div.flex.items-center.justify-between");
    await act(async () => { fireEvent.click(status.querySelector("button")); });
    expect(screen.getByText("settings.pipelineTab.statusInactive")).toBeTruthy();
  });
});
