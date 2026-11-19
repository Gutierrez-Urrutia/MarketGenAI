import { Badge, Btn, Card, Field, Input, Select } from "@/components/dashboard/ui";
import { RefreshIcon, SearchIcon } from "@/components/dashboard/icons";
import api, { authTokenStore } from "@/api/axios";
import { canViewAuditLogs } from "@/utils/permissions";
import { proposalStatusLabelKey } from "@/features/proposals/proposalStatus";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

const PROPOSAL_STATUS_CHANGED = "proposal_status_changed";
const PAGE_SIZE = 50;
// RNF-02: acciones de propuesta que deja el servidor en el registro.
const PROPOSAL_ACTIONS = [
  "proposal_created",
  "proposal_generated",
  "proposal_updated",
  "proposal_status_changed",
  "proposal_version_saved",
  "proposal_version_restored",
  "proposal_sent_to_crm",
  "proposal_deleted",
];
const EMPTY_FILTERS = { userId: "", action: "", resourceId: "", from: "", to: "" };

export function AuditLogsPage() {
  const { t } = useI18n();
  const [logs, setLogs] = useState([]);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const currentUser = authTokenStore.getUser() || {};

  const fetchLogs = async (nextFilters = filters, nextOffset = 0) => {
    setLoading(true);
    setError("");
    try {
      const params = { limit: PAGE_SIZE, offset: nextOffset };
      if (nextFilters.userId.trim()) params.userId = nextFilters.userId.trim();
      if (nextFilters.action) params.action = nextFilters.action;
      if (nextFilters.resourceId.trim()) params.resourceId = nextFilters.resourceId.trim();
      if (nextFilters.from) params.from = nextFilters.from;
      if (nextFilters.to) params.to = nextFilters.to;
      const { data } = await api.get("/admin/audit-logs", { params });
      setLogs(Array.isArray(data?.logs) ? data.logs : []);
      setHasMore(Boolean(data?.hasMore));
      setOffset(nextOffset);
    } catch (err) {
      setError(err.response?.data?.detail || t("auditLogs.loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (canViewAuditLogs(currentUser)) fetchLogs(EMPTY_FILTERS, 0);
  }, []);

  if (!canViewAuditLogs(currentUser)) {
    return null;
  }

  const setFilter = (name) => (event) => setFilters((prev) => ({ ...prev, [name]: event.target.value }));
  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    fetchLogs(EMPTY_FILTERS, 0);
  };

  const formatTimestamp = (value) => {
    if (!value) return "-";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  };
  const actionLabel = (action) => {
    if (!action) return "-";
    const key = `auditLogs.actions.${action}`;
    const label = t(key);
    return label === key ? action : label;   // registros HTTP genéricos: se muestra la acción tal cual
  };
  const failed = (log) => log.status === "failed" || Number(log.statusCode || 0) >= 400;
  const who = (log) => log.userEmail || log.userId || "-";
  const resource = (log) => log.resourceId || "-";

  return (
    <div className="space-y-2.5">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("auditLogs.title")}</h1>
          <p className="text-xs text-gray-500">{t("auditLogs.subtitle")}</p>
        </div>
        <Btn variant="secondary" icon={<RefreshIcon size={14} />} onClick={() => fetchLogs(filters, offset)} disabled={loading}>
          {t("auditLogs.refresh")}
        </Btn>
      </div>

      <Card className="p-2">
        <div className="grid grid-cols-1 gap-x-2 sm:grid-cols-2 lg:grid-cols-5">
          <Field label={t("auditLogs.filterUser")}>
            <Input value={filters.userId} onChange={setFilter("userId")} placeholder={t("auditLogs.filterUserPlaceholder")} />
          </Field>
          <Field label={t("auditLogs.filterAction")}>
            <Select value={filters.action} onChange={setFilter("action")}>
              <option value="">{t("auditLogs.allActions")}</option>
              {PROPOSAL_ACTIONS.map((action) => (
                <option key={action} value={action}>{actionLabel(action)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t("auditLogs.filterProposal")}>
            <Input value={filters.resourceId} onChange={setFilter("resourceId")} placeholder={t("auditLogs.filterProposalPlaceholder")} />
          </Field>
          <Field label={t("auditLogs.filterFrom")}>
            <Input type="date" value={filters.from} onChange={setFilter("from")} />
          </Field>
          <Field label={t("auditLogs.filterTo")}>
            <Input type="date" value={filters.to} onChange={setFilter("to")} />
          </Field>
        </div>
        <div className="flex gap-1">
          <Btn icon={<SearchIcon size={14} />} onClick={() => fetchLogs(filters, 0)} disabled={loading}>
            {t("auditLogs.search")}
          </Btn>
          <Btn variant="secondary" onClick={clearFilters} disabled={loading}>
            {t("auditLogs.clear")}
          </Btn>
        </div>
        {error && <div className="mt-2 rounded-lg border border-red-100 bg-red-50 px-3 py-4 text-xs text-red-700">{error}</div>}
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-100 text-left text-xs">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-4 font-semibold">{t("auditLogs.colDate")}</th>
                <th className="px-4 py-4 font-semibold">{t("auditLogs.colUser")}</th>
                <th className="px-4 py-4 font-semibold">{t("auditLogs.colAction")}</th>
                <th className="px-4 py-4 font-semibold">{t("auditLogs.colProposal")}</th>
                <th className="px-4 py-4 font-semibold">{t("auditLogs.colResult")}</th>
                <th className="px-4 py-4 font-semibold">{t("auditLogs.colIp")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-gray-400">{t("auditLogs.loading")}</td>
                </tr>
              )}
              {!loading && logs.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-gray-400">{t("auditLogs.empty")}</td>
                </tr>
              )}
              {!loading && logs.map((log) => (
                <tr key={log.id} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-4 text-gray-700">{formatTimestamp(log.timestamp)}</td>
                  <td className="max-w-[220px] truncate px-4 py-4 font-medium text-gray-900" title={log.userId || ""}>{who(log)}</td>
                  <td className="px-4 py-4 text-gray-700">
                    {log.action === PROPOSAL_STATUS_CHANGED ? (
                      <>
                        <div>{t("auditLogs.proposalStatusChanged")}</div>
                        <div className="text-[11px] text-gray-500">
                          {t(proposalStatusLabelKey(log.previousStatus))} → {t(proposalStatusLabelKey(log.newStatus))}
                        </div>
                      </>
                    ) : actionLabel(log.action)}
                  </td>
                  <td className="max-w-[220px] truncate px-4 py-4 font-mono text-[11px] text-gray-600" title={log.resourceId || log.path || ""}>{resource(log)}</td>
                  <td className="whitespace-nowrap px-4 py-4">
                    <Badge
                      label={failed(log) ? t("auditLogs.failed") : t("auditLogs.success")}
                      color={failed(log) ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}
                    />
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 text-gray-600">{log.ip || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end gap-1 p-2">
          <Btn variant="secondary" onClick={() => fetchLogs(filters, Math.max(0, offset - PAGE_SIZE))} disabled={loading || offset === 0}>
            {t("auditLogs.previous")}
          </Btn>
          <Btn variant="secondary" onClick={() => fetchLogs(filters, offset + PAGE_SIZE)} disabled={loading || !hasMore}>
            {t("auditLogs.next")}
          </Btn>
        </div>
      </Card>
    </div>
  );
}
