// RNF-01 (CP-162): cuando la cuenta queda bloqueada por intentos fallidos, la pantalla de login lo informa.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { toast, errorSpy, login } = vi.hoisted(() => {
  const errorSpy = vi.fn();
  return { errorSpy, login: vi.fn(), toast: Object.assign(vi.fn(), { error: errorSpy, success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }) };
});
vi.mock("react-hot-toast", () => ({ default: toast, Toaster: () => null }));
vi.mock("@/Dashboard", () => ({ default: () => null }));
vi.mock("../Dashboard", () => ({ default: () => null }));
vi.mock("@/api/axios", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, authApi: { ...actual.authApi, login } };
});

import AppWithProviders from "../App";

beforeEach(() => {
  vi.clearAllMocks();
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/login");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
// Sin `globals`, Testing Library no desmonta solo: la app del test anterior seguía viva y su llamada de red (sin backend, como en CI) ensuciaba el siguiente.
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// La app también comprueba la sesión al abrir; sin backend (como en CI) eso puede mostrar su propio aviso de red.
// Por eso se busca el aviso esperado entre todos los avisos y no se supone que sea el primero.
const avisos = () => errorSpy.mock.calls.map((c) => String(c[0]));

const iniciarSesion = async () => {
  render(<AppWithProviders />);
  fireEvent.change(await screen.findByPlaceholderText(/username or email|usuario o correo|usuário ou e-?mail/i), { target: { value: "ana@example.com" } });
  fireEvent.change(screen.getByPlaceholderText(/password|contraseña|senha/i), { target: { value: "incorrecta1" } });
  fireEvent.click(screen.getByRole("button", { name: /^(sign in|iniciar sesión|entrar)$/i }));
};

describe("login: cuenta bloqueada", () => {
  it("un 429 ACCOUNT_LOCKED muestra el mensaje del servidor, no «credenciales inválidas»", async () => {
    login.mockRejectedValue({ response: { status: 429, data: { detail: { code: "ACCOUNT_LOCKED", message: "Demasiados intentos fallidos. Intenta de nuevo en 15 minuto(s)." } } } });
    await iniciarSesion();
    await waitFor(() => expect(avisos().some((m) => m.includes("Demasiados intentos fallidos"))).toBe(true));
    expect(await screen.findAllByText(/Intenta de nuevo en 15 minuto/)).not.toHaveLength(0);
  });

  it("un 429 sin cuerpo (límite por IP) muestra un aviso de demasiados intentos", async () => {
    login.mockRejectedValue({ response: { status: 429, data: { error: "Rate limit exceeded" } } });
    await iniciarSesion();
    await waitFor(() => expect(avisos().some((m) => /too many|intentos|tentativas/i.test(m))).toBe(true));
  });

  it("un 401 sigue mostrando «credenciales inválidas»", async () => {
    login.mockRejectedValue({ response: { status: 401, data: { detail: { code: "INVALID_CREDENTIALS" } } } });
    await iniciarSesion();
    await waitFor(() => expect(avisos().some((m) => /invalid|inválidos/i.test(m))).toBe(true));
  });
});
