/**
 * RF-VTA-16, envío real — «Alcance» (OutreachPage) con la API mockeada:
 * send-status, envío, doble clic, envío incierto, «no contactar». Ninguna
 * llamada real; datos sintéticos (example.com, nombres inventados).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";

vi.mock("@/api/axios", () => {
  const api = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  return {
    default: api,
    campaignsApi: { update: vi.fn() },
    outreachEmailsApi: {
      list: vi.fn(), approve: vi.fn(), reject: vi.fn(), markSent: vi.fn(), regenerate: vi.fn(),
      send: vi.fn(), sendStatus: vi.fn(), listDoNotContact: vi.fn(), addDoNotContact: vi.fn(),
    },
  };
});
vi.mock("@/utils/dashboardData", () => ({ fetchOptional: vi.fn() }));
vi.mock("@/hooks/useI18n", () => ({ useI18n: () => ({ t: (key) => key }) }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("react-hot-toast", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast };
});

import toast from "react-hot-toast";
import { outreachEmailsApi } from "@/api/axios";
import { fetchOptional } from "@/utils/dashboardData";
import { OutreachPage } from "@/views/OutreachPage";

const KP = "outreachPage.prospecting";
const flush = () => act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });

const READY = {
  smtp_configured: true, smtp_missing_fields: [], server_send_enabled: true, user_send_enabled: true,
  real_send_enabled: true, daily_limit: 50, sent_today: 0, sender_email: "ventas@example.com", sender_name: "",
};
const approved = (overrides = {}) => ({
  id: "e1", user_id: "u", lead_id: "lead-1", contact_id: "c-1", status: "approved", language: "en",
  job_title: "Support Agent", company_name: "Example Services", contact_name: "Ana Prueba",
  to_email: "ana@example.com", contact_review_status: "not_required", subject: "Subject", body: "Body",
  history: [], unsubscribe_line: "If you would prefer not to receive further emails…", ...overrides,
});
const apiError = (status, code) => Object.assign(new Error(code), { response: { status, data: { detail: { code } } } });

async function renderPage({ emails = [approved()], status = READY, entries = [], onNavigate = vi.fn() } = {}) {
  outreachEmailsApi.list.mockResolvedValue({ data: { items: emails } });
  if (status instanceof Error) outreachEmailsApi.sendStatus.mockRejectedValue(status);
  else outreachEmailsApi.sendStatus.mockResolvedValue({ data: status });
  outreachEmailsApi.listDoNotContact.mockResolvedValue({ data: { items: entries, total: entries.length } });
  fetchOptional.mockResolvedValue({ reviewQueue: [], history: [] });
  render(<OutreachPage onNavigate={onNavigate} onOutreachBadgeChange={vi.fn()} />);
  await flush();
  fireEvent.click(screen.getAllByTestId("prospecting-item")[0]);
  await flush();
  return { onNavigate };
}

const detail = () => screen.getByTestId("prospecting-email-detail");
const sendButton = () => within(detail()).getByRole("button", { name: `${KP}.actions.send` });
const confirmSend = async () => {
  fireEvent.click(sendButton());
  const dialog = screen.getByRole("dialog");
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: `${KP}.send.confirmButton` })); });
  await flush();
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("envío real desde Alcance", () => {
  it("carga send-status y la lista «no contactar» al abrir", async () => {
    await renderPage();
    expect(outreachEmailsApi.sendStatus).toHaveBeenCalledTimes(1);
    expect(outreachEmailsApi.listDoNotContact).toHaveBeenCalledTimes(1);
    expect(sendButton().disabled).toBe(false);
  });

  it("un envío correcto reemplaza el correo, avisa y recarga el cupo", async () => {
    await renderPage();
    outreachEmailsApi.send.mockResolvedValue({ data: approved({ status: "sent", send_method: "smtp", sent_by_name: "Usuaria Demo" }) });
    await confirmSend();
    expect(outreachEmailsApi.send).toHaveBeenCalledWith("e1", { confirmToEmail: "ana@example.com", forceRetry: false });
    expect(toast.success).toHaveBeenCalledWith(`${KP}.messages.smtpSent`);
    expect(outreachEmailsApi.sendStatus).toHaveBeenCalledTimes(2);
  });

  it("dos confirmaciones seguidas envían una sola vez", async () => {
    await renderPage();
    let resolve;
    outreachEmailsApi.send.mockReturnValue(new Promise((r) => { resolve = r; }));
    fireEvent.click(sendButton());
    const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: `${KP}.send.confirmButton` });
    await act(async () => { fireEvent.click(confirm); });
    // While sending the button is disabled; a second attempt does nothing.
    const busy = within(detail()).getByRole("button", { name: `${KP}.actions.sending` });
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { resolve({ data: approved({ status: "sent", send_method: "smtp" }) }); });
    await flush();
    expect(outreachEmailsApi.send).toHaveBeenCalledTimes(1);
  });

  it("un timeout incierto muestra el error y recarga la lista", async () => {
    await renderPage();
    outreachEmailsApi.send.mockRejectedValue(apiError(504, "smtp_timeout"));
    await confirmSend();
    expect(toast.error).toHaveBeenCalledWith(`${KP}.errors.smtp_timeout`);
    expect(outreachEmailsApi.list).toHaveBeenCalledTimes(2);
  });

  it("un corte de axios también recarga la lista (el correo pudo haber salido)", async () => {
    await renderPage();
    outreachEmailsApi.send.mockRejectedValue(Object.assign(new Error("timeout"), { code: "ECONNABORTED" }));
    await confirmSend();
    expect(toast.error).toHaveBeenCalledWith(`${KP}.errors.timeout`);
    expect(outreachEmailsApi.list).toHaveBeenCalledTimes(2);
  });

  it("si send-status falla, «Enviar» queda desactivado y la página sigue funcionando", async () => {
    await renderPage({ status: new Error("down") });
    expect(sendButton().disabled).toBe(true);
    expect(within(detail()).getByTestId("send-block-note").textContent).toBe(`${KP}.send.blocked.loading`);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("con la cuenta incompleta el aviso lleva a Configuración › Pipeline", async () => {
    const { onNavigate } = await renderPage({ status: { ...READY, smtp_configured: false, smtp_missing_fields: ["smtp_host"] } });
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(within(detail()).getByRole("button", { name: `${KP}.send.openSettings` }));
    expect(onNavigate).toHaveBeenCalledWith("settings", { tab: "pipeline" });
  });

  it("un destinatario de la lista desactiva «Enviar» y muestra la marca", async () => {
    await renderPage({ entries: [{ id: "d1", kind: "domain", value: "example.com" }] });
    expect(sendButton().disabled).toBe(true);
    expect(within(detail()).getByTestId("do-not-contact-mark")).toBeTruthy();
  });

  it("«No volver a contactar» agrega la entrada y desactiva «Enviar»", async () => {
    await renderPage();
    outreachEmailsApi.addDoNotContact.mockResolvedValue({ data: { id: "d9", kind: "email", value: "ana@example.com" } });
    fireEvent.click(within(detail()).getByRole("button", { name: `${KP}.actions.doNotContact` }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: `${KP}.doNotContact.confirmButton` }));
    });
    await flush();
    expect(outreachEmailsApi.addDoNotContact).toHaveBeenCalledWith({ emailId: "e1" });
    expect(toast.success).toHaveBeenCalledWith(`${KP}.messages.doNotContactAdded`);
    expect(sendButton().disabled).toBe(true);
  });

  it("reintentar tras un envío incierto manda force_retry solo después de confirmar", async () => {
    await renderPage({ emails: [approved({ send_lock: { id: "l", at: "2026-11-12T15:00:00Z", uncertain: true } })] });
    outreachEmailsApi.send.mockResolvedValue({ data: approved({ status: "sent", send_method: "smtp" }) });
    fireEvent.click(within(detail()).getByRole("button", { name: `${KP}.actions.retrySend` }));
    expect(outreachEmailsApi.send).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: `${KP}.send.retryButton` }));
    });
    await flush();
    expect(outreachEmailsApi.send).toHaveBeenCalledWith("e1", { confirmToEmail: "ana@example.com", forceRetry: true });
  });
});
