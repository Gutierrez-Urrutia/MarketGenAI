import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

vi.mock("@/api/axios", () => ({
  pipelineApi: {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    createSource: vi.fn(),
    updateSource: vi.fn(),
    deleteSource: vi.fn(),
    testSource: vi.fn(),
  },
}));
vi.mock("@/hooks/useI18n", () => ({ useI18n: () => ({ t: (key) => key }) }));
vi.mock("react-hot-toast", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast };
});

import { pipelineApi } from "@/api/axios";
import PipelineSettingsTab from "@/pages/settings/PipelineSettingsTab";

const flush = () => act(async () => { await Promise.resolve(); });

const renderWith = async (smtpPasswordConfigured) => {
  pipelineApi.getConfig.mockResolvedValue({
    data: { sources: [], is_active: true, smtp_password_configured: smtpPasswordConfigured },
  });
  render(<PipelineSettingsTab />);
  await flush();
  const field = screen.getByText("settings.pipelineTab.passwordLabel").parentElement;
  return { field, input: field.querySelector("input[type=password]") };
};

const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;

beforeEach(() => {
  vi.clearAllMocks();
});

// The password hint used to sit between the label and the input, pushing the
// input below the Username one in the same grid row. It now goes after it.
describe("PipelineSettingsTab SMTP password hint", () => {
  it.each([
    [true, "settings.pipelineTab.passwordConfiguredHint"],
    [false, "settings.pipelineTab.passwordNotConfiguredHint"],
  ])("with configured=%s the hint follows the input and describes it", async (configured, hintKey) => {
    const { field, input } = await renderWith(configured);
    const hint = screen.getByText(hintKey);
    const label = screen.getByText("settings.pipelineTab.passwordLabel");

    expect(input).toBeTruthy();
    expect(field.contains(hint)).toBe(true);
    // label → input → hint, in that order.
    expect(label.compareDocumentPosition(input) & FOLLOWING).toBeTruthy();
    expect(input.compareDocumentPosition(hint) & FOLLOWING).toBeTruthy();

    expect(hint.id).toBeTruthy();
    expect(input.getAttribute("aria-describedby")).toBe(hint.id);
    expect(document.querySelectorAll(`[id="${hint.id}"]`)).toHaveLength(1);
  });

  it("shows only the hint that matches the state", async () => {
    await renderWith(true);
    expect(screen.queryByText("settings.pipelineTab.passwordNotConfiguredHint")).toBeNull();
  });

  it("lays out the SMTP rows in one column, and two from sm up", async () => {
    const { field } = await renderWith(true);
    const row = field.parentElement;
    expect(row.className).toContain("grid-cols-1");
    expect(row.className).toContain("sm:grid-cols-2");
    const card = row.parentElement;
    const rows = [...card.children].filter((el) => el.className.includes("grid"));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.className).toContain("grid-cols-1 sm:grid-cols-2");
    }
  });
});
