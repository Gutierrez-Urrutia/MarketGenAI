// Tarjetas de la Biblioteca de contenido: toda la tarjeta abre la vista previa.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("html2pdf.js", () => ({ default: () => ({}) }));
vi.mock("@/context/LanguageContext", () => ({ useLanguage: () => ({ language: "es" }), LanguageProvider: ({ children }) => children }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }), ThemeProvider: ({ children }) => children }));

const PROPOSAL = {
  id: "p1",
  title: "Propuesta Acme",
  description: "Resumen de la propuesta",
  proposal_status: "borrador",
  status: "generated",
};

const apiGet = vi.fn();
vi.mock("@/api/axios", async (importOriginal) => {
  const actual = await importOriginal();
  const empty = () => Promise.resolve({ data: {} });
  return {
    ...actual,
    default: { ...actual.default, get: (...args) => apiGet(...args), post: vi.fn(empty), put: vi.fn(empty), delete: vi.fn(empty) },
    authTokenStore: { ...actual.authTokenStore, getUser: () => ({ name: "Ana", email: "ana@noondalton.com", roles: ["user"] }) },
  };
});
vi.mock("@/api/proposalsApi", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getProposals: vi.fn(() => Promise.resolve([])), deleteProposal: vi.fn(() => Promise.resolve()) };
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  apiGet.mockImplementation((url) => Promise.resolve({
    data: url === "/content-library" ? { proposals: [PROPOSAL], templates: [], assets: [] } : {},
  }));
});

afterEach(() => vi.restoreAllMocks());

const renderLibrary = async () => {
  const { ContentLibraryPage } = await import("@/views/ContentLibraryPage");
  render(<ContentLibraryPage />);
  return screen.findByTestId("content-card");
};
const previewOpen = () => screen.queryByTestId("proposal-status-control");

describe("ContentLibraryPage: tarjetas", () => {
  it("clic en cualquier parte de la tarjeta abre la vista previa", async () => {
    await renderLibrary();
    expect(previewOpen()).toBeNull();
    fireEvent.click(screen.getByText(/Resumen de la propuesta/));
    await waitFor(() => expect(previewOpen()).toBeTruthy());
  });

  it("el título es un botón enfocable que abre la vista previa", async () => {
    await renderLibrary();
    const titleButton = screen.getByRole("button", { name: "Propuesta Acme" });
    titleButton.focus();
    expect(document.activeElement).toBe(titleButton);
    fireEvent.click(titleButton);
    await waitFor(() => expect(previewOpen()).toBeTruthy());
  });

  it("un botón de acción no abre la vista previa", async () => {
    await renderLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Duplicar: Propuesta Acme" }));
    expect(previewOpen()).toBeNull();
  });

  it("eliminar pide confirmación y, si se cancela, no abre ni borra", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Eliminar: Propuesta Acme" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(previewOpen()).toBeNull();
    expect(screen.getByTestId("content-card")).toBeTruthy();
  });

  it("ya no existe el botón de ver", async () => {
    await renderLibrary();
    expect(screen.queryByRole("button", { name: /^Ver/ })).toBeNull();
    expect(screen.queryByTitle("Ver")).toBeNull();
  });
});
