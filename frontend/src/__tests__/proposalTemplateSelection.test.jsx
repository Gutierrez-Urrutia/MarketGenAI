// RF-VTA-07: elegir una plantilla al generar una propuesta desde una oportunidad.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { proposals, templatesApi } = vi.hoisted(() => ({
  proposals: { createProposal: vi.fn(), generateProposalById: vi.fn(), updateProposal: vi.fn(), generateDraft: vi.fn(), proposalsApi: { exportFile: vi.fn() } },
  templatesApi: { list: vi.fn(), catalog: vi.fn() },
}));

vi.mock("react-hot-toast", () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock("html2pdf.js", () => ({ default: () => ({}) }));
vi.mock("@/context/LanguageContext", () => ({ useLanguage: () => ({ language: "es" }), LanguageProvider: ({ children }) => children }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }), ThemeProvider: ({ children }) => children }));
vi.mock("@/api/proposalsApi", () => proposals);
vi.mock("@/api/axios", async (importOriginal) => ({ ...(await importOriginal()), templatesApi }));

import { OpportunityProposalModal } from "@/features/proposals/OpportunityProposalModal";

const CATALOG = {
  serviceTypes: [
    { value: "collections", labels: { es: "Cobranza", en: "Collections", pt: "Cobrança" } },
    { value: "back_office", labels: { es: "Back office", en: "Back office", pt: "Back office" } },
  ],
  industries: [
    { value: "financial_services", labels: { es: "Servicios financieros", en: "Financial services", pt: "Serviços financeiros" } },
    { value: "general", labels: { es: "General", en: "General", pt: "Geral" } },
  ],
  standardVariables: { customer: ["cliente_empresa"], proposal: ["monto_total"] },
  defaultCommercialTerms: { es: "x", en: "x", pt: "x" },
};
const TEMPLATE = {
  id: "t1", name: "Cobranza temprana", type: "proposal", serviceType: "collections", industry: "financial_services",
  content: "Propuesta para {cliente_empresa}: tramo {tramo_mora}", commercialTerms: "Total {monto_total}",
};
const opportunity = { id: "opp-1", company: "Financiera Horizonte", job: "Cobranza telefónica", contact: "María", role: "Gerente", kw: ["cobranza"], content: "Cartera morosa" };
const byText = (re) => screen.getAllByRole("button").find((b) => re.test(b.textContent));

beforeEach(() => {
  vi.clearAllMocks();
  templatesApi.catalog.mockResolvedValue({ data: CATALOG });
  templatesApi.list.mockResolvedValue({ data: { items: [TEMPLATE], total: 1 } });
  proposals.createProposal.mockResolvedValue({ id: "p1" });
  proposals.generateProposalById.mockResolvedValue({ id: "p1", content: "<p>x</p>", status: "generated" });
});

// El modal simula ~4 s de pasos de progreso antes de generar: más margen que los 5 s por defecto.
const SLOW = 20000;

describe("OpportunityProposalModal: plantilla de propuesta", () => {
  it("sin plantilla genera como antes y no envía templateId", async () => {
    render(<OpportunityProposalModal opportunity={opportunity} onClose={() => {}} />);
    await screen.findByRole("option", { name: /Cobranza temprana/ });
    fireEvent.click(byText(/precios|pricing/i));
    fireEvent.click(byText(/borrador|draft/i));
    await waitFor(() => expect(proposals.generateProposalById).toHaveBeenCalled(), { timeout: 8000 });
    const body = proposals.generateProposalById.mock.calls[0][1];
    expect(body.templateId).toBeUndefined();
    expect(body.templateVariables).toBeUndefined();
    expect(body.template).toBe("NoonDalton Standard Proposal");
  }, SLOW);

  it("al elegir una plantilla toma su clasificación, pide sus variables propias y las envía", async () => {
    render(<OpportunityProposalModal opportunity={opportunity} onClose={() => {}} />);
    await screen.findByRole("option", { name: /Cobranza temprana · Cobranza · Servicios financieros/ });
    fireEvent.change(screen.getByRole("combobox", { name: /plantilla|template/i }), { target: { value: "t1" } });

    expect(screen.getByRole("combobox", { name: /servicio|service/i }).value).toBe("collections");
    expect(screen.getByRole("combobox", { name: /industria|industry/i }).value).toBe("financial_services");
    // {cliente_empresa} y {monto_total} son estándar: solo se pide la propia.
    expect(screen.queryByLabelText("{cliente_empresa}")).toBeNull();
    fireEvent.change(screen.getByLabelText("{tramo_mora}"), { target: { value: "30-60 días" } });
    fireEvent.change(screen.getByRole("combobox", { name: /industria|industry/i }), { target: { value: "general" } });

    fireEvent.click(byText(/precios|pricing/i));
    fireEvent.click(byText(/borrador|draft/i));
    await waitFor(() => expect(proposals.generateProposalById).toHaveBeenCalled(), { timeout: 8000 });

    expect(proposals.createProposal.mock.calls[0][0]).toMatchObject({
      templateId: "t1", serviceType: "collections", industry: "general", template: "Cobranza temprana",
    });
    expect(proposals.generateProposalById.mock.calls[0][1]).toMatchObject({
      templateId: "t1", serviceType: "collections", industry: "general",
      templateVariables: { tramo_mora: "30-60 días" },
    });
  }, SLOW);

  it("si no cargan las plantillas, se puede generar igual", async () => {
    templatesApi.list.mockRejectedValue(new Error("offline"));
    templatesApi.catalog.mockRejectedValue(new Error("offline"));
    render(<OpportunityProposalModal opportunity={opportunity} onClose={() => {}} />);
    fireEvent.click(byText(/precios|pricing/i));
    fireEvent.click(byText(/borrador|draft/i));
    await waitFor(() => expect(proposals.generateProposalById).toHaveBeenCalled(), { timeout: 8000 });
  }, SLOW);
});
