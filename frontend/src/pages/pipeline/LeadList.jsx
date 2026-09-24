/**
 * LeadList — Agente 1 output (Fase 2). Lists leads found by the last
 * scan(s) and lets the user trigger a new scan manually. Mounted by
 * Dashboard.jsx as the "leads" top-level page.
 */
import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Radar, Loader2, RefreshCw } from "lucide-react";

import { leadsApi, pipelineApi } from "@/api/axios";
import { useI18n } from "@/hooks/useI18n";

const STATUS_OPTIONS = [
  "new", "researching", "contacts_found", "composing", "ready_for_review",
  "approved", "auto_approved", "sent", "replied", "rejected", "error",
];

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 150; // ~5 minutes

function getApiErrorMessage(error, fallback) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const firstMessage = detail
      .map((item) => item?.msg || item?.message || (typeof item === "string" ? item : ""))
      .find(Boolean);
    if (firstMessage) return firstMessage;
  }
  return error?.message || fallback;
}

const Card = ({ children, className = "" }) => (
  <div className={`bg-white rounded-2xl border border-gray-100 shadow-sm ${className}`}>{children}</div>
);

const ScoreBadge = ({ score }) => {
  const pct = Math.round((score ?? 0) * 100);
  const color = pct >= 80 ? "bg-emerald-100 text-emerald-700"
    : pct >= 60 ? "bg-amber-100 text-amber-700"
    : "bg-gray-100 text-gray-600";
  return <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${color}`}>{pct}%</span>;
};

export default function LeadList() {
  const { t } = useI18n();
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");
  const [minScore, setMinScore] = useState("");
  const pollRef = useRef(null);

  const fetchLeads = async () => {
    setLoading(true);
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (minScore) params.min_score = Number(minScore);
      const { data } = await leadsApi.list(params);
      setLeads(data.items || []);
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Failed to load leads."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLeads();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, minScore]);

  const pollRun = (runId) => {
    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts += 1;
      try {
        const { data: run } = await pipelineApi.getRun(runId);
        if (run.status === "running") {
          if (attempts >= POLL_MAX_ATTEMPTS) {
            clearInterval(pollRef.current);
            setScanning(false);
            toast.error(t("leads.scanFailed"));
          }
          return;
        }
        clearInterval(pollRef.current);
        setScanning(false);
        if (run.status === "completed") {
          toast.success(
            t("leads.scanCompleted")
              .replace("{new}", run.leads_new ?? 0)
              .replace("{found}", run.leads_found ?? 0)
          );
        } else if (run.status === "partial") {
          toast(t("leads.scanPartial"));
        } else {
          toast.error(t("leads.scanFailed"));
        }
        fetchLeads();
      } catch (error) {
        clearInterval(pollRef.current);
        setScanning(false);
        toast.error(getApiErrorMessage(error, t("leads.scanFailed")));
      }
    }, POLL_INTERVAL_MS);
  };

  const runScan = async () => {
    setScanning(true);
    try {
      const { data } = await pipelineApi.runScan();
      toast.success(t("leads.scanStarted"));
      pollRun(data.job_id);
    } catch (error) {
      setScanning(false);
      toast.error(getApiErrorMessage(error, t("leads.scanFailed")));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <Radar size={20} className="text-indigo-600" /> {t("leads.title")}
          </h1>
          <p className="text-sm text-gray-500">{t("leads.subtitle")}</p>
        </div>
        <button
          onClick={runScan}
          disabled={scanning}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          {scanning ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {scanning ? t("leads.running") : t("leads.runScan")}
        </button>
      </div>

      <Card className="p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">{t("leads.filterStatus")}</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-gray-300 rounded-lg text-xs px-2.5 py-1.5"
          >
            <option value="">{t("leads.allStatuses")}</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{t(`leads.status.${s}`)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">{t("leads.filterMinScore")}</label>
          <input
            type="number" min="0" max="1" step="0.1"
            value={minScore}
            onChange={(e) => setMinScore(e.target.value)}
            className="border border-gray-300 rounded-lg text-xs px-2.5 py-1.5 w-24"
          />
        </div>
      </Card>

      <Card className="overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm">{t("common.loading")}</div>
        ) : leads.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">{t("leads.empty")}</div>
        ) : (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                <th className="px-4 py-3">{t("leads.columnTitle")}</th>
                <th className="px-4 py-3">{t("leads.columnCompany")}</th>
                <th className="px-4 py-3">{t("leads.columnScore")}</th>
                <th className="px-4 py-3">{t("leads.columnStatus")}</th>
                <th className="px-4 py-3">{t("leads.columnFound")}</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {lead.job_url ? (
                      <a href={lead.job_url} target="_blank" rel="noreferrer" className="hover:underline">
                        {lead.job_title}
                      </a>
                    ) : lead.job_title}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{lead.company_name}</td>
                  <td className="px-4 py-3"><ScoreBadge score={lead.relevance_score} /></td>
                  <td className="px-4 py-3 text-gray-600">{t(`leads.status.${lead.status}`)}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {lead.created_at ? new Date(lead.created_at).toLocaleString() : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
