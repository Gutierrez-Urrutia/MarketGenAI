/**
 * Historial › detalle de un correo de prospección en solo lectura: muestra el
 * correo y una línea de cómo, cuándo y por quién se cerró (envío desde la
 * plataforma, marcado a mano, rechazado), sin acciones ni datos técnicos.
 * Textos reales en inglés; datos sintéticos (example.com). El send_method del
 * envío del sistema es un valor genérico: no se depende del transporte.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import ProspectingEmailDetail from "@/features/outreach/ProspectingEmailDetail";
import { translations } from "@/i18n/translations";
import { formatDateTime } from "@/utils/dates";

const t = (key) => key.split(".").reduce((node, part) => node?.[part], translations.en) ?? key;
const P = translations.en.outreachPage.prospecting;
const fill = (text, params) => Object.entries(params).reduce((out, [k, v]) => out.split(`{${k}}`).join(v), text);

const BASE = {
  id: "e1", language: "es", job_title: "Support Agent", company_name: "Example Services",
  contact_name: "Ana Prueba", to_email: "ana@example.com", contact_review_status: "approved",
  subject: "Asunto de prueba", body: "Hola Ana,\n\nCuerpo del correo.",
  unsubscribe_line: "Si prefiere no recibir más correos, responda a este mensaje y lo anotaremos.",
  history: [
    { action: "approve", at: "2026-11-12T10:00:00Z", by: "u-1", by_name: "Usuaria Aprueba" },
    { action: "send", at: "2026-11-13T03:43:50Z", by: "u-1", by_name: "Usuaria Envío", send_error: "send_timeout" },
  ],
};
const SENT_AT = "2026-11-13T03:43:50Z";
const REJECTED_AT = "2026-11-13T02:56:19Z";
const SYSTEM = { ...BASE, status: "sent", send_method: "platform", sent_by: "u-1", sent_by_name: "Usuaria Envío", sent_at: SENT_AT };
const MANUAL = { ...BASE, status: "sent", send_method: "manual", sent_marked_by: "u-2", sent_marked_by_name: "Usuario Marca", sent_at: SENT_AT };
const REJECTED = { ...BASE, status: "rejected", rejected_by: "u-3", rejected_by_name: "Usuaria Rechazo", rejected_at: REJECTED_AT };

const ACTION_LABELS = [
  P.actions.send, P.actions.retrySend, P.actions.reject, P.actions.approve, P.actions.markSent,
  P.actions.copy, P.actions.regenerate, P.actions.doNotContact,
];

function renderReadOnly(email) {
  const handlers = {
    onSend: vi.fn(), onMarkSent: vi.fn(), onReject: vi.fn(), onApprove: vi.fn(), onCopy: vi.fn(),
    onRegenerate: vi.fn(), onDoNotContact: vi.fn(), onOpenSettings: vi.fn(),
  };
  // Aunque se pasen handlers, readOnly no muestra ninguna acción.
  render(<ProspectingEmailDetail email={email} t={t} readOnly {...handlers} />);
  return handlers;
}
const statusLine = () => screen.getByTestId("readonly-status").textContent;

describe("ProspectingEmailDetail en solo lectura", () => {
  it("muestra destinatario, asunto y cuerpo", () => {
    renderReadOnly(SYSTEM);
    expect(screen.getByText("ana@example.com")).toBeTruthy();
    expect(screen.getByTestId("email-subject").textContent).toBe("Asunto de prueba");
    expect(screen.getByTestId("email-body").textContent).toBe("Hola Ana,\n\nCuerpo del correo.");
  });

  it("enviado desde la plataforma: «Sent from the platform · fecha · by nombre»", () => {
    renderReadOnly(SYSTEM);
    expect(statusLine()).toBe(fill(P.readOnly.sentBySystem, { date: formatDateTime(SENT_AT), name: "Usuaria Envío" }));
    expect(statusLine()).not.toMatch(/smtp/i);
  });

  it("marcado como enviado: «Marked as sent · fecha · by nombre»", () => {
    renderReadOnly(MANUAL);
    expect(statusLine()).toBe(fill(P.readOnly.markedSent, { date: formatDateTime(SENT_AT), name: "Usuario Marca" }));
  });

  it("marcado antes del envío real (sin send_method): también «Marked as sent»", () => {
    const { send_method: _omit, ...legacy } = MANUAL;
    renderReadOnly(legacy);
    expect(statusLine()).toBe(fill(P.readOnly.markedSent, { date: formatDateTime(SENT_AT), name: "Usuario Marca" }));
  });

  it("rechazado: «Rejected · fecha · by nombre»", () => {
    renderReadOnly(REJECTED);
    expect(statusLine()).toBe(fill(P.readOnly.rejected, { date: formatDateTime(REJECTED_AT), name: "Usuaria Rechazo" }));
  });

  it("si el nombre guardado es el id, muestra «Unnamed user», no el id", () => {
    renderReadOnly({ ...SYSTEM, sent_by: "local-dev-admin", sent_by_name: "local-dev-admin" });
    expect(statusLine()).toContain(P.table.unknownUser);
    expect(statusLine()).not.toContain("local-dev-admin");
  });

  it.each([["enviado", SYSTEM], ["marcado", MANUAL], ["rechazado", REJECTED]])(
    "%s: no hay botones de acción",
    (_name, email) => {
      renderReadOnly(email);
      expect(screen.queryAllByRole("button")).toHaveLength(0);
      for (const label of ACTION_LABELS) expect(screen.queryByText(label)).toBeNull();
    },
  );

  it("no muestra datos técnicos: historial, candado, intentos, envío incierto ni último error", () => {
    renderReadOnly({
      ...SYSTEM,
      status: "sent",
      send_lock: { id: "lock-1", at: SENT_AT, uncertain: true },
      send_attempts: 3,
      last_send_error: { code: "send_timeout", at: SENT_AT },
      smtp_message_id: "<id-sintetico@example.com>",
    });
    expect(screen.queryByText(P.history.title)).toBeNull();
    expect(screen.queryByTestId("send-uncertain")).toBeNull();
    expect(screen.queryByTestId("send-last-error")).toBeNull();
    expect(screen.queryByTestId("sent-by")).toBeNull();
    expect(document.body.textContent).not.toMatch(/lock-1|id-sintetico/);
  });

  it("control: sin readOnly, un correo aprobado sigue mostrando sus acciones", () => {
    render(
      <ProspectingEmailDetail
        email={{ ...BASE, status: "approved" }}
        t={t}
        onSend={vi.fn()} onMarkSent={vi.fn()} onReject={vi.fn()} onCopy={vi.fn()} onDoNotContact={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: P.actions.reject })).toBeTruthy();
    expect(screen.getByRole("button", { name: P.actions.markSent })).toBeTruthy();
    expect(screen.getByRole("button", { name: P.actions.send })).toBeTruthy();
    expect(screen.queryByTestId("readonly-status")).toBeNull();
  });
});
