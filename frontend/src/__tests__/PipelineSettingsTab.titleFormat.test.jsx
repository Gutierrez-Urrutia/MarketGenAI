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

const LABEL = "settings.pipelineTab.sourceFieldTitleFormat";

const rssSource = (config) => ({
  id: "src-1", name: "Remote Jobs RSS", source_type: "rss", enabled: true,
  config: { feed_url: "https://weworkremotely.com/x.rss", ...config },
});

async function renderWithSources(sources) {
  pipelineApi.getConfig.mockResolvedValue({ data: { sources } });
  render(<PipelineSettingsTab />);
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PipelineSettingsTab RSS title_format", () => {
  it("new RSS source: shows the select defaulting to 'none' with both options", async () => {
    await renderWithSources([]);
    fireEvent.click(screen.getByRole("button", { name: "settings.pipelineTab.addSourceButton" }));

    const select = screen.getByLabelText(LABEL);
    expect(select.value).toBe("none");
    expect([...select.options].map((o) => o.value)).toEqual(["none", "company_colon_title"]);
  });

  it("sends the chosen title_format in the create payload", async () => {
    pipelineApi.createSource.mockResolvedValue({ data: { sources: [] } });
    await renderWithSources([]);
    fireEvent.click(screen.getByRole("button", { name: "settings.pipelineTab.addSourceButton" }));

    fireEvent.change(screen.getByPlaceholderText("Indeed RSS Feed"), { target: { value: "Remote Jobs RSS" } });
    fireEvent.change(screen.getByLabelText(LABEL), { target: { value: "company_colon_title" } });
    const saveButtons = screen.getAllByRole("button", { name: "settings.pipelineTab.addSourceButton" });
    await act(async () => { fireEvent.click(saveButtons[saveButtons.length - 1]); });

    expect(pipelineApi.createSource).toHaveBeenCalledWith({
      name: "Remote Jobs RSS",
      source_type: "rss",
      config: { title_format: "company_colon_title" },
    });
  });

  it("editing a source shows its saved title_format", async () => {
    await renderWithSources([rssSource({ title_format: "company_colon_title" })]);
    fireEvent.click(screen.getByTitle("settings.pipelineTab.editTitle"));

    expect(screen.getByLabelText(LABEL).value).toBe("company_colon_title");
  });

  it("is not shown for non-RSS source types", async () => {
    await renderWithSources([]);
    fireEvent.click(screen.getByRole("button", { name: "settings.pipelineTab.addSourceButton" }));
    fireEvent.change(screen.getByDisplayValue("RSS"), { target: { value: "api" } });

    expect(screen.queryByLabelText(LABEL)).toBeNull();
  });
});

describe("title_format / unknownCompany translations", () => {
  // getTranslation silently falls back to English, so check each language directly.
  it.each(["en", "es", "pt"])("are defined in %s", (lang) => {
    const tab = translations[lang].settings.pipelineTab;
    for (const key of ["sourceFieldTitleFormat", "sourceFieldTitleFormatHint", "titleFormatNone", "titleFormatCompanyColonTitle"]) {
      expect(tab[key], `${lang}.settings.pipelineTab.${key}`).toBeTruthy();
    }
    expect(translations[lang].leads.unknownCompany).toBeTruthy();
  });
});
