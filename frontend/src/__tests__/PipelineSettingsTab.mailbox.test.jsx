/**
 * RF-VTA-16 — Configuración › Pipeline › «Buzón de envío (Microsoft 365 /
 * Outlook)»: estado, Conectar, Reconectar, Probar y Desconectar, el texto de
 * consentimiento y el aviso al volver de Microsoft. Reemplaza al test de la
 * tarjeta SMTP. API y navegación mockeadas; datos sintéticos; ninguna llamada
 * real a Microsoft.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";

vi.mock("@/api/axios", () => ({
  pipelineApi: {
    getConfig: vi.fn(), updateConfig: vi.fn(), createSource: vi.fn(), updateSource: vi.fn(),
    deleteSource: vi.fn(), testSource: vi.fn(),
  },
  mailConnectionApi: { status: vi.fn(), start: vi.fn(), test: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/hooks/useI18n", () => {
  const templates = {
    "settings.pipelineTab.mailboxTestOk": "OK {address}",
    "settings.pipelineTab.mailboxConnectFailed": "Failed. {reason}",
  };
  return { useI18n: () => ({ t: (key) => templates[key] ?? key }) };
});
vi.mock("react-hot-toast", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast };
});
vi.mock("@/features/mailConnection/redirectResult", async (importOriginal) => ({
  ...(await importOriginal()),
  openAuthorizeUrl: vi.fn(() => true),
}));

import toast from "react-hot-toast";
import { mailConnectionApi, pipelineApi } from "@/api/axios";
import { MAIL_CONNECTION_RESULT_KEY, openAuthorizeUrl } from "@/features/mailConnection/redirectResult";
import { translations } from "@/i18n/translations";
import PipelineSettingsTab, { MAILBOX_ERROR_CODES } from "@/pages/settings/PipelineSettingsTab";

const K = "settings.pipelineTab";
const flush = () => act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });

const BOTH = { microsoft: true, google: true };
const NOT_CONNECTED = {
  oauth_configured: true, providers: BOTH, provider: null, connected: false, needs_reconnect: false, address: null, display_name: null,
};
const CONNECTED = {
  oauth_configured: true, providers: BOTH, provider: "microsoft", connected: true, needs_reconnect: false,
  address: "ventas@example.test", display_name: "Equipo Demo", connected_at: "2026-11-14T10:00:00Z",
};
const RECONNECT = { ...CONNECTED, needs_reconnect: true };
const GMAIL_CONNECTED = { ...CONNECTED, provider: "google", address: "ventas@gmail.example.test" };
const GMAIL_RECONNECT = { ...GMAIL_CONNECTED, needs_reconnect: true };

const apiError = (status, code) => Object.assign(new Error(`HTTP ${status}`), {
  response: { status, data: { detail: code ? { code } : "x" } },
});

async function renderTab(status = NOT_CONNECTED) {
  pipelineApi.getConfig.mockResolvedValue({ data: { sources: [], keywords: [], industries: [], excluded_companies: [] } });
  if (status instanceof Error) mailConnectionApi.status.mockRejectedValue(status);
  else mailConnectionApi.status.mockResolvedValue({ data: status });
  render(<PipelineSettingsTab />);
  await flush();
}

const badge = () => screen.getByTestId("mailbox-badge").textContent;
const button = (key) => screen.queryByRole("button", { name: `${K}.${key}` });
const click = async (element) => {
  await act(async () => { fireEvent.click(element); });
  await flush();
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});
afterEach(() => {
  sessionStorage.clear();
});

describe("estado del buzón", () => {
  it("sin conectar: «Conectar Outlook» y «Conectar Gmail», con el texto de consentimiento", async () => {
    await renderTab();
    expect(mailConnectionApi.status).toHaveBeenCalledTimes(1);
    expect(badge()).toBe(`${K}.mailboxNotConnected`);
    expect(button("mailboxConnectOutlook")).toBeTruthy();
    expect(button("mailboxConnectGmail")).toBeTruthy();
    expect(button("mailboxReconnectButton")).toBeNull();
    expect(button("mailboxTestButton")).toBeNull();
    expect(button("mailboxDisconnectButton")).toBeNull();
    expect(screen.queryByTestId("mailbox-account")).toBeNull();
    const consent = screen.getByTestId("mailbox-consent");
    expect(consent.textContent).toBe(`${K}.mailboxConsent`);
    expect(button("mailboxConnectOutlook").getAttribute("aria-describedby")).toBe(consent.id);
    expect(button("mailboxConnectGmail").getAttribute("aria-describedby")).toBe(consent.id);
  });

  it("conectado: la cuenta, «Probar» y «Desconectar»", async () => {
    await renderTab(CONNECTED);
    expect(badge()).toBe(`${K}.mailboxConnected`);
    expect(screen.getByTestId("mailbox-display-name").textContent).toBe("Equipo Demo");
    expect(screen.getByTestId("mailbox-address").textContent).toBe("ventas@example.test");
    expect(button("mailboxTestButton")).toBeTruthy();
    expect(button("mailboxDisconnectButton")).toBeTruthy();
    expect(button("mailboxConnectOutlook")).toBeNull();
    expect(button("mailboxConnectGmail")).toBeNull();
    expect(button("mailboxReconnectButton")).toBeNull();
    expect(screen.queryByTestId("mailbox-reconnect-note")).toBeNull();
    expect(screen.getByTestId("mailbox-provider").textContent).toBe(`${K}.mailboxProviderMicrosoft`);
  });

  it("conectado con Gmail: muestra Gmail y su dirección, «Probar» y «Desconectar»", async () => {
    await renderTab(GMAIL_CONNECTED);
    expect(badge()).toBe(`${K}.mailboxConnected`);
    expect(screen.getByTestId("mailbox-provider").textContent).toBe(`${K}.mailboxProviderGoogle`);
    expect(screen.getByTestId("mailbox-address").textContent).toBe("ventas@gmail.example.test");
    expect(button("mailboxTestButton")).toBeTruthy();
    expect(button("mailboxConnectGmail")).toBeNull();
  });

  it("un buzón guardado antes de Gmail (sin provider) se muestra como Outlook", async () => {
    const { provider, providers, ...old } = CONNECTED;
    await renderTab(old);
    expect(screen.getByTestId("mailbox-provider").textContent).toBe(`${K}.mailboxProviderMicrosoft`);
  });

  it("necesita reconexión: aviso, «Reconectar» y «Desconectar», sin «Probar»", async () => {
    await renderTab(RECONNECT);
    expect(badge()).toBe(`${K}.mailboxNeedsReconnect`);
    expect(screen.getByTestId("mailbox-reconnect-note").textContent).toBe(`${K}.mailboxReconnectNote`);
    expect(button("mailboxReconnectButton")).toBeTruthy();
    expect(button("mailboxDisconnectButton")).toBeTruthy();
    expect(button("mailboxTestButton")).toBeNull();
    expect(button("mailboxConnectOutlook")).toBeNull();
    expect(button("mailboxConnectGmail")).toBeNull();
  });

  it("sin ninguna app registrada en el servidor: aviso y ambos «Conectar» desactivados", async () => {
    await renderTab({ ...NOT_CONNECTED, oauth_configured: false, providers: { microsoft: false, google: false } });
    expect(screen.getByTestId("mailbox-oauth-off").textContent).toBe(`${K}.mailboxOauthNotConfigured`);
    expect(button("mailboxConnectOutlook").disabled).toBe(true);
    expect(button("mailboxConnectGmail").disabled).toBe(true);
  });

  it("solo Gmail disponible en el servidor: «Conectar Outlook» desactivado y «Conectar Gmail» activo", async () => {
    await renderTab({ ...NOT_CONNECTED, providers: { microsoft: false, google: true } });
    expect(screen.queryByTestId("mailbox-oauth-off")).toBeNull();
    expect(button("mailboxConnectOutlook").disabled).toBe(true);
    expect(button("mailboxConnectGmail").disabled).toBe(false);
  });

  it("un servidor antiguo sin `providers` sigue funcionando: ambos activos", async () => {
    const { providers, provider, ...old } = NOT_CONNECTED;
    await renderTab(old);
    expect(button("mailboxConnectOutlook").disabled).toBe(false);
    expect(button("mailboxConnectGmail").disabled).toBe(false);
  });

  it("si no se puede leer el estado: aviso y ningún botón del buzón", async () => {
    await renderTab(apiError(500));
    expect(badge()).toBe(`${K}.mailboxStatusUnknown`);
    expect(screen.getByTestId("mailbox-load-error")).toBeTruthy();
    for (const key of ["mailboxConnectOutlook", "mailboxConnectGmail", "mailboxReconnectButton", "mailboxTestButton", "mailboxDisconnectButton"]) {
      expect(button(key)).toBeNull();
    }
  });

  it("ya no hay campos SMTP ni de remitente", async () => {
    await renderTab(CONNECTED);
    expect(document.querySelector('input[type="password"]:not([aria-label])')).toBeNull();
    expect(screen.queryByText(/smtp/i)).toBeNull();
    expect(screen.queryByText(`${K}.senderEmailLabel`)).toBeNull();
    expect(screen.queryByText(`${K}.senderNameLabel`)).toBeNull();
  });
});

describe("«Conectar» y «Reconectar»", () => {
  it.each([
    ["Conectar Outlook", NOT_CONNECTED, "mailboxConnectOutlook", "microsoft"],
    ["Conectar Gmail", NOT_CONNECTED, "mailboxConnectGmail", "google"],
    ["Reconectar Outlook", RECONNECT, "mailboxReconnectButton", "microsoft"],
    ["Reconectar Gmail", GMAIL_RECONNECT, "mailboxReconnectButton", "google"],
  ])("%s pide la URL de su proveedor y navega a ella", async (_name, status, key, provider) => {
    await renderTab(status);
    mailConnectionApi.start.mockResolvedValue({ data: { authorize_url: "https://login.example.test/authorize?x=1" } });
    await click(button(key));
    expect(mailConnectionApi.start).toHaveBeenCalledTimes(1);
    expect(mailConnectionApi.start).toHaveBeenCalledWith(provider);
    expect(openAuthorizeUrl).toHaveBeenCalledWith("https://login.example.test/authorize?x=1");
    expect(toast.error).not.toHaveBeenCalled();
    // Mientras la página se va, el botón queda ocupado: un segundo clic no hace nada.
    expect(button(key).disabled).toBe(true);
  });

  it.each([
    ["mail_oauth_not_configured", apiError(503, "mail_oauth_not_configured"), "mail_oauth_not_configured"],
    ["encryption_not_configured", apiError(503, "encryption_not_configured"), "encryption_not_configured"],
    ["429 sin código", apiError(429), "rateLimited"],
    ["código desconocido", apiError(500, "algo_raro"), "generic"],
  ])("error al iniciar (%s) → su texto, sin navegar", async (_name, error, key) => {
    await renderTab();
    mailConnectionApi.start.mockRejectedValue(error);
    await click(button("mailboxConnectGmail"));
    expect(openAuthorizeUrl).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(`${K}.mailboxErrors.${key}`);
    expect(button("mailboxConnectGmail").disabled).toBe(false);
    expect(button("mailboxConnectOutlook").disabled).toBe(false);
  });

  it("una respuesta sin URL válida no navega y avisa", async () => {
    openAuthorizeUrl.mockReturnValueOnce(false);
    await renderTab();
    mailConnectionApi.start.mockResolvedValue({ data: { authorize_url: "javascript:alert(1)" } });
    await click(button("mailboxConnectOutlook"));
    expect(toast.error).toHaveBeenCalledWith(`${K}.mailboxErrors.generic`);
  });
});

describe("«Probar»", () => {
  it("éxito: avisa con la dirección y no envía nada", async () => {
    await renderTab(CONNECTED);
    mailConnectionApi.test.mockResolvedValue({ data: { ok: true, address: "ventas@example.test", display_name: "Equipo Demo" } });
    await click(button("mailboxTestButton"));
    expect(mailConnectionApi.test).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("OK ventas@example.test");
    expect(pipelineApi.updateConfig).not.toHaveBeenCalled();
  });

  it.each(["mailbox_auth_failed", "mail_throttled", "mail_service_unavailable", "mail_service_timeout", "missing_permissions"])(
    "error %s → su texto, sin recargar el estado",
    async (code) => {
      await renderTab(CONNECTED);
      mailConnectionApi.test.mockRejectedValue(apiError(502, code));
      await click(button("mailboxTestButton"));
      expect(toast.error).toHaveBeenCalledWith(`${K}.mailboxErrors.${code}`);
      expect(mailConnectionApi.status).toHaveBeenCalledTimes(1);
    },
  );

  it("mailbox_reconnect_required: avisa y recarga el estado (pasa a «Reconectar»)", async () => {
    await renderTab(CONNECTED);
    mailConnectionApi.test.mockRejectedValue(apiError(409, "mailbox_reconnect_required"));
    mailConnectionApi.status.mockResolvedValue({ data: RECONNECT });
    await click(button("mailboxTestButton"));
    expect(toast.error).toHaveBeenCalledWith(`${K}.mailboxErrors.mailbox_reconnect_required`);
    expect(mailConnectionApi.status).toHaveBeenCalledTimes(2);
    expect(badge()).toBe(`${K}.mailboxNeedsReconnect`);
  });

  it("queda desactivado mientras prueba (una sola llamada)", async () => {
    await renderTab(CONNECTED);
    let resolve;
    mailConnectionApi.test.mockReturnValue(new Promise((r) => { resolve = r; }));
    await click(button("mailboxTestButton"));
    const busy = screen.getByRole("button", { name: `${K}.mailboxTesting` });
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    await act(async () => { resolve({ data: { ok: true, address: "ventas@example.test" } }); });
    await flush();
    expect(mailConnectionApi.test).toHaveBeenCalledTimes(1);
  });
});

describe("«Desconectar»", () => {
  it("pide confirmación; al confirmar borra la conexión y recarga el estado", async () => {
    await renderTab(CONNECTED);
    mailConnectionApi.delete.mockResolvedValue({ status: 204 });
    mailConnectionApi.status.mockResolvedValue({ data: NOT_CONNECTED });
    await click(button("mailboxDisconnectButton"));
    expect(mailConnectionApi.delete).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(`${K}.mailboxDisconnectMessage`)).toBeTruthy();
    await click(within(dialog).getByRole("button", { name: `${K}.mailboxDisconnectButton` }));
    expect(mailConnectionApi.delete).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(`${K}.mailboxDisconnected`);
    expect(mailConnectionApi.status).toHaveBeenCalledTimes(2);
    expect(badge()).toBe(`${K}.mailboxNotConnected`);
  });

  it("cancelar no borra nada", async () => {
    await renderTab(CONNECTED);
    await click(button("mailboxDisconnectButton"));
    await click(within(screen.getByRole("dialog")).getByRole("button", { name: `${K}.cancelButton` }));
    expect(mailConnectionApi.delete).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("si falla, avisa y vuelve a leer el estado", async () => {
    await renderTab(CONNECTED);
    mailConnectionApi.delete.mockRejectedValue(apiError(500));
    await click(button("mailboxDisconnectButton"));
    await click(within(screen.getByRole("dialog")).getByRole("button", { name: `${K}.mailboxDisconnectButton` }));
    expect(toast.error).toHaveBeenCalledWith(`${K}.mailboxDisconnectError`);
    expect(mailConnectionApi.status).toHaveBeenCalledTimes(2);
  });
});

describe("aviso al volver de Microsoft", () => {
  it("conectado: aviso de éxito, una sola vez", async () => {
    sessionStorage.setItem(MAIL_CONNECTION_RESULT_KEY, "connected");
    await renderTab(CONNECTED);
    expect(screen.getByTestId("mailbox-result").textContent).toBe(`${K}.mailboxConnectedNotice`);
    expect(screen.getByTestId("mailbox-result").getAttribute("role")).toBe("status");
    expect(sessionStorage.getItem(MAIL_CONNECTION_RESULT_KEY)).toBeNull();
  });

  it.each(["consent_denied", "admin_consent_required", "invalid_state", "missing_permissions", "server_error"])(
    "error %s: aviso con su texto",
    async (code) => {
      sessionStorage.setItem(MAIL_CONNECTION_RESULT_KEY, code);
      await renderTab();
      const notice = screen.getByTestId("mailbox-result");
      expect(notice.getAttribute("role")).toBe("alert");
      expect(notice.textContent).toBe(`Failed. ${K}.mailboxErrors.${code}`);
      expect(sessionStorage.getItem(MAIL_CONNECTION_RESULT_KEY)).toBeNull();
    },
  );

  it("un código que la interfaz no conoce usa el texto genérico", async () => {
    sessionStorage.setItem(MAIL_CONNECTION_RESULT_KEY, "codigo_nuevo");
    await renderTab();
    expect(screen.getByTestId("mailbox-result").textContent).toBe(`Failed. ${K}.mailboxErrors.generic`);
  });

  it("sin resultado guardado no hay aviso", async () => {
    await renderTab();
    expect(screen.queryByTestId("mailbox-result")).toBeNull();
  });
});

describe("textos del buzón", () => {
  const LANGS = ["en", "es", "pt"];
  const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it.each(LANGS)("cada código de error del buzón tiene texto en %s", (lang) => {
    for (const code of MAILBOX_ERROR_CODES) {
      const value = translations[lang].settings.pipelineTab.mailboxErrors[code];
      expect(typeof value, `${lang}.${code}`).toBe("string");
      expect(value.trim(), `${lang}.${code}`).not.toBe("");
    }
  });

  it("los marcadores de los textos del buzón coinciden en los tres idiomas", () => {
    const tab = (lang) => translations[lang].settings.pipelineTab;
    for (const key of Object.keys(tab("en")).filter((k) => k.startsWith("mailbox") && typeof tab("en")[k] === "string")) {
      expect(placeholders(tab("es")[key]), `es.${key}`).toEqual(placeholders(tab("en")[key]));
      expect(placeholders(tab("pt")[key]), `pt.${key}`).toEqual(placeholders(tab("en")[key]));
    }
  });

  it("el consentimiento dice que se pide enviar y leer, y que solo se leen los mensajes propios", () => {
    const consent = (lang) => translations[lang].settings.pipelineTab.mailboxConsent;
    expect(consent("es")).toMatch(/enviar y leer/);
    expect(consent("es")).toMatch(/solo lee los mensajes que ella misma envió/);
    expect(consent("en")).toMatch(/send and read/);
    expect(consent("en")).toMatch(/only reads the messages it sent itself/);
    expect(consent("pt")).toMatch(/enviar e ler/);
    expect(consent("pt")).toMatch(/só lê as mensagens que ela mesma enviou/);
  });
});
