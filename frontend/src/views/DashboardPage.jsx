import { AlertIcon, BriefIcon, ChatIcon, CheckIcon, FileIcon, MailIcon, PlayIcon, RefreshIcon, SearchIcon, Share2Icon, TargetIcon, UsersIcon } from "@/components/dashboard/icons";
import { Badge, Btn, Card, KpiCard, QuickActionCard } from "@/components/dashboard/ui";
import { DASHBOARD_SNAPSHOT_KEY, buildDashboardMetricsFromSources, createEmptyDashboardState, dashboardSourceColor, dashboardSourceLabel, formatUpdatedTime, hasAnyDashboardMetric, loadDashboardSnapshot, percentWidth, saveDashboardSnapshot } from "@/features/dashboard/dashboardSnapshot";
import { QuickProposalModal } from "@/features/proposals/QuickProposalModal";
import { ToastStack, useToastQueue } from "@/components/dashboard/toasts";
import { createInitialCampaignWizardData } from "@/utils/campaignContent";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/context/ThemeContext";
import { CampaignWizard } from "@/features/campaigns/CampaignWizard";

export function DashboardPage({ onNavigate, setCampaignFlow = () => {} }) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const cachedDashboardSnapshot = loadDashboardSnapshot();
  const [dashboardState, setDashboardState] = useState(() => cachedDashboardSnapshot || createEmptyDashboardState());
  const [lastUpdated, setLastUpdated] = useState(() => cachedDashboardSnapshot?.lastUpdated || formatUpdatedTime());
  const [refreshing, setRefreshing] = useState(false);
  const [proposalModalOpen, setProposalModalOpen] = useState(false);
  const [campaignWizardOpen, setCampaignWizardOpen] = useState(false);
  const [wizardData, setWizardData] = useState(createInitialCampaignWizardData);
  const { toasts, setToast, removeToast, pauseToast, resumeToast } = useToastQueue();

  const refreshDashboard = async (showToast = false) => {
    setRefreshing(true);
    try {
      const currentSnapshot = loadDashboardSnapshot();
      const nextSnapshot = await buildDashboardMetricsFromSources({ allowDemo: false });
      if (nextSnapshot && (hasAnyDashboardMetric(nextSnapshot) || !currentSnapshot)) {
        saveDashboardSnapshot(nextSnapshot);
        setDashboardState(nextSnapshot);
        setLastUpdated(nextSnapshot.lastUpdated || formatUpdatedTime());
      } else if (!currentSnapshot) {
        localStorage.removeItem(DASHBOARD_SNAPSHOT_KEY);
        const emptySnapshot = createEmptyDashboardState();
        setDashboardState(emptySnapshot);
        setLastUpdated(formatUpdatedTime());
      }
    } finally {
      setRefreshing(false);
    }
    if (showToast) setToast("Dashboard updated");
  };

  useEffect(() => {
    refreshDashboard(false);
    const reload = () => refreshDashboard(false);
    // refreshDashboard itself writes the snapshot key, so reacting to that key would make
    // two open instances of this page re-trigger each other forever.
    const reloadOnStorage = (event) => {
      if (event.key === DASHBOARD_SNAPSHOT_KEY) return;
      reload();
    };
    window.addEventListener("marketgen:content-library-updated", reload);
    window.addEventListener("marketgen:campaigns-updated", reload);
    window.addEventListener("storage", reloadOnStorage);
    return () => {
      window.removeEventListener("marketgen:content-library-updated", reload);
      window.removeEventListener("marketgen:campaigns-updated", reload);
      window.removeEventListener("storage", reloadOnStorage);
    };
  }, []);

  const navigate = (page, state = {}) => {
    if (onNavigate) onNavigate(page, state);
  };
  const startCampaignFlow = () => {
    setCampaignFlow({
      campaignId: null,
      currentStep: 1,
      campaignName: "New Campaign",
      completedSteps: [],
      selectedOpportunities: [],
      brief: {},
      selectedAssets: [],
      savedNotes: [],
    });
    if (onNavigate) onNavigate("opportunities");
  };

  const { metrics, funnel, contentUsed, sourceLabel, quickActions } = dashboardState;
  const closeProposalModal = (message) => {
    setProposalModalOpen(false);
    if (message) setToast(message);
    refreshDashboard(false);
  };
  const closeCampaignModal = (message) => {
    setCampaignWizardOpen(false);
    if (message) setToast(message);
    refreshDashboard(false);
  };
  const proposalQuickMetrics = quickActions?.proposal || createEmptyDashboardState().quickActions.proposal;
  const campaignQuickMetrics = quickActions?.campaign || createEmptyDashboardState().quickActions.campaign;
  const proposalBadges = [
    t("sidebar.chat"),
    t("sidebar.books"),
    t("dashboard.quickActionCards.templates"),
    t("dashboard.quickActionCards.proposals"),
    t("sidebar.contentLibrary"),
    t("dashboard.quickActionCards.exportFormats"),
  ];
  const campaignBadges = [
    t("sidebar.chat"),
    t("sidebar.opportunities"),
    t("sidebar.contentLibrary"),
    t("sidebar.outreach"),
    t("sidebar.reports"),
    "LinkedIn",
    "Substack",
  ];
  const kpiCards = [
    { icon: SearchIcon, label: t("dashboard.kpis.detected"), value: metrics.detected, sub: t("dashboard.kpis.thisWeek"), color: "bg-blue-50 text-blue-600", page: "opportunities", state: { stageFilter: "Detected" }, aria: "Open opportunities filtered by detected stage" },
    { icon: UsersIcon, label: t("dashboard.kpis.researched"), value: metrics.researched, sub: t("dashboard.kpis.contacts"), color: "bg-cyan-50 text-cyan-600", page: "opportunities", state: { hasContact: true }, aria: "Open researched opportunities" },
    { icon: MailIcon, label: t("dashboard.kpis.contacted"), value: metrics.contacted, sub: t("dashboard.kpis.emails"), color: "bg-indigo-50 text-indigo-600", page: "outreach", state: { tab: "history", statusFilter: "sent" }, aria: "Open contacted outreach history" },
    { icon: AlertIcon, label: t("dashboard.kpis.pendingReview"), value: metrics.pendingReview, sub: t("dashboard.kpis.needAttention"), color: "bg-amber-50 text-amber-600", page: "outreach", state: { tab: "review" }, aria: "Open Outreach Review Queue" },
    { icon: ChatIcon, label: t("dashboard.kpis.replied"), value: metrics.replied, sub: t("dashboard.kpis.conversations"), color: "bg-purple-50 text-purple-600", page: "opportunities", state: { stageFilter: "Replied" }, aria: "Open opportunities filtered by replied stage" },
    { icon: CheckIcon, label: t("dashboard.kpis.won"), value: metrics.won, sub: t("dashboard.kpis.newClients"), color: "bg-green-50 text-green-600", page: "opportunities", state: { stageFilter: "Won" }, aria: "Open opportunities filtered by won stage" },
  ];
  const funnelMax = Math.max(
    Number(funnel.scanned || 0),
    Array.isArray(funnel.relevant) ? funnel.relevant.length : Number(funnel.relevant || 0),
    Number(funnel.contactsEnriched || 0),
    Number(funnel.contentMatched || 0),
    Number(funnel.emailsSent || 0),
    Number(funnel.repliesReceived || 0),
    Number(funnel.dealsWon || 0),
  );
  const funnelRows = [
    { label: t("dashboard.funnel.jobsScanned"), val: funnel.scanned, w: percentWidth(funnel.scanned, funnelMax), color: "bg-blue-300", icon: <SearchIcon size={13} />, page: "opportunities", state: { stageFilter: "All" } },
    { label: t("dashboard.funnel.relevantOpportunities"), val: funnel.relevant.length, w: percentWidth(funnel.relevant.length, funnelMax), color: "bg-blue-500", icon: <TargetIcon size={13} />, page: "opportunities", state: { minScore: 60 } },
    { label: t("dashboard.funnel.contactsEnriched"), val: funnel.contactsEnriched, w: percentWidth(funnel.contactsEnriched, funnelMax), color: "bg-cyan-500", icon: <UsersIcon size={13} />, page: "opportunities", state: { hasContact: true } },
    { label: t("dashboard.funnel.contentMatched"), val: funnel.contentMatched, w: percentWidth(funnel.contentMatched, funnelMax), color: "bg-indigo-400", icon: <FileIcon size={13} />, page: "content", state: { typeFilter: "All" } },
    { label: t("dashboard.funnel.personalizedEmails"), val: funnel.emailsSent, w: percentWidth(funnel.emailsSent, funnelMax), color: "bg-indigo-600", icon: <MailIcon size={13} />, page: "outreach", state: { tab: "history", statusFilter: "sent" } },
    { label: t("dashboard.funnel.repliesReceived"), val: funnel.repliesReceived, w: percentWidth(funnel.repliesReceived, funnelMax), color: "bg-purple-500", icon: <ChatIcon size={13} />, page: "opportunities", state: { stageFilter: "Replied" } },
    { label: t("dashboard.funnel.dealsWon"), val: funnel.dealsWon, w: percentWidth(funnel.dealsWon, funnelMax), color: "bg-green-500", icon: <CheckIcon size={13} />, page: "opportunities", state: { stageFilter: "Won" } },
  ];
  const pipelineCountLabel = (key, value) => String(t(`dashboard.pipeline.${key}`)).replace(/^\s*[-+]?\d+/, Number(value) || 0);
  const lastPipelineRunLabel = String(t("dashboard.lastPipelineRun")).split(/\s+(?:-|\u2014|\u00e2\u20ac\u201d)\s+/)[0] || t("dashboard.lastPipelineRun");
  const pipelineSteps = [
    { label: t("dashboard.pipeline.scout"), sub: pipelineCountLabel("leads", funnel.scanned), color: "bg-blue-500", done: funnel.scanned > 0 },
    { label: t("dashboard.pipeline.research"), sub: pipelineCountLabel("contacts", funnel.contactsEnriched), color: "bg-cyan-500", done: funnel.contactsEnriched > 0 },
    { label: t("dashboard.pipeline.matchContent"), sub: pipelineCountLabel("assets", funnel.contentMatched), color: "bg-indigo-500", done: funnel.contentMatched > 0 },
    { label: t("dashboard.pipeline.compose"), sub: pipelineCountLabel("emails", funnel.emailsSent), color: "bg-purple-500", done: funnel.emailsSent > 0 },
    { label: t("dashboard.pipeline.review"), sub: pipelineCountLabel("pending", metrics.pendingReview), color: "bg-amber-500", done: metrics.pendingReview === 0 && funnel.emailsSent > 0 },
    { label: t("dashboard.pipeline.send"), sub: pipelineCountLabel("sent", funnel.emailsSent), color: "bg-green-500", done: funnel.emailsSent > 0 },
  ];

  return (
    
    <div className="space-y-2.5">
      <ToastStack
        toasts={toasts}
        onClose={removeToast}
        onMouseEnter={pauseToast}
        onMouseLeave={resumeToast}
      />
      {proposalModalOpen && (
        <QuickProposalModal
          onClose={() => setProposalModalOpen(false)}
          onCreated={closeProposalModal}
        />
      )}
      {campaignWizardOpen && (
        <CampaignWizard
          wizardData={wizardData}
          setWizardData={setWizardData}
          onClose={() => setCampaignWizardOpen(false)}
          onCreated={closeCampaignModal}
          onNavigate={onNavigate}
        />
      )}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("dashboard.title")}</h1>
          <p className="text-xs text-gray-500">{t("dashboard.subtitle")}</p>
          <div className="mt-1 flex items-center gap-1 text-xs text-gray-400">
            <span>Last updated: {lastUpdated}</span>
            {refreshing && <span className="text-indigo-500 font-medium">Refreshing...</span>}
            <Badge
              label={dashboardSourceLabel(sourceLabel)}
              color={isDark ? "bg-slate-900 text-slate-300 border border-white/10" : dashboardSourceColor(sourceLabel)}
            />
          </div>
        </div>
        <div className="flex gap-1">
          <Btn
            variant="secondary"
            icon={<RefreshIcon size={13} className={refreshing ? "animate-spin" : ""} />}
            onClick={() => refreshDashboard(true)}
            disabled={refreshing}
          >
            {t("dashboard.refresh")}
          </Btn>
          <Btn variant="teal" icon={<PlayIcon size={13} />}>{t("dashboard.runPipeline")}</Btn>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
        <QuickActionCard
          icon={BriefIcon}
          title={t("dashboard.quickActionCards.createProposalTitle")}
          description={t("dashboard.quickActionCards.createProposalDescription")}
          badges={proposalBadges}
          buttonLabel={t("dashboard.quickActionCards.createProposalButton")}
          ariaLabel={t("dashboard.quickActionCards.createProposalAria")}
          onClick={() => onNavigate("content", { openCreateContentModal: true })}
          metrics={[
            { label: t("dashboard.quickActionCards.proposalsCreated"), value: proposalQuickMetrics.created },
            { label: t("dashboard.quickActionCards.proposalsApproved"), value: proposalQuickMetrics.approved },
            { label: t("dashboard.quickActionCards.proposalsSent"), value: proposalQuickMetrics.sent },
            { label: t("dashboard.quickActionCards.salesWon"), value: proposalQuickMetrics.won },
          ]}
        />
        <QuickActionCard
          icon={Share2Icon}
          title={t("dashboard.quickActionCards.socialMarketingTitle")}
          description={t("dashboard.quickActionCards.socialMarketingDescription")}
          badges={campaignBadges}
          buttonLabel={t("dashboard.quickActionCards.createCampaignButton")}
          ariaLabel={t("dashboard.quickActionCards.createCampaignAria")}
          onClick={startCampaignFlow}
          metrics={[
            { label: t("dashboard.quickActionCards.savedCampaigns"), value: campaignQuickMetrics.saved || 0 },
            { label: t("dashboard.quickActionCards.generatedPosts"), value: campaignQuickMetrics.posts },
            { label: t("dashboard.quickActionCards.sentEmails"), value: campaignQuickMetrics.emailsSent },
            { label: t("dashboard.quickActionCards.responses"), value: campaignQuickMetrics.replies },
          ]}
          accent="teal"
        />
      </div>

      {/* Full-funnel KPI row */}
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {kpiCards.map((card) => (
          <KpiCard
            key={card.label}
            icon={card.icon}
            label={card.label}
            value={card.value}
            sub={card.sub}
            color={card.color}
            ariaLabel={card.aria}
            title={card.aria}
            onClick={() => navigate(card.page, card.state)}
          />
        ))}
      </div>

      {/* Full-funnel visualization */}
      <Card className="p-3">
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-semibold text-gray-900">{t("dashboard.funnel.title")}</p>
          <div className="flex gap-1 text-xs text-gray-400">
            <span>{t("dashboard.funnel.intelligence")}</span><span>→</span><span>{t("dashboard.funnel.content")}</span><span>→</span><span>{t("dashboard.funnel.outreach")}</span><span>→</span><span>{t("dashboard.funnel.conversion")}</span>
          </div>
        </div>
        <div className="space-y-1.5">
          {funnelRows.map((f) => (
            <button
              key={f.label}
              type="button"
              onClick={() => navigate(f.page, f.state)}
              aria-label={`Open ${f.label}`}
              title={`Open ${f.label}`}
              className="w-full flex items-center gap-1.5 rounded-lg px-2 py-1 text-left cursor-pointer transition-colors hover:bg-gray-50 active:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            >
              <span className="w-5 text-gray-500">{f.icon}</span>
              <span className="text-xs text-gray-600 w-56 shrink-0">{f.label}</span>
              <div className={`flex-1 h-5 rounded-full overflow-hidden ${isDark ? "bg-[#0F172A] border border-white/10" : "bg-gray-100"}`}><div className={`h-full ${f.color} rounded-full transition-all`} style={{width:f.w}} /></div>
              <span className="text-xs font-semibold text-gray-700 w-10 text-right">{f.val}</span>
            </button>
          ))}
        </div>
      </Card>

      {/* Two-column: Activity + Content impact */}
      <div className="grid grid-cols-2 gap-2">
        <Card className="p-2">
          <p className="text-xs font-semibold text-gray-700 mb-1.5">{t("dashboard.pipelineActivity")}</p>
          <div className="h-32 bg-gradient-to-t from-indigo-50 to-transparent rounded-lg flex items-end justify-around px-4 pb-2">
            {funnelRows.map((row, i) => (
              <button
                key={row.label}
                type="button"
                onClick={() => navigate(row.page, row.state)}
                aria-label={`Open ${row.label}`}
                title={`Open ${row.label}`}
                className="w-5 h-full flex items-end justify-center rounded hover:bg-white/60"
              >
                <span className="w-2 rounded-t" style={{height: row.w, background: i % 2 === 0 ? "rgb(var(--brand-400))" : "#2dd4bf"}} />
              </button>
            ))}
          </div>
          <div className="flex justify-center gap-2 mt-2">
            <span className="flex items-center gap-1 text-xs text-gray-500"><span className="w-2 h-2 rounded bg-indigo-400"/>{t("dashboard.chart.emails")}</span>
            <span className="flex items-center gap-1 text-xs text-gray-500"><span className="w-2 h-2 rounded bg-teal-400"/>{t("dashboard.chart.replies")}</span>
          </div>
        </Card>
        <Card className="p-2">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs font-semibold text-gray-700">{t("dashboard.contentUsed")}</p>
            <button
              type="button"
              onClick={() => navigate("content", { typeFilter: "All" })}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-700"
            >
              View all
            </button>
          </div>
          {contentUsed.length === 0 ? (
            <div className="py-8 text-center text-xs text-gray-400 border border-dashed border-gray-200 rounded-xl">
              No data yet
            </div>
          ) : (
            <div className="space-y-1.5">
              {contentUsed.map((c, index) => {
                const colors = ["bg-indigo-500", "bg-teal-500", "bg-amber-500", "bg-purple-500"];
                return (
                  <button
                    key={c.id || c.title}
                    type="button"
                    onClick={() => navigate("content", { typeFilter: c.type === "Proposal" ? "Proposals" : "All" })}
                    aria-label={`Open content asset ${c.title}`}
                    title={`Open content asset ${c.title}`}
                    className="w-full flex items-center gap-1 rounded-lg px-1 py-1 text-left cursor-pointer transition-colors hover:bg-gray-50 active:bg-gray-100"
                  >
                    <div className={`w-1 h-8 rounded-full ${colors[index % colors.length]}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-gray-800 truncate">{c.title}</p>
                      <p className="text-xs text-gray-400">{c.type || "Asset"}</p>
                    </div>
                    <span className="text-xs font-semibold text-gray-600">{Number(c.uses || 0)}x</span>
                  </button>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Latest pipeline run */}
      <Card className="p-2">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs font-semibold text-gray-700">{lastPipelineRunLabel} - {lastUpdated}</p>
          <Badge label={t("dashboard.completed")} color="bg-green-100 text-green-700" />
        </div>
        <div className="flex items-center gap-1">
          {pipelineSteps.map((s, i) => (
            <div key={s.label} className="flex items-center gap-1 flex-1">
              <div className="flex-1">
                <div className="flex items-center gap-1 mb-1">
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center text-white text-xs ${s.done ? s.color : "bg-gray-300"}`}>
                    {s.done ? <CheckIcon size={10} /> : i + 1}
                  </div>
                  <span className="text-xs font-medium text-gray-700">{s.label}</span>
                </div>
                <p className="text-xs text-gray-400 ml-6">{s.sub}</p>
              </div>
              {i < 5 && <div className={`w-6 h-0.5 ${s.done ? s.color : "bg-gray-200"}`} />}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
