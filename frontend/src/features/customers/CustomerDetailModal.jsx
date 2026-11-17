/**
 * CustomerDetailModal — ficha del cliente: perfil e historial de propuestas (RF-VTA-03).
 * El historial llega del servidor de la más reciente a la más antigua.
 */
import { useCallback, useEffect, useState } from "react";

import { customersApi } from "@/api/customersApi";
import { Button, Modal, Spinner } from "@/components/ui";
import { proposalStatusColorClass, proposalStatusLabelKey } from "@/features/proposals/proposalStatus";
import { useI18n } from "@/hooks/useI18n";

const PAGE_SIZE = 10;

const formatDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : "—";
};

export function CustomerDetailModal({ open, onClose, customer, options }) {
  const { t } = useI18n();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!customer?.id) return;
    setLoading(true);
    setError(false);
    try {
      const { data } = await customersApi.proposals(customer.id, { limit: PAGE_SIZE, offset });
      setItems(data?.items ?? []);
      setTotal(data?.total ?? 0);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [customer?.id, offset]);

  useEffect(() => { if (open) setOffset(0); }, [open, customer?.id]);
  useEffect(() => { if (open) load(); }, [open, load]);

  if (!customer) return null;
  const industry = options.industryLabel(customer.industry);
  const size = options.sizeLabel(customer.size);

  return (
    <Modal open={open} onClose={onClose} title={customer.name} maxWidth="2xl">
      <div className="space-y-5">
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-slate-500">{t("customersPage.company")}</dt><dd className="text-slate-900">{customer.company || "—"}</dd></div>
          <div><dt className="text-xs text-slate-500">{t("customersPage.email")}</dt><dd className="text-slate-900">{customer.email}</dd></div>
          <div><dt className="text-xs text-slate-500">{t("customersPage.industry")}</dt><dd className="text-slate-900" data-testid="detail-industry">{industry || t("customersPage.undefined")}</dd></div>
          <div><dt className="text-xs text-slate-500">{t("customersPage.size")}</dt><dd className="text-slate-900" data-testid="detail-size">{size || t("customersPage.undefined")}</dd></div>
          {customer.phone && <div><dt className="text-xs text-slate-500">{t("customersPage.phone")}</dt><dd className="text-slate-900">{customer.phone}</dd></div>}
          {customer.notes && <div className="sm:col-span-2"><dt className="text-xs text-slate-500">{t("customersPage.notes")}</dt><dd className="text-slate-900">{customer.notes}</dd></div>}
        </dl>

        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-900">{t("customersPage.history")}</h3>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">{t("customersPage.proposalTitle")}</th>
                  <th className="px-3 py-2 text-left">{t("customersPage.proposalStatus")}</th>
                  <th className="px-3 py-2 text-left">{t("customersPage.proposalDate")}</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-400"><span className="inline-flex items-center gap-2"><Spinner size={14} />{t("customersPage.historyLoading")}</span></td></tr>
                )}
                {!loading && error && (
                  <tr><td colSpan={3} className="px-3 py-6 text-center text-red-500" role="alert">
                    {t("customersPage.historyError")}{" "}
                    <button type="button" className="underline" onClick={load}>{t("customersPage.retry")}</button>
                  </td></tr>
                )}
                {!loading && !error && items.length === 0 && (
                  <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-400">{t("customersPage.historyEmpty")}</td></tr>
                )}
                {!loading && !error && items.map((proposal) => (
                  <tr key={proposal.id} data-testid={`history-row-${proposal.id}`} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-800">{proposal.title || "—"}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${proposalStatusColorClass(proposal.proposal_status)}`}>
                        {t(proposalStatusLabelKey(proposal.proposal_status))}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-500">{formatDate(proposal.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > PAGE_SIZE && (
            <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
              <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} {t("customersPage.of")} {total}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>{t("customersPage.previous")}</Button>
                <Button size="sm" variant="secondary" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>{t("customersPage.next")}</Button>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>{t("customersPage.close")}</Button>
        </div>
      </div>
    </Modal>
  );
}
