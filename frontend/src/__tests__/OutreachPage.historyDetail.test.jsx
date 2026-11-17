/**
 * Historial › «Correos de prospección»: una fila se abre (clic, Enter o
 * Espacio) en un diálogo con el detalle del correo en solo lectura. Sin
 * acciones, sin llamadas de escritura y sin tocar la selección de la cola de
 * revisión. API mockeada; datos sintéticos (example.test).
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

import api, { outreachEmailsApi } from "@/api/axios";
import { fetchOptional } from "@/utils/dashboardData";
import { OutreachPage } from "@/views/OutreachPage";

const flush = () => act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
const email = (id, overrides) => ({
  id, user_id: "u", lead_id: "lead-1", contact_id: `c-${id}`, language: "es", job_title: "Agente",
  company_name: "Empresa Prueba", contact_name: `Contacto ${id}`, to_email: `${id}@example.test`,
  subject: `Asunto ${id}`, body: `Cuerpo ${id}`, history: [], ...overrides,
});
const SENT = email("enviado", {
  status: "sent", send_method: "platform", sent_by: "u-1", sent_by_name: "Usuaria Envío", sent_at: "2026-11-13T03:43:50Z",
});
const REJECTED = email("rechazado", {
  status: "rejected", rejected_by: "u-3", rejected_by_name: "Usuaria Rechazo", rejected_at: "2026-11-13T02:56:19Z",
});
const PENDING = email("pendiente", { status: "pending_review" });

const ACTION_KEYS = [
  "send", "retrySend", "reject", "approve", "markSent", "copy", "regenerate", "doNotContact",
].map((key) => `outreachPage.prospecting.actions.${key}`);
const WRITES = ["approve", "reject", "markSent", "regenerate", "send", "addDoNotContact"];

async function openHistory(items = [SENT, REJECTED, PENDING]) {
  outreachEmailsApi.list.mockResolvedValue({ data: { items } });
  outreachEmailsApi.sendStatus.mockResolvedValue({ data: null });
  outreachEmailsApi.listDoNotContact.mockResolvedValue({ data: { items: [] } });
  fetchOptional.mockResolvedValue({ reviewQueue: [], history: [] });
  render(<OutreachPage onOutreachBadgeChange={vi.fn()} />);
  await flush();
  fireEvent.click(screen.getByText("outreachPage.sentHistory"));
}
const rowOf = (item) => within(screen.getByTestId("prospecting-history")).getByText(item.contact_name).closest("tr");
const dialog = () => screen.queryByRole("dialog");

function expectNoWrites() {
  for (const name of WRITES) expect(outreachEmailsApi[name], name).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
  expect(api.patch).not.toHaveBeenCalled();
  expect(api.delete).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Historial › detalle de un correo de prospección", () => {
  it("las filas se pueden enfocar y anuncian que abren el correo", async () => {
    await openHistory();
    const row = rowOf(SENT);
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("aria-label")).toBe("outreachPage.prospecting.readOnly.openAria");
    expect(dialog()).toBeNull();
  });

  it("un clic en la fila abre el detalle de ese correo", async () => {
    await openHistory();
    fireEvent.click(rowOf(SENT));
    const box = within(dialog());
    expect(box.getByText("outreachPage.prospecting.readOnly.title")).toBeTruthy();
    expect(box.getByTestId("email-subject").textContent).toBe("Asunto enviado");
    expect(box.getByTestId("email-body").textContent).toBe("Cuerpo enviado");
    expect(box.getByText("enviado@example.test")).toBeTruthy();
    expect(box.getByTestId("readonly-status").textContent).toBe("outreachPage.prospecting.readOnly.sentBySystem");
  });

  it("Enter en la fila enfocada abre el detalle", async () => {
    await openHistory();
    const row = rowOf(REJECTED);
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    expect(within(dialog()).getByTestId("email-subject").textContent).toBe("Asunto rechazado");
    expect(within(dialog()).getByTestId("readonly-status").textContent).toBe("outreachPage.prospecting.readOnly.rejected");
  });

  it("Espacio en la fila enfocada abre el detalle", async () => {
    await openHistory();
    const row = rowOf(SENT);
    row.focus();
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    act(() => { row.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(within(dialog()).getByTestId("email-subject").textContent).toBe("Asunto enviado");
  });

  it("otras teclas no abren nada", async () => {
    await openHistory();
    fireEvent.keyDown(rowOf(SENT), { key: "a" });
    expect(dialog()).toBeNull();
  });

  it.each([["enviado", SENT], ["rechazado", REJECTED]])(
    "%s: el detalle no tiene botones de acción, solo Cerrar",
    async (_name, item) => {
      await openHistory();
      fireEvent.click(rowOf(item));
      const box = within(dialog());
      for (const key of ACTION_KEYS) expect(box.queryByText(key), key).toBeNull();
      expect(box.getAllByRole("button")).toHaveLength(1);
      expect(box.getByRole("button", { name: "Close dialog" })).toBeTruthy();
      expect(box.queryByTestId("prospecting-email-detail")).toBeTruthy();
    },
  );

  it("al abrir, el foco entra al diálogo", async () => {
    await openHistory();
    fireEvent.click(rowOf(SENT));
    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  it("Escape cierra el detalle y el foco vuelve a la fila", async () => {
    vi.useFakeTimers();
    try {
      await openHistory();
      const row = rowOf(SENT);
      row.focus();
      fireEvent.keyDown(row, { key: "Enter" });
      expect(dialog()).toBeTruthy();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(dialog()).toBeNull();
      act(() => { vi.runAllTimers(); });
      expect(document.activeElement).toBe(row);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Cerrar cierra el detalle y el foco vuelve a la fila", async () => {
    vi.useFakeTimers();
    try {
      await openHistory();
      const row = rowOf(REJECTED);
      fireEvent.click(row);
      fireEvent.click(within(dialog()).getByRole("button", { name: "Close dialog" }));
      expect(dialog()).toBeNull();
      act(() => { vi.runAllTimers(); });
      expect(document.activeElement).toBe(row);
    } finally {
      vi.useRealTimers();
    }
  });

  it("abrir y cerrar no escribe nada ni cambia la cola de revisión", async () => {
    await openHistory();
    fireEvent.click(rowOf(SENT));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(rowOf(REJECTED), { key: "Enter" });
    fireEvent.keyDown(window, { key: "Escape" });
    expectNoWrites();
    // De vuelta en la cola, sigue mostrándose el correo pendiente, como antes.
    fireEvent.click(screen.getByText("outreachPage.reviewQueue"));
    expect(within(screen.getByTestId("prospecting-email-detail")).getByTestId("email-subject").textContent).toBe("Asunto pendiente");
  });
});
