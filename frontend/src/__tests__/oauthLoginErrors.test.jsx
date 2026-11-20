// Login con Microsoft / Google: el aviso con que la pantalla recibe el error del servidor (oauth_error en la URL).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

// App.jsx envuelve toast.error/success/loading al cargar: se guardan los espías originales para comprobar lo que recibe el aviso.
const { toast, errorSpy } = vi.hoisted(() => {
  const errorSpy = vi.fn();
  return { errorSpy, toast: Object.assign(vi.fn(), { error: errorSpy, success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }) };
});
vi.mock("react-hot-toast", () => ({ default: toast, Toaster: () => null }));
vi.mock("@/Dashboard", () => ({ default: () => null }));
vi.mock("../Dashboard", () => ({ default: () => null }));

import AppWithProviders from "../App";

const abrirConError = (codigo) => window.history.replaceState({}, "", `/auth/callback?oauth_error=${codigo}`);

beforeEach(() => {
  vi.clearAllMocks();
  window.matchMedia = vi.fn(() => ({
    matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
  localStorage.clear();
  sessionStorage.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("avisos del login social", () => {
  it.each([
    ["microsoft_wrong_tenant", "no pertenece a la organización autorizada"],
    ["microsoft_state_invalid", "venció o no es válida"],
    ["microsoft_userinfo_failed", "datos de tu cuenta Microsoft"],
    ["google_userinfo_failed", "datos de tu cuenta Google"],
    ["account_disabled", "desactivada"],
    ["account_mismatch", "ya está vinculado a otra cuenta"],
  ])("%s muestra un aviso claro y vuelve al login", async (codigo, fragmento) => {
    abrirConError(codigo);
    render(<AppWithProviders />);

    await waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1));
    const mensaje = errorSpy.mock.calls[0][0];
    expect(mensaje).toContain(fragmento);
    expect(mensaje).not.toMatch(/logs|AADSTS|Error de autenticación social/i);
    expect(window.location.pathname).toBe("/login");
  });

  it("un código desconocido cae en el aviso genérico", async () => {
    abrirConError("algo_nuevo");
    render(<AppWithProviders />);
    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith("Error de autenticación social.", expect.anything()));
  });
});
