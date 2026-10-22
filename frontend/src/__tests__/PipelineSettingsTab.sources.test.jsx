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

const apiSource = (overrides = {}) => ({
  id: "src-api", name: "JSearch", source_type: "api", enabled: true,
  config: { base_url: "https://jsearch.example.com" }, configured_secret_fields: ["api_key"], ...overrides,
});

async function renderWithSources(sources) {
  pipelineApi.getConfig.mockResolvedValue({ data: { sources } });
  render(<PipelineSettingsTab />);
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
});

// RF13-D-004: al editar, el campo de la clave guardada viene vacío; debe decir que se conserva.
describe("PipelineSettingsTab stored secret fields", () => {
  it("editing an API source with a saved key says the empty field keeps it", async () => {
    await renderWithSources([apiSource()]);
    fireEvent.click(screen.getByTitle("settings.pipelineTab.editTitle"));

    expect(screen.getByPlaceholderText("settings.pipelineTab.secretKeptPlaceholder")).toBeTruthy();
  });

  it("a source without a saved key shows no such hint", async () => {
    await renderWithSources([apiSource({ configured_secret_fields: [] })]);
    fireEvent.click(screen.getByTitle("settings.pipelineTab.editTitle"));

    expect(screen.queryByPlaceholderText("settings.pipelineTab.secretKeptPlaceholder")).toBeNull();
  });

  it.each(["en", "es", "pt"])("the hint is translated in %s", (lang) => {
    expect(translations[lang].settings.pipelineTab.secretKeptPlaceholder).toBeTruthy();
  });
});
