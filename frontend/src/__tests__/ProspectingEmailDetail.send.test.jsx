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
  smtp_configured: true, smtp_missing_fields: [], server_send_enabled: true, user_send_enabled: true,
  real_send_enabled: true, daily_limit: 50, sent_today: 3, sender_email: "ventas@example.com", sender_name: "Equipo Ventas",
};
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

describe("«Enviar» y su confirmación", () => {
  it("con todo en orden está habilitado y no muestra aviso", () => {
    renderDetail();
    expect(sendButton().disabled).toBe(false);
    expect(sendButton().getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByTestId("send-block-note")).toBeNull();
  });

  it("el diálogo muestra destinatario, remitente y asunto; cancelar no envía", () => {
    const { onSend } = renderDetail();
    fireEvent.click(sendButton());
    const text = dialog().textContent;
    expect(text).toContain("ana@example.com");
    expect(text).toContain("Equipo Ventas <ventas@example.com>");
    expect(text).toContain("Asunto de prueba");
    expect(text).toContain(P.send.confirmWarning);
    fireEvent.click(within(dialog()).getByRole("button", { name: P.send.cancel }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
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
    ["smtp_not_configured", { ...READY, smtp_configured: false, smtp_missing_fields: ["smtp_host", "smtp_password"] }, {}, false],
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
    if (reason === "smtp_not_configured") {
      expect(note.textContent).toContain("server, password");
      fireEvent.click(within(note).getByRole("button", { name: P.send.openSettings }));
    } else {
      expect(note.textContent).toContain(P.send.blocked[reason]);
    }
  });

  it("el aviso de cuenta incompleta lleva a Configuración", () => {
    const { onOpenSettings } = renderDetail({ sendStatus: { ...READY, smtp_configured: false, smtp_missing_fields: ["smtp_user"] } });
    fireEvent.click(screen.getByRole("button", { name: P.send.openSettings }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
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
    renderDetail({ email: { ...EMAIL, last_send_error: { code: "smtp_auth_failed", at: "2026-11-12T15:00:00Z" } } });
    const alert = screen.getByTestId("send-last-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain(P.errors.smtp_auth_failed);
    expect(sendButton().disabled).toBe(false);
  });

  it("un envío incierto avisa, ofrece «Reintentar envío» con doble confirmación y deja «Marcar como enviado»", () => {
    const uncertain = { ...EMAIL, send_lock: { id: "l1", at: "2026-11-12T15:00:00Z", uncertain: true }, last_send_error: { code: "smtp_timeout", at: "2026-11-12T15:00:00Z" } };
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
  it("dice si salió por SMTP y quién lo envió", () => {
    renderDetail({ email: { ...EMAIL, status: "sent", send_method: "smtp", sent_by_name: "Usuaria Demo", sent_at: "2026-11-12T15:00:00Z" } });
    expect(screen.getByTestId("sent-by").textContent).toContain("Sent by SMTP · Usuaria Demo");
    expect(screen.queryByRole("button", { name: P.actions.send })).toBeNull();
  });

  it("o si solo se marcó como enviado", () => {
    renderDetail({ email: { ...EMAIL, status: "sent", send_method: "manual", sent_marked_by_name: "Usuaria Demo", sent_at: "2026-11-12T15:00:00Z" } });
    expect(screen.getByTestId("sent-by").textContent).toContain("Marked as sent · Usuaria Demo");
  });

  it("el historial muestra el envío por SMTP y el error previo de un marcado", () => {
    renderDetail({
      email: {
        ...EMAIL, status: "sent",
        history: [
          { action: "send", at: "2026-11-12T15:00:00Z", by_name: "Usuaria Demo" },
          { action: "mark_sent", at: "2026-11-12T15:05:00Z", send_error: "smtp_timeout" },
        ],
      },
    });
    expect(screen.getByText(P.history.actions.send)).toBeTruthy();
    expect(screen.getByText(new RegExp(P.errors.smtp_timeout.slice(0, 20)))).toBeTruthy();
  });
});
