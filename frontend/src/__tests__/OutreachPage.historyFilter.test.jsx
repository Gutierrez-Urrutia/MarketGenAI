/**
 * RF-VTA-16 (defecto RF16-D-002) — the status filter of «Historial enviado» also applies to the
 * «Correos de prospección» table, and the older history table (with no rows) is not drawn as an
 * empty header row above it. API mocked; synthetic data only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";

vi.mock("@/api/axios", () => {
  const api = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  return {
    default: api,
    campaignsApi: { update: vi.fn() },
    outreachEmailsApi: { list: vi.fn(), approve: vi.fn(), reject: vi.fn(), markSent: vi.fn(), regenerate: vi.fn() },
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

const flush = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
const email = (id, status) => ({
  id, user_id: "u", lead_id: "lead-1", contact_id: `c-${id}`, status, language: "en",
  job_title: "Support Agent", company_name: "Example Services", contact_name: `Ana ${id}`,
  contact_job_title: "Head of Support", to_email: `ana.${id}@example.com`, contact_review_status: "not_required",
  subject: `Subject ${id}`, body: `Body of ${id}`, history: [], sent_at: "2026-11-11T12:00:00Z", rejected_at: "2026-11-11T12:00:00Z",
});

async function openHistory({ emails, history = [] }) {
  outreachEmailsApi.list.mockResolvedValue({ data: { items: emails } });
  fetchOptional.mockResolvedValue({ reviewQueue: [], history });
  render(<OutreachPage onOutreachBadgeChange={vi.fn()} />);
  await flush();
  fireEvent.click(screen.getByText("outreachPage.sentHistory"));
}
const names = () => within(screen.getByTestId("prospecting-history")).queryAllByTestId("prospecting-history-row").map((row) => row.textContent);

beforeEach(() => vi.clearAllMocks());

describe("historial: filtro por estado", () => {
  it("«Enviados» deja solo los enviados y «Rechazados» solo los rechazados", async () => {
    await openHistory({ emails: [email("p1", "sent"), email("p2", "rejected"), email("p3", "sent")] });
    expect(names()).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "outreachPage.filters.sent" }));
    expect(names()).toHaveLength(2);
    expect(names().join(" ")).not.toContain("Ana p2");

    fireEvent.click(screen.getByRole("button", { name: "outreachPage.filters.rejected" }));
    expect(names()).toHaveLength(1);
    expect(names()[0]).toContain("Ana p2");

    fireEvent.click(screen.getByRole("button", { name: "outreachPage.filters.all" }));
    expect(names()).toHaveLength(3);
  });

  it("un filtro sin correos muestra el aviso de vacío y no una tabla sin filas", async () => {
    await openHistory({ emails: [email("p1", "sent")] });
    fireEvent.click(screen.getByRole("button", { name: "outreachPage.filters.rejected" }));
    expect(screen.queryByTestId("prospecting-history")).toBeNull();
    expect(screen.getByText("outreachPage.prospecting.table.empty")).toBeTruthy();
  });
});

describe("historial: tabla antigua", () => {
  it("sin filas no se dibuja la fila de encabezados", async () => {
    await openHistory({ emails: [email("p1", "sent")], history: [] });
    expect(screen.queryByText("outreachPage.columns.contentUsed")).toBeNull();
  });

  it("con filas se sigue dibujando y respeta el filtro", async () => {
    const old = { id: "h1", name: "Old Contact", co: "Old Co", subj: "Old", st: "Sent", status: "sent", score: 50 };
    await openHistory({ emails: [], history: [old] });
    expect(screen.getByText("outreachPage.columns.contentUsed")).toBeTruthy();
    expect(screen.getByText("Old Contact")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "outreachPage.filters.rejected" }));
    expect(screen.queryByText("Old Contact")).toBeNull();
    expect(screen.queryByText("outreachPage.columns.contentUsed")).toBeNull();
  });
});
