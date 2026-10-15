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

const button = () => screen.getByRole("button", { name: /leads\.(runScan|running)/ });
const tick = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const flush = () => act(async () => { await Promise.resolve(); });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  leadsApi.list.mockResolvedValue({ data: { items: [] } });
  pipelineApi.getActiveRun.mockResolvedValue({ data: { run: null } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LeadList scan state lives on the server, not in the component", () => {
  it("is enabled when no run is active", async () => {
    render(<LeadList />);
    await flush();
    expect(button().disabled).toBe(false);
  });

  it("re-attaches to a run still active after navigating away and back", async () => {
    pipelineApi.getActiveRun.mockResolvedValue({ data: { run: { id: "run-1", status: "running" } } });
    pipelineApi.getRun.mockResolvedValue({ data: { id: "run-1", status: "running" } });

    const first = render(<LeadList />);
    await flush();
    expect(button().disabled).toBe(true);

    first.unmount(); // user goes to Settings...
    render(<LeadList />); // ...and comes back: fresh component, no local state
    await flush();

    expect(button().disabled).toBe(true);
    await tick(2000);
    expect(pipelineApi.getRun).toHaveBeenCalledWith("run-1"); // and it keeps following it
  });

  it("stays disabled until the refreshed list has finished loading", async () => {
    pipelineApi.getActiveRun.mockResolvedValue({ data: { run: { id: "run-1", status: "running" } } });
    pipelineApi.getRun.mockResolvedValue({ data: { id: "run-1", status: "completed", leads_new: 1, leads_found: 1 } });
    const reload = deferred();

    render(<LeadList />);
    await flush();
    leadsApi.list.mockReturnValueOnce(reload.promise); // the post-scan reload is slow

    await tick(2000); // run reports completed -> list reload starts
    expect(button().disabled).toBe(true); // run is done, results not on screen yet

    await act(async () => {
      reload.resolve({ data: { items: [{ id: "l1", job_title: "Dev", company_name: "Acme", relevance_score: 0.9, status: "new" }] } });
    });
    expect(screen.getByText("Dev")).toBeTruthy(); // results visible
    expect(button().disabled).toBe(false); // only now
  });

  it("follows the active run when the backend answers 409 to a second scan", async () => {
    pipelineApi.runScan.mockRejectedValue({
      response: { status: 409, data: { detail: { message: "busy", run_id: "run-9" } } },
    });
    pipelineApi.getRun.mockResolvedValue({ data: { id: "run-9", status: "running" } });

    render(<LeadList />);
    await flush();
    await act(async () => { fireEvent.click(button()); });
    await flush();

    expect(button().disabled).toBe(true);
    await tick(2000);
    expect(pipelineApi.getRun).toHaveBeenCalledWith("run-9");
  });

  it("a filter change does not cancel the scan being followed", async () => {
    pipelineApi.getActiveRun.mockResolvedValue({ data: { run: { id: "run-1", status: "running" } } });
    pipelineApi.getRun
      .mockResolvedValueOnce({ data: { id: "run-1", status: "running" } })
      .mockResolvedValue({ data: { id: "run-1", status: "completed", leads_new: 0, leads_found: 0 } });

    const { container } = render(<LeadList />);
    await flush();
    await tick(2000); // still running

    fireEvent.change(container.querySelector("select"), { target: { value: "sent" } });
    await flush();
    await tick(2000); // completes after the filter changed

    expect(button().disabled).toBe(false); // was stuck disabled forever when the poll was torn down
  });

  it("stops polling when the component unmounts", async () => {
    pipelineApi.getActiveRun.mockResolvedValue({ data: { run: { id: "run-1", status: "running" } } });
    pipelineApi.getRun.mockResolvedValue({ data: { id: "run-1", status: "running" } });

    const { unmount } = render(<LeadList />);
    await flush();
    unmount();
    pipelineApi.getRun.mockClear();

    await tick(10000);
    expect(pipelineApi.getRun).not.toHaveBeenCalled();
  });
});
