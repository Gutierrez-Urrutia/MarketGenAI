// RNF-03 (CP-172): al guardar una propuesta a la que se le borró el bloque de condiciones comerciales,
// la pantalla advierte «quedará sin condiciones comerciales» antes de guardar; no bloquea el guardado.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const { api } = vi.hoisted(() => ({
  api: { createProposal: vi.fn(), generateProposalById: vi.fn(), updateProposal: vi.fn(), generateDraft: vi.fn(), proposalsApi: { exportFile: vi.fn() } },
}));

vi.mock("react-hot-toast", () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock("html2pdf.js", () => ({ default: () => ({}) }));
vi.mock("@/context/LanguageContext", () => ({ useLanguage: () => ({ language: "es" }), LanguageProvider: ({ children }) => children }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }), ThemeProvider: ({ children }) => children }));
vi.mock("@/api/proposalsApi", () => api);

import { OpportunityProposalModal } from "@/features/proposals/OpportunityProposalModal";
import { proposalHasCommercialTerms } from "@/utils/proposalSections";

const PRICING = '<table class="pricing-table"><thead><tr><th>Servicio</th></tr></thead><tbody><tr><td>Gestores</td></tr></tbody></table>';
const GENERADA = [
  "<h1>Propuesta de Cobranza</h1>",
  "<h2>Resumen Ejecutivo</h2><p>Recuperación de cartera morosa.</p>",
  "<h2>Alcance y Objetivos</h2><ul><li>Cobranza temprana</li></ul>",
  `<h2>Precios y Condiciones Comerciales</h2>${PRICING}<ul><li>Vigencia de la oferta hasta el 30-11-2026</li><li>Forma de pago: 30 días</li></ul>`,
  "<h2>Condiciones Generales</h2><ul><li>Confidencialidad</li></ul>",
].join("");

const opportunity = { id: "opp-1", company: "Financiera Horizonte", job: "Cobranza telefónica", contact: "María", role: "Gerente", kw: ["cobranza"], content: "Cartera morosa" };
const byText = (re) => screen.getAllByRole("button").find((b) => re.test(b.textContent));

async function abrirBorrador() {
  render(<OpportunityProposalModal opportunity={opportunity} onClose={() => {}} />);
  fireEvent.click(byText(/precios|pricing/i));
  fireEvent.click(byText(/borrador|draft/i));
  await screen.findByRole("button", { name: /guardar borrador/i }, { timeout: 8000 });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.createProposal.mockResolvedValue({ id: "p1" });
  api.generateProposalById.mockResolvedValue({ id: "p1", content: GENERADA, status: "generated" });
  api.updateProposal.mockResolvedValue({ id: "p1" });
});

describe("aviso al guardar sin condiciones comerciales (RNF-03)", () => {
  it("la propuesta generada trae las condiciones y se guarda sin aviso", async () => {
    await abrirBorrador();
    fireEvent.click(screen.getByRole("button", { name: /guardar borrador/i }));
    await waitFor(() => expect(api.updateProposal).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(proposalHasCommercialTerms(api.updateProposal.mock.calls[0][1].content)).toBe(true);
  }, 20000);

  it("si se borra el bloque, avisa antes de guardar; volver no guarda y confirmar guarda", async () => {
    await abrirBorrador();
    fireEvent.click(byText(/^editar$|^edit$/i));
    const editor = document.querySelector("[contenteditable]");
    expect(editor).toBeTruthy();
    // El usuario borra todas las condiciones comerciales (deja la tabla de precios).
    editor.querySelectorAll("li").forEach((li) => {
      if (/Vigencia|Forma de pago/.test(li.textContent)) li.remove();
    });
    fireEvent.blur(editor);

    fireEvent.click(screen.getByRole("button", { name: /guardar borrador/i }));
    const dialogo = await screen.findByRole("dialog");
    expect(within(dialogo).getByText(/quedará sin condiciones comerciales/i)).toBeTruthy();
    expect(api.updateProposal).not.toHaveBeenCalled();

    // Volver y editar: el aviso se cierra y no se guardó nada.
    fireEvent.click(within(dialogo).getByRole("button", { name: /volver y editar/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.updateProposal).not.toHaveBeenCalled();

    // Guardar de todos modos: el guardado sigue y la propuesta queda sin condiciones.
    fireEvent.click(screen.getByRole("button", { name: /guardar borrador/i }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /guardar de todos modos/i }));
    await waitFor(() => expect(api.updateProposal).toHaveBeenCalledTimes(1));
    expect(proposalHasCommercialTerms(api.updateProposal.mock.calls[0][1].content)).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  }, 20000);

  it("si solo se editan otras secciones, no avisa", async () => {
    await abrirBorrador();
    fireEvent.click(byText(/^editar$|^edit$/i));
    const editor = document.querySelector("[contenteditable]");
    editor.querySelectorAll("li").forEach((li) => {
      if (/Cobranza temprana/.test(li.textContent)) li.textContent = "Cobranza temprana y preventiva";
    });
    fireEvent.blur(editor);
    fireEvent.click(screen.getByRole("button", { name: /guardar borrador/i }));
    await waitFor(() => expect(api.updateProposal).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  }, 20000);
});
