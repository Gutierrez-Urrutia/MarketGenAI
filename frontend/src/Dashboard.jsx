import { useEffect, useState } from "react";

import { authApi, authTokenStore } from "./api/axios";
import { useI18n } from "./hooks/useI18n";

import { useTheme } from "./context/ThemeContext";

import LeadList from "./pages/pipeline/LeadList";

import { ArrowRightIcon, BookIcon, ChartIcon, FolderIcon, GearIcon, GridIcon, LogOutIcon, RadarIcon, SendIcon, ShieldIcon, SparkIcon, TargetIcon, XIcon } from "./components/dashboard/icons";

import { CAMPAIGN_FLOW_STEPS } from "./utils/campaignContent";
import { fetchOptional } from "./utils/dashboardData";

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

