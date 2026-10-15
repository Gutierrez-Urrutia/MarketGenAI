// Pruebas de humo de las páginas extraídas de Dashboard.jsx.
// 1) Cada módulo se evalúa y exporta su componente (detecta imports rotos, ciclos y exports faltantes).
// 2) Las páginas que no dependen de datos remotos se montan y muestran contenido.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("html2pdf.js", () => ({ default: () => ({}) }));
vi.mock("@/context/LanguageContext", () => ({ useLanguage: () => ({ language: "es" }), LanguageProvider: ({ children }) => children }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }), ThemeProvider: ({ children }) => children }));
vi.mock("@/api/axios", async (importOriginal) => {
  const actual = await importOriginal();
  const empty = () => Promise.resolve({ data: {} });
  const list = () => Promise.resolve({ data: [] });
  return {
    ...actual,
    default: { ...actual.default, get: vi.fn(empty), post: vi.fn(empty), put: vi.fn(empty), delete: vi.fn(empty) },
    authTokenStore: { ...actual.authTokenStore, getUser: () => ({ name: "Ana", email: "ana@noondalton.com", roles: ["admin"] }) },
    reportsApi: { ...actual.reportsApi },
    opportunitiesApi: { list, create: vi.fn(empty), update: vi.fn(empty), delete: vi.fn(empty) },
  };
});

const MODULES = {
  "@/views/AuditLogsPage": "AuditLogsPage",
  "@/views/ReportsPage": "ReportsPage",
  "@/views/AssistantPage": "AssistantPage",
  "@/views/CampaignBriefPage": "CampaignBriefPage",
  "@/views/OpportunitiesPage": "OpportunitiesPage",
  "@/views/OutreachPage": "OutreachPage",
  "@/views/SettingsPage": "SettingsPage",
  "@/views/DashboardPage": "DashboardPage",
  "@/views/ContentGeneratorPage": "ContentGeneratorPage",
  "@/views/ContentLibraryPage": "ContentLibraryPage",
  "@/features/campaigns/CampaignWizard": "CampaignWizard",
  "@/features/books/BookConceptsExperience": "BookConceptsExperience",
  "@/features/opportunities/CreateOpportunityModal": "CreateOpportunityModal",
  "@/legacy/CampaignModal": "CampaignModal",
  "@/legacy/OutreachPageLegacy": "OutreachPageLegacy",
};

describe("módulos de páginas extraídos de Dashboard.jsx", () => {
  for (const [path, exportName] of Object.entries(MODULES)) {
    it(`${path} exporta ${exportName}`, async () => {
      const mod = await import(/* @vite-ignore */ path);
      expect(typeof mod[exportName]).toBe("function");
    });
  }
});

describe("montaje de páginas simples", () => {
  beforeEach(() => vi.clearAllMocks());

  it("CampaignBriefPage se monta", async () => {
    const { CampaignBriefPage } = await import("@/views/CampaignBriefPage");
    const { container } = render(<CampaignBriefPage onNavigate={() => {}} campaignFlow={null} setCampaignFlow={() => {}} />);
    expect(container.querySelectorAll("input, textarea, select, button").length).toBeGreaterThan(0);
  });

  it("AuditLogsPage se monta para un admin y consulta los registros", async () => {
    const api = (await import("@/api/axios")).default;
    const { AuditLogsPage } = await import("@/views/AuditLogsPage");
    render(<AuditLogsPage />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
  });

  it("OpportunitiesPage se monta y pide las oportunidades", async () => {
    const { opportunitiesApi } = await import("@/api/axios");
    const { OpportunitiesPage } = await import("@/views/OpportunitiesPage");
    const listSpy = vi.spyOn(opportunitiesApi, "list");
    render(<OpportunitiesPage navigationState={{}} onNavigate={() => {}} campaignFlow={null} setCampaignFlow={() => {}} />);
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });
});
