// RF-VTA-03: la biblioteca («Crear contenido» → Propuesta) permite elegir un cliente propio y
// llega con el cliente ya elegido cuando se abre desde su ficha.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { customersApi, proposals } = vi.hoisted(() => ({
  customersApi: { options: vi.fn(), list: vi.fn() },
  proposals: { createProposal: vi.fn(), generateProposalById: vi.fn(), updateProposal: vi.fn(), getProposals: vi.fn(), deleteProposal: vi.fn(), updateProposalStatus: vi.fn(), sendProposalToCrm: vi.fn() },
}));

vi.mock("html2pdf.js", () => ({ default: () => ({}) }));
vi.mock("@/context/LanguageContext", () => ({ useLanguage: () => ({ language: "es" }), LanguageProvider: ({ children }) => children }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }), ThemeProvider: ({ children }) => children }));
vi.mock("@/api/customersApi", () => ({ customersApi }));
vi.mock("@/api/proposalsApi", async (importOriginal) => ({ ...(await importOriginal()), ...proposals }));
vi.mock("@/api/axios", async (importOriginal) => {
  const actual = await importOriginal();
  const empty = () => Promise.resolve({ data: {} });
  return {
    ...actual,
    default: { ...actual.default, get: vi.fn(empty), post: vi.fn(empty), put: vi.fn(empty), delete: vi.fn(empty) },
    authTokenStore: { ...actual.authTokenStore, getUser: () => ({ name: "Ana", email: "ana@noondalton.com", roles: ["user"] }) },
  };
});

const BANCO = { id: "c1", name: "Marcela Rojas", email: "marcela@banco-demo.com", company: "Banco Horizonte", industry: "financial_services", size: "large" };
const OPTIONS = {
  industries: [{ value: "financial_services", labels: { es: "Servicios financieros", en: "Financial services", pt: "Serviços financeiros" } }],
  sizes: [{ value: "large", employees: "200+", labels: { es: "Grande", en: "Large", pt: "Grande" } }],
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  customersApi.options.mockResolvedValue({ data: OPTIONS });
  customersApi.list.mockResolvedValue({ data: { items: [BANCO], total: 1 } });
  proposals.getProposals.mockResolvedValue([]);
});

const renderLibrary = async (navigationState) => {
  const { ContentLibraryPage } = await import("@/views/ContentLibraryPage");
  render(<ContentLibraryPage navigationState={navigationState} />);
};
const clientInput = () => screen.getByPlaceholderText(/Ingrese nombre del cliente|Enter customer name|Insira o nome do cliente/);

describe("Crear contenido → Propuesta: selector de cliente", () => {
  it("el paso 1 ofrece buscar entre los clientes guardados y al elegir uno completa sus datos", async () => {
    await renderLibrary({ openCreateContentModal: true });
    const search = await screen.findByLabelText("Cliente de la propuesta (opcional)");
    fireEvent.focus(search);
    const list = await screen.findByRole("listbox");
    fireEvent.click(within(list).getByRole("button", { name: /Marcela Rojas/ }));

    const chosen = await screen.findByTestId("selected-customer");
    expect(chosen.textContent).toContain("Marcela Rojas");
    expect(clientInput().value).toBe("Banco Horizonte");
    expect(screen.getByPlaceholderText("client@company.com").value).toBe("marcela@banco-demo.com");
  });

  it("abierto desde la ficha del cliente, la propuesta llega con ese cliente preseleccionado", async () => {
    await renderLibrary({ openCreateContentModal: true, customer: BANCO });
    const chosen = await screen.findByTestId("selected-customer");
    expect(chosen.textContent).toContain("Banco Horizonte");
    await waitFor(() => expect(clientInput().value).toBe("Banco Horizonte"));
    expect(screen.getByPlaceholderText("client@company.com").value).toBe("marcela@banco-demo.com");
    expect(customersApi.list).not.toHaveBeenCalled(); // ya viene elegido: no hace falta buscar
  });

  it("sin cliente elegido el campo de texto sigue funcionando como antes", async () => {
    await renderLibrary({ openCreateContentModal: true });
    await screen.findByLabelText("Cliente de la propuesta (opcional)");
    fireEvent.change(clientInput(), { target: { value: "Cliente nuevo SpA" } });
    expect(clientInput().value).toBe("Cliente nuevo SpA");
    expect(screen.queryByTestId("selected-customer")).toBeNull();
  });

  it("el cliente elegido viaja al crear y al generar la propuesta", async () => {
    proposals.createProposal.mockResolvedValue({ id: "p-new", title: "BPO Proposal for Finance" });
    proposals.generateProposalById.mockResolvedValue({ id: "p-new", title: "BPO Proposal for Finance" });
    await renderLibrary({ openCreateContentModal: true, customer: BANCO });
    await screen.findByTestId("selected-customer");

    fireEvent.click(await screen.findByRole("button", { name: /Continuar a Servicios y Precios|Continue to Services/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Continuar$|^Continue$/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Generar borrador de propuesta|Generate Proposal Draft/i }));
    await waitFor(() => expect(proposals.generateProposalById).toHaveBeenCalled(), { timeout: 8000 });

    expect(proposals.createProposal.mock.calls[0][0].customerId).toBe("c1");
    expect(proposals.generateProposalById.mock.calls[0][1].customerId).toBe("c1");
  }, 15000);
});
