import { stripHtml } from "@/utils/htmlText";

const cleanSocialText = (value = "") => stripHtml(String(value || ""))
  .replace(/```(?:\w+)?/g, "")
  .replace(/\*\*(.*?)\*\*/g, "$1")
  .replace(/__(.*?)__/g, "$1")
  .replace(/(?<!\*)\*(?!\*)(.*?)\*(?!\*)/g, "$1")
  .replace(/(?<!_)_(?!_)(.*?)_(?!_)/g, "$1")
  .replace(/^#{1,6}\s+/gm, "")
  .trim();

export function normalizeCampaignContent(rawContent = "", fallbackChannel = "linkedin", fallbackTitle = "") {
  let parsed = null;
  try {
    parsed = typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent;
  } catch {
    parsed = null;
  }

  const candidates = Array.isArray(parsed) ? parsed : parsed?.posts;
  if (Array.isArray(candidates) && candidates.length) {
    return candidates.map((post, index) => ({
      channel: post.channel || post.platform || fallbackChannel,
      headline: cleanSocialText(post.headline || (index === 0 ? fallbackTitle : "")),
      content: cleanSocialText(post.content || post.body || ""),
      hashtags: Array.isArray(post.hashtags)
        ? post.hashtags.map((tag) => cleanSocialText(tag)).filter(Boolean)
        : [],
    })).filter((post) => post.content);
  }

  const legacyText = cleanSocialText(rawContent);
  return legacyText ? [{
    channel: fallbackChannel,
    headline: cleanSocialText(fallbackTitle),
    content: legacyText,
    hashtags: [],
  }] : [];
}

export const WIZARD_STEPS = [
  { id: 1, label: "Audience", icon: "👥" },
  { id: 2, label: "Brief", icon: "🎯" },
  { id: 3, label: "AI Content", icon: "✦" },
  { id: 4, label: "Assets", icon: "📁" },
  { id: 5, label: "Review", icon: "✏️" },
  { id: 6, label: "Activate", icon: "🚀" },
  { id: 7, label: "Results", icon: "📊" },
];

export const createInitialCampaignWizardData = () => ({
  currentStep: 1,
  selectedOpportunities: [],
  brief: {
    name: "",
    objective: "lead_generation",
    channels: ["linkedin"],
    startDate: "",
    budget: "",
    kpis: "",
    context: "",
  },
  campaignId: null,
  generatedContent: null,
  selectedAssets: [],
  approved: false,
  activated: false,
});

export const CAMPAIGN_FLOW_STEPS = [
  { id: 1, label: "Audience", page: "opportunities" },
  { id: 2, label: "Brief", page: "campaign_brief" },
  { id: 3, label: "AI Content", page: "assistant" },
  { id: 4, label: "Assets", page: "content" },
  { id: 5, label: "Review", page: "outreach" },
  { id: 6, label: "Activate", page: "outreach" },
  { id: 7, label: "Results", page: "reports" },
];

export const completeCampaignFlowSteps = (current, steps, nextStep) => ({
  ...current,
  currentStep: nextStep,
  completedSteps: Array.from(new Set([...(current?.completedSteps || []), ...steps])),
});
