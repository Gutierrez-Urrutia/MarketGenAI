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
import toast from "react-hot-toast";
import PipelineSettingsTab from "@/pages/settings/PipelineSettingsTab";

const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });

const BASE = {
  sources: [],
  is_active: true,
  keywords: ["BPO"],
  industries: ["finance"],
  excluded_companies: ["Acme Rival"],
  smtp_host: "smtp.ejemplo.test",
  smtp_port: 587,
};

const LISTS = [
  ["keywords", "settings.pipelineTab.serviceKeywordsLabel", "BPO"],
  ["industries", "settings.pipelineTab.targetIndustriesLabel", "finance"],
  ["excluded_companies", "settings.pipelineTab.excludedCompaniesLabel", "Acme Rival"],
];

// The server echoes back what it stored for the field that was sent.
const echo = async (payload) => ({ data: { ...BASE, ...payload } });

const renderTab = async (config = BASE) => {
  pipelineApi.getConfig.mockResolvedValue({ data: config });
  render(<PipelineSettingsTab />);
  await flush();
};

const tagInput = (labelKey) => screen.getByText(labelKey).parentElement.querySelector("input[type=text]");

const addTag = async (labelKey, value) => {
  const input = tagInput(labelKey);
  fireEvent.change(input, { target: { value } });
  await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.clearAllMocks();
  pipelineApi.updateConfig.mockImplementation(echo);
});

describe("PipelineSettingsTab tag lists save on their own", () => {
  it.each(LISTS)("adding to %s sends only that list", async (field, labelKey, existing) => {
    await renderTab();
    await addTag(labelKey, "  Nueva  ");
    await flush();

    expect(pipelineApi.updateConfig).toHaveBeenCalledTimes(1);
    expect(pipelineApi.updateConfig.mock.calls[0][0]).toEqual({ [field]: [existing, "Nueva"] });
    expect(screen.getByText("Nueva")).toBeTruthy();
    expect(screen.getByText("settings.pipelineTab.tagsSaved")).toBeTruthy();
  });

  it.each(LISTS)("removing from %s with × sends only that list", async (field, _labelKey, existing) => {
    await renderTab();
    await act(async () => { fireEvent.click(screen.getByLabelText(`Remove ${existing}`)); });
    await flush();

    expect(pipelineApi.updateConfig).toHaveBeenCalledTimes(1);
    expect(pipelineApi.updateConfig.mock.calls[0][0]).toEqual({ [field]: [] });
    expect(screen.queryByText(existing)).toBeNull();
  });

  it("removing the last tag with Backspace also saves", async () => {
    await renderTab();
    const input = tagInput("settings.pipelineTab.serviceKeywordsLabel");
    await act(async () => { fireEvent.keyDown(input, { key: "Backspace" }); });
    await flush();

    expect(pipelineApi.updateConfig.mock.calls).toEqual([[{ keywords: [] }]]);
  });

  it("keeps the existing rules: blank and duplicate tags are not added or sent", async () => {
    await renderTab();
    await addTag("settings.pipelineTab.serviceKeywordsLabel", "   ");
    await addTag("settings.pipelineTab.serviceKeywordsLabel", "BPO");
    await flush();

    expect(pipelineApi.updateConfig).not.toHaveBeenCalled();
  });

  it("does not send anything when other fields are edited", async () => {
    await renderTab();
    fireEvent.change(screen.getByDisplayValue("smtp.ejemplo.test"), { target: { value: "smtp.otro.test" } });
    await flush();

    expect(pipelineApi.updateConfig).not.toHaveBeenCalled();
  });

  it("restores the confirmed list and shows an error when the save fails", async () => {
    pipelineApi.updateConfig.mockRejectedValue(Object.assign(new Error("HTTP 500"), { response: { status: 500 } }));
    await renderTab();
    await addTag("settings.pipelineTab.serviceKeywordsLabel", "Nueva");
    await flush();

    expect(screen.queryByText("Nueva")).toBeNull();
    expect(screen.getByText("BPO")).toBeTruthy();
    expect(toast.error).toHaveBeenCalledWith("settings.pipelineTab.tagsSaveError");
    expect(screen.queryByText("settings.pipelineTab.tagsSaved")).toBeNull();
  });

  it("saves quick additions one at a time and the last value wins", async () => {
    const first = deferred();
    let inFlight = 0;
    let maxInFlight = 0;
    pipelineApi.updateConfig.mockImplementation(async (payload) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (pipelineApi.updateConfig.mock.calls.length === 1) await first.promise;
        return await echo(payload);
      } finally {
        inFlight -= 1;
      }
    });
    await renderTab();

    await addTag("settings.pipelineTab.serviceKeywordsLabel", "A");
    await addTag("settings.pipelineTab.serviceKeywordsLabel", "B");
    await addTag("settings.pipelineTab.serviceKeywordsLabel", "C");
    await flush();
    expect(pipelineApi.updateConfig).toHaveBeenCalledTimes(1);
    expect(screen.getByText("settings.pipelineTab.tagsSaving")).toBeTruthy();

    await act(async () => { first.resolve(); });
    await flush();

    const sent = pipelineApi.updateConfig.mock.calls.map(([payload]) => payload);
    expect(sent[0]).toEqual({ keywords: ["BPO", "A"] });
    expect(sent.at(-1)).toEqual({ keywords: ["BPO", "A", "B", "C"] });
    expect(sent.length).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBe(1);
    for (const tag of ["A", "B", "C"]) expect(screen.getByText(tag)).toBeTruthy();
    expect(screen.getByText("settings.pipelineTab.tagsSaved")).toBeTruthy();
  });

  it("sends more than 8 keywords untouched (JSearch still uses the first 8 on the server)", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => `kw${i + 1}`);
    await renderTab({ ...BASE, keywords: nine });
    await addTag("settings.pipelineTab.serviceKeywordsLabel", "kw10");
    await flush();

    expect(pipelineApi.updateConfig.mock.calls[0][0]).toEqual({ keywords: [...nine, "kw10"] });
  });

  it("«Save account» saves SMTP without the three lists", async () => {
    await renderTab();
    fireEvent.change(screen.getByDisplayValue("smtp.ejemplo.test"), { target: { value: "smtp.otro.test" } });
    await act(async () => { fireEvent.click(screen.getByText("settings.pipelineTab.smtpSaveButton")); });
    await flush();

    expect(pipelineApi.updateConfig).toHaveBeenCalledTimes(1);
    const payload = pipelineApi.updateConfig.mock.calls[0][0];
    expect(payload.smtp_host).toBe("smtp.otro.test");
    for (const field of ["keywords", "industries", "excluded_companies"]) {
      expect(payload).not.toHaveProperty(field);
    }
  });

  it("«Test connection» waits for the tag saves in flight", async () => {
    const pending = deferred();
    pipelineApi.updateConfig.mockImplementation(async (payload) => { await pending.promise; return echo(payload); });
    pipelineApi.testSource.mockResolvedValue({ data: { ok: true, postings_read: 1, reason: "", warnings: [] } });
    const source = { id: "src-1", name: "Demo RSS", source_type: "rss", enabled: true, config: { feed_url: "https://ejemplo.test/rss" } };
    await renderTab({ ...BASE, sources: [source] });

    await addTag("settings.pipelineTab.serviceKeywordsLabel", "Nueva");
    await act(async () => { fireEvent.click(screen.getByTitle("settings.pipelineTab.testConnectionTitle")); });
    await flush();
    expect(pipelineApi.testSource).not.toHaveBeenCalled();

    await act(async () => { pending.resolve(); });
    await flush();
    expect(pipelineApi.testSource).toHaveBeenCalledWith("src-1");
  });
});
