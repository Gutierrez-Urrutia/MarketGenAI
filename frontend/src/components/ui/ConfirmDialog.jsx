/**
 * ConfirmDialog — confirmación accesible que se abre sobre otros modales.
 * El foco inicial va en Cancelar; Escape cancela; Enter solo activa el botón enfocado.
 * Con `busy`, Confirmar queda deshabilitado y no se puede cancelar.
 */
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Btn } from "@/components/dashboard/ui";

export function ConfirmDialog({ open, title, message, warning, cancelLabel, confirmLabel, onCancel, onConfirm, busy = false }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement;
    dialogRef.current?.querySelector("[data-confirm-cancel]")?.focus();
    return () => previousFocus?.focus?.();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (!busy) onCancel();
        return;
      }
      // Tab queda dentro del diálogo.
      if (event.key === "Tab" && dialogRef.current) {
        const buttons = [...dialogRef.current.querySelectorAll("button:not([disabled])")];
        if (!buttons.length) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl dark:border dark:border-white/10 dark:bg-slate-800"
      >
        <h2 id={titleId} className="text-base font-semibold text-gray-900 dark:text-white">{title}</h2>
        <p id={messageId} className="mt-2 text-sm text-gray-600 dark:text-slate-300">{message}</p>
        {warning && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
            {warning}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Btn type="button" variant="secondary" data-confirm-cancel="" onClick={onCancel} disabled={busy} className="disabled:opacity-60">
            {cancelLabel}
          </Btn>
          <Btn type="button" onClick={onConfirm} disabled={busy} className="disabled:cursor-wait disabled:opacity-60">
            {confirmLabel}
          </Btn>
        </div>
      </div>
    </div>,
    document.body,
  );
}
