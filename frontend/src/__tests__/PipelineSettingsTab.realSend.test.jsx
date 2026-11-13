/**
 * RF-VTA-16, envío real — Configuración › Pipeline › SMTP: badge de la
 * cuenta, interruptor «Envío real de correos», límite diario y «Probar
 * conexión». API mockeada; datos sintéticos.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

vi.mock("@/api/axios", () => ({
  pipelineApi: {
    getConfig: vi.fn(), updateConfig: vi.fn(), createSource: vi.fn(), updateSource: vi.fn(),
    deleteSource: vi.fn(), testSource: vi.fn(), testSmtp: vi.fn(),
  },
}));
vi.mock("@/hooks/useI18n", () => {
  const templates = { "settings.pipelineTab.smtpMissing": "Missing: {fields}." };
  return { useI18n: () => ({ t: (key) => templates[key] ?? key }) };
});
vi.mock("react-hot-toast", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast };
});

import toast from "react-hot-toast";
import { pipelineApi } from "@/api/axios";
import PipelineSettingsTab, { parseDailyLimit } from "@/pages/settings/PipelineSettingsTab";

const K = "settings.pipelineTab";
const flush = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });

const CONFIG = {
  sources: [], keywords: [], industries: [], excluded_companies: [],
  smtp_host: "smtp.example.test", smtp_port: 587, smtp_user: "usuario", sender_email: "ventas@example.test",
  sender_name: "Equipo Demo", smtp_password_configured: true, hunter_api_key_configured: false,
  smtp_configured: true, smtp_missing_fields: [], outreach_real_send_enabled: false,
  outreach_real_send_server_enabled: true, outreach_daily_send_limit: 20,
};

async function renderTab(overrides = {}) {
  const data = { ...CONFIG, ...overrides };
  pipelineApi.getConfig.mockResolvedValue({ data });
  pipelineApi.updateConfig.mockImplementation(async (payload) => ({ data: { ...data, ...payload } }));
  render(<PipelineSettingsTab />);
  await flush();
}

const realSendSwitch = () => screen.getByRole("switch", { name: `${K}.realSendLabel` });
const limitInput = () => screen.getByLabelText(`${K}.dailyLimitLabel`);
const testButton = () => screen.getByRole("button", { name: `${K}.testConnectionButton` });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("badge de la cuenta SMTP", () => {
  it("configurada", async () => {
    await renderTab();
    expect(screen.getByTestId("smtp-account-badge").textContent).toBe(`${K}.smtpConfigured`);
    expect(screen.queryByTestId("smtp-missing-fields")).toBeNull();
  });

  it("incompleta, con los campos que faltan", async () => {
    await renderTab({ smtp_configured: false, smtp_missing_fields: ["smtp_host", "smtp_password"] });
    expect(screen.getByTestId("smtp-account-badge").textContent).toBe(`${K}.smtpIncomplete`);
    expect(screen.getByTestId("smtp-missing-fields").textContent)
      .toBe(`Missing: ${K}.smtpFields.smtp_host, ${K}.smtpFields.smtp_password.`);
  });

  it("se actualiza con la respuesta al guardar la cuenta", async () => {
    await renderTab({ smtp_configured: false, smtp_missing_fields: ["smtp_password"] });
    pipelineApi.updateConfig.mockResolvedValue({ data: { ...CONFIG, smtp_configured: true, smtp_missing_fields: [] } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: `${K}.smtpSaveButton` })); });
    await flush();
    expect(screen.getByTestId("smtp-account-badge").textContent).toBe(`${K}.smtpConfigured`);
  });
});

describe("interruptor «Envío real de correos»", () => {
  it("empieza apagado y al activarlo manda solo ese campo", async () => {
    await renderTab();
    expect(realSendSwitch().getAttribute("aria-checked")).toBe("false");
    await act(async () => { fireEvent.click(realSendSwitch()); });
    await flush();
    expect(pipelineApi.updateConfig).toHaveBeenCalledTimes(1);
    expect(pipelineApi.updateConfig).toHaveBeenCalledWith({ outreach_real_send_enabled: true });
    expect(realSendSwitch().getAttribute("aria-checked")).toBe("true");
    expect(toast.success).toHaveBeenCalledWith(`${K}.realSendSaved`);
  });

  it("si falla el guardado queda como estaba", async () => {
    await renderTab({ outreach_real_send_enabled: true });
    pipelineApi.updateConfig.mockRejectedValue(new Error("x"));
    await act(async () => { fireEvent.click(realSendSwitch()); });
    await flush();
    expect(realSendSwitch().getAttribute("aria-checked")).toBe("true");
    expect(toast.error).toHaveBeenCalled();
  });

  it("muestra la nota cuando el servidor tiene el envío apagado", async () => {
    await renderTab({ outreach_real_send_server_enabled: false });
    expect(screen.getByTestId("real-send-server-off").textContent).toBe(`${K}.realSendServerOff`);
  });

  it("sin nota con el servidor encendido", async () => {
    await renderTab();
    expect(screen.queryByTestId("real-send-server-off")).toBeNull();
  });
});

describe("límite diario", () => {
  it("muestra el guardado y lo envía con la cuenta", async () => {
    await renderTab();
    expect(limitInput().value).toBe("20");
    fireEvent.change(limitInput(), { target: { value: "35" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: `${K}.smtpSaveButton` })); });
    await flush();
    expect(pipelineApi.updateConfig.mock.calls[0][0].outreach_daily_send_limit).toBe(35);
  });

  it.each(["0", "101", "2.5", "", "abc"])("fuera de rango (%s) no se envía", async (value) => {
    await renderTab();
    fireEvent.change(limitInput(), { target: { value } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: `${K}.smtpSaveButton` })); });
    await flush();
    expect(pipelineApi.updateConfig).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(`${K}.dailyLimitInvalid`);
  });

  it("parseDailyLimit acepta solo enteros entre 1 y 100", () => {
    expect(parseDailyLimit("1")).toBe(1);
    expect(parseDailyLimit(" 100 ")).toBe(100);
    expect(parseDailyLimit("101")).toBeNull();
    expect(parseDailyLimit("-3")).toBeNull();
    expect(parseDailyLimit("1e2")).toBeNull();
  });
});

describe("«Probar conexión»", () => {
  it("éxito: llama a testSmtp y avisa", async () => {
    await renderTab();
    pipelineApi.testSmtp.mockResolvedValue({ data: { ok: true } });
    await act(async () => { fireEvent.click(testButton()); });
    await flush();
    expect(pipelineApi.testSmtp).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(`${K}.testConnectionOk`);
    expect(pipelineApi.updateConfig).not.toHaveBeenCalled();
  });

  it.each([
    ["smtp_auth_failed", "smtp_auth_failed"],
    ["smtp_host_blocked", "smtp_host_blocked"],
    ["smtp_not_configured", "smtp_not_configured"],
    ["something_else", "generic"],
  ])("error %s → mensaje %s", async (code, key) => {
    await renderTab();
    pipelineApi.testSmtp.mockRejectedValue({ response: { status: 502, data: { detail: { code } } } });
    await act(async () => { fireEvent.click(testButton()); });
    await flush();
    expect(toast.error).toHaveBeenCalledWith(`${K}.testConnectionErrors.${key}`);
  });

  it("queda desactivado mientras prueba (una sola llamada)", async () => {
    await renderTab();
    let resolve;
    pipelineApi.testSmtp.mockReturnValue(new Promise((r) => { resolve = r; }));
    await act(async () => { fireEvent.click(testButton()); });
    const busy = screen.getByRole("button", { name: `${K}.testingConnection` });
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    await act(async () => { resolve({ data: { ok: true } }); });
    await flush();
    expect(pipelineApi.testSmtp).toHaveBeenCalledTimes(1);
  });
});
