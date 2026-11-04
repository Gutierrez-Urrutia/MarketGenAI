/**
 * A failed save / delete of a pipeline source (its config may carry the
 * JSearch api_key) is logged without the request: same toasts as before.
 * API mocked; synthetic values only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

vi.mock("@/api/axios", () => ({
  pipelineApi: {
    getConfig: vi.fn(), updateConfig: vi.fn(), createSource: vi.fn(), updateSource: vi.fn(),
    deleteSource: vi.fn(), testSource: vi.fn(),
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

const SECRET = "secret-value-0000";
const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });

const failure = (method, url) => Object.assign(new Error("Request failed"), {
  config: { method, url, data: JSON.stringify({ config: { api_key: SECRET } }), headers: { Authorization: `Bearer ${SECRET}` } },
  response: { status: 400, data: { detail: "Fuente inválida" } },
});

const source = { id: "src-1", name: "JSearch", source_type: "jsearch", enabled: true, config: {}, configured_secret_fields: ["api_key"] };

let err;
let log;
beforeEach(() => {
  vi.clearAllMocks();
  err = vi.spyOn(console, "error").mockImplementation(() => {});
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  pipelineApi.getConfig.mockResolvedValue({ data: { sources: [source], keywords: [], industries: [], excluded_companies: [] } });
});
afterEach(() => { err.mockRestore(); log.mockRestore(); });

const consoleText = () => JSON.stringify([...err.mock.calls, ...log.mock.calls], (key, value) => (
  value instanceof Error ? { ...value, message: value.message } : value
));

describe("PipelineSettingsTab never logs a source's secret", () => {
  it("a failed delete logs method, URL and status only, with the same toast", async () => {
    pipelineApi.deleteSource.mockRejectedValue(failure("delete", "/pipeline/config/sources/src-1"));
    render(<PipelineSettingsTab />);
    await flush();
    fireEvent.click(screen.getByTitle("settings.pipelineTab.deleteTitle"));
    await flush();

    expect(toast.error).toHaveBeenCalledWith("Fuente inválida");
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toBe("❌ [PipelineSettings] DELETE /pipeline/config/sources/src-1 () - Status: 400");
    expect(consoleText()).not.toContain(SECRET);
  });

  it("a failed save of a JSearch source does not log its api_key, with the same toast", async () => {
    pipelineApi.updateSource.mockRejectedValue(failure("put", "/pipeline/config/sources/src-1"));
    render(<PipelineSettingsTab />);
    await flush();
    fireEvent.click(screen.getByTitle("settings.pipelineTab.editTitle"));
    fireEvent.change(document.querySelector('input[type="password"][placeholder="settings.pipelineTab.secretKeptPlaceholder"]'), {
      target: { value: SECRET },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.pipelineTab.updateSourceButton" }));
    await flush();

    expect(pipelineApi.updateSource).toHaveBeenCalledWith("src-1", expect.objectContaining({ config: { api_key: SECRET } }));
    expect(toast.error).toHaveBeenCalledWith("Fuente inválida");
    expect(consoleText()).not.toContain(SECRET);
  });

  it("a failed load logs no response body either", async () => {
    pipelineApi.getConfig.mockRejectedValue(failure("get", "/pipeline/config"));
    render(<PipelineSettingsTab />);
    await flush();
    expect(toast.error).toHaveBeenCalledWith("settings.pipelineTab.toastLoadError");
    expect(consoleText()).not.toContain(SECRET);
  });
});
