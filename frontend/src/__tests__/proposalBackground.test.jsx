// RF-VTA-01 (C4): el usuario no queda bloqueado mientras se genera; puede cerrar el modal y recibe un aviso al terminar.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { toast, api } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  api: { createProposal: vi.fn(), generateProposalById: vi.fn(), updateProposal: vi.fn(), generateDraft: vi.fn(), proposalsApi: { exportFile: vi.fn() } },
}));

vi.mock("react-hot-toast", () => ({ default: toast }));
vi.mock("html2pdf.js", () => ({ default: () => ({}) }));
vi.mock("@/context/LanguageContext", () => ({ useLanguage: () => ({ language: "es" }), LanguageProvider: ({ children }) => children }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }), ThemeProvider: ({ children }) => children }));
vi.mock("@/api/proposalsApi", () => api);

import { OpportunityProposalModal } from "@/features/proposals/OpportunityProposalModal";

const opportunity = { id: "opp-1", company: "Financiera Horizonte", job: "Cobranza telefónica", contact: "María", role: "Gerente", kw: ["cobranza"], content: "Cartera morosa" };
const byText = (re) => screen.getAllByRole("button").find((b) => re.test(b.textContent));

const startGeneration = (onClose) => {
  render(<OpportunityProposalModal opportunity={opportunity} onClose={onClose} />);
  fireEvent.click(byText(/precios|pricing/i));
  fireEvent.click(byText(/borrador|draft/i));
};

beforeEach(() => {
  vi.clearAllMocks();
  api.createProposal.mockResolvedValue({ id: "p1" });
});

describe("generación de propuestas en segundo plano", () => {
  it("permite continuar en segundo plano, cierra el modal y avisa al terminar", async () => {
    let finish;
    api.generateProposalById.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const onClose = vi.fn();
    startGeneration(onClose);

    fireEvent.click(await screen.findByRole("button", { name: /segundo plano|background/i }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(api.generateProposalById).toHaveBeenCalled(), { timeout: 8000 });
    finish({ id: "p1", content: "<p>Propuesta</p>", status: "generated" });

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1), { timeout: 8000 });
    expect(toast.success.mock.calls[0][0]).toMatch(/Propuesta lista/);
  });

  it("avisa también si la generación falla con el modal cerrado", async () => {
    api.generateProposalById.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    startGeneration(vi.fn());

    fireEvent.click(await screen.findByRole("button", { name: /segundo plano|background/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1), { timeout: 8000 });
    expect(toast.error.mock.calls[0][0]).toMatch(/No se pudo generar/);
  });

  it("envía el equipo previsto al generar", async () => {
    api.generateProposalById.mockResolvedValue({ id: "p1", content: "<p>x</p>", status: "generated" });
    render(<OpportunityProposalModal opportunity={opportunity} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/equipo previsto/i), { target: { value: "10 agentes, 1 supervisor" } });
    fireEvent.click(byText(/precios|pricing/i));
    fireEvent.click(byText(/borrador|draft/i));
    await waitFor(() => expect(api.generateProposalById).toHaveBeenCalled(), { timeout: 8000 });
    expect(api.generateProposalById.mock.calls[0][1].teamSizing).toBe("10 agentes, 1 supervisor");
  });
});
