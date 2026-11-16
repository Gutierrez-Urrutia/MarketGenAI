/**
 * RF-VTA-16, envío real — Configuración › Pipeline › Buzón de envío:
 * interruptor «Envío real de correos» y límite diario (con su propio botón).
 * El estado del buzón y sus botones están en PipelineSettingsTab.mailbox.
 * API mockeada; datos sintéticos.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

vi.mock("@/api/axios", () => ({
  pipelineApi: {
    getConfig: vi.fn(), updateConfig: vi.fn(), createSource: vi.fn(), updateSource: vi.fn(),
    deleteSource: vi.fn(), testSource: vi.fn(),
  },
  mailConnectionApi: {
    status: vi.fn(async () => ({ data: { oauth_configured: true, connected: false, needs_reconnect: false } })),
    start: vi.fn(), test: vi.fn(), delete: vi.fn(),
  },
}));
vi.mock("@/hooks/useI18n", () => ({ useI18n: () => ({ t: (key) => key }) }));
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
  sources: [], keywords: [], industries: [], excluded_companies: [], hunter_api_key_configured: false,
  outreach_real_send_enabled: false, outreach_real_send_server_enabled: true, outreach_daily_send_limit: 20,
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
const saveLimit = async () => {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: `${K}.dailyLimitSaveButton` })); });
  await flush();
};

beforeEach(() => {
  vi.clearAllMocks();
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
  it("muestra el guardado y «Guardar límite» manda solo ese campo", async () => {
    await renderTab();
    expect(limitInput().value).toBe("20");
    fireEvent.change(limitInput(), { target: { value: "35" } });
    await saveLimit();
    expect(pipelineApi.updateConfig).toHaveBeenCalledTimes(1);
    expect(pipelineApi.updateConfig).toHaveBeenCalledWith({ outreach_daily_send_limit: 35 });
    expect(limitInput().value).toBe("35");
    expect(toast.success).toHaveBeenCalledWith(`${K}.dailyLimitSaved`);
  });

  it.each(["0", "101", "2.5", "", "abc"])("fuera de rango (%s) no se envía", async (value) => {
    await renderTab();
    fireEvent.change(limitInput(), { target: { value } });
    await saveLimit();
    expect(pipelineApi.updateConfig).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(`${K}.dailyLimitInvalid`);
  });

  it("si falla el guardado, avisa y deja el valor escrito", async () => {
    await renderTab();
    pipelineApi.updateConfig.mockRejectedValue(Object.assign(new Error(""), { response: { status: 500 } }));
    fireEvent.change(limitInput(), { target: { value: "35" } });
    await saveLimit();
    expect(toast.error).toHaveBeenCalledWith(`${K}.dailyLimitSaveError`);
    expect(limitInput().value).toBe("35");
  });

  it("parseDailyLimit acepta solo enteros entre 1 y 100", () => {
    expect(parseDailyLimit("1")).toBe(1);
    expect(parseDailyLimit(" 100 ")).toBe(100);
    expect(parseDailyLimit("101")).toBeNull();
    expect(parseDailyLimit("-3")).toBeNull();
    expect(parseDailyLimit("1e2")).toBeNull();
  });
});
