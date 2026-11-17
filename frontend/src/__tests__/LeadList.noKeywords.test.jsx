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

import toast from "react-hot-toast";
import { leadsApi, pipelineApi } from "@/api/axios";
import LeadList from "@/pages/pipeline/LeadList";
import { translations } from "@/i18n/translations";

const flush = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
  vi.clearAllMocks();
  leadsApi.list.mockResolvedValue({ data: { items: [] } });
  pipelineApi.getActiveRun.mockResolvedValue({ data: { run: null } });
});

afterEach(() => {
  vi.useRealTimers();
});

// RF13-D-002: sin palabras clave el servidor responde 422 { code: "no_keywords" } y la pantalla lo avisa traducido.
describe("LeadList scan without keywords", () => {
  it("shows the translated no-keywords message and re-enables the button", async () => {
    pipelineApi.runScan.mockRejectedValue({
      response: { status: 422, data: { detail: { code: "no_keywords", message: "Agrega al menos una palabra clave…" } } },
    });
    render(<LeadList />);
    await flush();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /leads\.runScan/ })); });

    expect(toast.error).toHaveBeenCalledWith("leads.scanNoKeywords");
    expect(pipelineApi.getRun).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /leads\.runScan/ }).disabled).toBe(false);
  });

  it.each(["en", "es", "pt"])("the message is translated in %s", (lang) => {
    expect(translations[lang].leads.scanNoKeywords).toBeTruthy();
  });
});
