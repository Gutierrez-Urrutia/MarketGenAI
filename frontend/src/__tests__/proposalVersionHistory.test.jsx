// RF-VTA-11: historial de versiones — lista con fecha y autor, vista previa y restauración.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/context/LanguageContext", () => ({ useLanguage: () => ({ language: "es" }), LanguageProvider: ({ children }) => children }));
vi.mock("@/features/proposals/ProposalDocumentPreview", () => ({
  ProposalDocumentPreview: ({ proposal }) => <div data-testid="preview">{proposal.content}</div>,
}));

const api = vi.hoisted(() => ({
  listProposalVersions: vi.fn(),
  getProposalVersion: vi.fn(),
  createProposalVersion: vi.fn(),
  restoreProposalVersion: vi.fn(),
}));
vi.mock("@/api/proposalsApi", () => api);

const VERSIONS = [
  { id: "v2", version: 2, label: "Version 2", source: "auto", authorName: "Ana Pérez", createdAt: "2026-11-05T12:00:00Z" },
  { id: "v1", version: 1, label: "Initial", source: "auto", authorName: "Luis Gómez", createdAt: "2026-11-04T09:30:00Z" },
];

const renderHistory = async (props = {}) => {
  const { ProposalVersionHistory } = await import("@/features/proposals/ProposalVersionHistory");
  const onClose = vi.fn();
  const onRestored = vi.fn();
  render(
    <ProposalVersionHistory
      proposal={{ id: "p1", title: "Propuesta", proposal_status: "borrador", ...props }}
      onClose={onClose}
      onRestored={onRestored}
    />
  );
  return { onClose, onRestored };
};

describe("ProposalVersionHistory", () => {
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset());
    api.listProposalVersions.mockResolvedValue({ data: { items: VERSIONS, total: 2 } });
    api.getProposalVersion.mockImplementation((_id, versionId) =>
      Promise.resolve({ data: { ...VERSIONS.find((v) => v.id === versionId), title: "Propuesta", content: `<p>contenido ${versionId}</p>` } })
    );
  });
  afterEach(() => cleanup());

  it("lista las versiones con número, autor y fecha", async () => {
    await renderHistory();
    expect(await screen.findByText("v2 · Version 2")).toBeTruthy();
    expect(screen.getByText(/Ana Pérez/)).toBeTruthy();
    expect(screen.getByText(/Luis Gómez/)).toBeTruthy();
    expect(screen.getAllByText("Automática").length).toBe(2);
    expect(api.listProposalVersions).toHaveBeenCalledWith("p1");
  });

  it("muestra el contenido de una versión anterior al seleccionarla", async () => {
    await renderHistory();
    fireEvent.click(await screen.findByText("v1 · Initial"));
    expect((await screen.findByTestId("preview")).textContent).toBe("<p>contenido v1</p>");
    expect(api.getProposalVersion).toHaveBeenCalledWith("p1", "v1");
  });

  it("restaura la versión elegida tras confirmar y avisa al padre", async () => {
    const restoredProposal = { id: "p1", content: "<p>contenido v1</p>" };
    api.restoreProposalVersion.mockResolvedValue({ data: restoredProposal });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onRestored, onClose } = await renderHistory();
    fireEvent.click(await screen.findByText("v1 · Initial"));
    await screen.findByTestId("preview");
    fireEvent.click(screen.getByRole("button", { name: /Restaurar esta versión/ }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(restoredProposal));
    expect(api.restoreProposalVersion).toHaveBeenCalledWith("p1", "v1");
    expect(onClose).toHaveBeenCalled();
  });

  it("no restaura si el usuario cancela la confirmación", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderHistory();
    fireEvent.click(await screen.findByText("v1 · Initial"));
    await screen.findByTestId("preview");
    fireEvent.click(screen.getByRole("button", { name: /Restaurar esta versión/ }));
    expect(api.restoreProposalVersion).not.toHaveBeenCalled();
  });

  it("deshabilita la restauración en una propuesta firmada", async () => {
    await renderHistory({ proposal_status: "firmada" });
    fireEvent.click(await screen.findByText("v1 · Initial"));
    await screen.findByTestId("preview");
    expect(screen.getByRole("button", { name: /Restaurar esta versión/ }).disabled).toBe(true);
  });

  it("Guardar versión crea una versión manual y recarga el listado", async () => {
    api.createProposalVersion.mockResolvedValue({ data: {} });
    await renderHistory();
    await screen.findByText("v2 · Version 2");
    fireEvent.click(screen.getByRole("button", { name: /Guardar versión/ }));
    await waitFor(() => expect(api.createProposalVersion).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(api.listProposalVersions).toHaveBeenCalledTimes(2));
  });

  it("muestra el mensaje del servidor si la restauración falla", async () => {
    api.restoreProposalVersion.mockRejectedValue({ response: { data: { detail: "No puedes restaurar una propuesta ya firmada." } } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderHistory();
    fireEvent.click(await screen.findByText("v1 · Initial"));
    await screen.findByTestId("preview");
    fireEvent.click(screen.getByRole("button", { name: /Restaurar esta versión/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("No puedes restaurar una propuesta ya firmada.");
  });
});
