import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PROPOSAL_STATUS, getAllowedTransitions, proposalStatusLabelKey, requiresStatusConfirmation, toDisplayProposalStatus } from "@/features/proposals/proposalStatus";
import { useI18n } from "@/hooks/useI18n";

// Selector del estado comercial: ofrece solo los destinos permitidos desde el
// estado actual, con aspecto de desplegable. Sin destinos (firmada, desconocido,
// rechazada sin ser admin) muestra solo la etiqueta, como badge de solo lectura.
// Firmada y rechazada piden confirmación antes de llamar a `onChange`.
export function ProposalStatusControl({ status, proposalTitle = "", isAdmin = false, pending = false, colorClassName = "", onChange }) {
  const { t } = useI18n();
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const currentStatus = toDisplayProposalStatus(status);
  const allowedStatuses = getAllowedTransitions(currentStatus, { isAdmin });
  const label = (value) => t(proposalStatusLabelKey(value));

  // El select es controlado: si no se llama a onChange, sigue mostrando el estado actual.
  const handleSelect = (value) => {
    if (requiresStatusConfirmation(value)) setConfirmTarget(value);
    else onChange(value);
  };

  const handleConfirm = async () => {
    if (submittingRef.current || !confirmTarget) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onChange(confirmTarget);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
      setConfirmTarget(null);
    }
  };

  const confirmDialog = (
    <ConfirmDialog
      open={Boolean(confirmTarget)}
      title={t("proposalStatus.confirm.title")}
      message={t("proposalStatus.confirm.message")
        .replace("{title}", proposalTitle)
        .replace("{status}", confirmTarget ? label(confirmTarget) : "")}
      warning={t(confirmTarget === PROPOSAL_STATUS.FIRMADA ? "proposalStatus.confirm.warningSigned" : "proposalStatus.confirm.warningRejected")}
      cancelLabel={t("proposalStatus.confirm.cancel")}
      confirmLabel={t("proposalStatus.confirm.confirm")}
      onCancel={() => setConfirmTarget(null)}
      onConfirm={handleConfirm}
      busy={submitting || pending}
    />
  );

  // El diálogo queda fuera de las dos ramas: al confirmar Firmada la actualización
  // inmediata deja la propuesta sin destinos y no debe desmontarse mientras guarda.
  const control = allowedStatuses.length === 0 ? (
    <div className="mt-3 inline-flex" data-testid="proposal-status-control">
      <span
        title={t("proposalStatus.noActions")}
        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium cursor-default ${colorClassName}`}
      >
        {label(currentStatus)}
      </span>
    </div>
  ) : (
    <div
      className={`relative mt-3 inline-flex items-center transition-opacity ${pending ? "opacity-60" : ""}`}
      data-testid="proposal-status-control"
    >
      <select
        value={currentStatus}
        onChange={(event) => handleSelect(event.target.value)}
        disabled={pending}
        aria-label={t("proposals.status")}
        className={`appearance-none cursor-pointer rounded-md border border-slate-300 dark:border-slate-500 py-1 pl-3 pr-8 text-xs font-medium shadow-sm transition-colors hover:border-slate-400 dark:hover:border-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-slate-800 disabled:cursor-wait ${colorClassName}`}
      >
        <option value={currentStatus} disabled className="bg-white text-slate-900">
          {label(currentStatus)}
        </option>
        {allowedStatuses.map((value) => (
          <option key={value} value={value} className="bg-white text-slate-900">
            {label(value)}
          </option>
        ))}
      </select>
      <ChevronDown size={14} aria-hidden="true" className="pointer-events-none absolute right-2.5 opacity-70" />
    </div>
  );

  return (
    <>
      {control}
      {confirmDialog}
    </>
  );
}
