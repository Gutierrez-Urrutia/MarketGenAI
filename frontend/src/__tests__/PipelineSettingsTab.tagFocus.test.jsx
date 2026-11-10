import { describe, it, expect, vi } from "vitest";
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

// The global input:focus-visible shadow (index.css) drew a second, orange
// border inside the tag field's own focus ring. Only the container's ring stays.
describe("PipelineSettingsTab tag field focus", () => {
  it.each([
    "settings.pipelineTab.serviceKeywordsLabel",
    "settings.pipelineTab.targetIndustriesLabel",
    "settings.pipelineTab.excludedCompaniesLabel",
  ])("%s: the inner input drops its shadow and the container keeps its ring", async (labelKey) => {
    pipelineApi.getConfig.mockResolvedValue({ data: { sources: [], is_active: true } });
    render(<PipelineSettingsTab />);
    await act(async () => { await Promise.resolve(); });

    const input = screen.getByText(labelKey).parentElement.querySelector("input[type=text]");
    const container = input.parentElement;

    expect(input.className.split(/\s+/)).toContain("focus-visible:shadow-none");
    expect(container.className).toContain("focus-within:ring-2");
    expect(container.className).toContain("focus-within:ring-indigo-500");
    expect(container.className).not.toContain("shadow-none");
  });
});
