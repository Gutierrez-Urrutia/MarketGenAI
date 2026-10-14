import { useEffect, useState } from "react";

import { authApi, authTokenStore, campaignsApi } from "./api/axios";
import { useI18n } from "./hooks/useI18n";

import { useTheme } from "./context/ThemeContext";

import LeadList from "./pages/pipeline/LeadList";

import { ArrowRightIcon, BookIcon, ChartIcon, CheckIcon, ClockIcon, FolderIcon, GearIcon, GridIcon, InboxIcon, LinkIcon, LogOutIcon, PenIcon, RadarIcon, RefreshIcon, SendIcon, ShieldIcon, SparkIcon, TargetIcon, XIcon } from "./components/dashboard/icons";

import { Badge, Btn, Card, Field, Input, Select } from "./components/dashboard/ui";

import { saveLocalCampaign } from "./utils/localStore";

import { createEmptyDashboardState } from "./features/dashboard/dashboardSnapshot";
import { normalizeStageName, selectOpportunityMetrics } from "./features/opportunities/opportunityHelpers";

import { CAMPAIGN_FLOW_STEPS } from "./utils/campaignContent";
import { fetchOptional } from "./utils/dashboardData";
import { DEMO_OPPORTUNITIES, DEMO_OUTREACH_HISTORY, DEMO_REVIEW_EMAILS } from "./utils/demoData";
import { canViewAuditLogs } from "./utils/permissions";
import { AuditLogsPage } from "./views/AuditLogsPage";
import { ReportsPage } from "./views/ReportsPage";
import { AssistantPage } from "./views/AssistantPage";
import { CampaignBriefPage } from "./views/CampaignBriefPage";
import { OpportunitiesPage } from "./views/OpportunitiesPage";
import { OutreachPage } from "./views/OutreachPage";
import { SettingsPage } from "./views/SettingsPage";
import { DashboardPage } from "./views/DashboardPage";
import { ContentGeneratorPage } from "./views/ContentGeneratorPage";
import { ContentLibraryPage } from "./views/ContentLibraryPage";

function hasPipelineSignals(state) {
  if (!state || typeof state !== "object") return false;
  const kpiTotal = ["detected", "researched", "contacted", "pendingReview", "replied", "won"]
    .reduce((sum, key) => sum + (Number(state.metrics?.[key]) || 0), 0);
  const funnelTotal = ["scanned", "contactsEnriched", "contentMatched", "emailsSent", "repliesReceived", "dealsWon"]
    .reduce((sum, key) => sum + (Number(state.funnel?.[key]) || 0), 0);
  const relevantTotal = Array.isArray(state.funnel?.relevant)
    ? state.funnel.relevant.length
    : Number(state.funnel?.relevant) || 0;
  return kpiTotal + funnelTotal + relevantTotal > 0;
}

function hasFunnelSignals(state) {
  if (!state || typeof state !== "object") return false;
  const funnelTotal = ["scanned", "contactsEnriched", "contentMatched", "emailsSent", "repliesReceived", "dealsWon"]
    .reduce((sum, key) => sum + (Number(state.funnel?.[key]) || 0), 0);
  const relevantTotal = Array.isArray(state.funnel?.relevant)
    ? state.funnel.relevant.length
    : Number(state.funnel?.relevant) || 0;
  return funnelTotal + relevantTotal > 0;
}

function buildLocalPipelineFallbackSnapshot(snapshot = createEmptyDashboardState()) {
  const opportunities = DEMO_OPPORTUNITIES;
  const reviewEmails = DEMO_REVIEW_EMAILS;
  const outreachHistory = DEMO_OUTREACH_HISTORY;
  const opportunityMetrics = selectOpportunityMetrics(opportunities);
  const relevant = opportunities.filter((item) => Number(item.score || 0) >= 60);
  const emailsSent = outreachHistory.filter((item) => ["sent", "opened", "replied"].includes(normalizeStageName(item.st || item.status))).length;
  const contentMatched = Math.max(Number(snapshot.funnel?.contentMatched || 0), (snapshot.contentUsed || []).length);

  return {
    ...snapshot,
    sourceLabel: "local",
    opportunities,
    reviewEmails,
    outreachHistory,
    metrics: {
      ...snapshot.metrics,
      detected: opportunityMetrics.detected,
      researched: opportunityMetrics.researched,
      contacted: opportunityMetrics.contacted,
      pendingReview: reviewEmails.length,
      replied: opportunityMetrics.replied,
      won: opportunityMetrics.won,
    },
    funnel: {
      ...snapshot.funnel,
      scanned: opportunities.length,
      relevant,
      contactsEnriched: opportunityMetrics.researched,
      contentMatched,
      emailsSent,
      repliesReceived: opportunityMetrics.replied,
      dealsWon: opportunityMetrics.won,
    },
    pipelineActivity: [
      opportunities.length,
      relevant.length,
      opportunityMetrics.researched,
      contentMatched,
      emailsSent,
      opportunityMetrics.replied,
      opportunityMetrics.won,
    ],
  };
}


function CampaignModal({ onClose, onCreated }) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    name: "",
    audience: "",
    channel: "linkedin",
    objective: "lead_generation",
    context: "",
  });
  const [saving, setSaving] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [generationStep, setGenerationStep] = useState("");

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const saveCampaign = async (status = "draft") => {
    const now = new Date();
    const name = form.name.trim() || t("dashboard.quickActionCards.campaignDefaultName");
    const payload = {
      name,
      audience: form.audience,
      channels: [form.channel],
      objective: form.objective,
      context: form.context,
      status,
    };

    setSaving(true);
    setGenerationProgress(status === "active" ? 8 : 0);
    setGenerationStep(status === "active" ? t("dashboard.quickActionCards.aiStepSaving") : "");
    let createdCampaign = null;
    let progressTimer = null;
    try {
      const { data } = await campaignsApi.create(payload);
      if (!data || typeof data !== "object" || Array.isArray(data) || !data.id) {
        throw new Error("Invalid campaign response");
      }
      createdCampaign = data;
      saveLocalCampaign({ ...data, channel: data.channels?.[0] || form.channel });

      if (status === "draft") {
        onCreated(t("dashboard.quickActionCards.campaignSaved"));
        return;
      }

      setGenerationProgress(20);
      setGenerationStep(t("dashboard.quickActionCards.aiStepAnalyzing"));
      progressTimer = window.setInterval(() => {
        setGenerationProgress((current) => {
          const next = Math.min(current + 7, 88);
          if (next >= 62) setGenerationStep(t("dashboard.quickActionCards.aiStepPublishing"));
          else if (next >= 36) setGenerationStep(t("dashboard.quickActionCards.aiStepWriting"));
          return next;
        });
      }, 700);

      await campaignsApi.generate(data.id);
      window.clearInterval(progressTimer);
      progressTimer = null;
      setGenerationProgress(100);
      setGenerationStep(t("dashboard.quickActionCards.aiStepComplete"));
      window.dispatchEvent(new CustomEvent("marketgen:content-library-updated"));
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      onCreated({ type: "success", message: t("dashboard.quickActionCards.campaignCreatedWithContent") });
    } catch (error) {
      if (createdCampaign) {
        setGenerationStep(t("dashboard.quickActionCards.aiStepFailed"));
        onCreated({ type: "error", message: t("dashboard.quickActionCards.campaignCreatedAiError") });
        return;
      }
      saveLocalCampaign({
        ...payload,
        id: `campaign-${Date.now()}`,
        channel: form.channel,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      onCreated(t("dashboard.quickActionCards.campaignSavedLocally"));
    } finally {
      if (progressTimer) window.clearInterval(progressTimer);
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 p-5">
          <div>
            <p className="text-sm font-semibold text-gray-900">{t("dashboard.quickActionCards.campaignModalTitle")}</p>
            <p className="text-xs text-gray-500">{t("dashboard.quickActionCards.campaignModalSubtitle")}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600" aria-label={t("common.close")}>
            <XIcon size={16} />
          </button>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label={t("dashboard.quickActionCards.campaignName")}>
            <Input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder={t("dashboard.quickActionCards.campaignNamePlaceholder")} />
          </Field>
          <Field label={t("dashboard.quickActionCards.targetAudience")}>
            <Input value={form.audience} onChange={(event) => update("audience", event.target.value)} placeholder={t("dashboard.quickActionCards.targetAudiencePlaceholder")} />
          </Field>
          <Field label={t("dashboard.quickActionCards.primaryChannel")}>
            <Select value={form.channel} onChange={(event) => update("channel", event.target.value)}>
              <option value="linkedin">LinkedIn</option>
              <option value="substack">Substack</option>
              <option value="email_outreach">Email Outreach</option>
            </Select>
          </Field>
          <Field label={t("dashboard.quickActionCards.objective")}>
            <Select value={form.objective} onChange={(event) => update("objective", event.target.value)}>
              <option value="lead_generation">{t("dashboard.quickActionCards.objectiveLeadGeneration")}</option>
              <option value="awareness">{t("dashboard.quickActionCards.objectiveAwareness")}</option>
              <option value="follow_up">{t("dashboard.quickActionCards.objectiveFollowUp")}</option>
              <option value="conversion">{t("dashboard.quickActionCards.objectiveConversion")}</option>
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field label={t("dashboard.quickActionCards.context")}>
              <textarea
                value={form.context}
                onChange={(event) => update("context", event.target.value)}
                rows={4}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-teal-500"
                placeholder={t("dashboard.quickActionCards.campaignContextPlaceholder")}
              />
            </Field>
          </div>
        </div>
        {saving && generationStep && (
          <div className="mx-5 mb-5 rounded-xl border border-teal-100 bg-teal-50 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold text-teal-800">{generationStep}</p>
              <span className="text-xs font-semibold text-teal-700">{generationProgress}%</span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white">
              <div
                className="h-full rounded-full bg-teal-500 transition-all duration-500"
                style={{ width: `${generationProgress}%` }}
              />
            </div>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 border-t border-gray-100 bg-gray-50 p-4">
          <p className="text-xs font-medium text-teal-600">
            {saving && generationStep ? t("dashboard.quickActionCards.generatingAiContent") : ""}
          </p>
          <div className="flex gap-2">
            <Btn variant="ghost" onClick={onClose} disabled={saving}>{t("common.cancel")}</Btn>
            <Btn variant="secondary" onClick={() => saveCampaign("draft")} disabled={saving}>{t("dashboard.quickActionCards.saveDraft")}</Btn>
            <Btn variant="teal" icon={<ArrowRightIcon size={13} />} onClick={() => saveCampaign("active")} disabled={saving}>{t("dashboard.quickActionCards.continue")}</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════ */
/*  PAGE: OUTREACH (merged Review Queue + Outreach History)        */
/* ═══════════════════════════════════════════════════════════════ */
function OutreachPageLegacy({ navigationState = {} }) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const [tab, setTab] = useState(navigationState.tab || "review");
  const [historyFilter, setHistoryFilter] = useState(navigationState.statusFilter || "all");
  const [selected, setSelected] = useState(0);

  const reviewEmails = DEMO_REVIEW_EMAILS;
  const history = DEMO_OUTREACH_HISTORY;

  useEffect(() => {
    if (navigationState.tab) setTab(navigationState.tab);
    if (navigationState.statusFilter) setHistoryFilter(navigationState.statusFilter);
  }, [navigationState.tab, navigationState.statusFilter]);

  const filteredHistory = historyFilter === "all"
    ? history
    : history.filter((item) => normalizeStageName(item.st) === normalizeStageName(historyFilter));

  const historyStatusLabel = (status) => ({
    Sent: t("outreachPage.filters.sent"),
    Opened: t("outreachPage.filters.opened"),
    Replied: t("outreachPage.filters.replied"),
    Bounced: t("outreachPage.filters.bounced"),
  }[status] || status);

  const e = reviewEmails[selected];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("outreachPage.title")}</h1>
          <p className="text-xs text-gray-500">{t("outreachPage.subtitle")}</p>
        </div>
        {tab === "review" && (
          <div className="flex gap-2">
            <Btn variant="destructive" small icon={<XIcon size={12} />}>{t("outreachPage.rejectAll")}</Btn>
            <Btn variant="teal" small icon={<CheckIcon size={12} />}>{t("outreachPage.approveAll")}</Btn>
          </div>
        )}
      </div>

      {/* Tab switcher */}
      <div className={`flex gap-1 p-1 rounded-xl w-fit ${isDark ? "bg-slate-800 border border-white/10" : "bg-gray-100"}`}>
        <button onClick={() => setTab("review")} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${tab === "review" ? isDark ? "bg-slate-700 text-white" : "bg-white text-gray-900 shadow-sm" : isDark ? "text-slate-300 hover:text-white" : "text-gray-500"}`}>
          <InboxIcon size={13} />{t("outreachPage.reviewQueue")}
          <span className="bg-amber-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">{reviewEmails.length}</span>
        </button>
        <button onClick={() => setTab("history")} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${tab === "history" ? isDark ? "bg-slate-700 text-white" : "bg-white text-gray-900 shadow-sm" : isDark ? "text-slate-300 hover:text-white" : "text-gray-500"}`}>
          <ClockIcon size={13} />{t("outreachPage.sentHistory")}
        </button>
      </div>

      {tab === "review" && (
        <div className="grid gap-4" style={{gridTemplateColumns:"2fr 3fr"}}>
          {/* Email list */}
          <div className="space-y-2">
            {reviewEmails.map((em, i) => (
              <div key={i} onClick={() => setSelected(i)}
                className={`p-3 rounded-xl border cursor-pointer transition-colors ${selected === i ? isDark ? "border-indigo-500/40 bg-slate-900" : "border-indigo-300 bg-indigo-50" : isDark ? "border-white/10 bg-slate-800 hover:border-white/20" : "border-gray-100 bg-white hover:border-gray-200"}`}>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs font-semibold text-gray-900">{em.to}</p>
                  <span className={`text-xs font-bold ${em.score >= 80 ? "text-green-600" : "text-amber-600"}`}>{t("outreachPage.confidenceShort")}: {em.score}%</span>
                </div>
                <p className="text-xs text-gray-500">{em.role} · {em.company}</p>
                <p className="text-xs text-gray-400 mt-1 truncate">{em.subject}</p>
                <div className="flex items-center gap-2 mt-1.5">
                  {em.score >= 80 && <Badge label={t("outreachPage.highScore")} color={isDark ? "bg-green-500/10 text-green-200 border border-green-400/20" : "bg-green-100 text-green-700"} />}
                  <span className="text-xs text-indigo-500 flex items-center gap-0.5"><LinkIcon size={9} />{em.contentRef}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Email preview */}
          <Card className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-semibold text-gray-900">{e.to}</p>
                <p className="text-xs text-gray-500">{e.role} @ {e.company}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-sm font-bold ${e.score >= 80 ? "text-green-600" : "text-amber-600"}`}>{t("outreachPage.confidenceShort")}: {e.score}%</span>
                <Badge label={e.score >= 80 ? t("outreachPage.highConfidence") : t("outreachPage.reviewSuggested")} color={isDark ? e.score >= 80 ? "bg-green-500/10 text-green-200 border border-green-400/20" : "bg-amber-500/10 text-amber-200 border border-amber-400/20" : e.score >= 80 ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"} />
              </div>
            </div>
            <div className="flex gap-3 mb-3">
              <div className={`flex-1 p-2 rounded-lg ${isDark ? "bg-[#0F172A] border border-white/10" : "bg-gray-50"}`}>
                <p className="text-xs text-gray-500">{t("outreachPage.opportunity")}</p>
                <p className="text-xs font-medium text-gray-800">{e.vacancy} @ {e.company}</p>
              </div>
              <div className={`flex-1 p-2 rounded-lg ${isDark ? "bg-[#0F172A] border border-white/10" : "bg-indigo-50"}`}>
                <p className="text-xs text-indigo-400">{t("outreachPage.contentReferenced")}</p>
                <p className="text-xs font-medium text-indigo-700 flex items-center gap-1"><LinkIcon size={10} />{e.contentRef}</p>
              </div>
            </div>
            <div className="mb-[18px]">
              <p className="text-xs text-gray-500 mb-1">{t("outreachPage.subject")}</p>
              <p className="text-xs font-semibold text-gray-900">{e.subject}</p>
            </div>
            <div className={`mb-4 p-3 rounded-lg ${isDark ? "bg-[#0F172A] border border-white/10" : "bg-white border border-gray-200"}`}>
              <pre className={`text-xs whitespace-pre-wrap font-sans leading-relaxed ${isDark ? "text-slate-200" : "text-gray-700"}`}>{e.preview}</pre>
            </div>
            <div className="flex gap-2 justify-end">
              <Btn variant="ghost" small icon={<RefreshIcon size={12} />}>{t("outreachPage.regenerate")}</Btn>
              <Btn variant="secondary" small icon={<PenIcon size={12} />}>{t("outreachPage.edit")}</Btn>
              <Btn variant="destructive" small icon={<XIcon size={12} />}>{t("outreachPage.reject")}</Btn>
              <Btn variant="teal" icon={<CheckIcon size={13} />}>{t("outreachPage.approveSend")}</Btn>
            </div>
          </Card>
        </div>
      )}

      {tab === "history" && (
        <>
          <div className="flex gap-2">{["all","sent","opened","replied","bounced"].map((filterKey,i)=>(
            <button
              key={filterKey}
              onClick={() => setHistoryFilter(filterKey)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium ${historyFilter === filterKey ? "bg-indigo-600 text-white" : isDark ? "bg-slate-800 text-slate-300 border border-white/10 hover:bg-slate-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              {t(`outreachPage.filters.${filterKey}`)}
            </button>
          ))}</div>
          <Card>
            <table className="w-full text-xs">
              <thead><tr className="bg-slate-50 text-slate-600 uppercase">
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.contact")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.company")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.subject")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.contentUsed")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.status")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.sent")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.score")}</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {filteredHistory.map((o) => (
                  <tr key={o.name} className="hover:bg-slate-50 cursor-pointer">
                    <td className="px-4 py-3 font-medium text-gray-900">{o.name}</td>
                    <td className="px-4 py-3 text-gray-600">{o.co}</td>
                    <td className="px-4 py-3 text-gray-500 truncate max-w-[180px]">{o.subj}</td>
                    <td className="px-4 py-3"><span className="text-xs text-indigo-600 flex items-center gap-1"><LinkIcon size={10} />{o.content}</span></td>
                    <td className="px-4 py-3"><Badge label={historyStatusLabel(o.st)} color={o.stc} /></td>
                    <td className="px-4 py-3 text-gray-500">{o.date}</td>
                    <td className="px-4 py-3 font-semibold text-indigo-600">{o.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════ */
/*  MAIN APP — SIDEBAR + ROUTING                                   */
/* ═══════════════════════════════════════════════════════════════ */


const MAIN_NAV = ["dashboard", "books", "opportunities", "content", "outreach", "leads", "assistant", "reports", "auditLogs"];
const BOTTOM_NAV = ["settings"];

const PATH_TO_PAGE = {
  "/": "dashboard",
  "/dashboard": "dashboard",
  "/books": "books",
  "/opportunities": "opportunities",
  "/content": "content",
  "/campaign_brief": "campaign_brief",
  "/outreach": "outreach",
  "/leads": "leads",
  "/assistant": "assistant",
  "/reports": "reports",
  "/auditLogs": "auditLogs",
  "/audit-logs": "auditLogs",
  "/settings": "settings",
};

export default function App() {
  const { t } = useI18n();
  const { theme } = useTheme();
  const [outreachBadge, setOutreachBadge] = useState(0);
  const [campaignFlow, setCampaignFlow] = useState(null);
  const currentUser = authTokenStore.getUser();
  const displayName = currentUser?.name || currentUser?.preferred_username || currentUser?.email || "User";
  const displayEmail = currentUser?.email || currentUser?.preferred_username || "";
  const showAuditLogs = canViewAuditLogs(currentUser || {});
  
  const PAGES = {
    dashboard:  { label: t("sidebar.dashboard"),        icon: GridIcon,    component: DashboardPage },
    books:      { label: t("sidebar.books"),    icon: BookIcon,    component: ContentGeneratorPage },
    opportunities: { label: t("sidebar.opportunities"),  icon: TargetIcon,  component: OpportunitiesPage },
    campaign_brief: { label: "Campaign Brief", icon: TargetIcon, component: CampaignBriefPage },
    content:    { label: t("sidebar.contentLibrary"),   icon: FolderIcon,  component: ContentLibraryPage },
    outreach:   { label: t("sidebar.outreach"),          icon: SendIcon,    component: OutreachPage, badge: outreachBadge },
    leads:      { label: t("sidebar.leads"),             icon: RadarIcon,   component: LeadList },
    assistant: { label: t("sidebar.chat"), icon: SparkIcon, component: AssistantPage },
    reports:    { label: t("sidebar.reports"),           icon: ChartIcon,   component: ReportsPage },
    auditLogs: { label: "Audit Logs", icon: ShieldIcon, component: AuditLogsPage, visible: showAuditLogs },
    settings:   { label: t("sidebar.settings"),          icon: GearIcon,    component: SettingsPage },
  };

  const [page, setPage] = useState(() => PATH_TO_PAGE[window.location.pathname] || "dashboard");
  const [navigationState, setNavigationState] = useState({});
  const [collapsed, setCollapsed] = useState(false);
  const PageComp = PAGES[page]?.visible === false ? DashboardPage : (PAGES[page]?.component || DashboardPage);

  useEffect(() => {
    const onPopState = () => {
      setPage(PATH_TO_PAGE[window.location.pathname] || "dashboard");
      setNavigationState({});
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const darkBySystem = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const useDark = theme === "dark" || (theme === "system" && darkBySystem);
    document.documentElement.classList.toggle("theme-dark", useDark);
  }, [theme]);

  useEffect(() => {
    fetchOptional("/outreach/review-queue", null).then((items) => {
      if (Array.isArray(items)) setOutreachBadge(items.length);
    });
  }, []);

  const goToPage = (key, state = {}) => {
    setPage(key);
    setNavigationState(state);
    const path = key === "dashboard" ? "/dashboard" : `/${key}`;
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
  };

  const navLink = (key) => {
    const p = PAGES[key];
    if (!p || p.visible === false) return null;
    const active = page === key;
    return (
      <button key={key} onClick={() => goToPage(key)}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
          active ? "bg-indigo-600 text-white" : "text-slate-300 hover:bg-slate-700 hover:text-white"
        } ${collapsed ? "justify-center" : ""}`}
        title={collapsed ? p.label : undefined}>
        <p.icon size={16} className="shrink-0" />
        {!collapsed && (
          <span className="flex-1 text-left">{p.label}</span>
        )}
        {!collapsed && p.badge && (
          <span className="bg-amber-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">{p.badge}</span>
        )}
      </button>
    );
  };

  return (
    <div className="app-shell flex h-screen bg-gray-50 rounded-xl overflow-hidden border border-gray-200" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Sidebar */}
      <aside className={`${collapsed ? "w-14" : "w-52"} bg-slate-800 flex flex-col h-full shrink-0 transition-all duration-200 rounded-l-xl`}>
        <div className={`flex items-center h-14 px-3 border-b border-slate-700 ${collapsed ? "justify-center" : "justify-between"}`}>
          {!collapsed && <div><p className="text-white font-bold text-sm leading-tight">NoonDalton</p><p className="text-teal-400 text-xs">AI Marketing Suite</p></div>}
          <button onClick={() => setCollapsed(!collapsed)} className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-700">
            {collapsed ? <ArrowRightIcon size={14} /> : <XIcon size={14} />}
          </button>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
          {MAIN_NAV.map(navLink)}
        </nav>

        <div className="mx-2 border-t border-slate-700" />
        <nav className="px-2 py-2 space-y-0.5">
          {BOTTOM_NAV.map(navLink)}
          <button
            onClick={async () => {
              await authApi.logout();
              window.location.assign("/login");
            }}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-slate-300 hover:bg-red-700/30 hover:text-red-300 ${collapsed ? "justify-center" : ""}`}
          >
            <LogOutIcon size={16} />{!collapsed && t("sidebar.logout")}
          </button>
        </nav>
        {!collapsed && (
          <div className="px-3 py-2.5 border-t border-slate-700">
            <p className="text-white text-xs font-medium truncate">{displayName}</p>
            {displayEmail && <p className="text-slate-400 text-xs truncate">{displayEmail}</p>}
          </div>
        )}
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto p-5">
        {campaignFlow && (
          <div className="campaign-flow-bar">
            <div className="campaign-flow-bar-inner">
              <span className="campaign-flow-name">📣 {campaignFlow.campaignName}</span>
              <div className="campaign-flow-steps">
                {CAMPAIGN_FLOW_STEPS.map((step) => (
                  <div key={step.id} className={`campaign-flow-step ${
                    campaignFlow.completedSteps.includes(step.id) ? "done" :
                    campaignFlow.currentStep === step.id ? "active" : ""
                  }`}>
                    <span className="campaign-flow-step-num">
                      {campaignFlow.completedSteps.includes(step.id) ? "✓" : step.id}
                    </span>
                    <span className="campaign-flow-step-label">{step.label}</span>
                  </div>
                ))}
              </div>
              <button onClick={() => setCampaignFlow(null)} className="campaign-flow-exit">
                Exit flow
              </button>
            </div>
          </div>
        )}
        <div className={page === "books" ? "mx-auto max-w-[1540px]" : "max-w-5xl mx-auto"}>
          <PageComp
            navigationState={navigationState}
            onNavigate={goToPage}
            onOutreachBadgeChange={setOutreachBadge}
            campaignFlow={campaignFlow}
            setCampaignFlow={setCampaignFlow}
          />
        </div>
      </main>
    </div>
  );
}

