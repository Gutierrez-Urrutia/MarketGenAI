export const PREF_KEYS = {
  language: "marketgen_language",
  theme: "marketgen_theme",
  model: "marketgen_ai_model",
  timezone: "marketgen_timezone",
  dateFormat: "marketgen_date_format",
};

export const getBrowserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const TIMEZONE_OPTIONS = [
  { value: "Europe/London", label: "(UTC+00:00) London, Dublin, Lisbon" },
  { value: "Europe/Paris", label: "(UTC+01:00) Paris, Berlin, Madrid, Amsterdam" },
  { value: "Europe/Moscow", label: "(UTC+03:00) Moscow, Istanbul" },
  { value: "Asia/Dubai", label: "(UTC+04:00) Dubai, Abu Dhabi" },
  { value: "Asia/Singapore", label: "(UTC+08:00) Singapore, Hong Kong, Perth" },
  { value: "Asia/Tokyo", label: "(UTC+09:00) Tokyo, Seoul" },
  { value: "Australia/Sydney", label: "(UTC+10:00) Sydney, Melbourne" },
  { value: "America/New_York", label: "(UTC-05:00) New York, Miami, Toronto" },
  { value: "America/Chicago", label: "(UTC-06:00) Chicago, Dallas, Mexico City" },
  { value: "America/Denver", label: "(UTC-07:00) Denver, Phoenix" },
  { value: "America/Los_Angeles", label: "(UTC-08:00) Los Angeles, San Francisco, Seattle" },
  { value: "America/Santiago", label: "(UTC-04:00) Santiago" },
  { value: "America/Sao_Paulo", label: "(UTC-03:00) São Paulo, Buenos Aires" },
  { value: "UTC", label: "(UTC+00:00) UTC" },
];

export const DATE_FORMAT_OPTIONS = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"];

export const getStoredPreference = (key, fallback) => localStorage.getItem(key) || fallback;

const DELETED_CONTENT_IDS_KEY = "marketgen_deleted_content_asset_ids";

const LOCAL_PROPOSALS_KEY = "marketgen_local_content_library_proposals";

const LOCAL_CAMPAIGNS_KEY = "marketgen_local_campaigns";

export const readDeletedContentIds = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(DELETED_CONTENT_IDS_KEY) || "[]");
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
};

export const writeDeletedContentIds = (ids) => {
  localStorage.setItem(DELETED_CONTENT_IDS_KEY, JSON.stringify([...new Set(ids)]));
};

export const getContentItemKey = (item = {}) => `${item.type || "Asset"}:${item.id || item.title || ""}`;

export const readLocalContentProposals = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(LOCAL_PROPOSALS_KEY) || "[]");
    return Array.isArray(stored)
      ? stored.filter((proposal) => !String(proposal?.id || "").startsWith("opportunity-proposal-"))
      : [];
  } catch {
    return [];
  }
};

const writeLocalContentProposals = (proposals) => {
  localStorage.setItem(LOCAL_PROPOSALS_KEY, JSON.stringify(proposals));
};

export const saveLocalContentProposal = (proposal) => {
  const current = readLocalContentProposals();
  const existingIndex = current.findIndex((item) => item.id === proposal.id);
  const next = existingIndex >= 0
    ? current.map((item) => (item.id === proposal.id ? proposal : item))
    : [proposal, ...current];
  writeLocalContentProposals(next);
  window.dispatchEvent(new CustomEvent("marketgen:proposal-updated"));
  window.dispatchEvent(new CustomEvent("marketgen:content-library-updated"));
  return next;
};

export const readLocalCampaigns = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(LOCAL_CAMPAIGNS_KEY) || "[]");
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
};

const writeLocalCampaigns = (campaigns) => {
  localStorage.setItem(LOCAL_CAMPAIGNS_KEY, JSON.stringify(campaigns));
};

export const saveLocalCampaign = (campaign) => {
  const current = readLocalCampaigns();
  const existingIndex = current.findIndex((item) => item.id === campaign.id);
  const next = existingIndex >= 0
    ? current.map((item) => (item.id === campaign.id ? campaign : item))
    : [campaign, ...current];
  writeLocalCampaigns(next);
  window.dispatchEvent(new CustomEvent("marketgen:campaign-updated"));
  window.dispatchEvent(new CustomEvent("marketgen:campaigns-updated"));
  return next;
};
