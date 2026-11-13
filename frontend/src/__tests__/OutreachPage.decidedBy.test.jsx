/**
 * RF-VTA-16, envío real — Historial › «Correos de prospección»: la columna
 * «Decidido por» muestra quién cerró el correo según cómo se cerró (enviado
 * por SMTP, marcado a mano, rechazado) y nunca un id técnico. API mockeada;
 * datos sintéticos.
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

import { outreachEmailsApi } from "@/api/axios";
import { fetchOptional } from "@/utils/dashboardData";
import { OutreachPage } from "@/views/OutreachPage";

const flush = () => act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
const closed = (id, overrides) => ({
  id, user_id: "u", lead_id: "lead-1", contact_id: `c-${id}`, language: "es", job_title: "Agente",
  company_name: "Empresa Prueba", contact_name: `Contacto ${id}`, to_email: `${id}@example.test`,
  subject: `Asunto ${id}`, body: "Cuerpo", history: [], ...overrides,
});

async function decidedByOf(email) {
  outreachEmailsApi.list.mockResolvedValue({ data: { items: [email] } });
  outreachEmailsApi.sendStatus.mockResolvedValue({ data: null });
  outreachEmailsApi.listDoNotContact.mockResolvedValue({ data: { items: [] } });
  fetchOptional.mockResolvedValue({ reviewQueue: [], history: [] });
  render(<OutreachPage onOutreachBadgeChange={vi.fn()} />);
  await flush();
  fireEvent.click(screen.getByText("outreachPage.sentHistory"));
  const row = within(screen.getByTestId("prospecting-history")).getByText(email.contact_name).closest("tr");
  return within(row).getByTestId("prospecting-decided-by").textContent;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("«Decidido por» en el historial de correos de prospección", () => {
  it("enviado por SMTP: quien lo envió (sent_by_name)", async () => {
    expect(await decidedByOf(closed("smtp", {
      status: "sent", send_method: "smtp", sent_by: "u-1", sent_by_name: "Usuaria Envío", sent_at: "2026-11-13T03:43:50Z",
    }))).toBe("Usuaria Envío");
  });

  it("marcado como enviado a mano: quien lo marcó (sent_marked_by_name)", async () => {
    expect(await decidedByOf(closed("manual", {
      status: "sent", send_method: "manual", sent_marked_by: "u-2", sent_marked_by_name: "Usuario Marca",
      sent_at: "2026-11-13T03:00:00Z",
    }))).toBe("Usuario Marca");
  });

  it("marcado antes del envío real (sin send_method): también sent_marked_by_name", async () => {
    expect(await decidedByOf(closed("legacy", {
      status: "sent", sent_marked_by: "u-2", sent_marked_by_name: "Usuario Antiguo", sent_at: "2026-11-01T10:00:00Z",
    }))).toBe("Usuario Antiguo");
  });

  it("rechazado: quien lo rechazó (rejected_by_name)", async () => {
    expect(await decidedByOf(closed("rechazo", {
      status: "rejected", rejected_by: "u-3", rejected_by_name: "Usuaria Rechazo", rejected_at: "2026-11-13T02:56:19Z",
    }))).toBe("Usuaria Rechazo");
  });

  it("sin nombre legible (vacío o igual al id) muestra un texto, no el id", async () => {
    expect(await decidedByOf(closed("sin-nombre", {
      status: "sent", send_method: "smtp", sent_by: "local-dev-admin", sent_by_name: "local-dev-admin",
      sent_at: "2026-11-13T03:43:50Z",
    }))).toBe("outreachPage.prospecting.table.unknownUser");
  });
});
