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

const flush = () => act(async () => { await Promise.resolve(); });

const renderWith = async (smtpPasswordConfigured) => {
  pipelineApi.getConfig.mockResolvedValue({
    data: { sources: [], is_active: true, smtp_password_configured: smtpPasswordConfigured },
  });
  render(<PipelineSettingsTab />);
  await flush();
  const field = screen.getByText("settings.pipelineTab.passwordLabel").parentElement;
  return { field, input: field.querySelector("input[type=password]") };
};

const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;

beforeEach(() => {
  vi.clearAllMocks();
});

// The password hint used to sit between the label and the input, pushing the
// input below the Username one in the same grid row. It now goes after it.
describe("PipelineSettingsTab SMTP password hint", () => {
  it.each([
    [true, "settings.pipelineTab.passwordConfiguredHint"],
    [false, "settings.pipelineTab.passwordNotConfiguredHint"],
  ])("with configured=%s the hint follows the input and describes it", async (configured, hintKey) => {
    const { field, input } = await renderWith(configured);
    const hint = screen.getByText(hintKey);
    const label = screen.getByText("settings.pipelineTab.passwordLabel");

    expect(input).toBeTruthy();
    expect(field.contains(hint)).toBe(true);
    // label → input → hint, in that order.
    expect(label.compareDocumentPosition(input) & FOLLOWING).toBeTruthy();
    expect(input.compareDocumentPosition(hint) & FOLLOWING).toBeTruthy();

    expect(hint.id).toBeTruthy();
    expect(input.getAttribute("aria-describedby")).toBe(hint.id);
    expect(document.querySelectorAll(`[id="${hint.id}"]`)).toHaveLength(1);
  });

  it("shows only the hint that matches the state", async () => {
    await renderWith(true);
    expect(screen.queryByText("settings.pipelineTab.passwordNotConfiguredHint")).toBeNull();
  });

  it("lays out the SMTP rows in one column, and two from sm up", async () => {
    const { field } = await renderWith(true);
    const row = field.parentElement;
    expect(row.className).toContain("grid-cols-1");
    expect(row.className).toContain("sm:grid-cols-2");
    const card = row.parentElement;
    const rows = [...card.children].filter((el) => el.className.includes("grid"));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.className).toContain("grid-cols-1 sm:grid-cols-2");
    }
  });
});

// The SMTP card has its own «Save account» button: it sends only the SMTP
// fields and resets only this card.
describe("PipelineSettingsTab SMTP card save", () => {
  const SMTP_CONFIG = {
    sources: [], is_active: true, keywords: ["BPO"], industries: [], excluded_companies: [],
    smtp_host: "smtp.ejemplo.test", smtp_port: 587, smtp_user: "ventas@ejemplo.test",
    sender_email: "ventas@ejemplo.test", sender_name: "Equipo Demo",
    smtp_password_configured: false, hunter_api_key_configured: false,
  };
  const SMTP_FIELDS = ["smtp_host", "smtp_port", "smtp_user", "sender_email", "sender_name"];
  const flushAll = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
  const saveButton = () => screen.getByRole("button", { name: "settings.pipelineTab.smtpSaveButton" });
  const passwordInput = () => screen.getByText("settings.pipelineTab.passwordLabel").parentElement.querySelector("input[type=password]");
  const hunterInput = () => screen.getByLabelText("settings.pipelineTab.hunterKeyLabel");

  const renderSmtp = async () => {
    pipelineApi.getConfig.mockResolvedValue({ data: SMTP_CONFIG });
    pipelineApi.updateConfig.mockImplementation(async (payload) => ({
      data: { ...SMTP_CONFIG, ...payload, smtp_password_configured: "smtp_password" in payload },
    }));
    render(<PipelineSettingsTab />);
    await flushAll();
  };

  it("is always enabled and sends only the SMTP fields, trimmed", async () => {
    await renderSmtp();
    expect(saveButton().disabled).toBe(false);
    fireEvent.change(screen.getByDisplayValue("Equipo Demo"), { target: { value: "  Equipo Nuevo  " } });
    await act(async () => { fireEvent.click(saveButton()); });
    await flushAll();

    expect(pipelineApi.updateConfig).toHaveBeenCalledTimes(1);
    const payload = pipelineApi.updateConfig.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual([...SMTP_FIELDS].sort());
    expect(payload.sender_name).toBe("Equipo Nuevo");
    expect(toast.success).toHaveBeenCalledWith("settings.pipelineTab.smtpSaved");
  });

  it("sends the password only when one was typed, then empties it", async () => {
    await renderSmtp();
    fireEvent.change(passwordInput(), { target: { value: "pw-sintetica" } });
    await act(async () => { fireEvent.click(saveButton()); });
    await flushAll();

    expect(pipelineApi.updateConfig.mock.calls[0][0].smtp_password).toBe("pw-sintetica");
    expect(passwordInput().value).toBe("");
    expect(screen.getByText("settings.pipelineTab.passwordConfiguredHint")).toBeTruthy();
  });

  it("keeps today's email validation: an invalid sender email is not sent", async () => {
    await renderSmtp();
    fireEvent.change(screen.getAllByDisplayValue("ventas@ejemplo.test")[1], { target: { value: "no-es-un-correo" } });
    await act(async () => { fireEvent.click(saveButton()); });
    await flushAll();

    expect(pipelineApi.updateConfig).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("settings.pipelineTab.toastInvalidEmail");
  });

  it("does not send or wipe a Hunter key typed in its own card", async () => {
    await renderSmtp();
    fireEvent.change(hunterInput(), { target: { value: "hk-sintetica-0000" } });
    await act(async () => { fireEvent.click(saveButton()); });
    await flushAll();

    expect(pipelineApi.updateConfig.mock.calls[0][0]).not.toHaveProperty("hunter_api_key");
    expect(pipelineApi.updateConfig.mock.calls[0][0]).not.toHaveProperty("is_active");
    expect(hunterInput().value).toBe("hk-sintetica-0000");
  });

  it("a failed save keeps the edits and shows the card's error", async () => {
    await renderSmtp();
    pipelineApi.updateConfig.mockRejectedValue(Object.assign(new Error(""), { response: { status: 500 } }));
    fireEvent.change(screen.getByDisplayValue("smtp.ejemplo.test"), { target: { value: "smtp.otro.test" } });
    await act(async () => { fireEvent.click(saveButton()); });
    await flushAll();

    expect(toast.error).toHaveBeenCalledWith("settings.pipelineTab.smtpSaveError");
    expect(screen.getByDisplayValue("smtp.otro.test")).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
  });

  it("a 503 (no encryption on the server) keeps its own message", async () => {
    await renderSmtp();
    pipelineApi.updateConfig.mockRejectedValue(Object.assign(new Error("HTTP 503"), { response: { status: 503 } }));
    fireEvent.change(passwordInput(), { target: { value: "pw-sintetica" } });
    await act(async () => { fireEvent.click(saveButton()); });
    await flushAll();

    expect(toast.error).toHaveBeenCalledWith("settings.pipelineTab.toastEncryptionUnavailable");
  });

  it("the global button no longer sends the SMTP fields nor resets them", async () => {
    await renderSmtp();
    fireEvent.change(screen.getByDisplayValue("smtp.ejemplo.test"), { target: { value: "smtp.otro.test" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "settings.pipelineTab.saveButton" })); });
    await flushAll();

    const payload = pipelineApi.updateConfig.mock.calls[0][0];
    for (const field of SMTP_FIELDS) expect(payload).not.toHaveProperty(field);
    expect(screen.getByDisplayValue("smtp.otro.test")).toBeTruthy();
  });
});
