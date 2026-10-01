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

// Only render a lead's job_url as a clickable link if it's http(s). The
// backend already drops non-http(s) schemes before persisting a Lead
// (job_scout_service._sanitize_job_url), but a pre-existing record from
// before that check shipped could still have an unsafe value (e.g.
// "javascript:...") sitting in Firestore — React does not sanitize URL
// schemes in an href, so this guard is the second, independent check.
function isSafeHttpUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// "Found" column: date and time (no seconds) as separate lines, the full
// value as a tooltip. Same default locale as toLocaleString(). null for a
// missing or unparseable value, so the cell can fall back to "-".
function formatFoundAt(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    date: date.toLocaleDateString(),
    time: date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    full: date.toLocaleString(),
  };
}

function FoundAtCell({ value }) {
  const found = formatFoundAt(value);
  if (!found) return <td className="px-4 py-3 text-gray-500 text-xs">-</td>;
  return (
    <td className="px-4 py-3 whitespace-nowrap" title={found.full}>
      <span className="block text-gray-700">{found.date}</span>
      <span className="block text-xs text-gray-500">{found.time}</span>
    </td>
  );
}

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
  const [loadError, setLoadError] = useState(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [minScore, setMinScore] = useState("");
  const pollRef = useRef(null);
  const mountedRef = useRef(true);
  // The poll outlives renders, so it must read the *current* filters, not the
  // ones captured when the scan started.
  const filtersRef = useRef({ statusFilter, minScore });
  filtersRef.current = { statusFilter, minScore };

  const requestSeqRef = useRef(0);

  const fetchLeads = async () => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const { statusFilter: status, minScore: score } = filtersRef.current;
      const params = {};
      if (status) params.status = status;
      if (score) params.min_score = Number(score);
      const { data } = await leadsApi.list(params);
      if (seq !== requestSeqRef.current) return; // a newer load superseded this one
      setLeads(data.items || []);
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      setLoadError(describeLoadError(error));
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    fetchLeads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, minScore]);

  // A failed load must say why and offer a retry — never leave "Loading...".
  const describeLoadError = (error) => {
    if (error?.response?.status === 401) return t("leads.sessionExpired");
    if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT") return t("leads.loadTimeout");
    return getApiErrorMessage(error, t("leads.loadError"));
  };

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };

  // Mount/unmount only: a filter change must not cancel a scan being followed,
  // and leaving the page must not leave a timer polling for a dead component.
  // The run itself keeps going on the server; it is re-attached on next mount.
  useEffect(() => {
    mountedRef.current = true;
    attachToActiveRun();
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The run state lives on the server, not in this component: after
  // navigating away and back (or reloading) ask which run is still active.
  const attachToActiveRun = async () => {
    try {
      const { data } = await pipelineApi.getActiveRun();
      if (mountedRef.current && data?.run?.id) {
        setScanning(true);
        pollRun(data.run.id);
      }
    } catch {
      // Best effort: without it the button is just enabled, and the backend
      // still rejects a second concurrent run with 409.
    }
  };

  const pollRun = (runId) => {
    stopPolling();
    let attempts = 0;
    let inFlight = false;
    pollRef.current = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      attempts += 1;
      try {
        const { data: run } = await pipelineApi.getRun(runId);
        if (!mountedRef.current) return;
        if (run.status === "running") {
          if (attempts >= POLL_MAX_ATTEMPTS) {
            stopPolling();
            setScanning(false);
            toast.error(t("leads.scanFailed"));
          }
          return;
        }
        stopPolling();
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
        // Stay disabled until the refreshed list is on screen, so the button
        // only comes back once the new results are visible.
        await fetchLeads();
        if (mountedRef.current) setScanning(false);
      } catch (error) {
        stopPolling();
        if (!mountedRef.current) return;
        setScanning(false);
        toast.error(getApiErrorMessage(error, t("leads.scanFailed")));
      } finally {
        inFlight = false;
      }
    }, POLL_INTERVAL_MS);
  };

  const runScan = async () => {
    setScanning(true);
    try {
      const { data } = await pipelineApi.runScan();
      if (!mountedRef.current) return; // left the page mid-request: re-attached on return
      toast.success(t("leads.scanStarted"));
      pollRun(data.job_id);
    } catch (error) {
      if (!mountedRef.current) return;
      const activeRunId = error?.response?.status === 409 ? error.response.data?.detail?.run_id : null;
      if (activeRunId) {
        // Someone (another tab, a reload) already started one: follow it.
        toast(t("leads.scanAlreadyRunning"));
        pollRun(activeRunId);
        return;
      }
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
        ) : loadError ? (
          <div role="alert" className="p-8 text-center text-sm">
            <p className="text-red-600 mb-3">{loadError}</p>
            <button
              onClick={fetchLeads}
              className="px-3.5 py-2 rounded-lg text-xs font-medium border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              {t("leads.retry")}
            </button>
          </div>
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
                    {isSafeHttpUrl(lead.job_url) ? (
                      <a href={lead.job_url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                        {lead.job_title}
                      </a>
                    ) : lead.job_title}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {lead.company_name?.trim() ? lead.company_name : (
                      <>
                        <span className="text-gray-400" title={t("leads.unknownCompany")} aria-hidden="true">—</span>
                        <span className="sr-only">{t("leads.unknownCompany")}</span>
                      </>
                    )}
                  </td>
                  <td className="px-4 py-3"><ScoreBadge score={lead.relevance_score} /></td>
                  <td className="px-4 py-3 text-gray-600">{t(`leads.status.${lead.status}`)}</td>
                  <FoundAtCell value={lead.created_at} />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
