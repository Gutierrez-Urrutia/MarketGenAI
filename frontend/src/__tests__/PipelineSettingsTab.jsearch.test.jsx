import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";

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

const KEY_LABEL = "settings.pipelineTab.sourceFieldApiKey";
const OTHER_TYPE_LABELS = [
  "settings.pipelineTab.sourceFieldBaseUrl",
  "settings.pipelineTab.sourceFieldFeedUrl",
  "settings.pipelineTab.sourceFieldTitleFormat",
  "settings.pipelineTab.sourceFieldUrl",
  "settings.pipelineTab.sourceFieldCssSelectors",
];
const DEFAULTED_FIELDS = ["country", "language", "num_pages", "date_posted"];

const jsearchSource = (overrides = {}) => ({
  id: "src-js", name: "LinkedIn e Indeed", source_type: "jsearch", enabled: true,
  config: {}, configured_secret_fields: ["api_key"], ...overrides,
});

async function renderWithSources(sources) {
  pipelineApi.getConfig.mockResolvedValue({ data: { sources } });
  render(<PipelineSettingsTab />);
  await flush();
}

async function openNewJsearchForm() {
  await renderWithSources([]);
  fireEvent.click(screen.getAllByText("settings.pipelineTab.addSourceButton")[0]);
  fireEvent.change(screen.getByDisplayValue("RSS"), { target: { value: "jsearch" } });
}

const keyInput = () => screen.getByText(KEY_LABEL).parentElement.querySelector("input");
const nameInput = () => screen.getByPlaceholderText("Indeed RSS Feed");
const sourceForm = () => nameInput().closest(".mt-2");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PipelineSettingsTab JSearch source", () => {
  it("choosing jsearch shows only the API key field, as a password, with its help text", async () => {
    await openNewJsearchForm();

    expect(screen.getByText(KEY_LABEL)).toBeTruthy();
    expect(keyInput().type).toBe("password");
    expect(screen.getByText("settings.pipelineTab.sourceFieldJsearchApiKeyHint")).toBeTruthy();
    for (const label of OTHER_TYPE_LABELS) {
      expect(screen.queryByText(label)).toBeNull();
    }
    // Name + key are the only inputs of the source form (no URL, country, language, pages...).
    const form = sourceForm();
    expect(within(form).getAllByRole("textbox")).toEqual([nameInput()]);
    expect(form.querySelectorAll("input")).toHaveLength(2);
    expect(within(form).getAllByRole("combobox")).toHaveLength(1);  // only the source type select
  });

  it("saving a new jsearch source sends api_key and none of the defaulted query settings", async () => {
    pipelineApi.createSource.mockResolvedValue({ data: { sources: [] } });
    await openNewJsearchForm();
    fireEvent.change(nameInput(), { target: { value: "LinkedIn e Indeed" } });
    fireEvent.change(keyInput(), { target: { value: "rapid-key-123" } });
    await act(async () => { fireEvent.click(screen.getAllByText("settings.pipelineTab.addSourceButton").at(-1)); });

    expect(pipelineApi.createSource).toHaveBeenCalledWith({
      name: "LinkedIn e Indeed", source_type: "jsearch", config: { api_key: "rapid-key-123" },
    });
    const sentConfig = pipelineApi.createSource.mock.calls[0][0].config;
    for (const field of DEFAULTED_FIELDS) {
      expect(sentConfig).not.toHaveProperty(field);
    }
  });

  it("a new jsearch source without a key is not saved", async () => {
    await openNewJsearchForm();
    fireEvent.change(nameInput(), { target: { value: "LinkedIn e Indeed" } });
    await act(async () => { fireEvent.click(screen.getAllByText("settings.pipelineTab.addSourceButton").at(-1)); });

    expect(pipelineApi.createSource).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("settings.pipelineTab.toastApiKeyRequired");
  });

  // RF13-D-004: the stored key is never sent back; the empty field must keep it.
  it("editing a jsearch source with a saved key and the field left empty does not clear the key", async () => {
    pipelineApi.updateSource.mockResolvedValue({ data: { sources: [jsearchSource()] } });
    await renderWithSources([jsearchSource({ config: { country: "us", num_pages: 2 } })]);
    fireEvent.click(screen.getByTitle("settings.pipelineTab.editTitle"));

    expect(keyInput().value).toBe("");
    expect(keyInput().placeholder).toBe("settings.pipelineTab.secretKeptPlaceholder");
    await act(async () => { fireEvent.click(screen.getByText("settings.pipelineTab.updateSourceButton")); });

    expect(toast.error).not.toHaveBeenCalled();
    expect(pipelineApi.updateSource).toHaveBeenCalledWith("src-js", {
      name: "LinkedIn e Indeed", source_type: "jsearch", config: {},
    });
  });

  it("test connection on a jsearch source uses the same {ok, postings_read, reason} messages", async () => {
    pipelineApi.testSource.mockResolvedValueOnce({ data: { ok: true, postings_read: 4, reason: "", warnings: [] } });
    await renderWithSources([jsearchSource()]);
    await act(async () => { fireEvent.click(screen.getByTitle("settings.pipelineTab.testConnectionTitle")); });
    expect(pipelineApi.testSource).toHaveBeenCalledWith("src-js");
    expect(toast.success).toHaveBeenCalledWith("settings.pipelineTab.toastSourceResponds");

    pipelineApi.testSource.mockResolvedValueOnce({
      data: { ok: false, postings_read: 0, reason: "cuota de JSearch agotada (HTTP 429)", warnings: [] },
    });
    await act(async () => { fireEvent.click(screen.getByTitle("settings.pipelineTab.testConnectionTitle")); });
    expect(toast.error).toHaveBeenCalledWith("settings.pipelineTab.toastSourceNotResponding");
  });

  it.each(["en", "es", "pt"])("the jsearch texts exist in %s", (lang) => {
    const tab = translations[lang].settings.pipelineTab;
    expect(tab.sourceTypeJsearch).toBeTruthy();
    expect(tab.sourceFieldJsearchApiKeyHint).toMatch(/RapidAPI/);
    expect(tab.sourceFieldJsearchApiKeyHint).toContain(tab.testConnectionTitle);
    // RF14-D-008: up to 8 keywords, 1 request per keyword per run, 1 per test.
    expect(tab.sourceFieldJsearchApiKeyHint).toMatch(/\b8\b/);
    expect(tab.sourceFieldJsearchApiKeyHint.match(/\b1\b/g)).toHaveLength(2);
    expect(tab.toastApiKeyRequired).toBeTruthy();
  });
});
