// RNF-04: una falla de un servicio externo o de la conexión se informa con un texto claro y la pantalla sigue viva.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const { toast } = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock("react-hot-toast", () => ({ default: toast }));

import api from "@/api/axios";
import { apiErrorToastMessage, errorText } from "@/api/errorMessages";
import { MAX_CONSECUTIVE_POLL_FAILURES, useJobPolling } from "@/hooks/useJobPolling";

const originalAdapter = api.defaults.adapter;

const respondWith = (status, data, code) => {
  api.defaults.adapter = async (config) => {
    const error = new Error(status ? `Request failed with status code ${status}` : "Network Error");
    error.config = config;
    error.code = code;
    if (status) error.response = { status, data, headers: {}, config };
    throw error;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  api.defaults.adapter = originalAdapter;
  vi.restoreAllMocks();
});

describe("avisos de la API (axios)", () => {
  it("sin conexión muestra «No hay conexión con el servidor» (antes no mostraba nada)", async () => {
    respondWith(null, null, "ERR_NETWORK");
    await expect(api.get("/proposals")).rejects.toBeTruthy();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error.mock.calls[0][0]).toMatch(/No hay conexión con el servidor/);
  });

  it("un tiempo agotado del navegador se avisa distinto de la falta de conexión", async () => {
    respondWith(null, null, "ECONNABORTED");
    await expect(api.get("/proposals")).rejects.toBeTruthy();
    expect(toast.error.mock.calls[0][0]).toMatch(/tardó demasiado/);
  });

  it("un 504 y un 502 de la IA muestran su propio mensaje, distinto entre sí", async () => {
    respondWith(504, { detail: "El servicio de IA tardó demasiado en responder. Inténtalo de nuevo.", message: "El servicio de IA tardó demasiado en responder. Inténtalo de nuevo." });
    await expect(api.post("/proposals/1/generate", {})).rejects.toBeTruthy();
    respondWith(502, { detail: "El servicio de IA no está disponible en este momento. Inténtalo de nuevo en unos minutos." });
    await expect(api.post("/proposals/1/generate", {})).rejects.toBeTruthy();
    const textos = toast.error.mock.calls.map((c) => c[0]);
    expect(textos[0]).toMatch(/tardó demasiado/);
    expect(textos[1]).toMatch(/no está disponible/);
    expect(textos[0]).not.toBe(textos[1]);
  });

  it("un 503 de la base de datos muestra su mensaje", async () => {
    respondWith(503, { detail: "La base de datos no está disponible en este momento. Inténtalo de nuevo en unos minutos.", code: "db_unavailable" });
    await expect(api.get("/proposals")).rejects.toBeTruthy();
    expect(toast.error.mock.calls[0][0]).toMatch(/base de datos no está disponible/);
  });

  it("un 500 con una traza no la muestra: usa el texto genérico", async () => {
    respondWith(500, { detail: 'Traceback (most recent call last):\n  File "/app/routers/x.py", line 9, in f' });
    await expect(api.get("/proposals")).rejects.toBeTruthy();
    const texto = toast.error.mock.calls[0][0];
    expect(texto).not.toMatch(/Traceback|\.py/);
    expect(texto).toMatch(/error en el servidor/);
  });

  it("un 429 avisa de demasiadas solicitudes", async () => {
    respondWith(429, { error: "Rate limit exceeded: 20 per 1 minute" });
    await expect(api.get("/proposals")).rejects.toBeTruthy();
    expect(toast.error.mock.calls[0][0]).toMatch(/demasiadas solicitudes/);
  });

  it("un 400 o un 404 de negocio no dispara el aviso general", async () => {
    respondWith(404, { detail: "Proposal not found" });
    await expect(api.get("/proposals/x")).rejects.toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("suppressServerErrorToast deja que el llamador muestre su propio mensaje (p. ej. el CRM)", async () => {
    respondWith(502, { detail: "HubSpot respondió con error 500" });
    await expect(api.post("/proposals/1/send-to-crm", {}, { suppressServerErrorToast: true })).rejects.toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("los avisos se muestran en el idioma elegido", () => {
    localStorage.setItem("marketgen_language", "en");
    expect(apiErrorToastMessage({ code: "ERR_NETWORK" })).toMatch(/Cannot reach the server/);
    localStorage.setItem("marketgen_language", "pt");
    expect(apiErrorToastMessage({ code: "ERR_NETWORK" })).toMatch(/Não há conexão/);
  });
});

describe("sondeo de tareas (useJobPolling) con el backend caído", () => {
  it("tras varios fallos seguidos deja de sondear y avisa", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    respondWith(null, null, "ERR_NETWORK");
    const { result } = renderHook(() => useJobPolling("job-1", { onError }));
    for (let i = 0; i < MAX_CONSECUTIVE_POLL_FAILURES + 1; i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    }
    expect(result.current.isError).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(errorText("pollingLost", "es"));
    vi.useRealTimers();
  });

  it("un fallo aislado no corta el sondeo", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    respondWith(null, null, "ERR_NETWORK");
    const { result } = renderHook(() => useJobPolling("job-2", { onError }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(result.current.isError).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
