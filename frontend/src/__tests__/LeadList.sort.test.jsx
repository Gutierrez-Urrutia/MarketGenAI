import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";

vi.mock("@/api/axios", () => ({
  leadsApi: { list: vi.fn() },
  pipelineApi: { runScan: vi.fn(), getRun: vi.fn(), getActiveRun: vi.fn() },
}));
// Status labels whose alphabetical order differs from the status keys' order.
const LABELS = {
  "leads.status.new": "Nuevo",
  "leads.status.approved": "Aprobado",
  "leads.status.sent": "Enviado",
  "leads.sortBy": "sort by {column}",
};
vi.mock("@/hooks/useI18n", () => ({ useI18n: () => ({ t: (key) => LABELS[key] ?? key }) }));
vi.mock("react-hot-toast", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast };
});

import { leadsApi, pipelineApi } from "@/api/axios";
import LeadList, { sortLeads, nextSort } from "@/pages/pipeline/LeadList";
import { translations } from "@/i18n/translations";

const flush = () => act(async () => { await Promise.resolve(); });

// As the backend sends them: found, newest first.
const LEADS = [
  { id: "c", job_title: "Contact Center Agent", company_name: "beta corp", relevance_score: 0.7, status: "sent", created_at: "2026-10-03T10:00:00Z" },
  { id: "a", job_title: "Analista de Datos", company_name: "Ácme", relevance_score: 0.95, status: "new", created_at: "2026-10-02T10:00:00Z" },
  { id: "b", job_title: "back office clerk", company_name: "", relevance_score: 0.6, status: "approved", created_at: "2026-10-01T10:00:00Z" },
];
const DEFAULT_ORDER = ["c", "a", "b"];

const COLUMNS = {
  title: "leads.columnTitle",
  company: "leads.columnCompany",
  score: "leads.columnScore",
  status: "leads.columnStatus",
  found: "leads.columnFound",
};

const bodyRows = () => screen.getAllByRole("row").slice(1);
const rowIds = () => bodyRows().map((row) => LEADS.find((lead) => row.textContent.includes(lead.job_title)).id);
const rowNumbers = () => bodyRows().map((row) => row.querySelector("td").textContent);
const header = (labelKey) => screen.getByTitle(`sort by ${labelKey}`);
const headerCell = (labelKey) => header(labelKey).closest("th");
const clickHeader = (labelKey) => act(async () => { fireEvent.click(header(labelKey)); });

async function renderWith(items = LEADS) {
  leadsApi.list.mockResolvedValue({ data: { items } });
  render(<LeadList />);
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  pipelineApi.getActiveRun.mockResolvedValue({ data: { run: null } });
});

describe("LeadList column sorting", () => {
  it("shows the backend order (found, newest first) with no active sort", async () => {
    await renderWith();
    expect(rowIds()).toEqual(DEFAULT_ORDER);
    for (const labelKey of Object.values(COLUMNS)) {
      expect(headerCell(labelKey).getAttribute("aria-sort")).toBe("none");
    }
  });

  it.each([
    // column, first click order, second click order
    ["title", "ascending", ["a", "b", "c"], ["c", "b", "a"]],
    ["company", "ascending", ["a", "c", "b"], ["c", "a", "b"]],  // blank company always last
    ["score", "descending", ["a", "c", "b"], ["b", "c", "a"]],
    ["status", "ascending", ["b", "c", "a"], ["a", "c", "b"]],  // Aprobado, Enviado, Nuevo
    ["found", "ascending", ["b", "a", "c"], ["c", "a", "b"]],
  ])("sorts by %s: first click %s, second click reversed", async (column, firstAria, firstOrder, secondOrder) => {
    const labelKey = COLUMNS[column];
    await renderWith();

    await clickHeader(labelKey);
    expect(rowIds()).toEqual(firstOrder);
    expect(headerCell(labelKey).getAttribute("aria-sort")).toBe(firstAria);

    await clickHeader(labelKey);
    expect(rowIds()).toEqual(secondOrder);
    expect(headerCell(labelKey).getAttribute("aria-sort")).toBe(firstAria === "ascending" ? "descending" : "ascending");
  });

  it("a first click on Found shows the oldest lead first", async () => {
    await renderWith();
    await clickHeader(COLUMNS.found);
    expect(rowIds()[0]).toBe("b");
    expect(headerCell(COLUMNS.found).getAttribute("aria-sort")).toBe("ascending");
    expect(within(headerCell(COLUMNS.found)).getByLabelText("leads.sortAscending")).toBeTruthy();
  });

  it.each(Object.keys(COLUMNS))("a third click on %s goes back to the default order", async (column) => {
    const labelKey = COLUMNS[column];
    await renderWith();
    await clickHeader(labelKey);
    await clickHeader(labelKey);
    await clickHeader(labelKey);

    expect(rowIds()).toEqual(DEFAULT_ORDER);
    expect(headerCell(labelKey).getAttribute("aria-sort")).toBe("none");
    expect(within(headerCell(labelKey)).queryByLabelText(/leads\.sort(Ascending|Descending)/)).toBeNull();
  });

  it("only the sorted column shows the arrow and a non-none aria-sort", async () => {
    await renderWith();
    await clickHeader(COLUMNS.score);
    await clickHeader(COLUMNS.title);

    expect(headerCell(COLUMNS.title).getAttribute("aria-sort")).toBe("ascending");
    expect(headerCell(COLUMNS.score).getAttribute("aria-sort")).toBe("none");
    expect(within(headerCell(COLUMNS.title)).getByLabelText("leads.sortAscending")).toBeTruthy();
    expect(within(headerCell(COLUMNS.score)).queryByLabelText(/leads\.sort/)).toBeNull();
  });

  it("the # column follows the visible position, also on page 2", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `l${i}`, job_title: `Job ${String(i).padStart(2, "0")}`, company_name: "Acme",
      relevance_score: i / 20, status: "new", created_at: `2026-10-${String(20 - i).padStart(2, "0")}T10:00:00Z`,
    }));
    await renderWith(many);
    await clickHeader(COLUMNS.score);  // descending: Job 11 first

    expect(rowNumbers()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(bodyRows()[0].textContent).toContain("Job 11");

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "common.next" })); });
    expect(rowNumbers()).toEqual(["11", "12"]);
    expect(bodyRows().map((row) => row.textContent.match(/Job \d+/)[0])).toEqual(["Job 01", "Job 00"]);
  });

  it("the minimum score filter keeps working with a sort active", async () => {
    await renderWith();
    await clickHeader(COLUMNS.title);  // ascending
    expect(rowIds()).toEqual(["a", "b", "c"]);

    leadsApi.list.mockResolvedValue({ data: { items: LEADS.filter((lead) => lead.relevance_score >= 0.7) } });
    await act(async () => {
      fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0.7" } });
    });
    await flush();

    expect(leadsApi.list).toHaveBeenLastCalledWith({ limit: 200, min_score: 0.7 });
    expect(rowIds()).toEqual(["a", "c"]);  // filtered, still sorted by title
    expect(headerCell(COLUMNS.title).getAttribute("aria-sort")).toBe("ascending");
  });

  it.each(["en", "es", "pt"])("the sorting texts exist in %s", (lang) => {
    const tab = translations[lang].leads;
    expect(tab.sortBy).toContain("{column}");
    expect(tab.sortAscending).toBeTruthy();
    expect(tab.sortDescending).toBeTruthy();
  });
});

describe("sortLeads / nextSort", () => {
  const t = (key) => LABELS[key] ?? key;

  it("returns the same list with no sort", () => {
    expect(sortLeads(LEADS, null, t)).toBe(LEADS);
  });

  it("keeps the backend order on ties and puts missing dates last", () => {
    const leads = [
      { id: "x", relevance_score: 0.8, created_at: null },
      { id: "y", relevance_score: 0.8, created_at: "2026-10-02T00:00:00Z" },
      { id: "z", relevance_score: 0.8, created_at: "2026-10-01T00:00:00Z" },
    ];
    expect(sortLeads(leads, { key: "relevance_score", dir: "desc" }, t).map((l) => l.id)).toEqual(["x", "y", "z"]);
    expect(sortLeads(leads, { key: "created_at", dir: "asc" }, t).map((l) => l.id)).toEqual(["z", "y", "x"]);
    expect(sortLeads(leads, { key: "created_at", dir: "desc" }, t).map((l) => l.id)).toEqual(["y", "z", "x"]);
  });

  it("cycles first direction → reversed → default", () => {
    const found = { key: "created_at", firstDir: "asc" };
    const score = { key: "relevance_score", firstDir: "desc" };
    expect(nextSort(null, found)).toEqual({ key: "created_at", dir: "asc" });
    expect(nextSort({ key: "created_at", dir: "asc" }, found)).toEqual({ key: "created_at", dir: "desc" });
    expect(nextSort({ key: "created_at", dir: "desc" }, found)).toBeNull();
    expect(nextSort(null, score)).toEqual({ key: "relevance_score", dir: "desc" });
    expect(nextSort({ key: "created_at", dir: "desc" }, score)).toEqual({ key: "relevance_score", dir: "desc" });
  });
});
