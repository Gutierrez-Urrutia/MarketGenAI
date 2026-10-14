import { calculateProposalTotal } from "@/features/proposals/proposalDocument";
import { campaignsApi } from "@/api/axios";
import { getDashboardData } from "@/api/dashboardApi";
import { getProposals } from "@/api/proposalsApi";
import { readLocalCampaigns, readLocalContentProposals } from "@/utils/localStore";
import { normalizeStageName, selectOpportunityMetrics, validContentRef } from "@/features/opportunities/opportunityHelpers";
import { asArray, fetchOptional } from "@/utils/dashboardData";
import { DEMO_CONTENT_ITEMS, DEMO_OPPORTUNITIES, DEMO_OUTREACH_HISTORY, DEMO_REVIEW_EMAILS } from "@/utils/demoData";

export const percentWidth = (value, total) => {
  const numericValue = Number(value) || 0;
  const numericTotal = Number(total) || 0;
  if (numericValue <= 0 || numericTotal <= 0) return "0%";
  return `${Math.max(2, Math.min(100, Math.round((numericValue / numericTotal) * 100)))}%`;
};

export const formatUpdatedTime = (date = new Date()) => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const DASHBOARD_SNAPSHOT_KEY = "marketgen_dashboard_snapshot";

export const createEmptyDashboardState = () => ({
  metrics: {
    detected: 0,
    researched: 0,
    contacted: 0,
    pendingReview: 0,
    replied: 0,
    won: 0,
    proposals: 0,
    contentUsed: 0,
    totalProposalValue: 0,
  },
  sourceLabel: "local",
  opportunities: [],
  reviewEmails: [],
  outreachHistory: [],
  contentUsed: [],
  quickActions: {
    proposal: {
      created: 0,
      approved: 0,
      sent: 0,
      won: 0,
    },
    campaign: {
      saved: 0,
      active: 0,
      posts: 0,
      emailsSent: 0,
      replies: 0,
    },
  },
  funnel: {
    scanned: 0,
    relevant: [],
    contactsEnriched: 0,
    contentMatched: 0,
    emailsSent: 0,
    repliesReceived: 0,
    dealsWon: 0,
  },
  pipelineActivity: [],
  lastUpdated: "",
});

function isValidDashboardSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (!snapshot.metrics || typeof snapshot.metrics !== "object") return false;
  if (!snapshot.funnel || typeof snapshot.funnel !== "object") return false;
  if (!Array.isArray(snapshot.contentUsed)) return false;
  return ["detected", "researched", "contacted", "pendingReview", "replied", "won"].every((key) => Number.isFinite(Number(snapshot.metrics[key])));
}

function normalizeDashboardSnapshotForDisplay(snapshot) {
  if (!isValidDashboardSnapshot(snapshot)) return null;
  const hydrated = { ...createEmptyDashboardState(), ...snapshot };
  if (hydrated.sourceLabel === "demo") return null;
  return hydrated;
}

export function loadDashboardSnapshot() {
  try {
    const snapshot = JSON.parse(localStorage.getItem(DASHBOARD_SNAPSHOT_KEY) || "null");
    const normalized = normalizeDashboardSnapshotForDisplay(snapshot);
    return normalized ? { ...normalized, sourceLabel: "cached" } : null;
  } catch {
    return null;
  }
}

export function saveDashboardSnapshot(snapshot) {
  if (!isValidDashboardSnapshot(snapshot)) return;
  localStorage.setItem(DASHBOARD_SNAPSHOT_KEY, JSON.stringify({
    ...snapshot,
    savedAt: new Date().toISOString(),
  }));
}

export function hasAnyDashboardMetric(state) {
  if (!isValidDashboardSnapshot(state)) return false;
  return hasMeaningfulDashboardData(state);
}

function hasMeaningfulDashboardData(state) {
  if (!state || typeof state !== "object") return false;
  const metricTotal = Object.values(state.metrics || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const funnelTotal = Object.entries(state.funnel || {}).reduce((sum, [key, value]) => {
    if (key === "relevant") return sum + (Array.isArray(value) ? value.length : Number(value) || 0);
    return sum + (Number(value) || 0);
  }, 0);
  const activityTotal = (state.pipelineActivity || []).reduce((sum, value) => sum + (Number(value) || 0), 0);
  return metricTotal > 0 || funnelTotal > 0 || activityTotal > 0 || (state.contentUsed || []).length > 0;
}

export const dashboardSourceLabel = (sourceLabel) => ({
  backend: "Based on backend data",
  local: "Based on local data",
  cached: "Based on cached data",
  demo: "Demo data",
}[sourceLabel] || sourceLabel || "Based on local data");

export const dashboardSourceColor = (sourceLabel) => ({
  backend: "bg-green-100 text-green-700",
  local: "bg-blue-100 text-blue-700",
  cached: "bg-slate-100 text-slate-700",
  demo: "bg-amber-100 text-amber-700",
}[sourceLabel] || "bg-gray-100 text-gray-600");

export async function buildDashboardMetricsFromSources({ allowDemo = false } = {}) {
  const [apiDashboard, backendProposalsRaw, backendCampaignsRaw, contentLibrary, backendOpportunitiesRaw, outreachRaw, reviewQueueRaw] = await Promise.all([
    getDashboardData().catch(() => null),
    getProposals().catch(() => []),
    campaignsApi.list().then(({ data }) => data).catch(() => null),
    fetchOptional("/content-library", null),
    fetchOptional("/opportunities", null),
    fetchOptional("/outreach", null),
    fetchOptional("/outreach/review-queue", null),
  ]);

  const localProposals = readLocalContentProposals();
  const localCampaigns = readLocalCampaigns();
  const backendCampaigns = asArray(backendCampaignsRaw);
  const backendCampaignIds = new Set(backendCampaigns.map((campaign) => campaign.id));
  const campaigns = [
    ...backendCampaigns,
    ...localCampaigns.filter((campaign) => !backendCampaignIds.has(campaign.id)),
  ];
  const backendProposals = asArray(backendProposalsRaw);
  const proposals = [...localProposals, ...backendProposals];
  const backendOpportunities = asArray(backendOpportunitiesRaw);
  const libraryAssets = [...asArray(contentLibrary?.assets), ...asArray(contentLibrary?.templates), ...asArray(contentLibrary?.proposals)];
  const backendReviewEmails = asArray(reviewQueueRaw).length ? asArray(reviewQueueRaw) : asArray(outreachRaw?.reviewQueue);
  const backendOutreachHistory = asArray(outreachRaw?.history).length ? asArray(outreachRaw.history) : asArray(outreachRaw);
  const apiMetrics = {
    detected: Number(apiDashboard?.detected || 0),
    researched: Number(apiDashboard?.researched || 0),
    contacted: Number(apiDashboard?.contacted || 0),
    pendingReview: Number(apiDashboard?.pendingReview || apiDashboard?.pending_review || 0),
    replied: Number(apiDashboard?.replied || 0),
    won: Number(apiDashboard?.won || 0),
  };
  const apiFunnel = {
    scanned: Number(apiDashboard?.jobsScanned ?? apiDashboard?.scanned ?? 0),
    relevant: Number(apiDashboard?.relevantOpportunities ?? apiDashboard?.relevant ?? 0),
    contactsEnriched: Number(apiDashboard?.contactsEnriched ?? apiDashboard?.contacts_enriched ?? 0),
    contentMatched: Number(apiDashboard?.contentMatched ?? apiDashboard?.content_matched ?? 0),
    emailsSent: Number(apiDashboard?.emailsSent ?? apiDashboard?.emails_sent ?? 0),
    repliesReceived: Number(apiDashboard?.repliesReceived ?? apiDashboard?.replies_received ?? 0),
    dealsWon: Number(apiDashboard?.dealsWon ?? apiDashboard?.deals_won ?? 0),
  };
  const backendDashboardHasData = hasMeaningfulDashboardData({
    metrics: apiMetrics,
    funnel: apiFunnel,
    contentUsed: asArray(apiDashboard?.contentUsed || apiDashboard?.content_used),
    pipelineActivity: asArray(apiDashboard?.pipelineActivity || apiDashboard?.pipeline_activity),
  });
  const hasBackendPipelineSource = backendDashboardHasData
    || backendOpportunities.length > 0
    || backendReviewEmails.length > 0
    || backendOutreachHistory.length > 0;
  const hasContentSource = localProposals.length > 0 || backendProposals.length > 0 || libraryAssets.length > 0 || campaigns.length > 0;
  const hasLocalSource = localProposals.length > 0 || localCampaigns.length > 0;
  const hasSources = hasContentSource || hasBackendPipelineSource;

  if (!hasSources && !allowDemo) return null;

  const useDemo = allowDemo && !hasSources;
  const opportunities = backendOpportunities.length ? backendOpportunities : useDemo ? DEMO_OPPORTUNITIES : [];
  const reviewEmails = backendReviewEmails.length ? backendReviewEmails : useDemo ? DEMO_REVIEW_EMAILS : [];
  const outreachHistory = backendOutreachHistory.length ? backendOutreachHistory : useDemo ? DEMO_OUTREACH_HISTORY : [];
  const contentItems = [
    ...libraryAssets.map((item) => ({
      ...item,
      title: item.title || item.name || "Untitled asset",
      type: item.type === "social_post" ? "Social Post" : item.type || (item.variables ? "Template" : "Asset"),
      uses: item.uses ?? item.usageCount ?? 0,
    })),
    ...proposals.map((proposal) => ({
      ...proposal,
      title: proposal.title || proposal.name || "AI Generated Proposal",
      type: "Proposal",
      uses: proposal.uses ?? proposal.usageCount ?? 0,
    })),
  ];
  const activeContentItems = contentItems.length ? contentItems : useDemo ? DEMO_CONTENT_ITEMS : [];
  const totalProposalValue = proposals.reduce((sum, proposal) => sum + (calculateProposalTotal(proposal).totalAmount || 0), 0);
  const contentRefs = [
    ...opportunities.map((item) => item.content || item.contentUsed || item.contentRef),
    ...reviewEmails.map((item) => item.contentRef || item.content),
    ...outreachHistory.map((item) => item.content || item.contentRef),
  ].filter(validContentRef);
  const contentUsed = activeContentItems
    .map((item) => ({
      ...item,
      uses: Number(item.uses || 0) + contentRefs.filter((ref) => String(ref).toLowerCase().includes(String(item.title || "").toLowerCase().slice(0, 10))).length,
    }))
    .sort((a, b) => Number(b.uses || 0) - Number(a.uses || 0))
    .slice(0, 4);

  const opportunityMetrics = selectOpportunityMetrics(opportunities);
  const scanned = Math.max(
    opportunities.length,
    backendDashboardHasData ? apiFunnel.scanned : 0,
    backendDashboardHasData ? apiMetrics.detected : 0,
  );
  const relevant = opportunities.filter((item) => Number(item.score || item.matchScore || 0) >= 60);
  const relevantCount = Math.max(
    relevant.length,
    backendDashboardHasData ? apiFunnel.relevant : 0,
    opportunities.length === 0 && backendDashboardHasData ? apiMetrics.detected : 0,
  );
  const relevantFunnelItems = relevant.length
    ? relevant
    : Array.from({ length: relevantCount }, (_, index) => ({ id: `backend-relevant-${index + 1}` }));
  const contactsEnriched = Math.max(
    opportunityMetrics.researched,
    backendDashboardHasData ? apiFunnel.contactsEnriched : 0,
    backendDashboardHasData ? apiMetrics.researched : 0,
  );
  const matchedContentItems = contentUsed.filter((item) => Number(item.uses || 0) > 0).length;
  const contentMatched = Math.max(
    contentRefs.length,
    matchedContentItems,
    activeContentItems.length,
    backendDashboardHasData ? apiFunnel.contentMatched : 0,
  );
  const emailsSent = Math.max(
    outreachHistory.filter((item) => ["sent", "opened", "replied"].includes(normalizeStageName(item.st || item.status))).length,
    backendDashboardHasData ? apiFunnel.emailsSent : 0,
    backendDashboardHasData ? apiMetrics.contacted : 0,
  );
  const repliedCount = Math.max(
    opportunityMetrics.replied,
    backendDashboardHasData ? apiFunnel.repliesReceived : 0,
    backendDashboardHasData ? apiMetrics.replied : 0,
  );
  const wonCount = Math.max(
    opportunityMetrics.won,
    backendDashboardHasData ? apiFunnel.dealsWon : 0,
    backendDashboardHasData ? apiMetrics.won : 0,
  );
  const metrics = {
    detected: Math.max(opportunityMetrics.detected, backendDashboardHasData ? apiMetrics.detected : 0),
    researched: Math.max(opportunityMetrics.researched, backendDashboardHasData ? apiMetrics.researched : 0),
    contacted: Math.max(opportunityMetrics.contacted, backendDashboardHasData ? apiMetrics.contacted : 0),
    pendingReview: Math.max(reviewEmails.length, backendDashboardHasData ? apiMetrics.pendingReview : 0),
    replied: Math.max(opportunityMetrics.replied, backendDashboardHasData ? apiMetrics.replied : 0),
    won: Math.max(opportunityMetrics.won, backendDashboardHasData ? apiMetrics.won : 0),
    proposals: proposals.length,
    contentUsed: contentUsed.reduce((sum, item) => sum + Number(item.uses || 0), 0),
    totalProposalValue,
  };
  const assets = activeContentItems.filter((item) => item.type !== "Proposal");
  const proposalApproved = proposals.filter((proposal) => ["approved", "accepted"].includes(normalizeStageName(proposal.status || proposal.state))).length;
  const proposalSent = proposals.filter((proposal) => normalizeStageName(proposal.status || proposal.state) === "sent").length;
  const socialPosts = activeContentItems.filter((item) => {
    const type = normalizeStageName(item.type || item.assetType || item.category);
    return type === "social post" || type === "socialpost";
  }).length;
  const activeCampaigns = campaigns.filter((campaign) => normalizeStageName(campaign.status) === "active").length;
  const campaignReplies = Math.max(repliedCount, outreachHistory.filter((item) => normalizeStageName(item.st || item.status) === "replied").length);
  const quickActions = {
    proposal: {
      created: proposals.length,
      approved: proposalApproved,
      sent: proposalSent,
      won: opportunities.filter((item) => ["won", "customer"].includes(normalizeStageName(item.stage || item.status))).length,
    },
    campaign: {
      saved: campaigns.length,
      active: activeCampaigns,
      posts: socialPosts,
      emailsSent,
      replies: campaignReplies,
    },
  };
  console.log("Dashboard sources", {
    opportunities,
    proposals,
    assets,
    outreach: { reviewEmails, outreachHistory },
    campaigns,
  });
  console.log("Dashboard metrics recalculated", metrics);

  return {
    metrics,
    sourceLabel: hasBackendPipelineSource || backendProposals.length > 0 || backendCampaigns.length > 0 || libraryAssets.length > 0 ? "backend" : hasLocalSource ? "local" : "demo",
    opportunities,
    reviewEmails,
    outreachHistory,
    contentUsed,
    quickActions,
    funnel: {
      scanned,
      relevant: relevantFunnelItems,
      contactsEnriched,
      contentMatched,
      emailsSent,
      repliesReceived: repliedCount,
      dealsWon: wonCount,
    },
    pipelineActivity: [
      scanned,
      relevantCount,
      contactsEnriched,
      contentMatched,
      emailsSent,
      repliedCount,
      wonCount,
    ],
    lastUpdated: formatUpdatedTime(),
  };
}
