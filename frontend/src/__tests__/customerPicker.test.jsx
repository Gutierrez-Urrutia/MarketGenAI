// RF-VTA-03 (PA-07, PA-12): elegir un cliente propio en el paso 1 de la propuesta.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { customersApi, proposals } = vi.hoisted(() => ({
  customersApi: { options: vi.fn(), list: vi.fn() },
  proposals: { createProposal: vi.fn(), generateProposalById: vi.fn(), updateProposal: vi.fn(), generateDraft: vi.fn(), proposalsApi: { exportFile: vi.fn() } },
}));

vi.mock("react-hot-toast", () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock("html2pdf.js", () => ({ default: () => ({}) }));
vi.mock("@/context/LanguageContext", () => ({ useLanguage: () => ({ language: "es" }), LanguageProvider: ({ children }) => children }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }), ThemeProvider: ({ children }) => children }));
vi.mock("@/api/proposalsApi", () => proposals);
vi.mock("@/api/customersApi", () => ({ customersApi }));
vi.mock("@/api/catalogApi", () => ({ getServices: vi.fn(() => Promise.resolve([])) }));

import { OpportunityProposalModal } from "@/features/proposals/OpportunityProposalModal";

const opportunity = { id: "opp-1", company: "Financiera Horizonte", job: "Cobranza telefónica", contact: "María", role: "Gerente", kw: ["cobranza"], content: "Cartera morosa" };

const BANCO = { id: "c1", name: "Marcela Rojas", email: "marcela@banco-demo.com", company: "Banco Horizonte", industry: "financial_services", size: "large" };
const SIN_PERFIL = { id: "c2", name: "Cliente Antiguo", email: "antiguo@x-demo.com", company: "Antigua SpA", industry: null, size: null };

const OPTIONS = {
  industries: [{ value: "financial_services", labels: { es: "Servicios financieros", en: "Financial services", pt: "Serviços financeiros" } }],
  sizes: [{ value: "large", employees: "200+", labels: { es: "Grande", en: "Large", pt: "Grande" } }],
};

const byText = (re) => screen.getAllByRole("button").find((b) => re.test(b.textContent));
const searchBox = () => screen.getByLabelText("Cliente de la propuesta (opcional)");

const openPicker = async () => {
  fireEvent.focus(searchBox());
  await screen.findByRole("listbox");
};
const pick = async (name) => {
  await openPicker();
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
};

beforeEach(() => {
  vi.clearAllMocks();
  customersApi.options.mockResolvedValue({ data: OPTIONS });
  customersApi.list.mockResolvedValue({ data: { items: [BANCO, SIN_PERFIL], total: 2 } });
  proposals.createProposal.mockResolvedValue({ id: "p1" });
  proposals.generateProposalById.mockResolvedValue({ id: "p1", content: "<p>x</p>", status: "generated" });
  render(<OpportunityProposalModal opportunity={opportunity} onClose={() => {}} />);
});

describe("selector de cliente (paso 1)", () => {
  it("no consulta los clientes hasta que el usuario abre el buscador", () => {
    expect(customersApi.list).not.toHaveBeenCalled();
  });

  it("ofrece los clientes propios con su perfil y la opción «Sin cliente»", async () => {
    await openPicker();
    expect(customersApi.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
    expect(screen.getByRole("button", { name: /Sin cliente/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Marcela Rojas/ }).textContent).toMatch(/Servicios financieros/);
    expect(screen.getByRole("button", { name: /Cliente Antiguo/ }).textContent).toMatch(/Sin definir/);
  });

  it("PA-12: al elegir un cliente muestra su perfil y completa el correo", async () => {
    await pick("Marcela Rojas");
    const card = screen.getByTestId("selected-customer");
    expect(card.textContent).toMatch(/Servicios financieros/);
    expect(card.textContent).toMatch(/Grande/);
    expect(screen.getByPlaceholderText("client@company.com").value).toBe("marcela@banco-demo.com");
  });

  it("PA-05/PA-14: un cliente sin perfil avisa que el borrador no lo supondrá", async () => {
    await pick("Cliente Antiguo");
    expect(screen.getByTestId("selected-customer").textContent).toMatch(/no los supondrá/);
  });

  it("se puede quitar el cliente y volver al buscador", async () => {
    await pick("Marcela Rojas");
    fireEvent.click(screen.getByRole("button", { name: "Quitar cliente" }));
    expect(screen.queryByTestId("selected-customer")).toBeNull();
    expect(searchBox()).toBeTruthy();
  });

  it("si los clientes no cargan avisa y deja continuar sin cliente", async () => {
    customersApi.list.mockRejectedValue(new Error("boom"));
    fireEvent.focus(searchBox());
    expect((await screen.findByRole("alert")).textContent).toMatch(/Puedes continuar sin cliente/);
    expect(byText(/precios|pricing/i)).toBeTruthy();
  });

  it("PA-07: el cliente elegido viaja en la creación y en la generación, con su industria", async () => {
    await pick("Marcela Rojas");
    fireEvent.click(byText(/precios|pricing/i));
    fireEvent.click(byText(/borrador|draft/i));
    await waitFor(() => expect(proposals.generateProposalById).toHaveBeenCalled(), { timeout: 8000 });

    expect(proposals.createProposal.mock.calls[0][0].customerId).toBe("c1");
    expect(proposals.createProposal.mock.calls[0][0].clientEmail).toBe("marcela@banco-demo.com");
    const payload = proposals.generateProposalById.mock.calls[0][1];
    expect(payload.customerId).toBe("c1");
    expect(payload.industry).toBe("financial_services"); // la industria del cliente orienta la plantilla
    // El perfil lo resuelve el servidor desde el cliente guardado: el navegador no lo envía.
    expect(payload).not.toHaveProperty("clientIndustry");
    expect(payload).not.toHaveProperty("clientSize");
  }, 15000);

  it("PA-12: sin cliente el flujo sigue igual y no se envía customerId", async () => {
    fireEvent.click(byText(/precios|pricing/i));
    fireEvent.click(byText(/borrador|draft/i));
    await waitFor(() => expect(proposals.generateProposalById).toHaveBeenCalled(), { timeout: 8000 });
    // undefined: el JSON que viaja al servidor no lo incluye.
    expect(proposals.createProposal.mock.calls[0][0].customerId).toBeUndefined();
    expect(proposals.generateProposalById.mock.calls[0][1].customerId).toBeUndefined();
    expect(JSON.parse(JSON.stringify(proposals.generateProposalById.mock.calls[0][1]))).not.toHaveProperty("customerId");
    expect(customersApi.list).not.toHaveBeenCalled();
  }, 15000);
});
