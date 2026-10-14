import { DEMO_OPPORTUNITIES, DEMO_OUTREACH_HISTORY, DEMO_REVIEW_EMAILS } from "@/utils/demoData";
import { createEmptyDashboardState } from "@/features/dashboard/dashboardSnapshot";
import { normalizeStageName, selectOpportunityMetrics } from "@/features/opportunities/opportunityHelpers";

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
