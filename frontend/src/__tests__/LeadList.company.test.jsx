import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, within } from "@testing-library/react";

vi.mock("@/api/axios", () => ({
  leadsApi: { list: vi.fn() },
  pipelineApi: { runScan: vi.fn(), getRun: vi.fn(), getActiveRun: vi.fn() },
}));
vi.mock("@/hooks/useI18n", () => ({ useI18n: () => ({ t: (key) => key }) }));
vi.mock("react-hot-toast", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast };
});

import { leadsApi, pipelineApi } from "@/api/axios";
import LeadList from "@/pages/pipeline/LeadList";
import { translations } from "@/i18n/translations";

const flush = () => act(async () => { await Promise.resolve(); });

const lead = (overrides) => ({ id: "l1", job_title: "Dev", relevance_score: 0.9, status: "new", ...overrides });

// Company is the 3rd column of the leads table (after "#" and title).
const companyCell = (jobTitle) => screen.getByText(jobTitle).closest("tr").querySelectorAll("td")[2];

beforeEach(() => {
  vi.clearAllMocks();
  pipelineApi.getActiveRun.mockResolvedValue({ data: { run: null } });
});

describe("LeadList company column", () => {
  it.each([
    ["an empty string", { company_name: "" }],
    ["only whitespace", { company_name: "   " }],
    ["null", { company_name: null }],
    ["a missing field", {}],
  ])("shows a visible «company not provided» text when company_name is %s (RF14-D-003)", async (_label, overrides) => {
    leadsApi.list.mockResolvedValue({ data: { items: [lead(overrides)] } });
    render(<LeadList />);
    await flush();

    const cell = companyCell("Dev");
    // Visible for everyone (not only screen readers) and no bare dash.
    const text = within(cell).getByText("leads.unknownCompany");
    expect(text.className).not.toContain("sr-only");
    expect(text.getAttribute("aria-hidden")).toBeNull();
    expect(within(cell).queryByText("—")).toBeNull();
  });

  it("shows the company name when there is one", async () => {
    leadsApi.list.mockResolvedValue({ data: { items: [lead({ company_name: "Acme" })] } });
    render(<LeadList />);
    await flush();

    const cell = companyCell("Dev");
    expect(cell.textContent).toBe("Acme");
    expect(within(cell).queryByText("—")).toBeNull();
    expect(within(cell).queryByText("leads.unknownCompany")).toBeNull();
  });
});

describe("LeadList company-not-provided text (RF14-D-003)", () => {
  it.each([["es", "Empresa no indicada"], ["en", "Company not provided"], ["pt", "Empresa não informada"]])("reads %s → %s", (lang, texto) => {
    expect(translations[lang].leads.unknownCompany).toBe(texto);
  });
});
