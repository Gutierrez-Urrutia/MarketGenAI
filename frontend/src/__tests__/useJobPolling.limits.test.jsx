// RNF-05 (CP-099): si nadie toma la tarea (worker detenido) o tarda demasiado, el sondeo termina y la pantalla avisa.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock("@/api/axios", () => ({ jobsApi: { get: vi.fn() } }));

import { jobsApi } from "@/api/axios";
import { errorText } from "@/api/errorMessages";
import { MAX_PENDING_MS, MAX_TOTAL_MS, useJobPolling } from "@/hooks/useJobPolling";

const flush = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
const advance = async (ms) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sondeo de trabajos: tiempos máximos", () => {
  it("una tarea que nadie toma (sigue «pending») termina con aviso claro, no queda cargando", async () => {
    jobsApi.get.mockResolvedValue({ data: { status: "pending", progress: 0 } });
    const onError = vi.fn();
    const { result } = renderHook(() => useJobPolling("job-1", { onError }));
    await flush();
    expect(result.current.isRunning).toBe(true);

    await advance(MAX_PENDING_MS - 10_000);
    expect(result.current.isError).toBe(false);          // aún dentro del plazo (cola con mucha carga)
    await advance(20_000);
    expect(result.current.isError).toBe(true);
    expect(result.current.isRunning).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(errorText("taskStalled"));
  });

  it("una tarea en curso que supera el tope total también avisa", async () => {
    jobsApi.get.mockResolvedValue({ data: { status: "processing", progress: 40 } });
    const onError = vi.fn();
    const { result } = renderHook(() => useJobPolling("job-2", { onError }));
    await flush();
    await advance(MAX_PENDING_MS + 60_000);
    expect(result.current.isError).toBe(false);          // «processing» no se corta por el plazo de pendientes
    await advance(MAX_TOTAL_MS);
    expect(result.current.isError).toBe(true);
    expect(onError).toHaveBeenCalledWith(errorText("taskTooLong"));
  });

  it("una tarea que termina a tiempo no dispara ningún aviso", async () => {
    jobsApi.get
      .mockResolvedValueOnce({ data: { status: "pending", progress: 0 } })
      .mockResolvedValueOnce({ data: { status: "processing", progress: 50 } })
      .mockResolvedValue({ data: { status: "completed", progress: 100 } });
    const onError = vi.fn();
    const onComplete = vi.fn();
    const { result } = renderHook(() => useJobPolling("job-3", { onError, onComplete }));
    await flush();
    await advance(10_000);
    expect(result.current.isDone).toBe(true);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    await advance(MAX_TOTAL_MS);                          // ya terminó: no hay aviso tardío
    expect(onError).not.toHaveBeenCalled();
  });

  it("el plazo se cuenta desde que empieza cada tarea, no desde que se montó la pantalla", async () => {
    jobsApi.get.mockResolvedValue({ data: { status: "pending", progress: 0 } });
    const onError = vi.fn();
    const { result, rerender } = renderHook(({ id }) => useJobPolling(id, { onError }), { initialProps: { id: "a" } });
    await flush();
    await advance(MAX_PENDING_MS - 20_000);
    rerender({ id: "b" });                                // otra tarea: el reloj arranca de nuevo
    await flush();
    await advance(60_000);
    expect(result.current.isError).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });
});
