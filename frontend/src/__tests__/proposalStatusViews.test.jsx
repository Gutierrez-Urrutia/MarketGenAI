// RF-VTA-05: componentes que muestran el estado de propuesta.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("html2pdf.js", () => ({ default: () => ({}) }));
vi.mock("@/context/LanguageContext", () => ({ useLanguage: () => ({ language: "es" }), LanguageProvider: ({ children }) => children }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }), ThemeProvider: ({ children }) => children }));

const apiGet = vi.fn();
const reportsProposals = vi.fn();
vi.mock("@/api/axios", async (importOriginal) => {
  const actual = await importOriginal();
  const empty = () => Promise.resolve({ data: {} });
  return {
    ...actual,
    default: { ...actual.default, get: (...args) => apiGet(...args), post: vi.fn(empty), put: vi.fn(empty), delete: vi.fn(empty) },
    authTokenStore: { ...actual.authTokenStore, getUser: () => ({ name: "Ana", email: "ana@noondalton.com", roles: ["admin"] }) },
    reportsApi: { ...actual.reportsApi, overview: vi.fn(empty), proposals: (...args) => reportsProposals(...args) },
    campaignsApi: { ...actual.campaignsApi, list: vi.fn(() => Promise.resolve({ data: [] })) },
  };
});
vi.mock("@/api/dashboardApi", () => ({ getDashboardData: vi.fn(() => Promise.resolve({})) }));
const getProposalsMock = vi.fn();
vi.mock("@/api/proposalsApi", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getProposals: (...args) => getProposalsMock(...args) };
});

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockResolvedValue({ data: {} });
  localStorage.clear();
});

describe("ProposalStatusControl", () => {
  const renderControl = async (props) => {
    const { ProposalStatusControl } = await import("@/features/proposals/ProposalStatusControl");
    const onChange = vi.fn();
    render(<ProposalStatusControl onChange={onChange} {...props} />);
    return onChange;
  };
  const optionLabels = () => within(screen.getByRole("combobox")).getAllByRole("option").map((o) => o.textContent);

  it("borrador ofrece solo Enviada (más el actual, deshabilitado)", async () => {
    const onChange = await renderControl({ status: "borrador" });
    expect(optionLabels()).toEqual(["Borrador", "Enviada"]);
    expect(within(screen.getByRole("combobox")).getByRole("option", { name: "Borrador" }).disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "enviada" } });
    expect(onChange).toHaveBeenCalledWith("enviada");
  });

  it("enviada ofrece Vista, En negociación y Rechazada", async () => {
    await renderControl({ status: "enviada" });
    expect(optionLabels()).toEqual(["Enviada", "Vista", "En negociación", "Rechazada"]);
  });

  it("rechazada: sin admin no hay selector; con admin solo En negociación", async () => {
    await renderControl({ status: "rechazada", isAdmin: false });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Rechazada")).toBeTruthy();
  });

  it("rechazada como admin ofrece reabrir", async () => {
    await renderControl({ status: "rechazada", isAdmin: true });
    expect(optionLabels()).toEqual(["Rechazada", "En negociación"]);
  });

  it("firmada no tiene selector, tampoco para admin", async () => {
    await renderControl({ status: "firmada", isAdmin: true });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Firmada")).toBeTruthy();
  });

  it("un estado desconocido se muestra con su etiqueta y sin acciones", async () => {
    await renderControl({ status: "Ganada", isAdmin: true });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Desconocido")).toBeTruthy();
  });

  it("mientras se guarda, el selector queda deshabilitado", async () => {
    await renderControl({ status: "vista", pending: true });
    expect(screen.getByRole("combobox").disabled).toBe(true);
  });
});

describe("ReportsPage: desglose por estado", () => {
  it("muestra los códigos con su etiqueta, incluido desconocido, y omite los que no tienen propuestas", async () => {
    reportsProposals.mockResolvedValue({ data: { dimension: "proposal_status", timeSeries: [], data: [
      { label: "borrador", count: 2, totalValue: 0 },
      { label: "en_negociacion", count: 3, totalValue: 160 },
      { label: "firmada", count: 1, totalValue: 1000 },
      { label: "desconocido", count: 1, totalValue: 7 },
    ] } });
    const { ReportsPage } = await import("@/views/ReportsPage");
    render(<ReportsPage onNavigate={() => {}} />);

    await waitFor(() => expect(screen.getByText("En negociación")).toBeTruthy());
    expect(screen.getByText("Borrador")).toBeTruthy();
    expect(screen.getByText("Firmada")).toBeTruthy();
    expect(screen.getByText("Desconocido")).toBeTruthy();
    expect(screen.queryByText("Vista")).toBeNull();
    expect(screen.queryByText("Generada")).toBeNull();
  });
});

describe("AuditLogsPage: proposal_status_changed", () => {
  it("muestra la acción nueva con estados traducidos y deja igual las viejas", async () => {
    apiGet.mockResolvedValue({ data: { logs: [
      { id: "a1", action: "proposal_status_changed", previousStatus: "enviada", newStatus: "vista", userId: "u1", method: "PATCH", path: "/api/v1/proposals/p1/status", timestamp: "2026-10-14T12:00:00+00:00" },
      { id: "a2", action: "created_proposal", userId: "u1", method: "POST", path: "/api/v1/proposals", statusCode: 201, timestamp: "2026-10-14T11:00:00+00:00" },
    ] } });
    const { AuditLogsPage } = await import("@/views/AuditLogsPage");
    render(<AuditLogsPage />);

    await waitFor(() => expect(screen.getByText("Cambio de estado de propuesta")).toBeTruthy());
    expect(screen.getByText("Enviada → Vista")).toBeTruthy();
    expect(screen.getByText("created_proposal")).toBeTruthy();
  });
});

describe("dashboardSnapshot: propuestas aprobadas y enviadas", () => {
  it("cuenta por proposal_status, no por status", async () => {
    getProposalsMock.mockResolvedValue([
      { id: "1", proposal_status: "borrador", status: "generated" },
      { id: "2", proposal_status: "enviada", status: "draft" },
      { id: "3", proposal_status: "vista" },
      { id: "4", proposal_status: "en_negociacion" },
      { id: "5", proposal_status: "firmada" },
      { id: "6", proposal_status: "rechazada" },
      { id: "7", proposal_status: "Ganada", status: "accepted" },
    ]);
    const { buildDashboardMetricsFromSources } = await import("@/features/dashboard/dashboardSnapshot");
    const snapshot = await buildDashboardMetricsFromSources();
    expect(snapshot.quickActions.proposal.approved).toBe(1);
    expect(snapshot.quickActions.proposal.sent).toBe(5);
  });
});
