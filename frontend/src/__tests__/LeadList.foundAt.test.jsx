import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

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

// "Found" is the 5th (last) column of the leads table.
const foundCell = (jobTitle) => screen.getByText(jobTitle).closest("tr").querySelectorAll("td")[4];

// 47 seconds: a value that must not show up in the time line.
const CREATED_AT = "2026-09-30T23:11:47Z";

async function renderWith(createdAt) {
  leadsApi.list.mockResolvedValue({ data: { items: [lead({ created_at: createdAt })] } });
  render(<LeadList />);
  await flush();
  return foundCell("Dev");
}

beforeEach(() => {
  vi.clearAllMocks();
  pipelineApi.getActiveRun.mockResolvedValue({ data: { run: null } });
});

describe("LeadList found column", () => {
  it("shows the date and the time in separate elements", async () => {
    const cell = await renderWith(CREATED_AT);
    const date = new Date(CREATED_AT);

    const [dateLine, timeLine] = cell.querySelectorAll("span");
    expect(dateLine.textContent).toBe(date.toLocaleDateString());
    expect(timeLine.textContent).toBe(date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
    expect(timeLine.className).toContain("text-xs");
    expect(timeLine.className).toContain("text-gray-500");
  });

  it("shows the time without seconds", async () => {
    const cell = await renderWith(CREATED_AT);
    const timeLine = cell.querySelectorAll("span")[1];
    expect(timeLine.textContent).not.toMatch(/\d:\d{2}:\d{2}/);
    expect(timeLine.textContent).not.toContain("47");
  });

  it("puts the full date and time in the cell title", async () => {
    const cell = await renderWith(CREATED_AT);
    expect(cell.getAttribute("title")).toBe(new Date(CREATED_AT).toLocaleString());
  });

  it.each([
    ["null", null],
    ["a missing field", undefined],
    ["an invalid date", "not-a-date"],
  ])("shows '-' when created_at is %s", async (_label, createdAt) => {
    const cell = await renderWith(createdAt);
    expect(cell.textContent).toBe("-");
    expect(cell.querySelectorAll("span")).toHaveLength(0);
    expect(cell.getAttribute("title")).toBeNull();
  });
});
