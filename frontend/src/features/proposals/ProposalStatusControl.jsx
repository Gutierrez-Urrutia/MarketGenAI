import { getAllowedTransitions, proposalStatusLabelKey, toDisplayProposalStatus } from "@/features/proposals/proposalStatus";
import { useI18n } from "@/hooks/useI18n";

// Selector del estado comercial: ofrece solo los destinos permitidos desde el
// estado actual. Sin destinos (firmada, desconocido, rechazada sin ser admin)
// muestra solo la etiqueta.
export function ProposalStatusControl({ status, isAdmin = false, pending = false, colorClassName = "", onChange }) {
  const { t } = useI18n();
  const currentStatus = toDisplayProposalStatus(status);
  const allowedStatuses = getAllowedTransitions(currentStatus, { isAdmin });
  const label = (value) => t(proposalStatusLabelKey(value));

  return (
    <div
      className={`mt-3 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium shadow-sm ${colorClassName}`}
      data-testid="proposal-status-control"
    >
      {allowedStatuses.length > 0 ? (
        <select
          value={currentStatus}
          onChange={(event) => onChange(event.target.value)}
          disabled={pending}
          aria-label={t("proposalStatus.changeTo")}
          className="cursor-pointer appearance-none border-0 bg-transparent pr-5 text-xs font-medium text-current outline-none disabled:cursor-wait"
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
      ) : (
        <span title={t("proposalStatus.noActions")}>{label(currentStatus)}</span>
      )}
    </div>
  );
}
