import { useEffect, useState } from "react";

import { authApi, authTokenStore } from "./api/axios";
import { useI18n } from "./hooks/useI18n";

import { useTheme } from "./context/ThemeContext";

import LeadList from "./pages/pipeline/LeadList";

import { BookIcon, ChartIcon, FolderIcon, GearIcon, GridIcon, RadarIcon, SendIcon, ShieldIcon, SparkIcon, TargetIcon } from "./components/dashboard/icons";
import { AppSidebar } from "./components/shell/AppSidebar";
import { AppTopbar } from "./components/shell/AppTopbar";

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

  const navItem = (key) => {
    const entry = PAGES[key];
    if (!entry || entry.visible === false) return null;
    return { key, label: entry.label, icon: entry.icon, badge: entry.badge };
  };
  const mainItems = MAIN_NAV.map(navItem).filter(Boolean);
  const bottomItems = BOTTOM_NAV.map(navItem).filter(Boolean);
  const handleLogout = async () => {
    await authApi.logout();
    window.location.assign("/login");
  };

  return (
    <div className="app-shell flex h-screen overflow-hidden bg-page" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
      <AppSidebar
        mainItems={mainItems}
        bottomItems={bottomItems}
        activeKey={page}
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
        onNavigate={(key) => goToPage(key)}
        user={{ name: displayName, email: displayEmail }}
        logoutLabel={t("sidebar.logout")}
        onLogout={handleLogout}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <AppTopbar title={PAGES[page]?.label || ""} />
        <main className="flex-1 overflow-y-auto px-6 py-6">
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
          <div className={page === "books" ? "mx-auto max-w-[1540px]" : "mx-auto max-w-[1280px]"}>
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
    </div>
  );
}

