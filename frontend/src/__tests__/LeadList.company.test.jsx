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

const flush = () => act(async () => { await Promise.resolve(); });

const lead = (overrides) => ({ id: "l1", job_title: "Dev", relevance_score: 0.9, status: "new", ...overrides });

// Company is the 2nd column of the leads table.
const companyCell = (jobTitle) => screen.getByText(jobTitle).closest("tr").querySelectorAll("td")[1];

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
  ])("shows a visual em dash plus screen-reader text when company_name is %s", async (_label, overrides) => {
    leadsApi.list.mockResolvedValue({ data: { items: [lead(overrides)] } });
    render(<LeadList />);
    await flush();

    const cell = companyCell("Dev");
    // The dash is decorative: hidden from assistive tech.
    const dash = within(cell).getByText("—");
    expect(dash.getAttribute("aria-hidden")).toBe("true");
    expect(dash.getAttribute("title")).toBe("leads.unknownCompany");
    // What a screen reader announces instead.
    const srText = within(cell).getByText("leads.unknownCompany");
    expect(srText.className).toContain("sr-only");
    expect(srText.getAttribute("aria-hidden")).toBeNull();
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
