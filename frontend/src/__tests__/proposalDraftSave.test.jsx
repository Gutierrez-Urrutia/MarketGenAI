// Guardar una propuesta como borrador sin generarla: se crea en el servidor (id real) y se puede regenerar.
// Antes se guardaba solo en el navegador con un id inventado (manual-proposal-…) y al regenerar la API respondía «proposal not found».
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { proposals, customersApi } = vi.hoisted(() => ({
  proposals: { createProposal: vi.fn(), generateProposalById: vi.fn(), updateProposal: vi.fn(), getProposals: vi.fn(), deleteProposal: vi.fn(), updateProposalStatus: vi.fn(), sendProposalToCrm: vi.fn() },
  customersApi: { options: vi.fn(), list: vi.fn() },
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

import { LOCAL_PROPOSAL_ID_PREFIX, deleteLocalContentProposal, isLocalProposalId, readLocalContentProposals, saveLocalContentProposal } from "@/utils/localStore";

const LOCAL_KEY = "marketgen_local_content_library_proposals"; // clave real de localStore.js

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  customersApi.options.mockResolvedValue({ data: { industries: [], sizes: [] } });
  customersApi.list.mockResolvedValue({ data: { items: [], total: 0 } });
  proposals.getProposals.mockResolvedValue([]);
});

const renderLibrary = async (navigationState = { openCreateContentModal: true }) => {
  const { ContentLibraryPage } = await import("@/views/ContentLibraryPage");
  render(<ContentLibraryPage navigationState={navigationState} />);
};
const fillClient = async (name) => {
  const input = await screen.findByPlaceholderText(/Ingrese nombre del cliente|Enter customer name|Insira o nome do cliente/);
  fireEvent.change(input, { target: { value: name } });
};
const saveDraft = () => fireEvent.click(screen.getByRole("button", { name: /Guardar borrador|Save as Draft|Salvar rascunho/i }));

describe("Guardar borrador de propuesta", () => {
  it("lo crea en el servidor como borrador y no deja una copia solo local con id inventado", async () => {
    proposals.createProposal.mockResolvedValue({ id: "srv-1", title: "BPO Proposal for Finance", proposal_status: "borrador" });
    await renderLibrary();
    await fillClient("Cliente Demo");
    saveDraft();

    await waitFor(() => expect(proposals.createProposal).toHaveBeenCalledTimes(1));
    const body = proposals.createProposal.mock.calls[0][0];
    expect(body.status).toBe("draft");
    expect(body.clientName).toBe("Cliente Demo");
    expect(proposals.generateProposalById).not.toHaveBeenCalled(); // guardar no genera
    expect(readLocalContentProposals()).toEqual([]);
    expect(localStorage.getItem(LOCAL_KEY) || "").not.toContain(LOCAL_PROPOSAL_ID_PREFIX);
  });

  it("si el servidor falla, avisa y no guarda un borrador fantasma en el navegador", async () => {
    proposals.createProposal.mockRejectedValue(new Error("boom"));
    await renderLibrary();
    await fillClient("Cliente Demo");
    saveDraft();

    await waitFor(() => expect(proposals.createProposal).toHaveBeenCalled());
    await waitFor(() => expect(readLocalContentProposals()).toEqual([]));
  });
});

describe("borradores locales antiguos", () => {
  it("se reconocen por su id y se pueden quitar del navegador", () => {
    expect(isLocalProposalId("manual-proposal-1730000000000")).toBe(true);
    expect(isLocalProposalId("0ea56db4-1647-478c-a9d7-a76912c04d24")).toBe(false);
    expect(isLocalProposalId(undefined)).toBe(false);

    saveLocalContentProposal({ id: "manual-proposal-1", title: "Viejo" });
    saveLocalContentProposal({ id: "manual-proposal-2", title: "Otro" });
    deleteLocalContentProposal("manual-proposal-1");
    expect(readLocalContentProposals().map((p) => p.id)).toEqual(["manual-proposal-2"]);
  });
});
