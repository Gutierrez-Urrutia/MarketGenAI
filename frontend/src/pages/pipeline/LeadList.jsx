/**
 * LeadList — Agente 1 output (Fase 2). Lists leads found by the last
 * scan(s) and lets the user trigger a new scan manually. Mounted by
 * Dashboard.jsx as the "leads" top-level page.
 *
 * RF15: each row can expand into LeadContactsPanel (contact search of that
 * lead). Only one contact search runs at a time on the whole screen — each
 * one may spend Hunter credits — so the lock lives here.
 */
import { Fragment, forwardRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Radar, Loader2, RefreshCw, ArrowUp, ArrowDown, ChevronDown, ChevronRight } from "lucide-react";

import { leadsApi, pipelineApi } from "@/api/axios";
import { useI18n } from "@/hooks/useI18n";
import LeadContactsPanel from "./LeadContactsPanel";

const STATUS_OPTIONS = [
  "new", "researching", "contacts_found", "composing", "ready_for_review",
  "approved", "auto_approved", "sent", "replied", "rejected", "error",
];

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 150; // ~5 minutes

// Paging happens in the browser over one response. GET /leads caps at 200
// (most recent first), so a full response means older leads were left out.
const LEADS_LIMIT = 200;
const PAGE_SIZE = 10;

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

// Sortable columns and the direction of their first click. The backend
// already returns the default order (found, newest first), so "found" starts
// ascending; score starts with the best leads. Third click: back to default.
const SORT_COLUMNS = [
  { key: "job_title", labelKey: "leads.columnTitle", firstDir: "asc" },
  { key: "company_name", labelKey: "leads.columnCompany", firstDir: "asc" },
  { key: "relevance_score", labelKey: "leads.columnScore", firstDir: "desc" },
  { key: "status", labelKey: "leads.columnStatus", firstDir: "asc" },
  { key: "created_at", labelKey: "leads.columnFound", firstDir: "asc" },
];

export function nextSort(sort, column) {
  if (!sort || sort.key !== column.key) return { key: column.key, dir: column.firstDir };
  if (sort.dir === column.firstDir) return { key: column.key, dir: column.firstDir === "asc" ? "desc" : "asc" };
  return null;
}

const compareText = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

function foundTime(value) {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isNaN(time) ? null : time;
}

// Sorts on every render over the leads the backend sent (at most
// LEADS_LIMIT, already filtered). Blank companies and missing dates always
// go last; ties keep the backend order (found, newest first) since the sort
// is stable. Status sorts by the label the user sees.
export function sortLeads(leads, sort, t) {
  if (!sort) return leads;
  const sign = sort.dir === "asc" ? 1 : -1;
  const valueOf = {
    job_title: (lead) => (lead.job_title || "").trim(),
    company_name: (lead) => (lead.company_name || "").trim() || null,
    relevance_score: (lead) => lead.relevance_score ?? 0,
    status: (lead) => t(`leads.status.${lead.status}`),
    created_at: (lead) => foundTime(lead.created_at),
  }[sort.key];
  return [...leads].sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    if (va === null || vb === null) return (va === null) - (vb === null);
    return sign * (typeof va === "string" ? compareText(va, vb) : va - vb);
  });
}

// Derived on every render (no effect): when the list shrinks under the page
// being shown, that page is clamped to the last one that still exists.
export function paginate(items, page, pageSize = PAGE_SIZE) {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), pageCount);
  const firstIndex = (currentPage - 1) * pageSize;
  return { pageCount, currentPage, firstIndex, pageItems: items.slice(firstIndex, firstIndex + pageSize) };
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

const Card = forwardRef(({ children, className = "" }, ref) => (
  <div ref={ref} className={`bg-white rounded-2xl border border-gray-100 shadow-sm ${className}`}>{children}</div>
));
Card.displayName = "Card";

const ScoreBadge = ({ score }) => {
  const pct = Math.round((score ?? 0) * 100);
  const color = pct >= 80 ? "bg-emerald-100 text-emerald-700"
    : pct >= 60 ? "bg-amber-100 text-amber-700"
    : "bg-gray-100 text-gray-600";
  return <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${color}`}>{pct}%</span>;
};

// Width of the table's scroll container, so the expanded panel (a sticky,
// full-row cell) is never wider than what is visible: on a phone the table
// may scroll sideways, the panel does not. null until measured (jsdom).
function useVisibleWidth(ref) {
  const [width, setWidth] = useState(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => setWidth(element.clientWidth || null);
    measure();
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [ref]);
  return width;
}

const COLUMN_COUNT = SORT_COLUMNS.length + 2; // "#" + sortable columns + contacts

export default function LeadList({ onNavigate } = {}) {
  const { t } = useI18n();
  const [expandedLeadId, setExpandedLeadId] = useState(null);
  const [searchingLeadId, setSearchingLeadId] = useState(null);
  const searchingLeadRef = useRef(null);
  const tableBoxRef = useRef(null);
  const visibleWidth = useVisibleWidth(tableBoxRef);

  // The ref is checked and set before any await, so two clicks in the same
  // tick (or on two rows) can never both start a search.
  const searchLock = {
    activeLeadId: searchingLeadId,
    tryAcquire: (leadId) => {
      if (searchingLeadRef.current !== null) return false;
      searchingLeadRef.current = leadId;
      setSearchingLeadId(leadId);
      return true;
    },
    release: (leadId) => {
      if (searchingLeadRef.current !== leadId) return;
      searchingLeadRef.current = null;
      setSearchingLeadId(null);
    },
  };

  // After a search or a refresh: patch the row at once, then replace it with
  // the lead as the server has it. The rest of the table and its page stay.
  const handleLeadChanged = async (leadId, patch) => {
    if (patch) {
      setLeads((current) => current.map((lead) => (lead.id === leadId ? { ...lead, ...patch } : lead)));
    }
    try {
      const { data } = await leadsApi.get(leadId);
      if (data?.id === leadId) setLeads((current) => current.map((lead) => (lead.id === leadId ? data : lead)));
    } catch {
      // Best effort: the patch above already shows the result.
    }
  };

  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [minScore, setMinScore] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState(null);
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
      const params = { limit: LEADS_LIMIT };
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
        // New leads land at the top, i.e. on page 1.
        setPage(1);
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
      if (error?.response?.data?.detail?.code === "no_keywords") {
        toast.error(t("leads.scanNoKeywords"));
        return;
      }
      toast.error(getApiErrorMessage(error, t("leads.scanFailed")));
    }
  };

  const sortedLeads = sortLeads(leads, sort, t);
  const { pageCount, currentPage, firstIndex, pageItems: pageLeads } = paginate(sortedLeads, page);

  const changeSort = (column) => {
    setSort((current) => nextSort(current, column));
    setPage(1);
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
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
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
            onChange={(e) => { setMinScore(e.target.value); setPage(1); }}
            className="border border-gray-300 rounded-lg text-xs px-2.5 py-1.5 w-24"
          />
        </div>
      </Card>

      <Card className="overflow-x-auto" ref={tableBoxRef}>
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
                <th className="px-4 py-3 text-right">#</th>
                {SORT_COLUMNS.map((column) => {
                  const label = t(column.labelKey);
                  const dir = sort?.key === column.key ? sort.dir : null;
                  const Arrow = dir === "asc" ? ArrowUp : ArrowDown;
                  return (
                    <th
                      key={column.key}
                      className="px-4 py-3"
                      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
                    >
                      <button
                        type="button"
                        onClick={() => changeSort(column)}
                        title={t("leads.sortBy").replace("{column}", label)}
                        className={`inline-flex items-center gap-1 hover:text-gray-800 ${dir ? "text-gray-800 font-semibold" : ""}`}
                      >
                        {label}
                        {dir && (
                          <Arrow
                            size={12}
                            aria-label={t(dir === "asc" ? "leads.sortAscending" : "leads.sortDescending")}
                          />
                        )}
                      </button>
                    </th>
                  );
                })}
                <th className="px-4 py-3">{t("leads.contacts.column")}</th>
              </tr>
            </thead>
            <tbody>
              {pageLeads.map((lead, i) => {
                const expanded = expandedLeadId === lead.id;
                const panelId = `lead-contacts-${lead.id}`;
                return (
                <Fragment key={lead.id}>
                <tr className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-3 text-right text-xs text-gray-400 tabular-nums">{firstIndex + i + 1}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {isSafeHttpUrl(lead.job_url) ? (
                      <a href={lead.job_url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                        {lead.job_title}
                      </a>
                    ) : lead.job_title}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {lead.company_name?.trim() ? lead.company_name : (
                      <span className="text-gray-400 italic">{t("leads.unknownCompany")}</span>
                    )}
                  </td>
                  <td className="px-4 py-3"><ScoreBadge score={lead.relevance_score} /></td>
                  <td className="px-4 py-3 text-gray-600">{t(`leads.status.${lead.status}`)}</td>
                  <FoundAtCell value={lead.created_at} />
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={panelId}
                      onClick={() => setExpandedLeadId(expanded ? null : lead.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                    >
                      {expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                      {t(expanded ? "leads.contacts.hide" : "leads.contacts.show")}
                    </button>
                  </td>
                </tr>
                {expanded && (
                  <tr id={panelId}>
                    <td colSpan={COLUMN_COUNT} className="p-0">
                      <div className="sticky left-0" style={visibleWidth ? { width: visibleWidth } : undefined}>
                        <LeadContactsPanel
                          lead={lead}
                          searchLock={searchLock}
                          onLeadChanged={handleLeadChanged}
                          onNavigate={onNavigate}
                        />
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        {!loading && !loadError && leads.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-gray-100 bg-gray-50">
            <div>
              <span className="text-xs text-gray-400">
                {t("leads.showing")
                  .replace("{from}", firstIndex + 1)
                  .replace("{to}", firstIndex + pageLeads.length)
                  .replace("{total}", leads.length)}
              </span>
              {leads.length >= LEADS_LIMIT && (
                <p className="text-xs text-amber-600">
                  {t("leads.limitReached").replace(/\{limit\}/g, LEADS_LIMIT)}
                </p>
              )}
            </div>
            {pageCount > 1 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">
                  {t("leads.pageOf").replace("{page}", currentPage).replace("{pages}", pageCount)}
                </span>
                <button
                  onClick={() => setPage(currentPage - 1)}
                  disabled={currentPage <= 1}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                >
                  {t("common.previous")}
                </button>
                <button
                  onClick={() => setPage(currentPage + 1)}
                  disabled={currentPage >= pageCount}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                >
                  {t("common.next")}
                </button>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
