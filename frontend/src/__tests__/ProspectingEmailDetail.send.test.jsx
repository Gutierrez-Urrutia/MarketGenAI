/**
 * RF-VTA-16, envío real — ProspectingEmailDetail: «Enviar» con confirmación,
 * motivos para desactivarlo, error y envío incierto con «Reintentar», línea
 * de baja aparte del cuerpo y «No volver a contactar». Sin API: callbacks
 * espiados. Textos reales en inglés; datos sintéticos (example.com).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import ProspectingEmailDetail from "@/features/outreach/ProspectingEmailDetail";
import { translations } from "@/i18n/translations";

const t = (key) => key.split(".").reduce((node, part) => node?.[part], translations.en) ?? key;
const P = translations.en.outreachPage.prospecting;

const READY = {
  oauth_configured: true, mailbox_connected: true, mailbox_needs_reconnect: false, mailbox_address: "ventas@example.com",
  server_send_enabled: true, user_send_enabled: true, real_send_enabled: true, daily_limit: 50, sent_today: 3,
  sender_email: "ventas@example.com", sender_name: "Equipo Ventas",
};
const NOT_CONNECTED = { ...READY, mailbox_connected: false, mailbox_address: null, sender_email: "", sender_name: "" };
const RECONNECT = { ...READY, mailbox_needs_reconnect: true };
const EMAIL = {
  id: "e1", status: "approved", language: "es", job_title: "Support Agent", company_name: "Example Services",
  contact_name: "Ana Prueba", to_email: "ana@example.com", contact_review_status: "not_required",
  subject: "Asunto de prueba", body: "Hola Ana,\n\nCuerpo.", history: [],
  unsubscribe_line: "Si prefiere no recibir más correos, responda a este mensaje y lo anotaremos.",
};

function renderDetail(props = {}) {
  const handlers = {
    onSend: vi.fn(), onMarkSent: vi.fn(), onReject: vi.fn(), onCopy: vi.fn(), onDoNotContact: vi.fn(), onOpenSettings: vi.fn(),
  };
  render(<ProspectingEmailDetail email={EMAIL} t={t} sendStatus={READY} {...handlers} {...props} />);
  return handlers;
}

const sendButton = () => screen.getByRole("button", { name: P.actions.send });
const dialog = () => screen.getByRole("dialog");

describe("entorno de pruebas: el correo va al equipo, no al contacto", () => {
  const TEAM = ["pa.gutierrezu@duocuc.cl", "her.lopezs@duocuc.cl", "jor.saavedra@duocuc.cl"];

  it("sin redirección no aparece la fila", () => {
    renderDetail();
    fireEvent.click(sendButton());
    expect(within(dialog()).queryByTestId("send-summary-redirect")).toBeNull();
  });

  it("con redirección muestra a quién se entregará de verdad, junto al aviso", () => {
    renderDetail({ sendStatus: { ...READY, redirect_active: true, redirect_to: TEAM, redirect_misconfigured: false } });
    fireEvent.click(sendButton());
    const row = within(dialog()).getByTestId("send-summary-redirect");
    expect(row.querySelector("dt").textContent).toBe(P.send.redirectLabel);
    expect(within(row).getByTestId("send-redirect-to").textContent).toBe(TEAM.join(", "));
    expect(within(row).getByTestId("send-redirect-note").textContent).toBe(P.send.redirectNote);
    // El contacto real sigue visible en «Para», para que se vea que NO es a quien llega.
    expect(within(dialog()).getByTestId("send-summary-to").querySelector("dd").textContent).toBe("ana@example.com");
    const rows = [...within(dialog()).getByTestId("send-summary").querySelectorAll(":scope > div")].map((el) => el.dataset.testid);
    expect(rows).toEqual(["send-summary-to", "send-summary-redirect", "send-summary-from", "send-summary-subject"]);
  });

  it("con la configuración rota avisa que no se enviará nada y no lista direcciones", () => {
    renderDetail({ sendStatus: { ...READY, redirect_active: true, redirect_to: [], redirect_misconfigured: true } });
    fireEvent.click(sendButton());
    const row = within(dialog()).getByTestId("send-summary-redirect");
    expect(within(row).getByTestId("send-redirect-broken").textContent).toBe(P.send.redirectBroken);
    expect(within(row).queryByTestId("send-redirect-to")).toBeNull();
  });
});

describe("«Enviar» y su confirmación", () => {
  it("con todo en orden está habilitado y no muestra aviso", () => {
    renderDetail();
    expect(sendButton().disabled).toBe(false);
    expect(sendButton().getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByTestId("send-block-note")).toBeNull();
  });

  it("el diálogo muestra Para, Desde y Asunto en filas separadas; cancelar no envía", () => {
    const { onSend } = renderDetail();
    fireEvent.click(sendButton());
    const row = (id) => within(dialog()).getByTestId(id);
    // Each row: the label (dt) above its value (dd), in this order.
    const rows = within(dialog()).getByTestId("send-summary").querySelectorAll(":scope > div");
    expect([...rows].map((el) => el.dataset.testid)).toEqual(["send-summary-to", "send-summary-from", "send-summary-subject"]);
    expect(row("send-summary-to").querySelector("dt").textContent).toBe(P.send.toLabel);
    expect(row("send-summary-to").querySelector("dd").textContent).toBe("ana@example.com");
    expect(row("send-summary-from").querySelector("dt").textContent).toBe(P.send.fromLabel);
    // Sender name and address on separate lines.
    expect(row("send-summary-from-name").textContent).toBe("Equipo Ventas");
    expect(row("send-summary-from-email").textContent).toBe("ventas@example.com");
    expect(row("send-summary-from-name").className).toContain("block");
    expect(row("send-summary-from-email").className).toContain("block");
    expect(row("send-summary-subject").querySelector("dt").textContent).toBe(P.send.subjectLabel);
    expect(row("send-summary-subject").querySelector("dd").textContent).toBe("Asunto de prueba");
    // Long addresses wrap instead of overflowing.
    expect(row("send-summary-to").querySelector("dd").className).toContain("[overflow-wrap:anywhere]");
    // The real-send warning comes after the rows.
    const warning = within(dialog()).getByText(P.send.confirmWarning);
    expect(row("send-summary-subject").compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dialog().getAttribute("aria-describedby")).toContain(within(dialog()).getByTestId("send-summary").parentElement.id);
    fireEvent.click(within(dialog()).getByRole("button", { name: P.send.cancel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sin nombre de remitente, «Desde» muestra solo la dirección", () => {
    renderDetail({ sendStatus: { ...READY, sender_name: "" } });
    fireEvent.click(sendButton());
    expect(within(dialog()).queryByTestId("send-summary-from-name")).toBeNull();
    expect(within(dialog()).getByTestId("send-summary-from-email").textContent).toBe("ventas@example.com");
  });

  it("confirmar envía una vez, sin force_retry", () => {
    const { onSend } = renderDetail();
    fireEvent.click(sendButton());
    fireEvent.click(within(dialog()).getByRole("button", { name: P.send.confirmButton }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith(EMAIL, { forceRetry: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    ["mailbox_not_connected", NOT_CONNECTED, {}, false],
    ["mailbox_reconnect_required", RECONNECT, {}, false],
    ["server_disabled", { ...READY, server_send_enabled: false }, {}, false],
    ["user_disabled", { ...READY, user_send_enabled: false }, {}, false],
    ["contact_not_reviewed", READY, { contact_review_status: "pending" }, false],
    ["do_not_contact", READY, {}, true],
    ["daily_limit", { ...READY, sent_today: 50 }, {}, false],
    ["loading", null, {}, false],
  ])("%s: «Enviar» desactivado con su aviso enlazado", (reason, status, emailChange, blocked) => {
    const { onSend } = renderDetail({ sendStatus: status, email: { ...EMAIL, ...emailChange }, blocked });
    const button = sendButton();
    expect(button.disabled).toBe(true);
    const note = screen.getByTestId("send-block-note");
    expect(button.getAttribute("aria-describedby")).toBe(note.id);
    expect(note.getAttribute("role")).toBe("note");
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
    expect(note.textContent).toContain(P.send.blocked[reason]);
    // Only the mailbox and the user's own switch link to Settings.
    const link = within(note).queryByTestId("send-block-settings-link");
    expect(Boolean(link)).toBe(["mailbox_not_connected", "mailbox_reconnect_required", "user_disabled"].includes(reason));
  });

  it("sin buzón conectado: enlace «Ir a Configuración», sin iniciar ninguna conexión", () => {
    const { onOpenSettings, onSend } = renderDetail({ sendStatus: NOT_CONNECTED });
    fireEvent.click(within(screen.getByTestId("send-block-note")).getByRole("button", { name: P.send.openSettings }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledWith();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("buzón que necesita reconexión: enlace «Reconectar en Configuración» que lleva a Configuración", () => {
    const { onOpenSettings } = renderDetail({ sendStatus: RECONNECT });
    const note = screen.getByTestId("send-block-note");
    expect(note.textContent).toContain(P.send.blocked.mailbox_reconnect_required);
    fireEvent.click(within(note).getByRole("button", { name: P.send.reconnectInSettings }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("el buzón tiene prioridad sobre los demás motivos", () => {
    renderDetail({ sendStatus: { ...NOT_CONNECTED, user_send_enabled: false, sent_today: 99 }, blocked: true });
    expect(screen.getByTestId("send-block-note").textContent).toContain(P.send.blocked.mailbox_not_connected);
  });

  it("mientras envía, todo queda desactivado", () => {
    renderDetail({ sending: true });
    const button = screen.getByRole("button", { name: P.actions.sending });
    expect(button.disabled).toBe(true);
    expect(screen.getByRole("button", { name: P.actions.markSent }).disabled).toBe(true);
  });

  it("sin onSend (otras vistas) no aparece «Enviar»", () => {
    render(<ProspectingEmailDetail email={EMAIL} t={t} />);
    expect(screen.queryByRole("button", { name: P.actions.send })).toBeNull();
  });
});

describe("errores y envío incierto", () => {
  it("un fallo anterior se muestra como alerta y se puede volver a enviar", () => {
    renderDetail({ email: { ...EMAIL, last_send_error: { code: "mail_rejected", at: "2026-11-12T15:00:00Z" } } });
    const alert = screen.getByTestId("send-last-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain(P.errors.mail_rejected);
    expect(sendButton().disabled).toBe(false);
  });

  it("un envío incierto avisa, ofrece «Reintentar envío» con doble confirmación y deja «Marcar como enviado»", () => {
    const uncertain = { ...EMAIL, send_lock: { id: "l1", at: "2026-11-12T15:00:00Z", uncertain: true }, last_send_error: { code: "send_timeout", at: "2026-11-12T15:00:00Z" } };
    const { onSend, onMarkSent } = renderDetail({ email: uncertain });
    expect(screen.getByTestId("send-uncertain").textContent).toBe(P.send.uncertain);
    expect(screen.queryByTestId("send-last-error")).toBeNull();
    expect(screen.queryByRole("button", { name: P.actions.send })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: P.actions.retrySend }));
    expect(dialog().textContent).toContain(P.send.retryTitle);
    expect(dialog().textContent).toContain(P.send.retryWarning);
    fireEvent.click(within(dialog()).getByRole("button", { name: P.send.cancel }));
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: P.actions.retrySend }));
    fireEvent.click(within(dialog()).getByRole("button", { name: P.send.retryButton }));
    expect(onSend).toHaveBeenCalledWith(uncertain, { forceRetry: true });

    fireEvent.click(screen.getByRole("button", { name: P.actions.markSent }));
    expect(onMarkSent).toHaveBeenCalledTimes(1);
  });
});

describe("línea de baja", () => {
  it.each(["pending_review", "approved", "sent"])("se ve aparte del cuerpo en %s", (status) => {
    renderDetail({ email: { ...EMAIL, status } });
    const line = screen.getByTestId("email-unsubscribe-line");
    expect(line.textContent).toContain(P.detail.unsubscribeLabel);
    expect(line.textContent).toContain(EMAIL.unsubscribe_line);
    expect(screen.getByTestId("email-body").textContent).toBe(EMAIL.body);
    expect(screen.getByTestId("email-body").contains(line)).toBe(false);
  });

  it("no se muestra en un correo rechazado", () => {
    renderDetail({ email: { ...EMAIL, status: "rejected" } });
    expect(screen.queryByTestId("email-unsubscribe-line")).toBeNull();
  });
});

describe("«No volver a contactar»", () => {
  it("pide confirmación antes de agregar", () => {
    const { onDoNotContact } = renderDetail();
    fireEvent.click(screen.getByRole("button", { name: P.actions.doNotContact }));
    expect(dialog().textContent).toContain("ana@example.com");
    fireEvent.click(within(dialog()).getByRole("button", { name: P.send.cancel }));
    expect(onDoNotContact).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: P.actions.doNotContact }));
    fireEvent.click(within(dialog()).getByRole("button", { name: P.doNotContact.confirmButton }));
    expect(onDoNotContact).toHaveBeenCalledWith(EMAIL);
  });

  it("con el destinatario en la lista muestra la marca en lugar del botón", () => {
    renderDetail({ blocked: true });
    expect(screen.getByTestId("do-not-contact-mark").textContent).toBe(P.detail.onDoNotContactList);
    expect(screen.queryByRole("button", { name: P.actions.doNotContact })).toBeNull();
  });
});

describe("correo enviado", () => {
  it("dice si salió desde la plataforma y quién lo envió", () => {
    renderDetail({ email: { ...EMAIL, status: "sent", send_method: "platform", sent_by_name: "Usuaria Demo", sent_at: "2026-11-12T15:00:00Z" } });
    expect(screen.getByTestId("sent-by").textContent).toContain("Sent from the platform · Usuaria Demo");
    expect(screen.getByTestId("sent-by").textContent).not.toMatch(/smtp/i);
    expect(screen.queryByRole("button", { name: P.actions.send })).toBeNull();
  });

  it("o si solo se marcó como enviado", () => {
    renderDetail({ email: { ...EMAIL, status: "sent", send_method: "manual", sent_marked_by_name: "Usuaria Demo", sent_at: "2026-11-12T15:00:00Z" } });
    expect(screen.getByTestId("sent-by").textContent).toContain("Marked as sent · Usuaria Demo");
  });

  it("el historial muestra el envío desde la plataforma y el error previo de un marcado", () => {
    renderDetail({
      email: {
        ...EMAIL, status: "sent",
        history: [
          { action: "send", at: "2026-11-12T15:00:00Z", by_name: "Usuaria Demo" },
          { action: "mark_sent", at: "2026-11-12T15:05:00Z", send_error: "send_timeout" },
        ],
      },
    });
    expect(screen.getByText(P.history.actions.send)).toBeTruthy();
    expect(screen.getByText(new RegExp(P.errors.send_timeout.slice(0, 20)))).toBeTruthy();
  });
});
