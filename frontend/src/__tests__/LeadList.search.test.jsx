/**
 * Leads — text search by company and job title over the loaded leads.
 * API mocked (it filters by status / min_score like the backend); synthetic
 * data only (example.com, invented companies and titles).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

vi.mock("@/api/axios", () => ({
  leadsApi: {
    list: vi.fn(), get: vi.fn(), searchContacts: vi.fn(), listContacts: vi.fn(), reviewContact: vi.fn(),
  },
  pipelineApi: { runScan: vi.fn(), getRun: vi.fn(), getActiveRun: vi.fn() },
}));
// Keys come back as-is, except the templates whose placeholders the tests read.
vi.mock("@/hooks/useI18n", () => {
  const templates = {
    "leads.searchCount": "{total} loaded",
    "leads.searchMatches": "{n} of {total} loaded",
    "leads.searchStatusSuffix": " with {status}",
    "leads.searchLimit": "searching the {limit} most recent",
    "leads.noMatches": "no lead matches {query}",
    "leads.showing": "showing {from}-{to} of {total}",
  };
  return { useI18n: () => ({ t: (key) => templates[key] ?? key }) };
});
vi.mock("react-hot-toast", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast };
});

import { leadsApi, pipelineApi } from "@/api/axios";
import LeadList from "@/pages/pipeline/LeadList";

const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });

const makeLead = (id, overrides = {}) => ({
  id,
  job_title: `Customer Support Agent ${id}`,
  company_name: "Example Services",
  job_url: `https://jobs.example.com/${id}`,
  relevance_score: 0.9,
  status: "new",
  created_at: "2026-11-05T12:00:00Z",
  ...overrides,
});

const DATA = [
  makeLead("a1", { company_name: "Acme Corp", status: "new", relevance_score: 0.9 }),
  makeLead("a2", { company_name: "Acme Corp", status: "contacts_found", relevance_score: 0.85 }),
  makeLead("a3", { company_name: "ACME Corp ", status: "contacts_found", relevance_score: 0.6 }),
  makeLead("b1", { company_name: "Beta Example Ltd", status: "contacts_found", relevance_score: 0.95 }),
  makeLead("b2", { company_name: "Beta Example Ltd", status: "new" }),
  makeLead("g1", { company_name: "Gamma Ejemplo SpA", job_title: "Agente de Soporte Técnico" }),
  makeLead("g2", { company_name: "Gamma Ejemplo SpA", job_title: "Analista de datos" }),
];

// Like GET /leads: status and min_score are applied by the backend.
function serveLeads(items) {
  leadsApi.list.mockImplementation(async (params = {}) => ({
    data: {
      items: items.filter((lead) => (!params.status || lead.status === params.status)
        && (params.min_score === undefined || (lead.relevance_score ?? 0) >= params.min_score)),
    },
  }));
}

async function renderList(items = DATA) {
  serveLeads(items);
  const utils = render(<LeadList />);
  await flush();
  return utils;
}

const searchBox = () => screen.getByRole("searchbox", { name: "leads.searchLabel" });
const typeSearch = async (text) => { fireEvent.change(searchBox(), { target: { value: text } }); await flush(); };
const rowIds = (container) => [...container.querySelectorAll("tbody tr a")].map((a) => a.getAttribute("href").split("/").pop());
const counter = () => document.getElementById("leads-search-count").textContent;

beforeEach(() => {
  vi.clearAllMocks();
  pipelineApi.getActiveRun.mockResolvedValue({ data: { run: null } });
  leadsApi.listContacts.mockResolvedValue({ data: { items: [], total: 0 } });
});

describe("LeadList search", () => {
  it("(a) a company name leaves only that company's leads and the counter shows how many", async () => {
    const { container } = await renderList();
    expect(counter()).toBe("7 loaded");

    await typeSearch("acme");
    expect(rowIds(container).sort()).toEqual(["a1", "a2", "a3"]);
    expect(counter()).toBe("3 of 7 loaded");
    expect(searchBox().getAttribute("aria-describedby")).toBe("leads-search-count");
  });

  it("(b) searches by job title, ignoring case, accents and extra spaces", async () => {
    const { container } = await renderList();
    await typeSearch("  SOPORTE   tecnico ");
    expect(rowIds(container)).toEqual(["g1"]);
    expect(counter()).toBe("1 of 7 loaded");

    await typeSearch("análista");
    expect(rowIds(container)).toEqual(["g2"]);
  });

  it("(c) combines with the status filter and the minimum score", async () => {
    const { container } = await renderList();
    await typeSearch("acme");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "contacts_found" } });
    await flush();
    expect(leadsApi.list).toHaveBeenLastCalledWith({ limit: 200, status: "contacts_found" });
    expect(rowIds(container).sort()).toEqual(["a2", "a3"]);
    expect(counter()).toBe("2 of 3 loaded with leads.status.contacts_found");

    fireEvent.change(container.querySelector("input[type=number]"), { target: { value: "0.8" } });
    await flush();
    expect(leadsApi.list).toHaveBeenLastCalledWith({ limit: 200, status: "contacts_found", min_score: 0.8 });
    expect(rowIds(container)).toEqual(["a2"]);
    expect(counter()).toBe("1 of 2 loaded with leads.status.contacts_found");
  });

  it("(d) clearing the search brings back every lead", async () => {
    const { container } = await renderList();
    await typeSearch("beta");
    expect(rowIds(container)).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "leads.clearSearch" }));
    await flush();
    expect(searchBox().value).toBe("");
    expect(rowIds(container)).toHaveLength(7);
    expect(counter()).toBe("7 loaded");
    expect(screen.queryByRole("button", { name: "leads.clearSearch" })).toBeNull();
  });

  it("(e) no match shows its own message, not the empty list one", async () => {
    await renderList();
    await typeSearch("zzz-no-existe");
    expect(screen.getByText("no lead matches zzz-no-existe")).toBeTruthy();
    expect(screen.queryByText("leads.empty")).toBeNull();
    expect(counter()).toBe("0 of 7 loaded");
    expect(document.querySelector("tbody")).toBeNull();
  });

  it("(f) with two pages, typing a search goes back to page 1", async () => {
    const many = Array.from({ length: 15 }, (_, i) => makeLead(`m${i + 1}`));
    await renderList(many);
    fireEvent.click(screen.getByRole("button", { name: "common.next" }));
    await flush();
    expect(screen.getByText("showing 11-15 of 15")).toBeTruthy();

    await typeSearch("agent");
    expect(screen.getByText("showing 1-10 of 15")).toBeTruthy();
  });

  it("(g) with 200 leads loaded the counter says the search only sees the most recent", async () => {
    const full = Array.from({ length: 200 }, (_, i) => makeLead(`f${i + 1}`));
    await renderList(full);
    expect(counter()).toBe("200 loadedsearching the 200 most recent");
    await typeSearch("f1");
    expect(counter()).toMatch(/^\d+ of 200 loadedsearching the 200 most recent$/);
  });

  it("(g) under the limit there is no limit notice", async () => {
    await renderList(DATA);
    expect(counter()).not.toContain("most recent");
  });
});
