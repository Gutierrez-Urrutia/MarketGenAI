// RF-VTA-06 (etapa diferida): el documento firmado se ve con un enlace temporal; la URL del archivo no viaja con la propuesta.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/context/LanguageContext", () => ({ useLanguage: () => ({ language: "es" }), LanguageProvider: ({ children }) => children }));

const api = vi.hoisted(() => ({
  getSignedDocumentLink: vi.fn(),
  uploadSignedDocument: vi.fn(),
  removeSignedDocument: vi.fn(),
}));
vi.mock("@/api/proposalsApi", () => api);

const renderAttachment = async (proposal, onChange = vi.fn()) => {
  const { SignedDocumentAttachment } = await import("@/features/proposals/SignedDocumentAttachment");
  render(<SignedDocumentAttachment proposal={proposal} onChange={onChange} />);
  return onChange;
};

describe("SignedDocumentAttachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.open = vi.fn();
  });

  it("sin documento ofrece adjuntarlo", async () => {
    await renderAttachment({ id: "p1", hasSignedDocument: false });
    expect(screen.getByText("Adjuntar documento firmado")).toBeTruthy();
  });

  it("con documento muestra el nombre y, al pulsarlo, abre el enlace temporal que pide al servidor", async () => {
    api.getSignedDocumentLink.mockResolvedValue({ data: { url: "https://storage.example/sign/abc?token=t", expiresIn: 300 } });
    await renderAttachment({ id: "p1", hasSignedDocument: true, signedDocumentName: "contrato.pdf", proposal_status: "en_negociacion" });
    fireEvent.click(screen.getByText("contrato.pdf"));
    await waitFor(() => expect(window.open).toHaveBeenCalledWith("https://storage.example/sign/abc?token=t", "_blank", "noopener,noreferrer"));
    expect(api.getSignedDocumentLink).toHaveBeenCalledWith("p1");
  });

  it("si el servidor no entrega el enlace muestra un error y no abre nada", async () => {
    api.getSignedDocumentLink.mockRejectedValue(new Error("502"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await renderAttachment({ id: "p1", hasSignedDocument: true, signedDocumentName: "contrato.pdf" });
    fireEvent.click(screen.getByText("contrato.pdf"));
    await waitFor(() => expect(screen.getByText("No se pudo guardar el documento firmado.")).toBeTruthy());
    expect(window.open).not.toHaveBeenCalled();
  });

  it("una propuesta firmada permite reemplazar pero no quitar el documento", async () => {
    await renderAttachment({ id: "p1", hasSignedDocument: true, signedDocumentName: "contrato.pdf", proposal_status: "firmada" });
    expect(screen.getByText("Reemplazar")).toBeTruthy();
    expect(screen.queryByText("Quitar")).toBeNull();
  });

  it("no usa una signedDocumentUrl antigua para decidir si hay documento", async () => {
    await renderAttachment({ id: "p1", signedDocumentUrl: "https://publico.example/x.pdf" });
    expect(screen.getByText("Adjuntar documento firmado")).toBeTruthy();
  });
});
