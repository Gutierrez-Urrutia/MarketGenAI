/**
 * RF15 — Hunter API key in Settings → Pipeline: write-only, like the SMTP
 * password. Synthetic values only; the API is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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

const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
const KEY = "hk-sintetica-0000";

const config = (overrides = {}) => ({
  id: "user-1", keywords: ["BPO"], industries: [], excluded_companies: [], sources: [],
  smtp_host: "", smtp_port: 587, smtp_user: "", sender_email: "", sender_name: "",
  smtp_password_configured: false, hunter_api_key_configured: false, is_active: true, ...overrides,
});

const keyInput = () => screen.getByLabelText("settings.pipelineTab.hunterKeyLabel");
const save = async () => {
  fireEvent.click(screen.getByRole("button", { name: "settings.pipelineTab.saveButton" }));
  await flush();
};
const sentPayload = () => pipelineApi.updateConfig.mock.calls.at(-1)[0];

async function renderTab(cfg = config()) {
  pipelineApi.getConfig.mockResolvedValue({ data: cfg });
  render(<PipelineSettingsTab />);
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  pipelineApi.updateConfig.mockImplementation(async (payload) => ({
    data: config({ hunter_api_key_configured: "hunter_api_key" in payload ? payload.hunter_api_key !== "" : true }),
  }));
});

describe("Hunter key field", () => {
  it("not configured: says so and starts empty", async () => {
    await renderTab();
    expect(screen.getByText("settings.pipelineTab.hunterStatusNotConfigured")).toBeTruthy();
    expect(screen.getByText("settings.pipelineTab.hunterNotConfiguredHint")).toBeTruthy();
    expect(keyInput().type).toBe("password");
    expect(keyInput().value).toBe("");
    expect(keyInput().getAttribute("autocomplete")).toBe("new-password");
    expect(screen.queryByRole("button", { name: "settings.pipelineTab.hunterClear" })).toBeNull();
  });

  it("configured: says so and is never filled with a value", async () => {
    await renderTab(config({ hunter_api_key_configured: true, hunter_api_key: KEY }));
    expect(screen.getByText("settings.pipelineTab.hunterStatusConfigured")).toBeTruthy();
    expect(keyInput().value).toBe("");
    expect(keyInput().placeholder).toBe("••••••••");
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it("saving without touching the field does not send the key", async () => {
    await renderTab(config({ hunter_api_key_configured: true }));
    await save();
    expect(pipelineApi.updateConfig).toHaveBeenCalledTimes(1);
    expect("hunter_api_key" in sentPayload()).toBe(false);
  });

  it("a whitespace-only value is not sent", async () => {
    await renderTab(config({ hunter_api_key_configured: true }));
    fireEvent.change(keyInput(), { target: { value: "   " } });
    await save();
    expect("hunter_api_key" in sentPayload()).toBe(false);
  });

  it("a new key is sent trimmed, then the field is emptied", async () => {
    await renderTab();
    fireEvent.change(keyInput(), { target: { value: `  ${KEY}  ` } });
    await save();
    expect(sentPayload().hunter_api_key).toBe(KEY);
    expect(keyInput().value).toBe("");
    expect(screen.getByText("settings.pipelineTab.hunterStatusConfigured")).toBeTruthy();
  });

  it("'Clear key' is applied on save and sends an empty string", async () => {
    await renderTab(config({ hunter_api_key_configured: true }));
    fireEvent.click(screen.getByRole("button", { name: "settings.pipelineTab.hunterClear" }));
    expect(screen.getByText("settings.pipelineTab.hunterClearPending")).toBeTruthy();
    expect(pipelineApi.updateConfig).not.toHaveBeenCalled();
    await save();
    expect(sentPayload().hunter_api_key).toBe("");
    expect(screen.getByText("settings.pipelineTab.hunterStatusNotConfigured")).toBeTruthy();
  });

  it("'Undo' before saving keeps the key", async () => {
    await renderTab(config({ hunter_api_key_configured: true }));
    fireEvent.click(screen.getByRole("button", { name: "settings.pipelineTab.hunterClear" }));
    fireEvent.click(screen.getByRole("button", { name: "settings.pipelineTab.hunterUndoClear" }));
    expect(screen.queryByText("settings.pipelineTab.hunterClearPending")).toBeNull();
    await save();
    expect("hunter_api_key" in sentPayload()).toBe(false);
  });

  it("typing a new key after 'Clear key' replaces it instead of clearing", async () => {
    await renderTab(config({ hunter_api_key_configured: true }));
    fireEvent.click(screen.getByRole("button", { name: "settings.pipelineTab.hunterClear" }));
    fireEvent.change(keyInput(), { target: { value: KEY } });
    await save();
    expect(sentPayload().hunter_api_key).toBe(KEY);
  });

  it("a 503 (no encryption on the server) shows its own message", async () => {
    pipelineApi.updateConfig.mockRejectedValue(Object.assign(new Error("HTTP 503"), {
      response: { status: 503, data: { detail: "PIPELINE_ENCRYPTION_KEY is not set" } },
    }));
    await renderTab();
    fireEvent.change(keyInput(), { target: { value: KEY } });
    await save();
    expect(toast.error).toHaveBeenCalledWith("settings.pipelineTab.toastEncryptionUnavailable");
  });

  it("a failed save logs neither the Hunter key nor the SMTP password", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = Object.assign(new Error("HTTP 400"), {
      config: { data: JSON.stringify({ hunter_api_key: KEY, smtp_password: "pw-sintetica" }) },
      response: { status: 400, data: { detail: "Bad request" } },
    });
    pipelineApi.updateConfig.mockRejectedValue(failure);
    await renderTab();
    fireEvent.change(keyInput(), { target: { value: KEY } });
    fireEvent.change(document.querySelector('input[autocomplete="new-password"]:not([aria-label])'), {
      target: { value: "pw-sintetica" },
    });
    await save();
    const logged = JSON.stringify([...log.mock.calls, ...err.mock.calls], (k, v) => (v instanceof Error ? { ...v, message: v.message } : v));
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("pw-sintetica");
    expect(err).not.toHaveBeenCalled();
    log.mockRestore(); err.mockRestore();
  });
});
