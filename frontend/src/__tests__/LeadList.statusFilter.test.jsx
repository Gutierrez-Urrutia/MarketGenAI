/**
 * RF15 — the Status filter of LeadList offers only the statuses the system
 * assigns today (new, contacts_found); the Status column still shows any status.
 * API mocked; synthetic data only (example.com, invented titles).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";

vi.mock("@/api/axios", () => ({
  leadsApi: {
    list: vi.fn(), get: vi.fn(), searchContacts: vi.fn(), listContacts: vi.fn(), reviewContact: vi.fn(),
  },
  pipelineApi: { runScan: vi.fn(), getRun: vi.fn(), getActiveRun: vi.fn() },
}));
// Keys come back as-is.
vi.mock("@/hooks/useI18n", () => ({ useI18n: () => ({ t: (key) => key }) }));
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
  job_url: "https://jobs.example.com/1",
  relevance_score: 0.9,
  status: "new",
  created_at: "2026-11-05T12:00:00Z",
  ...overrides,
});

async function renderList(leads) {
  leadsApi.list.mockResolvedValue({ data: { items: leads } });
  render(<LeadList />);
  await flush();
}

const statusSelect = () => screen.getByRole("combobox");
const rowOf = (title) => screen.getByText(title).closest("tr");
const lastListParams = () => leadsApi.list.mock.calls.at(-1)[0];

beforeEach(() => {
  vi.clearAllMocks();
  pipelineApi.getActiveRun.mockResolvedValue({ data: { run: null } });
  leadsApi.listContacts.mockResolvedValue({ data: { items: [], total: 0 } });
});

describe("LeadList status filter", () => {
  it("offers All and the statuses a lead rests in (RF-VTA-16 adds the email ones)", async () => {
    await renderList([makeLead("lead-1")]);
    const options = within(statusSelect()).getAllByRole("option");
    expect(options.map((option) => option.value)).toEqual(["", "new", "contacts_found", "ready_for_review", "approved", "sent"]);
    expect(options.map((option) => option.textContent)).toEqual([
      "leads.allStatuses", "leads.status.new", "leads.status.contacts_found",
      "leads.status.ready_for_review", "leads.status.approved", "leads.status.sent",
    ]);
  });

  it("with All, leads in hidden statuses still show their status", async () => {
    await renderList([
      makeLead("lead-1", { status: "researching" }),
      makeLead("lead-2", { status: "composing" }),
    ]);
    expect(statusSelect().value).toBe("");
    expect(leadsApi.list.mock.calls[0][0]).not.toHaveProperty("status");
    expect(within(rowOf("Customer Support Agent lead-1")).getByText("leads.status.researching")).toBeTruthy();
    expect(within(rowOf("Customer Support Agent lead-2")).getByText("leads.status.composing")).toBeTruthy();
  });

  it("choosing contacts_found or new asks the API for that status", async () => {
    await renderList([makeLead("lead-1")]);

    fireEvent.change(statusSelect(), { target: { value: "contacts_found" } });
    await flush();
    expect(lastListParams()).toEqual({ limit: 200, status: "contacts_found" });

    fireEvent.change(statusSelect(), { target: { value: "new" } });
    await flush();
    expect(lastListParams()).toEqual({ limit: 200, status: "new" });

    fireEvent.change(statusSelect(), { target: { value: "" } });
    await flush();
    expect(lastListParams()).toEqual({ limit: 200 });
  });
});
