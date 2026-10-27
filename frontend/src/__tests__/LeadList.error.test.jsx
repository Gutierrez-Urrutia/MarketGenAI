import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

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

beforeEach(() => {
  vi.clearAllMocks();
  pipelineApi.getActiveRun.mockResolvedValue({ data: { run: null } });
});

describe("LeadList load errors", () => {
  it("shows the session-expired message on a 401 instead of loading forever", async () => {
    leadsApi.list.mockRejectedValue({ response: { status: 401 }, message: "Request failed with status code 401" });
    render(<LeadList />);
    await flush();

    expect(screen.getByRole("alert").textContent).toContain("leads.sessionExpired");
    expect(screen.queryByText("common.loading")).toBeNull();
  });

  it("shows a timeout message when the request times out", async () => {
    leadsApi.list.mockRejectedValue({ code: "ECONNABORTED", message: "timeout of 30000ms exceeded" });
    render(<LeadList />);
    await flush();

    expect(screen.getByRole("alert").textContent).toContain("leads.loadTimeout");
    expect(screen.queryByText("common.loading")).toBeNull();
  });

  it("shows the server's message for other failures, distinct from the empty state", async () => {
    leadsApi.list.mockRejectedValue({ response: { status: 500, data: { detail: "db unavailable" } } });
    render(<LeadList />);
    await flush();

    expect(screen.getByRole("alert").textContent).toContain("db unavailable");
    expect(screen.queryByText("leads.empty")).toBeNull();
  });

  it("retry reloads and clears the error", async () => {
    leadsApi.list
      .mockRejectedValueOnce({ response: { status: 500 }, message: "boom" })
      .mockResolvedValueOnce({
        data: { items: [{ id: "l1", job_title: "Dev", company_name: "Acme", relevance_score: 0.9, status: "new" }] },
      });
    render(<LeadList />);
    await flush();
    expect(screen.getByRole("alert")).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "leads.retry" })); });
    await flush();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Dev")).toBeTruthy();
  });

  it("ignores a stale response that arrives after a newer load", async () => {
    let rejectFirst;
    leadsApi.list
      .mockReturnValueOnce(new Promise((_, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce({ data: { items: [] } });
    const { container } = render(<LeadList />);
    await flush();

    fireEvent.change(container.querySelector("select"), { target: { value: "sent" } }); // newer load
    await flush();
    await act(async () => { rejectFirst({ response: { status: 500 }, message: "late" }); });

    expect(screen.queryByRole("alert")).toBeNull(); // the old failure must not clobber the newer result
  });
});
