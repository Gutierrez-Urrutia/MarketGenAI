/**
 * RF-VTA-16 — el resultado con que el callback de Microsoft devuelve al
 * navegador (/?mail_connection=connected o /?mail_connection_error=<código>):
 * se guarda solo el código en sessionStorage, se quita de la URL, se lee una
 * vez y, sin sessionStorage, la app sigue igual (sin aviso).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  MAIL_CONNECTION_RESULT_KEY, captureMailConnectionRedirect, openAuthorizeUrl, peekMailConnectionResult,
  resultFromQuery, takeMailConnectionResult,
} from "@/features/mailConnection/redirectResult";

const goTo = (url) => window.history.replaceState({}, "", url);

beforeEach(() => {
  sessionStorage.clear();
  goTo("/");
});
afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  goTo("/");
});

describe("captureMailConnectionRedirect", () => {
  it("conectado: guarda solo «connected» y limpia la URL", () => {
    goTo("/?mail_connection=connected");
    expect(captureMailConnectionRedirect()).toBe(true);
    expect(sessionStorage.getItem(MAIL_CONNECTION_RESULT_KEY)).toBe("connected");
    expect(sessionStorage.length).toBe(1);
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe("/");
  });

  it("error: guarda solo el código y deja los demás parámetros", () => {
    goTo("/?foo=1&mail_connection_error=admin_consent_required");
    expect(captureMailConnectionRedirect()).toBe(true);
    expect(sessionStorage.getItem(MAIL_CONNECTION_RESULT_KEY)).toBe("admin_consent_required");
    expect(window.location.search).toBe("?foo=1");
  });

  it("un código mal formado o un valor inesperado se guarda como «generic»", () => {
    goTo("/?mail_connection_error=%3Cscript%3E");
    captureMailConnectionRedirect();
    expect(sessionStorage.getItem(MAIL_CONNECTION_RESULT_KEY)).toBe("generic");
    goTo("/?mail_connection=algo");
    captureMailConnectionRedirect();
    expect(sessionStorage.getItem(MAIL_CONNECTION_RESULT_KEY)).toBe("generic");
  });

  it("sin parámetros no guarda ni cambia nada", () => {
    goTo("/dashboard?tab=x");
    expect(captureMailConnectionRedirect()).toBe(false);
    expect(sessionStorage.length).toBe(0);
    expect(window.location.search).toBe("?tab=x");
    expect(takeMailConnectionResult()).toBeNull();
  });

  it("sin sessionStorage: no falla, limpia la URL y no hay aviso", () => {
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => { throw new Error("bloqueado"); });
    goTo("/?mail_connection=connected");
    expect(() => captureMailConnectionRedirect()).not.toThrow();
    expect(window.location.search).toBe("");
    expect(peekMailConnectionResult()).toBeNull();
    expect(takeMailConnectionResult()).toBeNull();
  });

  it("si setItem falla (almacenamiento lleno), tampoco falla", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("lleno"); });
    goTo("/?mail_connection_error=consent_denied");
    expect(() => captureMailConnectionRedirect()).not.toThrow();
    expect(window.location.search).toBe("");
    expect(takeMailConnectionResult()).toBeNull();
  });
});

describe("takeMailConnectionResult", () => {
  it("devuelve el resultado una sola vez y lo borra", () => {
    sessionStorage.setItem(MAIL_CONNECTION_RESULT_KEY, "connected");
    expect(peekMailConnectionResult()).toBe("connected");
    expect(takeMailConnectionResult()).toBe("connected");
    expect(sessionStorage.getItem(MAIL_CONNECTION_RESULT_KEY)).toBeNull();
    expect(takeMailConnectionResult()).toBeNull();
  });

  it("ignora un valor guardado que no es un código", () => {
    sessionStorage.setItem(MAIL_CONNECTION_RESULT_KEY, "<b>x</b>");
    expect(peekMailConnectionResult()).toBeNull();
    expect(takeMailConnectionResult()).toBeNull();
    expect(sessionStorage.getItem(MAIL_CONNECTION_RESULT_KEY)).toBeNull();
  });
});

describe("resultFromQuery y openAuthorizeUrl", () => {
  it("resultFromQuery", () => {
    expect(resultFromQuery("")).toBeNull();
    expect(resultFromQuery("?mail_connection=connected")).toBe("connected");
    expect(resultFromQuery("?mail_connection_error=invalid_state")).toBe("invalid_state");
    // Un error gana aunque venga también «connected».
    expect(resultFromQuery("?mail_connection=connected&mail_connection_error=server_error")).toBe("server_error");
  });

  it("openAuthorizeUrl no navega a algo que no sea http(s)", () => {
    expect(openAuthorizeUrl("javascript:alert(1)")).toBe(false);
    expect(openAuthorizeUrl(undefined)).toBe(false);
    expect(openAuthorizeUrl("/relativa")).toBe(false);
  });
});
