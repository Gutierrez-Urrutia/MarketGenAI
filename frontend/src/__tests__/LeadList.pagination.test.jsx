import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

vi.mock("@/api/axios", () => ({
  leadsApi: { list: vi.fn() },
  pipelineApi: { runScan: vi.fn(), getRun: vi.fn(), getActiveRun: vi.fn() },
}));
// Templates with placeholders, so the counters can be asserted with their values.
const TEMPLATES = {
  "leads.showing": "showing {from}-{to} of {total}",
  "leads.pageOf": "page {page} of {pages}",
  "leads.limitReached": "more than {limit}, showing {limit}",
};
vi.mock("@/hooks/useI18n", () => ({ useI18n: () => ({ t: (key) => TEMPLATES[key] ?? key }) }));
vi.mock("react-hot-toast", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast };
});

import { leadsApi, pipelineApi } from "@/api/axios";
import LeadList, { paginate } from "@/pages/pipeline/LeadList";

const flush = () => act(async () => { await Promise.resolve(); });
const tick = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

const makeLeads = (n) => Array.from({ length: n }, (_, i) => ({
  id: `l${i + 1}`, job_title: `Lead ${i + 1}`, company_name: "Acme", relevance_score: 0.9, status: "new",
}));
const listReturns = (n) => leadsApi.list.mockResolvedValue({ data: { items: makeLeads(n) } });

const bodyRows = () => screen.getAllByRole("row").slice(1); // drop the header row
const rowNumbers = () => bodyRows().map((row) => row.querySelector("td").textContent);
const prevButton = () => screen.queryByRole("button", { name: "common.previous" });
const nextButton = () => screen.queryByRole("button", { name: "common.next" });

async function renderWith(n) {
  listReturns(n);
  const utils = render(<LeadList />);
  await flush();
  return utils;
}

beforeEach(() => {
  vi.clearAllMocks();
  pipelineApi.getActiveRun.mockResolvedValue({ data: { run: null } });
});

describe("LeadList pagination", () => {
  it("asks the backend for up to 200 leads", async () => {
    await renderWith(0);
    expect(leadsApi.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
  });

  it("shows 10 leads per page and moves with Previous/Next", async () => {
    await renderWith(25);

    expect(bodyRows()).toHaveLength(10);
    expect(screen.getByText("Lead 1")).toBeTruthy();
    expect(screen.queryByText("Lead 11")).toBeNull();
    expect(screen.getByText("showing 1-10 of 25")).toBeTruthy();
    expect(screen.getByText("page 1 of 3")).toBeTruthy();
    expect(prevButton().disabled).toBe(true);

    fireEvent.click(nextButton());
    expect(screen.getByText("Lead 11")).toBeTruthy();
    expect(screen.getByText("showing 11-20 of 25")).toBeTruthy();
    expect(prevButton().disabled).toBe(false);

    fireEvent.click(nextButton());
    expect(bodyRows()).toHaveLength(5);
    expect(screen.getByText("showing 21-25 of 25")).toBeTruthy();
    expect(screen.getByText("page 3 of 3")).toBeTruthy();
    expect(nextButton().disabled).toBe(true);

    fireEvent.click(prevButton());
    expect(screen.getByText("page 2 of 3")).toBeTruthy();
  });

  it("numbers rows globally in the # column", async () => {
    await renderWith(25);
    expect(rowNumbers()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);

    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    expect(rowNumbers()).toEqual(["21", "22", "23", "24", "25"]);
  });

  it("shows the counter but no page controls when everything fits on one page", async () => {
    await renderWith(7);
    expect(bodyRows()).toHaveLength(7);
    expect(screen.getByText("showing 1-7 of 7")).toBeTruthy();
    expect(prevButton()).toBeNull();
    expect(nextButton()).toBeNull();
    expect(screen.queryByText(/^page /)).toBeNull();
  });

  it("shows no counter when there are no leads", async () => {
    await renderWith(0);
    expect(screen.getByText("leads.empty")).toBeTruthy();
    expect(screen.queryByText(/^showing /)).toBeNull();
  });

  it("warns that older leads were left out when the response hits the 200 cap", async () => {
    await renderWith(200);
    expect(screen.getByText("more than 200, showing 200")).toBeTruthy();
  });

  it("does not warn with 199 leads", async () => {
    await renderWith(199);
    expect(screen.queryByText(/^more than/)).toBeNull();
  });

  it("goes back to page 1 when the status filter changes", async () => {
    const { container } = await renderWith(25);
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    expect(screen.getByText("page 3 of 3")).toBeTruthy();

    fireEvent.change(container.querySelector("select"), { target: { value: "new" } });
    await flush();

    expect(screen.getByText("page 1 of 3")).toBeTruthy();
    expect(screen.getByText("Lead 1")).toBeTruthy();
  });

  it("goes back to page 1 when the minimum score changes", async () => {
    const { container } = await renderWith(25);
    fireEvent.click(nextButton());
    expect(screen.getByText("page 2 of 3")).toBeTruthy();

    fireEvent.change(container.querySelector("input[type=number]"), { target: { value: "0.5" } });
    await flush();

    expect(screen.getByText("page 1 of 3")).toBeTruthy();
  });
});

describe("LeadList pagination after a scan", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("goes back to page 1 once a scan has finished", async () => {
    pipelineApi.getActiveRun.mockResolvedValue({ data: { run: { id: "run-1", status: "running" } } });
    pipelineApi.getRun
      .mockResolvedValueOnce({ data: { id: "run-1", status: "running" } })
      .mockResolvedValue({ data: { id: "run-1", status: "completed", leads_new: 5, leads_found: 5 } });
    await renderWith(25);

    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    expect(screen.getByText("page 3 of 3")).toBeTruthy();

    listReturns(30); // the scan added leads
    await tick(2000); // still running: the page is left alone
    expect(screen.getByText("page 3 of 3")).toBeTruthy();

    await tick(2000); // completed: the list reloads on page 1
    expect(screen.getByText("page 1 of 3")).toBeTruthy();
    expect(screen.getByText("showing 1-10 of 30")).toBeTruthy();
  });
});

describe("paginate", () => {
  const items = makeLeads(25);

  it("clamps a page that no longer exists to the last one", () => {
    const shrunk = items.slice(0, 12); // was on page 3 of 25, now only 2 pages
    const result = paginate(shrunk, 3);
    expect(result.currentPage).toBe(2);
    expect(result.pageCount).toBe(2);
    expect(result.firstIndex).toBe(10);
    expect(result.pageItems.map((lead) => lead.id)).toEqual(["l11", "l12"]);
  });

  it("stays on page 1 with an empty list", () => {
    expect(paginate([], 4)).toEqual({ pageCount: 1, currentPage: 1, firstIndex: 0, pageItems: [] });
  });

  it("returns the requested page when it exists", () => {
    const result = paginate(items, 2);
    expect(result.currentPage).toBe(2);
    expect(result.pageItems.map((lead) => lead.id)).toEqual(
      ["l11", "l12", "l13", "l14", "l15", "l16", "l17", "l18", "l19", "l20"],
    );
  });
});
