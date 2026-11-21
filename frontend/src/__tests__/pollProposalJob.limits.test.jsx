// RNF-05 (CP-099): el asistente de propuestas corta la espera a los 3 min y avisa en el idioma del usuario (antes: «Proposal generation timed out»).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/api/axios", () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));

import api from "@/api/axios";
import { errorText } from "@/api/errorMessages";
import { pollProposalJob } from "@/api/proposalsApi";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("pollProposalJob: tiempo máximo y avisos", () => {
  it("si el trabajo sigue pendiente se rinde a los 3 min con un aviso en español, no en inglés", async () => {
    api.get.mockResolvedValue({ data: { status: "pending", progress: 0 } });
    const result = pollProposalJob("job-1", "p-1");
    const assertion = expect(result).rejects.toThrow(errorText("taskTooLong", "es"));
    await vi.advanceTimersByTimeAsync(185_000);
    await assertion;
    expect(errorText("taskTooLong", "es")).not.toMatch(/timed out/i);
  });

  it("el aviso respeta el idioma elegido", async () => {
    localStorage.setItem("marketgen_language", "en");
    api.get.mockResolvedValue({ data: { status: "pending", progress: 0 } });
    const result = pollProposalJob("job-2", "p-2");
    const assertion = expect(result).rejects.toThrow(errorText("taskTooLong", "en"));
    await vi.advanceTimersByTimeAsync(185_000);
    await assertion;
  });

  it("un trabajo fallido sin mensaje muestra un aviso general traducido, no «Proposal generation failed»", async () => {
    api.get.mockResolvedValue({ data: { status: "failed" } });
    await expect(pollProposalJob("job-3", "p-3")).rejects.toThrow(errorText("server", "es"));
  });

  it("un trabajo que termina a tiempo devuelve la propuesta", async () => {
    api.get
      .mockResolvedValueOnce({ data: { status: "processing" } })
      .mockResolvedValueOnce({ data: { status: "completed" } })
      .mockResolvedValueOnce({ data: { id: "p-4", content: "ok" } });
    const result = pollProposalJob("job-4", "p-4");
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(result).resolves.toEqual({ id: "p-4", content: "ok" });
  });
});
