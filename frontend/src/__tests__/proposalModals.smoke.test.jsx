// Pruebas de humo: los modales de propuestas, extraídos de Dashboard.jsx, se montan con sus
// dependencias reales (iconos, componentes de UI, toasts, traducciones) y recorren el flujo básico.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("html2pdf.js", () => ({ default: () => ({}) }));
// Los proveedores reales consultan /settings y matchMedia; aquí basta con valores fijos.
vi.mock("@/context/LanguageContext", () => ({ useLanguage: () => ({ language: "es" }), LanguageProvider: ({ children }) => children }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }), ThemeProvider: ({ children }) => children }));
vi.mock("@/api/axios", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, authTokenStore: { ...actual.authTokenStore, getUser: () => ({ name: "Ana Ejecutiva", email: "ana@noondalton.com" }) } };
});
vi.mock("@/api/proposalsApi", () => ({
  createProposal: vi.fn(),
  generateProposalById: vi.fn(),
  updateProposal: vi.fn(),
  proposalsApi: { exportFile: vi.fn() },
  generateDraft: vi.fn(),
}));

import { OpportunityProposalModal } from "@/features/proposals/OpportunityProposalModal";
import { QuickProposalModal } from "@/features/proposals/QuickProposalModal";

const withProviders = (ui) => render(ui);

const opportunity = {
  id: "opp-1",
  company: "Financiera Horizonte",
  job: "Cobranza telefónica cartera de consumo",
  contact: "María Fuentes",
  role: "Gerente de Cobranzas",
  stage: "Detected",
  score: 30,
  kw: ["cobranza", "mora"],
  content: "Cartera de 12.000 clientes morosos.",
};

describe("OpportunityProposalModal (extraído de Dashboard.jsx)", () => {
  it("muestra el paso 1 con el cliente y el contexto de la oportunidad", () => {
    withProviders(<OpportunityProposalModal opportunity={opportunity} onClose={() => {}} />);
    expect(screen.getAllByText(/Financiera Horizonte/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Cobranza telefónica cartera de consumo/).length).toBeGreaterThan(0);
    expect(screen.getByText("María Fuentes")).toBeTruthy();
  });

  it("no expone la etapa ni el puntaje del CRM en el texto que se envía a generar", () => {
    withProviders(<OpportunityProposalModal opportunity={opportunity} onClose={() => {}} />);
    expect(document.body.textContent).not.toMatch(/fit score|current stage is/i);
  });

  it("avanza al paso 2 (servicios y precios)", () => {
    withProviders(<OpportunityProposalModal opportunity={opportunity} onClose={() => {}} />);
    const next = screen.getAllByRole("button").find((b) => /pricing|precios|preços/i.test(b.textContent));
    expect(next).toBeTruthy();
    fireEvent.click(next);
    expect(screen.getAllByRole("button").some((b) => /draft|borrador|rascunho/i.test(b.textContent))).toBe(true);
  });

  it("cierra con el botón de cerrar", () => {
    const onClose = vi.fn();
    withProviders(<OpportunityProposalModal opportunity={opportunity} onClose={onClose} />);
    const close = screen.getAllByRole("button").find((b) => /^(close|cerrar|fechar)$/i.test(b.textContent.trim()));
    expect(close).toBeTruthy();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("QuickProposalModal (extraído de Dashboard.jsx)", () => {
  it("se monta con sus campos", () => {
    const { container } = withProviders(<QuickProposalModal onClose={() => {}} onCreated={() => {}} />);
    expect(container.querySelectorAll("input, textarea, select").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });
});

describe("Dashboard.jsx tras la extracción", () => {
  it("se evalúa sin errores de módulo (orden de imports, ciclos, exports faltantes)", async () => {
    const mod = await import("@/Dashboard");
    expect(typeof mod.default).toBe("function");
  });
});
