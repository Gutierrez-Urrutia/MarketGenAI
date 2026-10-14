import { useEffect, useState, useRef } from "react";
import html2pdf from "html2pdf.js";

import { Footer } from "docx";

import api, { authApi, authTokenStore, campaignsApi, socialApi } from "./api/axios";
import { useI18n } from "./hooks/useI18n";
import { useLanguage } from "./context/LanguageContext";
import { useTheme } from "./context/ThemeContext";
import { getProposals, createProposal, deleteProposal, updateProposal, updateProposalStatus, generateProposalById, sendProposalToCrm } from "./api/proposalsApi";

import LeadList from "./pages/pipeline/LeadList";
import Modal from "./components/ui/Modal";

import { ProposalDocumentPreview } from "./features/proposals/ProposalDocumentPreview";
import { calculateProposalTotal, cleanStructuredText, formatUsd, normalizeLineItem, normalizeProposalDocument } from "./features/proposals/proposalDocument";
import { downloadBlob, exportProposalDocument, sanitizeDownloadName } from "./features/proposals/proposalExport";
import { proposalDocumentToHtml } from "./features/proposals/proposalHtml";
import { cleanProposalHtml, stripHtml } from "./utils/htmlText";
import { ProgressModal } from "./components/dashboard/ProgressModal";
import { ArrowRightIcon, BookIcon, BriefIcon, ChartIcon, CheckIcon, ClockIcon, DownloadIcon, EyeIcon, FileIcon, FolderIcon, GearIcon, GridIcon, InboxIcon, LayersIcon, LinkIcon, LogOutIcon, PenIcon, PlugIcon, PlusIcon, RadarIcon, RefreshIcon, SaveIcon, SendIcon, Share2Icon, ShieldIcon, SparkIcon, TargetIcon, TrashIcon, XIcon } from "./components/dashboard/icons";
import { ToastStack, useToastQueue } from "./components/dashboard/toasts";
import { Badge, Btn, Card, Field, Input, Select } from "./components/dashboard/ui";

import { PREF_KEYS, getContentItemKey, getStoredPreference, readDeletedContentIds, readLocalContentProposals, saveLocalCampaign, saveLocalContentProposal, writeDeletedContentIds } from "./utils/localStore";
import { AsyncJobCard } from "./components/dashboard/AsyncJobCard";
import { createEmptyDashboardState } from "./features/dashboard/dashboardSnapshot";
import { normalizeStageName, selectOpportunityMetrics } from "./features/opportunities/opportunityHelpers";
import { PROPOSAL_STATUSES, PROPOSAL_STATUS_COLOR_CLASSES } from "./features/proposals/proposalStatus";
import { ASSET_REGENERATION_TYPES, ASSET_REGENERATION_VARIATION_INSTRUCTION } from "./utils/assetRegeneration";
import { CAMPAIGN_FLOW_STEPS, completeCampaignFlowSteps, normalizeCampaignContent } from "./utils/campaignContent";
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

function extractH1Text(html = "") {
  const match = cleanProposalHtml(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return match ? stripHtml(match[1]).trim() : "";
}


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
/*  PAGE: CONTENT LIBRARY (merged Assets, Proposals, Templates)    */
/* ═══════════════════════════════════════════════════════════════ */
function ContentLibraryPage({ navigationState = {}, onNavigate = () => {}, campaignFlow = null, setCampaignFlow = () => {} }) {
  const { t } = useI18n();
  const { language: activeLanguage } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const [proposals, setProposals] = useState([]);
  const [libraryItems, setLibraryItems] = useState([]);
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [typeFilter, setTypeFilter] = useState(navigationState.typeFilter || "All");
  const [statusFilter, setStatusFilter] = useState(navigationState.statusFilter || "");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createType, setCreateType] = useState("Proposal");
  const [contentLanguage, setContentLanguage] = useState(getStoredPreference(PREF_KEYS.language, "en"));
  const [editingProposal, setEditingProposal] = useState(null);
  const [viewingProposal, setViewingProposal] = useState(null);
  const [crmSending, setCrmSending] = useState(false);
  const [crmEmailPrompt, setCrmEmailPrompt] = useState(null); // { proposal, email } while asking for a missing client email
  const [crmEmailPromptSaving, setCrmEmailPromptSaving] = useState(false);
  const [viewingContentItem, setViewingContentItem] = useState(null);
  const [viewingCampaignContent, setViewingCampaignContent] = useState(null);
  const [socialPublishStatus, setSocialPublishStatus] = useState(null);
  const [contentTitle, setContentTitle] = useState("");
  const [contentDescription, setContentDescription] = useState("");
  const [detailedDescription, setDetailedDescription] = useState("");
  const [teamSizing, setTeamSizing] = useState("");
  const [proposalLength, setProposalLength] = useState("standard");
  const [proposalContentSource, setProposalContentSource] = useState("ai");
  const [proposalLanguage, setProposalLanguage] = useState(getStoredPreference(PREF_KEYS.language, "en"));
  const [proposalLanguageManuallySelected, setProposalLanguageManuallySelected] = useState(false);
  const [proposalCustomPrompt, setProposalCustomPrompt] = useState("");
  const [contentAiStep, setContentAiStep] = useState(1);
  const [contentAiForm, setContentAiForm] = useState({
    client_name: "",
    industry: "",
    region: "",
    duration_months: 3,
    challenge: "",
    solution: "",
    metric_1_label: "",
    metric_1_value: "",
    metric_2_label: "",
    metric_2_value: "",
    metric_3_label: "",
    metric_3_value: "",
    testimonial_quote: "",
    testimonial_name: "",
    testimonial_role: "",
    title: "",
    subtitle: "",
    topic: "",
    target_audience: "",
    key_sections: "",
    abstract: "",
    template_name: "",
    channel: "Email",
    category: "follow_up",
    tone: "Friendly",
    use_case: "",
    merge_variables: "first_name, company, use_case",
    product_name: "",
    tagline: "",
    features: "",
    cta_text: "",
    cta_url: "",
    platform: "LinkedIn",
    key_points: "",
  });
  const [generatedContentItem, setGeneratedContentItem] = useState(null);
  const [contentGenerating, setContentGenerating] = useState(false);
  const [structuredEditingProposalId, setStructuredEditingProposalId] = useState(null);
  const [generationModal, setGenerationModal] = useState(null);
  const [wizardStep, setWizardStep] = useState(1);
  const { toasts, setToast, removeToast, pauseToast, resumeToast } = useToastQueue();
  const [deletedContentIds, setDeletedContentIds] = useState(readDeletedContentIds);
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(0);
  const [proposalForm, setProposalForm] = useState({
    name: "BPO Proposal for Finance",
    customer: "",
    customerEmail: "",
    customerCompany: "",
    template: "NoonDalton Standard Proposal",
    date: new Date().toISOString().slice(0, 10),
    tags: [],
    tax: 0,
    discount: 0,
  });
  const [customProposalTag, setCustomProposalTag] = useState("");
  const [pricingRows, setPricingRows] = useState([
    { id: 1, service: "Discovery and Solution Design", description: "Customer context, requirements, and implementation plan.", quantity: 1, unitPrice: 1200 },
    { id: 2, service: "AI Workflow Implementation", description: "Configuration of the main automation and operational workflow.", quantity: 1, unitPrice: 3800 },
  ]);
  const [draftHtml, setDraftHtml] = useState("");
  const viewingProposalPreviewRef = useRef(null);
  const createProposalPreviewRef = useRef(null);
  const proposalEditorRef = useRef(null);
  const editorSessionRef = useRef(0);
  useEffect(() => {
    if (editingProposal && proposalEditorRef.current) {
      proposalEditorRef.current.innerHTML = editingProposal.draftContent || "";
    }
    // Only re-seed the editable DOM when a (re)opened proposal loads, never on
    // keystrokes — otherwise React's dangerouslySetInnerHTML re-render fights
    // the browser's own contentEditable mutations and crashes on delete.
    // Keyed off editSession (not proposal.id) so it still fires when the same
    // proposal is reopened or when id is missing/duplicated across drafts.
  }, [editingProposal?.editSession]);
  const resetCreateContentForm = () => {
    setWizardStep(1);
    setContentTitle("");
    setContentDescription("");
    setDetailedDescription("");
    setTeamSizing("");
    setProposalLength("standard");
    setProposalContentSource("ai");
    setProposalLanguage(platformGenerationLanguage);
    setProposalLanguageManuallySelected(false);
    setProposalCustomPrompt("");
    setContentAiStep(1);
    setContentAiForm({
      client_name: "",
      industry: "",
      region: "",
      duration_months: 3,
      challenge: "",
      solution: "",
      metric_1_label: "",
      metric_1_value: "",
      metric_2_label: "",
      metric_2_value: "",
      metric_3_label: "",
      metric_3_value: "",
      testimonial_quote: "",
      testimonial_name: "",
      testimonial_role: "",
      title: "",
      subtitle: "",
      topic: "",
      target_audience: "",
      key_sections: "",
      abstract: "",
      template_name: "",
      channel: "Email",
      category: "follow_up",
      tone: "Friendly",
      use_case: "",
      merge_variables: "first_name, company, use_case",
      product_name: "",
      tagline: "",
      features: "",
      cta_text: "",
      cta_url: "",
      platform: "LinkedIn",
      key_points: "",
    });
    setGeneratedContentItem(null);
    setContentGenerating(false);
    setStructuredEditingProposalId(null);
    setProposalForm({
      name: "BPO Proposal for Finance",
      customer: "",
      customerEmail: "",
      customerCompany: "",
      template: "NoonDalton Standard Proposal",
      date: new Date().toISOString().slice(0, 10),
      tags: [],
      tax: 0,
      discount: 0,
    });
    setCustomProposalTag("");
    setPricingRows([
      { id: 1, service: "Discovery and Solution Design", description: "Customer context, requirements, and implementation plan.", quantity: 1, unitPrice: 1200 },
      { id: 2, service: "AI Workflow Implementation", description: "Configuration of the main automation and operational workflow.", quantity: 1, unitPrice: 3800 },
    ]);
    setDraftHtml("");
  };
  const openCreateContentModal = (type = createType) => {
    resetCreateContentForm();
    setCreateType(type);
    setShowCreateModal(true);
  };
  const closeCreateContentModal = () => {
    setShowCreateModal(false);
    resetCreateContentForm();
  };

  useEffect(() => {
    if (navigationState.typeFilter) {
      setTypeFilter(navigationState.typeFilter);
      if (!navigationState.statusFilter) setStatusFilter("");
    }
    if (navigationState.statusFilter) {
      setStatusFilter(navigationState.statusFilter);
      setTypeFilter("Proposals");
    }
  }, [navigationState.typeFilter, navigationState.statusFilter]);

  useEffect(() => {
    if (navigationState.openCreateContentModal) {
      openCreateContentModal("Proposal");
    }
  }, [navigationState.openCreateContentModal]);

  useEffect(() => {
    const refreshLibrary = () => setLibraryRefreshKey((current) => current + 1);
    window.addEventListener("marketgen:content-library-updated", refreshLibrary);
    return () => window.removeEventListener("marketgen:content-library-updated", refreshLibrary);
  }, []);

  useEffect(() => {
    if (viewingCampaignContent) refreshPublishStatus();
  }, [viewingCampaignContent]);

  useEffect(() => {
    setContentLanguage(activeLanguage || getStoredPreference(PREF_KEYS.language, "en"));
    if (!proposalLanguageManuallySelected) {
      setProposalLanguage(activeLanguage || getStoredPreference(PREF_KEYS.language, "en"));
    }
  }, [activeLanguage, proposalLanguageManuallySelected]);

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const money = formatUsd;
  const publishPlatforms = [
    { platform: "facebook", label: "Facebook" },
    { platform: "twitter", label: "Twitter / X" },
    { platform: "linkedin", label: "LinkedIn" },
  ];
  const refreshPublishStatus = async () => {
    try {
      const { data } = await socialApi.status();
      setSocialPublishStatus(data);
    } catch (error) {
      console.error(error);
      setSocialPublishStatus(null);
    }
  };
  const publishSocialPost = async (platform, post, copyText) => {
    try {
      const { data } = await socialApi.publish({
        platform,
        title: post.headline || viewingCampaignContent?.title || "",
        content: copyText,
      });
      if (data?.shareUrl) {
        window.open(data.shareUrl, "_blank", "noopener,noreferrer");
      }
      setToast({ type: "success", message: `Opened ${data?.platform || platform} publisher.` });
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: error.response?.data?.detail || "Connect this social account in Settings first." });
    }
  };
  const createCopy = {
    en: {
      openCreate: "Create Content",
      modalTitle: "Create Content",
      modalSubtitle: "Add a new item to your Content Library",
      contentType: "Content Type",
      title: "Title",
      titleExample: "BPO Proposal for [Client]",
      templateTitleExample: "Follow-up after demo",
      assetTitleExample: "Marketing Automation Playbook",
      proposalDescription: "Proposal Description",
      proposalDescriptionPlaceholder: "Describe the client's challenge, goals, desired outcome, and business problem...",
      detailedDescription: "Detailed Process Description",
      detailedDescriptionPlaceholder: "Example: Receive requests by email, validate documents, enter data into the ERP, route exceptions to a supervisor, and send a daily completion report.",
      teamSizing: "Team to Quote",
      teamSizingPlaceholder: "6 back office agents + 1 supervisor, Philippines",
      length: "Length",
      brief: "Brief",
      standard: "Standard",
      extended: "Extended",
      proposalLanguage: "Proposal Language",
      detected: "detected",
      english: "English",
      spanish: "Español",
      portuguese: "Português",
      description: "Description",
      descriptionHint: "Brief summary - the AI will use this when referencing your content in outreach emails.",
      descriptionPlaceholder: "What is this content about? What value does it demonstrate?",
      proposalDetails: "Proposal Details",
      servicesPricing: "Services & Pricing",
      reviewProposal: "Review Proposal",
      step: "Step",
      customer: "Customer",
      customerPlaceholder: "Enter customer name",
      template: "Template",
      tags: "Tags",
      customTagPlaceholder: "Add custom tag...",
      contentSource: "Content Source",
      generateWithAi: "Generate with AI",
      generateWithAiHint: "Based on title and tags",
      uploadFile: "Upload file",
      uploadFileHint: "PDF, DOCX, text",
      manual: "Manual",
      manualHint: "Write draft",
      cancel: "Cancel",
      saveDraft: "Save as Draft",
      back: "Back",
      continue: "Continue",
      continuePricing: "Continue to Services & Pricing",
      generateDraft: "Generate Proposal Draft",
      regenerate: "Regenerate Proposal",
      editStructure: "Edit Structure",
      adjustmentInstructions: "Adjustment Instructions",
      adjustmentInstructionsPlaceholder: "Example: Frame it as a commercial offer and emphasize benefits instead of problems.",
      downloadDocx: "Download DOCX",
      downloadPdf: "Download PDF",
      uploadCrm: "Upload to CRM",
      crmQueued: "CRM upload queued",
      comingSoon: "Coming Soon",
      titleRequired: "Proposal title is required before continuing",
      customerRequired: "Customer is required before continuing",
      templateRequired: "Template is required before continuing",
      proposalDescriptionRequired: "Proposal Description is required before generating a proposal",
      tagLimit: "You can select up to 6 tags.",
      draftSaved: "Draft saved",
      proposalGenerated: "Proposal draft generated successfully",
      proposalRegenerated: "Proposal regenerated successfully",
      generationFailedDraftSaved: "Generation failed; your draft was saved",
      draftCreationFailed: "The proposal draft could not be saved",
      aiCreatesContent: "AI creates the content based on title and tags",
      uploadExistingFile: "Upload existing file",
      uploadExistingFileHint: "PDF, DOCX, or plain text",
      writeManually: "Write manually",
      writeManuallyHint: "Enter content directly in the editor",
      serviceUnit: "Service / Unit",
      serviceDescription: "Description",
      qty: "Qty",
      unitPrice: "Unit Price",
      subtotal: "Subtotal",
      addLineItem: "Add Line Item",
      tax: "Tax",
      discount: "Discount",
      totalAmount: "Total Amount",
      noPricing: "No pricing items added yet.",
      reviewDetails: "Proposal details",
      reviewPricing: "Services and pricing",
      notProvided: "Not provided",
      generatingProposal: "Generating proposal",
      estimatedTime: "Estimated time: 10 - 15 seconds",
      complete: "complete",
      retry: "Retry",
      proposalSteps: [
        "Analyzing customer context",
        "Loading proposal template",
        "Processing service units and pricing",
        "Calculating totals",
        "Generating executive summary",
        "Creating solution section",
        "Building pricing and ROI section",
        "Formatting proposal draft",
        "Preparing preview",
        "Completed",
      ],
    },
    es: {
      openCreate: "Crear Contenido",
      modalTitle: "Crear Contenido",
      modalSubtitle: "Agrega un nuevo elemento a tu Content Library",
      contentType: "Tipo de contenido",
      title: "Título",
      titleExample: "Propuesta BPO para [Cliente]",
      templateTitleExample: "Seguimiento después de demo",
      assetTitleExample: "Playbook de automatización de marketing",
      proposalDescription: "Descripción de la propuesta",
      proposalDescriptionPlaceholder: "Describe el desafío del cliente, objetivos, resultado esperado y problema de negocio...",
      detailedDescription: "Descripción detallada del proceso",
      detailedDescriptionPlaceholder: "Ejemplo: Recibir solicitudes por email, validar documentos, ingresar datos al ERP, derivar excepciones a un supervisor y enviar un reporte diario de finalización.",
      teamSizing: "Equipo a cotizar",
      teamSizingPlaceholder: "6 agentes back office + 1 supervisor, Filipinas",
      length: "Extensión",
      brief: "Breve",
      standard: "Estándar",
      extended: "Extensa",
      proposalLanguage: "Idioma de la propuesta",
      detected: "detectado",
      english: "English",
      spanish: "Español",
      portuguese: "Português",
      description: "Descripción",
      descriptionHint: "Resumen breve - la IA lo usará al referenciar este contenido en emails.",
      descriptionPlaceholder: "¿De qué trata este contenido? ¿Qué valor demuestra?",
      proposalDetails: "Detalles de la Propuesta",
      servicesPricing: "Servicios y Precios",
      reviewProposal: "Revisar Propuesta",
      step: "Paso",
      customer: "Cliente",
      customerPlaceholder: "Ingrese nombre del cliente",
      template: "Template",
      tags: "Etiquetas",
      customTagPlaceholder: "Agregar etiqueta personalizada...",
      contentSource: "Fuente de contenido",
      generateWithAi: "Generar con IA",
      generateWithAiHint: "Segun titulo y etiquetas",
      uploadFile: "Subir archivo",
      uploadFileHint: "PDF, DOCX, texto",
      manual: "Manual",
      manualHint: "Escribir borrador",
      cancel: "Cancelar",
      saveDraft: "Guardar borrador",
      back: "Atrás",
      continue: "Continuar",
      continuePricing: "Continuar a Servicios y Precios",
      generateDraft: "Generar borrador de propuesta",
      regenerate: "Regenerar propuesta",
      editStructure: "Editar estructura",
      adjustmentInstructions: "Instrucciones de ajuste",
      adjustmentInstructionsPlaceholder: "Ej.: enfócalo como oferta comercial, destaca beneficios en vez de problemas.",
      downloadDocx: "Descargar DOCX",
      downloadPdf: "Descargar PDF",
      uploadCrm: "Subir al CRM",
      crmQueued: "Subida al CRM en cola",
      comingSoon: "Próximamente",
      titleRequired: "El título de la propuesta es obligatorio antes de continuar",
      customerRequired: "El cliente es obligatorio antes de continuar",
      templateRequired: "El template es obligatorio antes de continuar",
      proposalDescriptionRequired: "La descripción de la propuesta es obligatoria antes de generar",
      tagLimit: "Puedes seleccionar hasta 6 etiquetas.",
      draftSaved: "Borrador guardado",
      proposalGenerated: "Borrador de propuesta generado correctamente",
      proposalRegenerated: "Propuesta regenerada correctamente",
      generationFailedDraftSaved: "La generación falló; tu borrador quedó guardado",
      draftCreationFailed: "No se pudo guardar el borrador de la propuesta",
      aiCreatesContent: "La IA crea el contenido según título y etiquetas",
      uploadExistingFile: "Subir archivo existente",
      uploadExistingFileHint: "PDF, DOCX o texto plano",
      writeManually: "Escribir manualmente",
      writeManuallyHint: "Ingresar contenido directamente en el editor",
      serviceUnit: "Servicio / Unidad",
      serviceDescription: "Descripción",
      qty: "Cant.",
      unitPrice: "Precio unitario",
      subtotal: "Subtotal",
      addLineItem: "Agregar ítem",
      tax: "Impuesto",
      discount: "Descuento",
      totalAmount: "Monto total",
      noPricing: "Aún no se agregaron servicios.",
      reviewDetails: "Detalles de la propuesta",
      reviewPricing: "Servicios y precios",
      notProvided: "No informado",
      generatingProposal: "Generando propuesta",
      estimatedTime: "Tiempo estimado: 10 - 15 segundos",
      complete: "completado",
      retry: "Reintentar",
      proposalSteps: [
        "Analizando contexto del cliente",
        "Cargando template de propuesta",
        "Procesando servicios y precios",
        "Calculando totales",
        "Generando resumen ejecutivo",
        "Creando sección de solución",
        "Construyendo precios y ROI",
        "Formateando borrador",
        "Preparando vista previa",
        "Completado",
      ],
    },
    pt: {
      openCreate: "Criar Conteudo",
      modalTitle: "Criar Conteudo",
      modalSubtitle: "Adicione um novo item a sua Content Library",
      contentType: "Tipo de conteudo",
      title: "Titulo",
      titleExample: "Proposta BPO para [Cliente]",
      templateTitleExample: "Follow-up apos demo",
      assetTitleExample: "Playbook de automacao de marketing",
      proposalDescription: "Descricao da proposta",
      proposalDescriptionPlaceholder: "Descreva o desafio do cliente, objetivos, resultado desejado e problema de negocio...",
      detailedDescription: "Descricao detalhada do processo",
      detailedDescriptionPlaceholder: "Exemplo: Receber solicitacoes por email, validar documentos, inserir dados no ERP, encaminhar excecoes a um supervisor e enviar um relatorio diario de conclusao.",
      teamSizing: "Equipe a cotar",
      teamSizingPlaceholder: "6 agentes de back office + 1 supervisor, Filipinas",
      length: "Extensao",
      brief: "Breve",
      standard: "Padrao",
      extended: "Extensa",
      proposalLanguage: "Idioma da proposta",
      detected: "detectado",
      english: "English",
      spanish: "Español",
      portuguese: "Português",
      description: "Descricao",
      descriptionHint: "Resumo breve - a IA usara isto ao referenciar seu conteudo em emails.",
      descriptionPlaceholder: "Sobre o que e este conteudo? Que valor ele demonstra?",
      proposalDetails: "Detalhes da Proposta",
      servicesPricing: "Servicos e Precos",
      reviewProposal: "Revisar Proposta",
      step: "Etapa",
      customer: "Cliente",
      customerPlaceholder: "Insira o nome do cliente",
      template: "Template",
      tags: "Etiquetas",
      customTagPlaceholder: "Adicionar etiqueta personalizada...",
      contentSource: "Fonte de conteudo",
      generateWithAi: "Gerar com IA",
      generateWithAiHint: "Com base no titulo e etiquetas",
      uploadFile: "Enviar arquivo",
      uploadFileHint: "PDF, DOCX, texto",
      manual: "Manual",
      manualHint: "Escrever rascunho",
      cancel: "Cancelar",
      saveDraft: "Salvar rascunho",
      back: "Voltar",
      continue: "Continuar",
      continuePricing: "Continuar para Servicos e Precos",
      generateDraft: "Gerar rascunho da proposta",
      regenerate: "Regenerar proposta",
      editStructure: "Editar estrutura",
      adjustmentInstructions: "Instrucoes de ajuste",
      adjustmentInstructionsPlaceholder: "Ex.: apresente como oferta comercial e destaque beneficios em vez de problemas.",
      downloadDocx: "Baixar DOCX",
      downloadPdf: "Baixar PDF",
      uploadCrm: "Enviar ao CRM",
      crmQueued: "Envio ao CRM na fila",
      comingSoon: "Em breve",
      titleRequired: "O titulo da proposta e obrigatorio antes de continuar",
      customerRequired: "O cliente e obrigatorio antes de continuar",
      templateRequired: "O template e obrigatorio antes de continuar",
      proposalDescriptionRequired: "A descricao da proposta e obrigatoria antes de gerar",
      tagLimit: "Voce pode selecionar ate 6 etiquetas.",
      draftSaved: "Rascunho salvo",
      proposalGenerated: "Rascunho da proposta gerado com sucesso",
      proposalRegenerated: "Proposta regenerada com sucesso",
      generationFailedDraftSaved: "A geração falhou; seu rascunho foi salvo",
      draftCreationFailed: "Nao foi possivel salvar o rascunho da proposta",
      aiCreatesContent: "A IA cria o conteudo com base no titulo e etiquetas",
      uploadExistingFile: "Enviar arquivo existente",
      uploadExistingFileHint: "PDF, DOCX ou texto simples",
      writeManually: "Escrever manualmente",
      writeManuallyHint: "Inserir conteudo diretamente no editor",
      serviceUnit: "Servico / Unidade",
      serviceDescription: "Descricao",
      qty: "Qtd.",
      unitPrice: "Preco unitario",
      subtotal: "Subtotal",
      addLineItem: "Adicionar item",
      tax: "Imposto",
      discount: "Desconto",
      totalAmount: "Valor total",
      noPricing: "Nenhum servico adicionado ainda.",
      reviewDetails: "Detalhes da proposta",
      reviewPricing: "Servicos e precos",
      notProvided: "Nao informado",
      generatingProposal: "Gerando proposta",
      estimatedTime: "Tempo estimado: 10 - 15 segundos",
      complete: "concluido",
      retry: "Tentar novamente",
      proposalSteps: [
        "Analisando contexto do cliente",
        "Carregando template da proposta",
        "Processando servicos e precos",
        "Calculando totais",
        "Gerando resumo executivo",
        "Criando secao de solucao",
        "Construindo precos e ROI",
        "Formatando rascunho",
        "Preparando visualizacao",
        "Concluido",
      ],
    },
  };
  const createT = createCopy[contentLanguage] || createCopy.en;
  const proposalLanguageLabels = {
    en: createT.english,
    es: createT.spanish,
    pt: createT.portuguese,
  };
  const proposalSteps = createT.proposalSteps;
  const contentTypeOptions = ["Case Study", "Proposal", "Template", "Whitepaper", "Social Post", "One-Pager"];
  const aiContentTypes = ["Case Study", "Whitepaper", "Template", "One-Pager", "Social Post"];
  const isAiContentType = aiContentTypes.includes(createType);
  const contentTypeEndpoint = {
    "Case Study": "case-study",
    Whitepaper: "whitepaper",
    Template: "template",
    "One-Pager": "one-pager",
    "Social Post": "social-post",
  };
  const contentTypeBackendType = {
    "Case Study": "case_study",
    Whitepaper: "whitepaper",
    Template: "template",
    "One-Pager": "one_pager",
    "Social Post": "social_post",
  };
  const contentTypeTitleField = {
    "Case Study": "client_name",
    Whitepaper: "title",
    Template: "template_name",
    "One-Pager": "product_name",
    "Social Post": "topic",
  };
  const maxProposalTags = 6;
  const pricingSubtotal = pricingRows.reduce((sum, row) => sum + Number(row.quantity || 0) * Number(row.unitPrice || 0), 0);
  const pricingTotal = calculateProposalTotal({
    pricingRows,
    tax: proposalForm.tax,
    discount: proposalForm.discount,
  }).totalAmount || 0;
  const defaultProposalTags = ["Lead Generation", "Email Marketing", "Outreach", "Sales Enablement", "Content Marketing", "B2B Marketing", "Marketing Automation", "CRM", "Personalization", "Campaign Strategy", "Conversion Optimization", "Analytics", "AI Content", "Proposal Automation"];
  const normalizeTags = (tags) => Array.isArray(tags)
    ? tags.map((tag) => String(tag).trim()).filter(Boolean)
    : String(tags || "").split(",").map((tag) => tag.trim()).filter(Boolean);
  const proposalTags = normalizeTags(proposalForm.tags);
  const allProposalTags = [...new Set([...defaultProposalTags, ...proposalTags])];
  const canContinueProposalSetup = proposalForm.name.trim() && proposalForm.customer.trim();
  const updateProposalForm = (field, value) => setProposalForm((current) => ({ ...current, [field]: value }));
  const updateContentAiForm = (field, value) => setContentAiForm((current) => ({ ...current, [field]: value }));
  const splitListInput = (value) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  const contentAiLabel = (key) => t(`contentLibrary.aiFields.${key}`);
  const platformGenerationLanguage = proposalLanguage || activeLanguage || contentLanguage || getStoredPreference(PREF_KEYS.language, "en") || "en";
  const backendPdfContentTypes = new Set(["Case Study", "Whitepaper", "Template", "One-Pager"]);
  const canUseBackendContentPdf = (item) => (
    item?.id
    && backendPdfContentTypes.has(item.type)
    && !String(item.id).startsWith("mock-")
    && !String(item.id).startsWith("ai-content-")
  );
  const downloadBackendContentPdf = async (item) => {
    const response = await api.get(`/content/generate/content-items/${item.id}/download`, {
      params: { format: "pdf" },
      responseType: "blob",
    });
    downloadBlob(response.data, `${sanitizeDownloadName(item.title || item.type || "content")}.pdf`);
  };
  const normalizeGeneratedContentItem = (item, type = createType) => ({
    id: item.id || `ai-content-${Date.now()}`,
    title: item.title || contentAiForm[contentTypeTitleField[type]] || type,
    type,
    assetType: item.type || contentTypeBackendType[type],
    status: "ready",
    description: stripHtml(item.content || "").slice(0, 180),
    industry: stripHtml(item.content || "").slice(0, 220) || type,
    services: ["AI"],
    uses: 0,
    date: item.updated_at || item.updatedAt || item.created_at || item.createdAt || new Date().toISOString(),
    updatedAt: item.updated_at || item.updatedAt || item.created_at || item.createdAt || new Date().toISOString(),
    content: item.content || "",
    rawContent: item.content || "",
    language: item.language || platformGenerationLanguage,
  });
  const isGeneratedContentType = (type) => ["Case Study", "Whitepaper", "Template", "One-Pager"].includes(type);
  const contentPreviewBadgeColor = (type) => ({
    "Case Study": "bg-green-100 text-green-700",
    Whitepaper: "bg-blue-100 text-blue-700",
    Template: "bg-orange-100 text-orange-700",
    "One-Pager": "bg-purple-100 text-purple-700",
  }[type] || "bg-gray-100 text-gray-600");
  const getCardPreview = (item) => {
    if (item.type === "Proposal") return item.description || "";
    const div = document.createElement("div");
    div.innerHTML = item.content || "";
    const text = div.textContent?.slice(0, 120) || "";
    return text ? `${text}${div.textContent.length > 120 ? "..." : ""}` : "";
  };
  const getRelativeDate = (dateStr) => {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return "";
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Updated just now";
    if (diffMins < 60) return `Updated ${diffMins}m ago`;
    if (diffHours < 24) return `Updated ${diffHours}h ago`;
    if (diffDays === 1) return "Updated yesterday";
    if (diffDays < 30) return `Updated ${diffDays} days ago`;
    if (diffDays < 365) return `Updated ${Math.floor(diffDays / 30)} months ago`;
    return `Updated ${Math.floor(diffDays / 365)} years ago`;
  };
  const getUpdatedDateValue = (item) => (
    item.updatedAt || item.updated_at || item.updated || item.createdAt || item.created_at || ""
  );
  const getUpdatedLabel = (item) => getRelativeDate(getUpdatedDateValue(item)) || (item.date ? `Updated ${item.date}` : "");
  const toggleProposalTag = (tag) => {
    setProposalForm((current) => {
      const currentTags = normalizeTags(current.tags);
      const exists = currentTags.some((item) => item.toLowerCase() === tag.toLowerCase());
      if (!exists && currentTags.length >= maxProposalTags) {
        setToast({ type: "warning", message: createT.tagLimit });
        return current;
      }
      return {
        ...current,
        tags: exists ? currentTags.filter((item) => item.toLowerCase() !== tag.toLowerCase()) : [...currentTags, tag],
      };
    });
  };
  const addCustomProposalTag = () => {
    const tag = customProposalTag.trim();
    if (!tag) return;
    setProposalForm((current) => {
      const currentTags = normalizeTags(current.tags);
      const exists = currentTags.some((item) => item.toLowerCase() === tag.toLowerCase());
      if (!exists && currentTags.length >= maxProposalTags) {
        setToast({ type: "warning", message: createT.tagLimit });
        return current;
      }
      return { ...current, tags: exists ? currentTags : [...currentTags, tag] };
    });
    setCustomProposalTag("");
  };
  const removeProposalTag = (tag) => {
    setProposalForm((current) => ({
      ...current,
      tags: normalizeTags(current.tags).filter((item) => item.toLowerCase() !== tag.toLowerCase()),
    }));
  };
  const goToProposalStep = (step) => {
    if (step > 1 && !proposalForm.customer.trim()) {
      setToast(createT.customerRequired);
      return;
    }
    if (step > 1 && !proposalForm.name.trim()) {
      setToast(createT.titleRequired);
      return;
    }
    setWizardStep(step);
  };
  const updatePricingRow = (id, field, value) => setPricingRows((current) => current.map((row) => row.id === id ? { ...row, [field]: value } : row));
  const addPricingRow = () => setPricingRows((current) => [...current, { id: Date.now(), service: "", description: "", quantity: 1, unitPrice: 0 }]);
  const removePricingRow = (id) => setPricingRows((current) => current.filter((row) => row.id !== id));
  const openProposalHtmlEditor = (proposal) => {
    editorSessionRef.current += 1;
    setViewingProposal(proposal);
    setEditingProposal({
      ...proposal,
      draftTitle: proposal.title || "",
      draftContent: proposalDocumentToHtml(proposal),
      editSession: editorSessionRef.current,
    });
  };
  const openStructuredProposalEditor = (proposal) => {
    const structured = proposal.structuredContent || proposal.structured_content || {};
    const sourceRows = proposal.pricingRows || proposal.pricing_rows || proposal.lineItems || structured.lineItems || structured.line_items || [];
    resetCreateContentForm();
    setStructuredEditingProposalId(proposal.id);
    setCreateType("Proposal");
    setProposalForm({
      name: proposal.title || structured.title || "",
      customer: proposal.customerName || proposal.clientName || proposal.client_name || structured.client || structured.customer || "",
      customerEmail: proposal.clientEmail || "",
      customerCompany: proposal.clientCompany || "",
      template: proposal.template || "NoonDalton Standard Proposal",
      date: proposal.date || new Date().toISOString().slice(0, 10),
      tags: normalizeTags(proposal.tags || structured.tags || []),
      tax: proposal.tax || 0,
      discount: proposal.discount || 0,
    });
    setContentDescription(proposal.proposalDescription || proposal.proposal_description || proposal.description || "");
    setDetailedDescription(proposal.detailedDescription || proposal.detailed_description || "");
    setTeamSizing(proposal.teamSizing || proposal.team_sizing || "");
    setProposalLength(proposal.length || "standard");
    setProposalLanguage(platformGenerationLanguage);
    setProposalLanguageManuallySelected(false);
    setProposalCustomPrompt(proposal.customPrompt || proposal.custom_prompt || "");
    setPricingRows(sourceRows.map((row, index) => ({
      id: row.id || `${proposal.id}-${index}`,
      service: row.service || row.name || "",
      description: row.description || "",
      quantity: row.quantity ?? row.qty ?? 1,
      unitPrice: row.unitPrice ?? row.unit_price ?? 0,
    })));
    setWizardStep(1);
    setViewingProposal(null);
    setEditingProposal(null);
    setShowCreateModal(true);
  };
  const detectProposalDomain = (context) => {
    const value = context.toLowerCase();
    if (/hospital|clinic|patient|medical|appointment|triage|clinical|healthcare|waiting list|waitlist|lista de espera|paciente|salud|medic/.test(value)) return "hospital";
    if (/restaurant|reservation|order|kitchen|menu|dining|food|chef|mesa|pedido|cocina|reserva/.test(value)) return "restaurant";
    if (/finance|financial|bank|audit|compliance|invoice|accounting|back office|data processing|financ|contab|auditor/.test(value)) return "finance";
    if (/marketing|lead|campaign|crm|outreach|email|conversion|content|sales enablement/.test(value)) return "marketing";
    return "general";
  };
  const buildContextualProposalStructure = (title = proposalForm.name) => {
    const description = contentDescription.trim();
    const customer = proposalForm.customer.trim();
    const tags = proposalTags.join(", ");
    const context = [description, customer, tags, title, proposalForm.template].filter(Boolean).join(" ");
    const domain = detectProposalDomain(context);
    const language = platformGenerationLanguage;
    const domainCopy = {
      en: {
        hospital: {
          industry: "Healthcare operations",
          problemFocus: ["patient waiting lists", "specialty appointment access", "patient prioritization", "scheduling coordination", "clinical operations visibility"],
          technologies: ["Waiting list automation", "Patient prioritization rules", "Appointment scheduling workflow", "Clinical operations dashboard", "Patient communication automation"],
          solution: "The proposed AI solution uses the proposal description as the operating brief: automate waiting list intake, classify patient priority, coordinate specialty appointment scheduling, and surface operational bottlenecks for clinical teams.",
          roi: "Expected impact includes shorter waiting times, better appointment utilization, clearer patient prioritization, fewer manual coordination tasks, and improved visibility across clinical operations.",
          nextSteps: ["Validate patient waiting list data sources and scheduling rules.", "Define triage and prioritization criteria with clinical stakeholders.", "Pilot the automated workflow for one specialty appointment queue."],
        },
        restaurant: {
          industry: "Restaurant operations",
          problemFocus: ["reservation flow", "order handling", "kitchen coordination", "customer experience", "service timing"],
          technologies: ["Reservation automation", "Order workflow orchestration", "Kitchen operations dashboard", "Customer communication automation", "Service performance analytics"],
          solution: "The proposed AI solution automates the restaurant workflow described in the proposal: coordinate reservations, orders, kitchen operations, and customer communication so staff can respond faster with better service visibility.",
          roi: "Expected impact includes faster table and order handling, fewer service bottlenecks, better kitchen coordination, and a more consistent customer experience.",
          nextSteps: ["Confirm reservation, order, and kitchen workflow data sources.", "Map peak service bottlenecks and customer communication points.", "Pilot automation on the highest-volume service workflow."],
        },
        finance: {
          industry: "Finance operations",
          problemFocus: ["back-office processing", "data quality", "compliance controls", "audit visibility", "operational reporting"],
          technologies: ["Back-office workflow automation", "Data processing controls", "Compliance rule checks", "Audit visibility dashboard", "Exception management"],
          solution: "The proposed AI solution automates the finance workflow described in the proposal: structure back-office processing, improve data quality, flag exceptions, and increase compliance and audit visibility.",
          roi: "Expected impact includes faster processing cycles, fewer manual errors, stronger compliance evidence, and clearer audit trails for operational teams.",
          nextSteps: ["Confirm source systems, control requirements, and audit evidence needs.", "Define exception rules and approval workflows.", "Pilot automation on one high-volume finance process."],
        },
        marketing: {
          industry: "Marketing automation",
          problemFocus: ["lead generation", "campaign automation", "CRM workflow", "outreach personalization", "conversion optimization"],
          technologies: ["Lead generation workflow", "Campaign automation", "CRM integration", "Outreach personalization", "Conversion analytics"],
          solution: "The proposed AI solution automates the marketing workflow described in the proposal: connect lead generation, campaign execution, CRM updates, personalized outreach, and conversion reporting.",
          roi: "Expected impact includes higher campaign throughput, faster lead follow-up, cleaner CRM activity, improved personalization, and clearer conversion measurement.",
          nextSteps: ["Confirm lead sources, CRM fields, and campaign rules.", "Define personalization and outreach approval criteria.", "Pilot automation on one priority campaign or segment."],
        },
        general: {
          industry: proposalTags[0] || "",
          problemFocus: ["the business problem described by the client", "desired operating outcomes", "manual coordination points", "data visibility gaps", "workflow accountability"],
          technologies: ["Workflow automation", "Context-aware AI assistance", "Operational dashboard", "Exception tracking", "Performance analytics"],
          solution: "The proposed AI solution is based on the proposal description: translate the client's challenge, goals, and desired outcomes into a focused automation workflow with clear operating controls.",
          roi: "Expected impact will be measured against the business problem described by the client, including cycle time, quality, visibility, and team workload.",
          nextSteps: ["Confirm the described business problem and target outcome.", "Map current workflow inputs, handoffs, and decision points.", "Pilot the focused automation workflow with measurable success criteria."],
        },
      },
      es: {
        hospital: {
          industry: "Operaciones clínicas",
          problemFocus: ["listas de espera de pacientes", "acceso a citas de especialidad", "priorización de pacientes", "coordinación de agenda médica", "visibilidad de operaciones clínicas"],
          technologies: ["Automatización de listas de espera", "Reglas de priorización de pacientes", "Flujo de programación de citas", "Panel de operaciones clínicas", "Automatización de comunicación con pacientes"],
          solution: "La solución de IA propuesta utiliza la descripción como brief operativo: automatizar el ingreso de listas de espera, clasificar prioridad de pacientes, coordinar citas de especialidad y visibilizar cuellos de botella para los equipos clínicos.",
          roi: "El impacto esperado incluye menor tiempo de espera, mejor utilización de agendas médicas, priorización más clara de pacientes, menos coordinación manual y mayor visibilidad de las operaciones clínicas.",
          nextSteps: ["Validar fuentes de datos de listas de espera y reglas de agenda médica.", "Definir criterios de triage y priorización con los equipos clínicos.", "Pilotear el flujo automatizado en una cola de citas de especialidad."],
        },
        restaurant: {
          industry: "Operaciones de restaurante",
          problemFocus: ["reservas", "gestión de pedidos", "coordinación de cocina", "experiencia del cliente", "tiempos de servicio"],
          technologies: ["Automatización de reservas", "Orquestación de pedidos", "Panel de operaciones de cocina", "Automatización de comunicación con clientes", "Analítica de desempeño del servicio"],
          solution: "La solución de IA propuesta automatiza el flujo descrito para coordinar reservas, pedidos, cocina y comunicación con clientes, permitiendo responder más rápido y con mejor visibilidad del servicio.",
          roi: "El impacto esperado incluye mayor velocidad en reservas y pedidos, menos cuellos de botella en servicio, mejor coordinación de cocina y una experiencia de cliente más consistente.",
          nextSteps: ["Confirmar fuentes de datos de reservas, pedidos y cocina.", "Mapear cuellos de botella en horarios punta y puntos de comunicación con clientes.", "Pilotear la automatización en el flujo de mayor volumen."],
        },
        finance: {
          industry: "Operaciones financieras",
          problemFocus: ["procesamiento back office", "calidad de datos", "controles de cumplimiento", "visibilidad de auditoría", "reportería operativa"],
          technologies: ["Automatización de back office", "Controles de procesamiento de datos", "Validaciones de cumplimiento", "Panel de visibilidad de auditoría", "Gestión de excepciones"],
          solution: "La solución de IA propuesta automatiza el flujo financiero descrito: estructurar procesamiento back office, mejorar calidad de datos, detectar excepciones y aumentar visibilidad de cumplimiento y auditoría.",
          roi: "El impacto esperado incluye ciclos de procesamiento más rápidos, menos errores manuales, evidencia de cumplimiento más sólida y trazabilidad clara para auditoría.",
          nextSteps: ["Confirmar sistemas fuente, requisitos de control y evidencia de auditoría.", "Definir reglas de excepción y flujos de aprobación.", "Pilotear la automatización en un proceso financiero de alto volumen."],
        },
        marketing: {
          industry: "Automatización de marketing",
          problemFocus: ["generación de leads", "automatización de campañas", "flujo CRM", "personalización de outreach", "optimización de conversión"],
          technologies: ["Flujo de generación de leads", "Automatización de campañas", "Integración CRM", "Personalización de outreach", "Analítica de conversión"],
          solution: "La solución de IA propuesta automatiza el flujo de marketing descrito: conectar generación de leads, ejecución de campañas, actualizaciones CRM, outreach personalizado y reportes de conversión.",
          roi: "El impacto esperado incluye mayor volumen de campañas, seguimiento más rápido de leads, actividad CRM más limpia, mejor personalización y medición más clara de conversión.",
          nextSteps: ["Confirmar fuentes de leads, campos CRM y reglas de campaña.", "Definir criterios de personalización y aprobación de outreach.", "Pilotear la automatización en una campaña o segmento prioritario."],
        },
        general: {
          industry: proposalTags[0] || "",
          problemFocus: ["el problema de negocio descrito por el cliente", "resultados operativos deseados", "puntos de coordinación manual", "brechas de visibilidad de datos", "responsabilidad del flujo de trabajo"],
          technologies: ["Automatización de flujos", "Asistencia de IA contextual", "Panel operativo", "Seguimiento de excepciones", "Analítica de desempeño"],
          solution: "La solución de IA propuesta se basa en la descripción: traducir el desafío, objetivos y resultado deseado del cliente en un flujo de automatización enfocado con controles operativos claros.",
          roi: "El impacto esperado se medirá contra el problema de negocio descrito, incluyendo tiempo de ciclo, calidad, visibilidad y carga operativa del equipo.",
          nextSteps: ["Confirmar el problema de negocio y resultado objetivo.", "Mapear entradas, traspasos y puntos de decisión del flujo actual.", "Pilotear el flujo automatizado con criterios de éxito medibles."],
        },
      },
      pt: {
        hospital: {
          industry: "Operações clínicas",
          problemFocus: ["listas de espera de pacientes", "acesso a consultas especializadas", "priorização de pacientes", "coordenação de agendamento", "visibilidade das operações clínicas"],
          technologies: ["Automação de listas de espera", "Regras de priorização de pacientes", "Fluxo de agendamento de consultas", "Painel de operações clínicas", "Automação de comunicação com pacientes"],
          solution: "A solução de IA proposta usa a descrição como brief operacional: automatizar a entrada de listas de espera, classificar prioridade de pacientes, coordenar consultas especializadas e expor gargalos para equipes clínicas.",
          roi: "O impacto esperado inclui menor tempo de espera, melhor utilização de agendas, priorização mais clara de pacientes, menos coordenação manual e maior visibilidade das operações clínicas.",
          nextSteps: ["Validar fontes de dados de listas de espera e regras de agendamento.", "Definir critérios de triagem e priorização com as equipes clínicas.", "Pilotar o fluxo automatizado em uma fila de consultas especializadas."],
        },
        restaurant: {
          industry: "Operações de restaurante",
          problemFocus: ["reservas", "gestão de pedidos", "coordenação de cozinha", "experiência do cliente", "tempo de serviço"],
          technologies: ["Automação de reservas", "Orquestração de pedidos", "Painel de operações de cozinha", "Automação de comunicação com clientes", "Análise de desempenho do serviço"],
          solution: "A solução de IA proposta automatiza o fluxo descrito para coordenar reservas, pedidos, cozinha e comunicação com clientes, permitindo respostas mais rápidas e melhor visibilidade do serviço.",
          roi: "O impacto esperado inclui maior velocidade em reservas e pedidos, menos gargalos no serviço, melhor coordenação da cozinha e experiência do cliente mais consistente.",
          nextSteps: ["Confirmar fontes de dados de reservas, pedidos e cozinha.", "Mapear gargalos em horários de pico e pontos de comunicação com clientes.", "Pilotar a automação no fluxo de maior volume."],
        },
        finance: {
          industry: "Operações financeiras",
          problemFocus: ["processamento back office", "qualidade dos dados", "controles de conformidade", "visibilidade de auditoria", "relatórios operacionais"],
          technologies: ["Automação de back office", "Controles de processamento de dados", "Validações de conformidade", "Painel de visibilidade de auditoria", "Gestão de exceções"],
          solution: "A solução de IA proposta automatiza o fluxo financeiro descrito: estruturar processamento back office, melhorar qualidade dos dados, sinalizar exceções e ampliar visibilidade de conformidade e auditoria.",
          roi: "O impacto esperado inclui ciclos de processamento mais rápidos, menos erros manuais, evidências de conformidade mais fortes e trilhas de auditoria claras.",
          nextSteps: ["Confirmar sistemas fonte, requisitos de controle e evidências de auditoria.", "Definir regras de exceção e fluxos de aprovação.", "Pilotar a automação em um processo financeiro de alto volume."],
        },
        marketing: {
          industry: "Automação de marketing",
          problemFocus: ["geração de leads", "automação de campanhas", "fluxo CRM", "personalização de outreach", "otimização de conversão"],
          technologies: ["Fluxo de geração de leads", "Automação de campanhas", "Integração CRM", "Personalização de outreach", "Análise de conversão"],
          solution: "A solução de IA proposta automatiza o fluxo de marketing descrito: conectar geração de leads, execução de campanhas, atualizações CRM, outreach personalizado e relatórios de conversão.",
          roi: "O impacto esperado inclui maior volume de campanhas, acompanhamento mais rápido de leads, atividade CRM mais limpa, melhor personalização e medição de conversão mais clara.",
          nextSteps: ["Confirmar fontes de leads, campos CRM e regras de campanha.", "Definir critérios de personalização e aprovação de outreach.", "Pilotar a automação em uma campanha ou segmento prioritário."],
        },
        general: {
          industry: proposalTags[0] || "",
          problemFocus: ["o problema de negócio descrito pelo cliente", "resultados operacionais desejados", "pontos de coordenação manual", "lacunas de visibilidade de dados", "responsabilidade do fluxo de trabalho"],
          technologies: ["Automação de fluxos", "Assistência de IA contextual", "Painel operacional", "Rastreamento de exceções", "Análise de desempenho"],
          solution: "A solução de IA proposta se baseia na descrição: traduzir o desafio, objetivos e resultado desejado do cliente em um fluxo de automação focado com controles operacionais claros.",
          roi: "O impacto esperado será medido contra o problema de negócio descrito, incluindo tempo de ciclo, qualidade, visibilidade e carga operacional da equipe.",
          nextSteps: ["Confirmar o problema de negócio e resultado alvo.", "Mapear entradas, passagens e pontos de decisão do fluxo atual.", "Pilotar o fluxo automatizado com critérios de sucesso mensuráveis."],
        },
      },
    }[language]?.[domain] || domainCopy?.en?.[domain];
    return {
      title,
      client: customer,
      contact: "",
      language,
      stage: "Draft",
      score: null,
      totalAmount: pricingTotal,
      industry: domainCopy.industry,
      serviceLine: proposalForm.template,
      executiveSummary: description,
      problemsIdentified: [
        language === "es" ? `Desafío actual: ${description}` : language === "pt" ? `Desafio atual: ${description}` : `Current challenge: ${description}`,
        language === "es"
          ? `${customer || "El cliente"} necesita un flujo operativo enfocado en ${domainCopy.problemFocus.slice(0, 3).join(", ")}.`
          : language === "pt"
          ? `${customer || "O cliente"} precisa de um fluxo operacional focado em ${domainCopy.problemFocus.slice(0, 3).join(", ")}.`
          : `${customer || "The client"} needs a focused operating workflow for ${domainCopy.problemFocus.slice(0, 3).join(", ")}.`,
        language === "es"
          ? `Los equipos necesitan mayor visibilidad, priorización y responsabilidad sobre ${domainCopy.problemFocus.slice(-2).join(" y ")}.`
          : language === "pt"
          ? `As equipes precisam de maior visibilidade, priorização e responsabilidade sobre ${domainCopy.problemFocus.slice(-2).join(" e ")}.`
          : `Teams need clearer visibility, prioritization, and accountability around ${domainCopy.problemFocus.slice(-2).join(" and ")}.`,
      ],
      proposedSolution: domainCopy.solution,
      technologiesUsed: domainCopy.technologies,
      lineItems: pricingRows.map(normalizeLineItem),
      expectedROI: domainCopy.roi,
      nextSteps: domainCopy.nextSteps,
    };
  };
  const buildProposalStructure = (title = proposalForm.name) => buildContextualProposalStructure(title);

  const buildProposalPersistencePayload = (title = proposalForm.name) => ({
    title,
    description: contentDescription,
    proposal_description: contentDescription,
    detailed_description: detailedDescription,
    team_sizing: teamSizing,
    length: proposalLength,
    language: platformGenerationLanguage,
    custom_prompt: proposalCustomPrompt,
    customer_name: proposalForm.customer,
    clientName: proposalForm.customer,
    clientEmail: proposalForm.customerEmail || undefined,
    clientCompany: proposalForm.customerCompany || undefined,
    template: proposalForm.template,
    tags: proposalTags,
    pricing_rows: pricingRows,
    lineItems: pricingRows.map(normalizeLineItem),
    total_amount: pricingTotal,
    structured_content: buildProposalStructure(title),
  });
  const saveCreateContentDraft = async () => {
    if (createType === "Proposal") {
      if (structuredEditingProposalId) {
        try {
          await updateProposal(structuredEditingProposalId, buildProposalPersistencePayload());
          setProposals((current) => current.map((proposal) => proposal.id === structuredEditingProposalId
            ? { ...proposal, ...buildProposalPersistencePayload(), customerName: proposalForm.customer, pricingRows, lineItems: pricingRows.map(normalizeLineItem), customPrompt: proposalCustomPrompt }
            : proposal));
          closeCreateContentModal();
          setToast(createT.draftSaved);
        } catch (error) {
          console.error(error);
          setToast(createT.draftCreationFailed);
        }
        return;
      }
      const draft = {
        id: `manual-proposal-${Date.now()}`,
        title: proposalForm.name || contentTitle || "Proposal Draft",
        type: "Proposal",
        status: "draft",
        description: contentDescription,
        proposalDescription: contentDescription,
        detailedDescription,
        teamSizing,
        length: proposalLength,
        contentSource: proposalContentSource,
        customerName: proposalForm.customer,
        template: proposalForm.template,
        tags: proposalTags,
        pricingRows,
        lineItems: pricingRows.map(normalizeLineItem),
        totalAmount: pricingTotal,
        language: platformGenerationLanguage,
        customPrompt: proposalCustomPrompt,
        date: proposalForm.date,
        content: "",
        updated: "Today",
      };
      saveLocalContentProposal(draft);
      setProposals((current) => [...current, draft]);
    }
    closeCreateContentModal();
    setToast(createT.draftSaved);
  };
  const buildAiContentPayload = () => {
    const language = platformGenerationLanguage;
    if (createType === "Case Study") {
      return {
        client_name: contentAiForm.client_name,
        industry: contentAiForm.industry,
        region: contentAiForm.region,
        duration_months: Number(contentAiForm.duration_months) || 1,
        challenge: contentAiForm.challenge,
        solution: contentAiForm.solution,
        metric_1_label: contentAiForm.metric_1_label,
        metric_1_value: contentAiForm.metric_1_value,
        metric_2_label: contentAiForm.metric_2_label,
        metric_2_value: contentAiForm.metric_2_value,
        metric_3_label: contentAiForm.metric_3_label,
        metric_3_value: contentAiForm.metric_3_value,
        testimonial_quote: contentAiForm.testimonial_quote,
        testimonial_name: contentAiForm.testimonial_name,
        testimonial_role: contentAiForm.testimonial_role,
        language,
      };
    }
    if (createType === "Whitepaper") {
      return {
        title: contentAiForm.title,
        subtitle: contentAiForm.subtitle,
        topic: contentAiForm.topic,
        target_audience: contentAiForm.target_audience,
        key_sections: splitListInput(contentAiForm.key_sections),
        abstract: contentAiForm.abstract,
        language,
      };
    }
    if (createType === "Template") {
      return {
        template_name: contentAiForm.template_name,
        channel: contentAiForm.channel,
        category: contentAiForm.category,
        tone: contentAiForm.tone,
        use_case: contentAiForm.use_case,
        merge_variables: splitListInput(contentAiForm.merge_variables),
        language,
      };
    }
    if (createType === "Social Post") {
      return {
        platform: contentAiForm.platform,
        topic: contentAiForm.topic,
        tone: contentAiForm.tone,
        target_audience: contentAiForm.target_audience,
        cta_text: contentAiForm.cta_text,
        key_points: splitListInput(contentAiForm.key_points),
        language,
      };
    }
    return {
      product_name: contentAiForm.product_name,
      tagline: contentAiForm.tagline,
      target_audience: contentAiForm.target_audience,
      features: splitListInput(contentAiForm.features),
      metric_1_label: contentAiForm.metric_1_label,
      metric_1_value: contentAiForm.metric_1_value,
      metric_2_label: contentAiForm.metric_2_label,
      metric_2_value: contentAiForm.metric_2_value,
      metric_3_label: contentAiForm.metric_3_label,
      metric_3_value: contentAiForm.metric_3_value,
      cta_text: contentAiForm.cta_text,
      cta_url: contentAiForm.cta_url,
      language,
    };
  };
  const generateAiContent = async () => {
    if (createType === "One-Pager") {
      const featuresCount = splitListInput(contentAiForm.features).length;
      if (featuresCount < 3 || featuresCount > 4) {
        setToast({ type: "error", message: t("contentLibrary.aiFields.featuresCountError") });
        return;
      }
    }
    setContentAiStep(2);
    setContentGenerating(true);
    try {
      const response = await api.post(`/content/generate/${contentTypeEndpoint[createType]}`, buildAiContentPayload(), { timeout: 0 });
      setGeneratedContentItem(normalizeGeneratedContentItem(response.data));
      setContentAiStep(3);
    } catch (error) {
      console.error(error);
      setContentAiStep(1);
      const detail = error.response?.data?.detail;
      const message = typeof detail === "string" ? detail : t("contentLibrary.aiFields.generationFailed");
      setToast({ type: "error", message });
    } finally {
      setContentGenerating(false);
    }
  };
  const saveGeneratedContentToLibrary = () => {
    if (!generatedContentItem) return;
    // The backend already persisted this item to Firestore when it was
    // generated (POST /content/generate/{type} calls _persist_content_item
    // internally) — this just reflects it into the local grid immediately
    // instead of waiting for the next /content-library refetch.
    setLibraryItems((current) => [{ ...generatedContentItem, source: "contentItems" }, ...current]);
    closeCreateContentModal();
    setToast(t("contentLibrary.aiFields.savedToLibrary"));
  };
  const exportGeneratedContentPdf = async () => {
    if (!generatedContentItem?.content) return;
    if (canUseBackendContentPdf(generatedContentItem)) {
      try {
        await downloadBackendContentPdf(generatedContentItem);
        return;
      } catch (error) {
        console.error(error);
      }
    }
    const wrapper = document.createElement("div");
    wrapper.className = "generated-content-preview p-6 bg-white text-slate-800";
    wrapper.innerHTML = generatedContentItem.content;
    document.body.appendChild(wrapper);
    try {
      await html2pdf().set({
        margin: 0.5,
        filename: `${sanitizeDownloadName(generatedContentItem.title || "content")}.pdf`,
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "in", format: "letter", orientation: "portrait" },
      }).from(wrapper).save();
    } finally {
      document.body.removeChild(wrapper);
    }
  };
  const exportContentItemPdf = async (item) => {
    if (!item?.content) return;
    if (canUseBackendContentPdf(item)) {
      try {
        await downloadBackendContentPdf(item);
        return;
      } catch (error) {
        console.error(error);
      }
    }
    const wrapper = document.createElement("div");
    wrapper.className = "content-preview-document p-6 bg-white text-slate-800";
    wrapper.innerHTML = item.content;
    document.body.appendChild(wrapper);
    try {
      await html2pdf().set({
        margin: 0.5,
        filename: `${sanitizeDownloadName(item.title || "content")}.pdf`,
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "in", format: "letter", orientation: "portrait" },
      }).from(wrapper).save();
    } finally {
      document.body.removeChild(wrapper);
    }
  };

  const upsertGeneratedProposal = (proposal) => {
    setProposals((current) => {
      const exists = current.some((item) => item.id === proposal.id);
      return exists
        ? current.map((item) => item.id === proposal.id ? proposal : item)
        : [...current, proposal];
    });
  };
  const buildProposalGenerationPayload = (title) => ({
    title,
    description: contentDescription,
    proposalDescription: contentDescription,
    proposal_description: contentDescription,
    detailedDescription,
    teamSizing,
    length: proposalLength,
    contextPriority: ["proposalDescription", "customer", "tags", "title", "template"],
    clientName: proposalForm.customer,
    customer: proposalForm.customer,
    template: proposalForm.template,
    tags: proposalTags,
    lineItems: pricingRows.map(normalizeLineItem),
    totalAmount: pricingTotal,
    language: platformGenerationLanguage,
    customPrompt: proposalCustomPrompt,
    model: getStoredPreference(PREF_KEYS.model, "deepseek"),
  });
  const advanceProposalProgressToPreview = async () => {
    const preparingPreviewIndex = proposalSteps.length - 2;
    for (let index = 0; index < preparingPreviewIndex; index += 1) {
      setGenerationModal((current) => ({
        ...current,
        activeStep: index,
        progress: Math.round((index / preparingPreviewIndex) * 82) + 5,
      }));
      await wait(650);
      setGenerationModal((current) => ({
        ...current,
        completedSteps: [...new Set([...(current?.completedSteps || []), index])],
        progress: Math.round(((index + 1) / preparingPreviewIndex) * 85),
      }));
    }
    setGenerationModal((current) => ({
      ...current,
      activeStep: preparingPreviewIndex,
      progress: 90,
    }));
  };
  const completeProposalGeneration = async (generatedProposal, title, contextualStructure = {}) => {
    const safeGeneratedProposal = generatedProposal || {};
    const safeContextualStructure = contextualStructure || {};
    const generatedLineItems = safeGeneratedProposal.pricingRows
      || safeGeneratedProposal.pricing_rows
      || safeGeneratedProposal.lineItems
      || pricingRows;
    const proposalTotal = calculateProposalTotal({
      ...safeGeneratedProposal,
      pricingRows: generatedLineItems,
      lineItems: generatedLineItems,
      tax: safeGeneratedProposal.tax ?? proposalForm.tax,
      discount: safeGeneratedProposal.discount ?? proposalForm.discount,
    });
    const generatedStructure = normalizeProposalDocument({
      ...safeGeneratedProposal,
      structuredContent: {},
      pricingRows: generatedLineItems,
      lineItems: generatedLineItems,
      totalAmount: proposalTotal.totalAmount ?? pricingTotal,
      language: safeGeneratedProposal.language || platformGenerationLanguage,
    });
    const structuredContent = {
      ...safeContextualStructure,
      ...generatedStructure,
      title: generatedStructure.title || safeContextualStructure.title || safeGeneratedProposal.title || title,
      client: generatedStructure.client || safeContextualStructure.client || proposalForm.customer,
      contact: cleanStructuredText(generatedStructure.contact) || cleanStructuredText(safeContextualStructure.contact),
      industry: cleanStructuredText(generatedStructure.industry) || cleanStructuredText(safeContextualStructure.industry),
      serviceLine: cleanStructuredText(generatedStructure.serviceLine) || cleanStructuredText(safeContextualStructure.serviceLine) || proposalForm.template,
      lineItems: generatedStructure.lineItems?.length ? generatedStructure.lineItems : pricingRows.map(normalizeLineItem),
      totalAmount: proposalTotal.totalAmount ?? pricingTotal,
      language: safeGeneratedProposal.language || platformGenerationLanguage,
      length: proposalLength,
    };
    const professionalContent = proposalDocumentToHtml({
      ...safeGeneratedProposal,
      description: contentDescription,
      structuredContent,
      pricingRows: structuredContent.lineItems,
      lineItems: structuredContent.lineItems,
      totalAmount: structuredContent.totalAmount,
      language: structuredContent.language,
    });
    const normalizedProposal = {
      ...safeGeneratedProposal,
      title: safeGeneratedProposal.title || title,
      description: contentDescription,
      proposalDescription: contentDescription,
      detailedDescription,
      teamSizing,
      length: proposalLength,
      language: platformGenerationLanguage,
      customPrompt: proposalCustomPrompt,
      structuredContent,
      ...structuredContent,
      content: professionalContent,
      customerName: safeGeneratedProposal.customerName || proposalForm.customer,
      date: safeGeneratedProposal.date || proposalForm.date,
      template: safeGeneratedProposal.template || proposalForm.template,
      tags: normalizeTags(safeGeneratedProposal.tags || proposalTags),
      pricingRows: structuredContent.lineItems,
      lineItems: structuredContent.lineItems,
      totalAmount: proposalTotal.totalAmount ?? pricingTotal,
      status: safeGeneratedProposal.status || "generated",
    };
    const completedSteps = proposalSteps.map((_, index) => index);
    setGenerationModal((current) => ({
      ...current,
      activeStep: proposalSteps.length - 1,
      completedSteps,
      progress: 100,
      error: null,
    }));
    setDraftHtml(normalizedProposal.content);
    upsertGeneratedProposal(normalizedProposal);
    await wait(250);
    setGenerationModal(null);
    closeCreateContentModal();
    setViewingProposal(normalizedProposal);
    setToast(structuredEditingProposalId ? createT.proposalRegenerated : createT.proposalGenerated);
  };

  const runProposalGeneration = async () => {
    const title = proposalForm.name || contentTitle || "AI Generated Proposal";
    if (!proposalForm.customer.trim()) {
      setToast(createT.customerRequired);
      setWizardStep(1);
      return;
    }
    if (!proposalForm.name.trim()) {
      setToast(createT.titleRequired);
      setWizardStep(1);
      return;
    }
    const contextualStructure = buildProposalStructure(title);
    const generationPayload = buildProposalGenerationPayload(title);
    setGenerationModal({
      title,
      activeStep: 0,
      completedSteps: [],
      progress: 5,
      cancelled: false,
    });

    let draftProposal = null;
    try {
      if (structuredEditingProposalId) {
        draftProposal = { id: structuredEditingProposalId };
        setGenerationModal((current) => ({ ...current, draftId: structuredEditingProposalId }));
        await updateProposal(structuredEditingProposalId, buildProposalPersistencePayload(title));
        await advanceProposalProgressToPreview();
        const generatedProposal = await generateProposalById(structuredEditingProposalId, generationPayload);
        await completeProposalGeneration(generatedProposal, title, contextualStructure);
        return;
      }
      draftProposal = await createProposal({
        title,
        description: contentDescription,
        proposal_description: contentDescription,
        detailed_description: detailedDescription,
        team_sizing: teamSizing,
        length: proposalLength,
        language: platformGenerationLanguage,
        custom_prompt: proposalCustomPrompt,
        status: "draft",
        customer_name: proposalForm.customer,
        clientName: proposalForm.customer,
        clientEmail: proposalForm.customerEmail || undefined,
        clientCompany: proposalForm.customerCompany || undefined,
        template: proposalForm.template,
        tags: proposalTags,
        pricing_rows: pricingRows,
        total_amount: pricingTotal,
        structured_content: contextualStructure,
      });
      upsertGeneratedProposal(draftProposal);
      setGenerationModal((current) => ({ ...current, draftId: draftProposal.id }));
      await advanceProposalProgressToPreview();
      const generatedProposal = await generateProposalById(draftProposal.id, generationPayload);
      await completeProposalGeneration(generatedProposal, title, contextualStructure);
    } catch (error) {
      console.error(error);
      setGenerationModal((current) => ({
        ...current,
        error: draftProposal ? createT.generationFailedDraftSaved : createT.draftCreationFailed,
        draftId: draftProposal?.id || current?.draftId,
      }));
    }
  };

  const retryProposalGeneration = async () => {
    const draftId = generationModal?.draftId;
    if (!draftId) {
      runProposalGeneration();
      return;
    }
    const title = generationModal.title || proposalForm.name || "AI Generated Proposal";
    const contextualStructure = buildProposalStructure(title);
    const preparingPreviewIndex = proposalSteps.length - 2;
    setGenerationModal((current) => ({
      ...current,
      error: null,
      activeStep: preparingPreviewIndex,
      completedSteps: proposalSteps.slice(0, preparingPreviewIndex).map((_, index) => index),
      progress: 90,
    }));
    try {
      const generatedProposal = await generateProposalById(draftId, buildProposalGenerationPayload(title));
      await completeProposalGeneration(generatedProposal, title, contextualStructure);
    } catch (error) {
      console.error(error);
      setGenerationModal((current) => ({
        ...current,
        error: createT.generationFailedDraftSaved,
        activeStep: preparingPreviewIndex,
        progress: 90,
      }));
    }
  };

  useEffect(() => {
    const syncLanguage = () => setContentLanguage(getStoredPreference(PREF_KEYS.language, "en"));
    syncLanguage();
    window.addEventListener("marketgen:prefs", syncLanguage);
    window.addEventListener("storage", syncLanguage);
    return () => {
      window.removeEventListener("marketgen:prefs", syncLanguage);
      window.removeEventListener("storage", syncLanguage);
    };
  }, []);

  useEffect(() => {
  async function loadProposals() {
    setLoadingLibrary(true);
    try {
      const library = await api.get("/content-library").then((r) => r.data).catch(() => null);
      const data = library?.proposals || await getProposals();
      const localProposals = readLocalContentProposals();
      const templates = (library?.templates || []).map((template) => ({
        id: template.id,
        title: template.name || "Template",
        type: template.type || "Template",
        status: template.isPublic ? "Public" : "Private",
        description: template.description || "",
        industry: template.content || template.description || "Template",
        content: template.content || "",
        rawContent: template.content || "",
        language: template.language || activeLanguage || contentLanguage,
        source: template.source,
        inputData: template.inputData || template.input_data || {},
        services: template.variables || [],
        uses: template.usageCount || 0,
        date: template.updatedAt || template.createdAt || "Today",
        updatedAt: template.updatedAt,
        createdAt: template.createdAt,
      }));
      const assets = (library?.assets || []).map((asset) => {
        let preview = asset.content || "";
        const campaignPosts = asset.type === "campaign_content"
          ? normalizeCampaignContent(asset.content, asset.channel, asset.title)
          : [];
        if (asset.type === "social_post" || asset.type === "campaign_content") {
          try {
            const posts = JSON.parse(asset.content);
            const parsedPosts = Array.isArray(posts) ? posts : posts?.posts;
            if (Array.isArray(parsedPosts) && parsedPosts.length) {
              preview = parsedPosts.map((post) => post.content).filter(Boolean).join("\n\n");
            }
          } catch {
            // content is plain text, use as-is
          }
        }
        const tags = [asset.channel, asset.objective].filter(Boolean);
        return {
          id: asset.id,
          title: asset.campaignName || asset.title || asset.type || "Asset",
          type: asset.type === "social_post" || asset.type === "campaign_content" ? "Social Post" : asset.type === "whitepaper" ? "Whitepaper" : "Case Study",
          assetType: asset.type,
          campaignId: asset.campaignId,
          rawContent: asset.content || "",
          campaignPosts,
          status: asset.status || "ready",
          description: preview,
          industry: preview || asset.title || "Asset",
          services: tags.length ? tags : ["asset"],
          uses: 0,
          date: asset.updatedAt || asset.createdAt || "Today",
          updatedAt: asset.updatedAt,
          createdAt: asset.createdAt,
        };
      });
      setLibraryItems([...templates, ...assets].filter((item) => !deletedContentIds.includes(getContentItemKey(item))));

      console.log("PROPOSALS:", data);

      if (Array.isArray(data)) {
        setProposals([...localProposals, ...data]
          .map((proposal) => {
            const total = calculateProposalTotal(proposal);
            const structuredContent = normalizeProposalDocument(proposal);
            return {
              ...proposal,
              structuredContent,
              pricingRows: proposal.pricingRows || proposal.pricing_rows || proposal.lineItems || [],
              totalAmount: total.totalAmount,
            };
          })
          .filter((proposal) => !deletedContentIds.includes(getContentItemKey({ ...proposal, type: "Proposal" }))));
      } else {
        setProposals(localProposals);
      }

    } catch (error) {
      console.error(error);
      setProposals(readLocalContentProposals());
      setLibraryItems([]);
    } finally {
      setLoadingLibrary(false);
    }
  }

  loadProposals();
}, [deletedContentIds, libraryRefreshKey]);

  const handleDeleteContentItem = async (item) => {
    const warning = item.uses > 0
      ? t("contentLibrary.deleteWarningUsed")
      : t("contentLibrary.deleteWarning");
    if (!window.confirm(warning)) return;

    const deletedKey = getContentItemKey(item);
    console.log("Deleting asset", item.id, item.title);
    const removeLocally = () => {
      setDeletedContentIds((current) => {
        const next = [...new Set([...current, deletedKey])];
        writeDeletedContentIds(next);
        console.log("Deleted IDs", next);
        return next;
      });
      setProposals((current) => {
        const updated = current.filter((proposal) => getContentItemKey({ ...proposal, type: "Proposal" }) !== deletedKey);
        console.log("Assets after delete", updated);
        return updated;
      });
      setLibraryItems((current) => current.filter((asset) => getContentItemKey(asset) !== deletedKey));
    };

    removeLocally();
    setToast({ type: "success", message: t("contentLibrary.assetDeleted") });

    try {
      if (item.id && item.type === "Proposal" && !String(item.id).startsWith("mock-")) {
        await deleteProposal(item.id);
      } else if (item.id && item.source === "contentItems" && !String(item.id).startsWith("mock-")) {
        await api.delete(`/generate/content-items/${item.id}`);
      } else if (item.id && item.type === "Template" && !String(item.id).startsWith("mock-")) {
        await api.delete(`/templates/${item.id}`);
      } else if (item.id && !String(item.id).startsWith("mock-")) {
        await api.delete(`/assets/${item.id}`);
      }
    } catch (error) {
      console.warn("Backend delete failed; asset remains deleted locally.", error);
    }
  };

  const types = ["All", "Case Studies", "Proposals", "Templates", "Whitepapers", "Social Posts", "One-Pagers"];
  const typeToItemType = {
    "Case Studies": "Case Study",
    "Proposals": "Proposal",
    "Templates": "Template",
    "Whitepapers": "Whitepaper",
    "Social Posts": "Social Post",
    "One-Pagers": "One-Pager",
  };
  const typeLabelKeys = {
    "All": "all",
    "Case Studies": "caseStudies",
    "Proposals": "proposals",
    "Templates": "templates",
    "Whitepapers": "whitepapers",
    "Social Posts": "socialPosts",
    "One-Pagers": "onePagers",
    "Case Study": "caseStudy",
    "Proposal": "proposal",
    "Template": "template",
    "Whitepaper": "whitepaper",
    "Social Post": "socialPost",
    "One-Pager": "onePager",
  };
  const statusLabelKeys = {
    Published: "published",
    Active: "active",
    Sent: "sent",
    Accepted: "accepted",
    Draft: "draft",
    draft: "draft",
    generated: "generated",
    Generated: "generated",
    "Generating...": "generating",
    ready: "ready",
    Private: "private",
    Public: "public",
  };
  const contentTypeLabel = (type) => t(`contentLibrary.types.${typeLabelKeys[type] || "all"}`);
  const contentStatusLabel = (status) => t(`contentLibrary.statuses.${statusLabelKeys[status] || "generated"}`);

  const realProposalItems = (Array.isArray(proposals) ? proposals : []).map((proposal) => {
  const total = calculateProposalTotal(proposal);
  const structuredContent = proposal.structuredContent || proposal.structured_content || normalizeProposalDocument(proposal);
  const industry = cleanStructuredText(
    structuredContent.industry
    || proposal.industryName
    || proposal.industry_name
    || proposal.opportunity?.industry
    || proposal.industry,
  ) || "AI Generated Proposal";
  return {
    ...proposal,
    id: proposal.id,
    title: proposal.title || proposal.name || "AI Generated Proposal",
    type: "Proposal",
    status: proposal.status || "generated",
    proposal_status: proposal.proposal_status || "Generada",
    description: proposal.description || "",
    content: proposal.content || proposal.description || "",
    structuredContent,
    industry,
    services: ["AI"],
    uses: 0,
    date: "Today",
    pricingRows: proposal.pricingRows || proposal.pricing_rows || proposal.lineItems || [],
    totalAmount: total.totalAmount,
    formattedTotal: total.formattedTotal,
  };
});

const allItems = [...realProposalItems, ...libraryItems];

const filtered = allItems.filter((item) => {
  if (typeFilter !== "All" && item.type !== (typeToItemType[typeFilter] || typeFilter)) return false;
  if (statusFilter) return item.type === "Proposal" && (item.proposal_status || "Generada") === statusFilter;
  return true;
});

  const campaignAssetsStep = campaignFlow?.currentStep === 4;
  const handleAssetToggle = (item) => {
    if (!campaignAssetsStep) return;
    setCampaignFlow((prev) => {
      const already = prev?.selectedAssets?.some((asset) => asset.id === item.id);
      return {
        ...prev,
        selectedAssets: already
          ? (prev?.selectedAssets || []).filter((asset) => asset.id !== item.id)
          : [...(prev?.selectedAssets || []), { id: item.id, title: item.title, type: item.type }],
      };
    });
  };

  const typeIcon = (t) => {
    const m = { "Case Study": BookIcon, "Proposal": BriefIcon, "Template": FileIcon, "Whitepaper": LayersIcon, "Social Post": Share2Icon, "One-Pager": FileIcon };
    return m[t] || FileIcon;
  };
  const typeColor = (type) => {
    if (isDark) return "bg-slate-900 text-slate-200 border border-white/10";
    const colors = { "Case Study": "text-indigo-600 bg-indigo-50", "Proposal": "text-teal-600 bg-teal-50", "Template": "text-amber-600 bg-amber-50", "Whitepaper": "text-purple-600 bg-purple-50", "Social Post": "text-pink-600 bg-pink-50", "One-Pager": "text-blue-600 bg-blue-50" };
    return colors[type] || "text-gray-600 bg-gray-50";
  };
  const statusColor = (status) => {
    if (isDark) return "bg-slate-900 text-slate-200 border border-white/10";
    const colors = { "Published": "bg-green-100 text-green-700", "Active": "bg-green-100 text-green-700", "Sent": "bg-blue-100 text-blue-700", "Accepted": "bg-green-100 text-green-700", "Draft": "bg-gray-100 text-gray-600", "draft": "bg-gray-100 text-gray-600", "generated": "bg-indigo-100 text-indigo-700", "Generated": "bg-indigo-100 text-indigo-700", "pending CRM upload": "bg-yellow-100 text-yellow-700", "uploaded": "bg-green-100 text-green-700", "Generating...": "bg-yellow-100 text-yellow-700" };
    return colors[status] || "bg-gray-100 text-gray-600";
  };
  const proposalStatusColor = (proposalStatus = "Generada") => {
    if (isDark) return "bg-slate-900 text-slate-200 border border-white/10";
    return PROPOSAL_STATUS_COLOR_CLASSES[proposalStatus] || "bg-gray-100 text-gray-600";
  };
  const proposalStatusLabel = (proposalStatus = "Generada") => {
    const statusConfig = PROPOSAL_STATUSES.find((item) => item.value === proposalStatus) || PROPOSAL_STATUSES[0];
    return t(`contentLibrary.proposalStatuses.${statusConfig.labelKey}`);
  };
  const handleProposalStatusChange = async (proposal, proposalStatus) => {
    const nextProposal = { ...proposal, proposal_status: proposalStatus };
    setViewingProposal(nextProposal);
    setProposals((current) => current.map((item) => (
      item.id === proposal.id ? { ...item, proposal_status: proposalStatus } : item
    )));
    try {
      await updateProposalStatus(proposal.id, proposalStatus);
    } catch (error) {
      console.error(error);
      setViewingProposal(proposal);
      setProposals((current) => current.map((item) => (
        item.id === proposal.id ? { ...item, proposal_status: proposal.proposal_status || "Generada" } : item
      )));
      setToast({ type: "error", message: "No se pudo actualizar el estado de la propuesta." });
    }
  };
  const duplicateItem = (item) => {
    const copy = { ...item, id: `copy-${Date.now()}`, title: `${item.title} Copy`, status: "Draft", date: "Today" };
    if (item.type === "Proposal") setProposals((current) => [...current, copy]);
    else setLibraryItems((current) => [...current, copy]);
    setToast(t("contentLibrary.assetDuplicated"));
  };
  const downloadItem = async (item, format = "pdf", sourceElementOverride = null) => {
    if (item.type === "Proposal") {
      const sourceElement = sourceElementOverride || (viewingProposal?.id === item.id
        ? viewingProposalPreviewRef.current
        : null);
      try {
        await exportProposalDocument(item, format, sourceElement);
      } catch (error) {
        console.error(error);
        setToast({ type: "error", message: t("contentLibrary.exportUnsupported") });
      }
      return;
    }
    // Book Concepts assets (One-Pager/Whitepaper/Social from /books/{id}/assets/*)
    // already carry a real signed storage URL — just open it, same as the
    // working "Download" buttons in Book Concepts.
    if (item.downloadUrl || item.url) {
      window.open(item.downloadUrl || item.url, "_blank", "noopener,noreferrer");
      return;
    }
    // Case Study / Whitepaper / Template / One-Pager generated via the AI
    // content wizard only have HTML content in Firestore, no server-rendered
    // file — render it client-side, same as the wizard's own export step.
    if (item.content) {
      try {
        await exportContentItemPdf(item);
      } catch (error) {
        console.error(error);
        setToast({ type: "error", message: t("contentLibrary.exportUnsupported") });
      }
      return;
    }
    setToast({ type: "error", message: t("contentLibrary.exportUnsupported") });
  };
  const getCrmErrorMessage = (error, fallback) => {
    const detail = error?.response?.data?.detail;
    return (typeof detail === "string" && detail.trim()) ? detail : (error?.message || fallback);
  };
  const applyCrmSyncResult = (proposalId, crmSync) => {
    setProposals((current) => current.map((proposal) => proposal.id === proposalId ? { ...proposal, crmSync } : proposal));
    setViewingProposal((current) => current && current.id === proposalId ? { ...current, crmSync } : current);
  };
  const sendProposalToCrmNow = async (proposal) => {
    setCrmSending(true);
    try {
      const { data } = await sendProposalToCrm(proposal.id);
      applyCrmSyncResult(proposal.id, data.crmSync);
      const providerLabel = data?.crmSync?.provider === "salesforce" ? "Salesforce" : "HubSpot";
      setToast({ type: "success", message: `Proposal sent to ${providerLabel}.` });
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: getCrmErrorMessage(error, "Could not send the proposal to the CRM.") });
    } finally {
      setCrmSending(false);
    }
  };
  const handleUploadToCrm = (proposal) => {
    if (!proposal.clientEmail) {
      setCrmEmailPrompt({ proposal, email: "" });
      return;
    }
    sendProposalToCrmNow(proposal);
  };
  const confirmCrmEmailPrompt = async () => {
    const email = crmEmailPrompt?.email.trim();
    if (!email) return;
    setCrmEmailPromptSaving(true);
    try {
      const { data } = await updateProposal(crmEmailPrompt.proposal.id, { clientEmail: email });
      const updatedProposal = { ...crmEmailPrompt.proposal, ...data, clientEmail: email };
      setProposals((current) => current.map((item) => item.id === updatedProposal.id ? { ...item, ...updatedProposal } : item));
      setViewingProposal((current) => current && current.id === updatedProposal.id ? { ...current, ...updatedProposal } : current);
      setCrmEmailPrompt(null);
      await sendProposalToCrmNow(updatedProposal);
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: getCrmErrorMessage(error, "Could not save the client email.") });
    } finally {
      setCrmEmailPromptSaving(false);
    }
  };
  const renderAiInput = (field, textarea = false, type = "text") => (
    <Field label={contentAiLabel(field)}>
      {textarea ? (
        <textarea
          className="w-full rounded-lg border border-gray-300 px-3 py-4 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none h-24"
          value={contentAiForm[field]}
          onChange={(event) => updateContentAiForm(field, event.target.value)}
        />
      ) : (
        <Input
          type={type}
          value={contentAiForm[field]}
          onChange={(event) => updateContentAiForm(field, event.target.value)}
        />
      )}
    </Field>
  );
  const renderAiSelect = (field, options) => (
    <Field label={contentAiLabel(field)}>
      <Select value={contentAiForm[field]} onChange={(event) => updateContentAiForm(field, event.target.value)}>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </Select>
    </Field>
  );
  const renderAiContentForm = () => {
    if (createType === "Case Study") {
      return (
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            {renderAiInput("client_name")}
            {renderAiInput("industry")}
            {renderAiInput("region")}
            {renderAiInput("duration_months", false, "number")}
          </div>
          {renderAiInput("challenge", true)}
          {renderAiInput("solution", true)}
          <div className="grid grid-cols-2 gap-1.5">
            {renderAiInput("metric_1_label")}
            {renderAiInput("metric_1_value")}
            {renderAiInput("metric_2_label")}
            {renderAiInput("metric_2_value")}
            {renderAiInput("metric_3_label")}
            {renderAiInput("metric_3_value")}
            {renderAiInput("testimonial_name")}
            {renderAiInput("testimonial_role")}
          </div>
          {renderAiInput("testimonial_quote", true)}
        </div>
      );
    }
    if (createType === "Whitepaper") {
      return (
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            {renderAiInput("title")}
            {renderAiInput("subtitle")}
            {renderAiInput("topic")}
            {renderAiInput("target_audience")}
          </div>
          {renderAiInput("key_sections", true)}
          {renderAiInput("abstract", true)}
        </div>
      );
    }
    if (createType === "Template") {
      return (
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            {renderAiInput("template_name")}
            {renderAiSelect("channel", ["Email", "LinkedIn", "WhatsApp"])}
            {renderAiSelect("category", ["follow_up", "cold_outreach", "post_demo", "nurture"])}
            {renderAiSelect("tone", ["Friendly", "Formal", "Urgent"])}
          </div>
          {renderAiInput("use_case", true)}
          {renderAiInput("merge_variables")}
        </div>
      );
    }
    if (createType === "Social Post") {
      return (
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            {renderAiSelect("platform", ["LinkedIn", "Instagram", "Twitter", "Facebook"])}
            {renderAiInput("topic")}
            {renderAiSelect("tone", ["Friendly", "Formal", "Urgent"])}
            {renderAiInput("target_audience")}
            {renderAiInput("cta_text")}
          </div>
          {renderAiInput("key_points", true)}
        </div>
      );
    }
    return (
      <div className="space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          {renderAiInput("product_name")}
          {renderAiInput("tagline")}
          {renderAiInput("target_audience")}
          {renderAiInput("cta_text")}
          {renderAiInput("cta_url")}
        </div>
        {renderAiInput("features", true)}
        <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>{t("contentLibrary.aiFields.featuresHint")}</p>
        <div className="grid grid-cols-2 gap-1.5">
          {renderAiInput("metric_1_label")}
          {renderAiInput("metric_1_value")}
          {renderAiInput("metric_2_label")}
          {renderAiInput("metric_2_value")}
          {renderAiInput("metric_3_label")}
          {renderAiInput("metric_3_value")}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-2">
      {campaignFlow?.currentStep === 4 && (
        <div className="flow-step-banner">
          <span>
            📁 Step 4: Select assets for this campaign
            {campaignFlow.selectedAssets?.length > 0 && (
              <span style={{ marginLeft: 8, background: "#6366F1", color: "white", borderRadius: 12, padding: "2px 8px", fontSize: "0.8em" }}>
                {campaignFlow.selectedAssets.length} selected
              </span>
            )}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => {
                setCampaignFlow((prev) => completeCampaignFlowSteps(prev, [4], 5));
                onNavigate("outreach");
              }}
              style={{ background: "transparent", color: "#6366F1", border: "1px solid #6366F1", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: "0.85em" }}
            >
              Skip
            </button>
            <button
              type="button"
              onClick={() => {
                setCampaignFlow((prev) => completeCampaignFlowSteps(prev, [4], 5));
                onNavigate("outreach");
              }}
            >
              Continue to Review →
            </button>
          </div>
        </div>
      )}
      <ToastStack
        toasts={toasts}
        onClose={removeToast}
        onMouseEnter={pauseToast}
        onMouseLeave={resumeToast}
      />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("contentLibrary.title")}</h1>
          <p className="text-xs text-gray-500">{t("contentLibrary.subtitle")}</p>
        </div>
        <Btn icon={<PlusIcon size={14} />} onClick={() => openCreateContentModal()}>{createT.openCreate}</Btn>
      </div>

      {/* Type filter tabs */}
      <div className="flex gap-1">
        {types.map(t => (
          <button key={t} onClick={() => { setTypeFilter(t); setStatusFilter(""); }}
            className={`px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
              typeFilter === t
                ? "bg-[#4F46E5] text-white border-[#4F46E5]"
                : isDark
                  ? "bg-slate-800 text-slate-300 border-white/10 hover:bg-slate-700"
                  : "bg-gray-100 text-gray-600 border-transparent hover:bg-gray-200"
            }`}>
            {contentTypeLabel(t)}{t !== "All" && <span className="ml-1 opacity-60">{allItems.filter(i => i.type === (typeToItemType[t] || t)).length}</span>}
          </button>
        ))}
      </div>

      {/* Content grid */}
      {loadingLibrary ? (
        <div style={{ background: isDark ? '#1E293B' : '#fff', borderRadius: 14, border: `1px solid ${isDark ? '#334155' : '#eaecf3'}`, padding: '48px 24px', textAlign: 'center' }}>
          <p style={{ fontSize: 14, color: isDark ? '#64748B' : '#94a3b8', fontWeight: 500, margin: 0 }}>{t("contentLibrary.loading")}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #eaecf3", padding: "48px 24px", textAlign: "center" }}>
          <p style={{ fontSize: 14, color: "#94a3b8", fontWeight: 500, margin: 0 }}>{t("contentLibrary.emptyState")}</p>
        </div>
      ) : (
      <div className="grid grid-cols-3 gap-1.5">
        {filtered.map(item => {
          const Ic = typeIcon(item.type);
          const isSelectedAsset = campaignFlow?.selectedAssets?.some((asset) => asset.id === item.id);
          const card = (
            <Card className={`p-2 hover:border-indigo-200 cursor-pointer transition-colors group ${campaignAssetsStep && isSelectedAsset ? "!border-2 !border-[#6366F1] !bg-[#F5F3FF]" : ""}`}>
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${typeColor(item.type)}`}><Ic size={14} /></div>
                  <Badge label={contentTypeLabel(item.type)} color={typeColor(item.type)} />
                </div>
                {campaignAssetsStep ? (
                  <input
                    type="checkbox"
                    checked={Boolean(isSelectedAsset)}
                    readOnly
                    className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                  />
                ) : item.type === "Proposal" ? (
                    <Badge
                      label={proposalStatusLabel(item.proposal_status || "Generada")}
                      color={proposalStatusColor(item.proposal_status || "Generada")}
                    />
                ) : (
                  <Badge label={contentStatusLabel(item.status)} color={statusColor(item.status)} />
                )}
              </div>
              <p className="text-sm font-medium text-gray-900 mb-1">{item.title}</p>
              <p className="text-xs text-gray-400 mb-1 line-clamp-3">
                 {getCardPreview(item)} · {getUpdatedLabel(item)}
              </p>
              <div className="flex flex-wrap gap-1 mb-1.5">
                {item.services.map((s) => (
                  <span
                    key={s}
                    className={`px-1.5 py-0.5 rounded border text-xs ${
                      isDark
                        ? "bg-slate-900 text-slate-200 border-white/10"
                        : "bg-indigo-50 text-indigo-600 border-transparent"
                    }`}
                  >
                    {s}
                  </span>
                ))}
              </div>
              {item.type === "Proposal" && (
                <div className={`mb-1.5 rounded-lg border px-3 py-4 text-xs ${
                  isDark
                    ? "bg-[#0F172A] text-white border-white/10"
                    : "bg-slate-50 text-slate-500 border-transparent"
                }`}>
                  {t("contentLibrary.totalAmount")}: <span className={`font-semibold ${isDark ? "text-white" : "text-slate-800"}`}>{item.formattedTotal || calculateProposalTotal(item).formattedTotal}</span>
                </div>
              )}
              <div className="flex items-center justify-between pt-2 border-t border-gray-50">
                <span className="text-xs text-gray-400 flex items-center gap-1">
                  {item.uses > 0 ? <><LinkIcon size={10} /> {t("contentLibrary.usedInEmails").replace("{count}", item.uses)}</> : t("contentLibrary.notYetUsed")}
                </span>
                
                {!campaignAssetsStep && (
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100">

                  <button
                    onClick={() => {
                      if (item.type === "Proposal") {
                        setViewingProposal(item);
                      } else if (item.assetType === "campaign_content") {
                        setViewingCampaignContent(item);
                      } else if (item.type === "Social Post") {
                        setViewingCampaignContent({
                          ...item,
                          campaignPosts: normalizeCampaignContent(
                            item.content || item.rawContent || item.description,
                            item.inputData?.platform || item.services?.[0] || "linkedin",
                            item.title,
                          ),
                        });
                      } else {
                        console.log("Viewing content item:", item);
                        setViewingContentItem(item);
                      }
                    }}
                    title={t("contentLibrary.actions.view")}
                    className="p-1 rounded hover:bg-gray-100"
                  >
                    <EyeIcon size={11} className="text-gray-400" />
                  </button>

                  {item.type === "Proposal" && item.assetType !== "campaign_content" && (
                    <button
                      onClick={() => openProposalHtmlEditor(item)}
                      title={t("contentLibrary.actions.edit")}
                      className="p-1 rounded hover:bg-gray-100"
                    >
                      <PenIcon size={11} className="text-gray-400" />
                    </button>
                  )}

                  <button
                    onClick={() => duplicateItem(item)}
                    title={t("contentLibrary.actions.duplicate")}
                    className="p-1 rounded hover:bg-gray-100"
                  >
                    <FileIcon size={11} className="text-gray-400" />
                  </button>

                  {item.assetType !== "campaign_content" && (
                    <button
                      onClick={() => downloadItem(item, "pdf")}
                      title={t("contentLibrary.actions.download")}
                      className="p-1 rounded hover:bg-gray-100"
                    >
                      <DownloadIcon size={11} className="text-gray-400" />
                    </button>
                  )}

                  <button
                    onClick={() => handleDeleteContentItem(item)}
                    title={t("contentLibrary.actions.delete")}
                    className="p-1 rounded hover:bg-red-100"
                  >
                    <TrashIcon size={11} className="text-red-500" />
                  </button>

                </div>
                )}
              </div>
            </Card>
          );
          return campaignAssetsStep ? (
            <div
              key={item.id || item.title}
              role="button"
              tabIndex={0}
              onClick={() => handleAssetToggle(item)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  handleAssetToggle(item);
                }
              }}
              className="block w-full text-left"
            >
              {card}
            </div>
          ) : (
            card
          );
        })}
      </div>
      )}

      {/* ── Create Content Modal ── */}
{showCreateModal && (
  <div className="fixed inset-0 z-50 flex items-center justify-center">
    <div
      className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      onClick={closeCreateContentModal}
    />

    <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-4xl mx-4 max-h-[90vh] overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between p-2 border-b border-gray-100">
        <div className="flex items-center gap-1">
          <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
            <PlusIcon size={16} className="text-indigo-600" />
          </div>

          <div>
            <h2 className="text-sm font-semibold text-gray-900">{createT.modalTitle}</h2>
            <p className="text-xs text-gray-400">{createT.modalSubtitle}</p>
          </div>
        </div>

        <button
          onClick={closeCreateContentModal}
          className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <XIcon size={16} className="text-gray-400" />
        </button>
      </div>

      {/* Body */}
      <div className="p-2 space-y-1.5">
        <Field label={createT.contentType}>
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-6">
            {contentTypeOptions.map((type) => {
              const isProposal = type === "Proposal";
              const isEnabledAiType = aiContentTypes.includes(type);
              const isEnabledCreateType = isProposal || isEnabledAiType;
              return (
                <button
                  key={type}
                  type="button"
                  disabled={!isEnabledCreateType}
                  onClick={isEnabledCreateType ? () => {
                    resetCreateContentForm();
                    setCreateType(type);
                  } : undefined}
                  className={`min-h-9 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors ${
                    createType === type
                      ? "border-indigo-300 bg-indigo-600 text-white shadow-sm"
                      : isEnabledCreateType
                      ? "border-gray-200 bg-white text-gray-600 hover:border-indigo-200 hover:text-indigo-700"
                      : "cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400 opacity-75"
                  }`}
                >
                  <span className="block">{contentTypeLabel(type)}</span>
                  {!isEnabledCreateType && (
                    <span className="mt-0.5 inline-flex rounded-full bg-gray-200 px-1.5 py-0.5 text-[9px] font-semibold text-gray-500">
                      {createT.comingSoon}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </Field>

        {createType === "Proposal" && (
          <div className="grid grid-cols-3 gap-1">
            {[createT.proposalDetails, createT.servicesPricing, createT.reviewProposal].map((label, index) => (
              <button
                key={label}
                type="button"
                onClick={() => goToProposalStep(index + 1)}
                className={`rounded-lg border px-2 py-4 text-xs font-medium ${
                  wizardStep === index + 1
                    ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                    : "border-gray-100 bg-gray-50 text-gray-500"
                }`}
              >
                {createT.step} {index + 1}<br />{label}
              </button>
            ))}
          </div>
        )}

        {createType !== "Proposal" && !isAiContentType && <Field label={createT.title}>
          <Input
            placeholder={`e.g. "${
              createType === "Template"
                ? createT.templateTitleExample
                : createType === "Proposal"
                ? createT.titleExample
                : createT.assetTitleExample
            }"`}
            value={createType === "Proposal" ? proposalForm.name : contentTitle}
            onChange={(e) => createType === "Proposal" ? updateProposalForm("name", e.target.value) : setContentTitle(e.target.value)}
          />
        </Field>}

        {createType === "Proposal" && wizardStep === 1 && (
          <div className="space-y-1.5">
          <Field label={createT.title}>
            <Input
              placeholder={`e.g. "${createT.titleExample}"`}
              value={proposalForm.name}
              onChange={(e) => updateProposalForm("name", e.target.value)}
            />
          </Field>
          <Field label={createT.proposalDescription}>
            <textarea
              className="w-full border border-gray-300 rounded-lg px-3 py-4 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none h-20"
              placeholder={createT.proposalDescriptionPlaceholder}
              value={contentDescription}
              onChange={(e) => setContentDescription(e.target.value)}
            />
          </Field>
          <div className="max-w-xs">
            <Field label={createT.proposalLanguage}>
              <Select
                value={proposalLanguage}
                onChange={(e) => {
                  setProposalLanguage(e.target.value);
                  setProposalLanguageManuallySelected(true);
                }}
              >
                {Object.entries(proposalLanguageLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}{!proposalLanguageManuallySelected && proposalLanguage === value ? ` (${createT.detected})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          </div>
        )}

        {isAiContentType && createType !== "Proposal" && contentAiStep === 1 && (
          <div className="max-w-xs">
            <Field label={createT.proposalLanguage}>
              <Select
                value={proposalLanguage}
                onChange={(e) => {
                  setProposalLanguage(e.target.value);
                  setProposalLanguageManuallySelected(true);
                }}
              >
                {Object.entries(proposalLanguageLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}{!proposalLanguageManuallySelected && proposalLanguage === value ? ` (${createT.detected})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}

        {createType !== "Social Post" && createType !== "Proposal" && !isAiContentType && (
          <Field
            label={createT.description}
            hint={createT.descriptionHint}
          >
            <textarea
              className="w-full border border-gray-300 rounded-lg px-3 py-4 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none h-20"
              placeholder={createT.descriptionPlaceholder}
              value={contentDescription}
              onChange={(e) => setContentDescription(e.target.value)}
            />
          </Field>
        )}

        {createType === "Proposal" && wizardStep === 1 && (
          <div className="space-y-1.5">
                <div className="grid grid-cols-2 gap-1.5">
                <Field label={createT.customer}>
                  <Input value={proposalForm.customer} onChange={(e) => updateProposalForm("customer", e.target.value)} placeholder={createT.customerPlaceholder} />
                </Field>
                <Field label={createT.template}>
                  <Select value={proposalForm.template} onChange={(e) => updateProposalForm("template", e.target.value)}>
                    <option>NoonDalton Standard Proposal</option>
                    <option>BPO Services Proposal</option>
                    <option>AI Automation Proposal</option>
                  </Select>
                </Field>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                <Field label="Client email" hint="Used to send this proposal to your CRM">
                  <Input type="email" value={proposalForm.customerEmail} onChange={(e) => updateProposalForm("customerEmail", e.target.value)} placeholder="client@company.com" />
                </Field>
                <Field label="Client company">
                  <Input value={proposalForm.customerCompany} onChange={(e) => updateProposalForm("customerCompany", e.target.value)} placeholder="Acme Corp" />
                </Field>
                </div>
                <Field label={createT.tags}>
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-2.5">
                    <div className="flex flex-wrap gap-1">
                      {allProposalTags.map((tag) => {
                        const selected = proposalTags.some((item) => item.toLowerCase() === tag.toLowerCase());
                        return (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => toggleProposalTag(tag)}
                            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                              selected
                                ? "border-indigo-300 bg-indigo-600 text-white shadow-sm"
                                : "border-gray-200 bg-white text-gray-600 hover:border-indigo-200 hover:text-indigo-700"
                            }`}
                          >
                            <span>{tag}</span>
                            {selected && (
                              <span
                                role="button"
                                tabIndex={-1}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  removeProposalTag(tag);
                                }}
                                className="ml-0.5 rounded-full bg-white/20 p-0.5 hover:bg-white/30"
                                aria-label={`Remove ${tag}`}
                              >
                                <XIcon size={10} />
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <input
                      value={customProposalTag}
                      onChange={(e) => setCustomProposalTag(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addCustomProposalTag();
                        }
                      }}
                      placeholder={createT.customTagPlaceholder}
                      className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                </Field>
                <Field label={createT.detailedDescription}>
                  <textarea
                    className="w-full border border-gray-300 rounded-lg px-3 py-4 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none h-24"
                    placeholder={createT.detailedDescriptionPlaceholder}
                    value={detailedDescription}
                    onChange={(e) => setDetailedDescription(e.target.value)}
                  />
                </Field>
                <Field label={createT.teamSizing}>
                  <textarea
                    className="w-full border border-gray-300 rounded-lg px-3 py-4 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none h-20"
                    placeholder={createT.teamSizingPlaceholder}
                    value={teamSizing}
                    onChange={(e) => setTeamSizing(e.target.value)}
                  />
                </Field>
                <Field label={createT.length}>
                  <Select value={proposalLength} onChange={(e) => setProposalLength(e.target.value)}>
                    <option value="brief">{createT.brief}</option>
                    <option value="standard">{createT.standard}</option>
                    <option value="extended">{createT.extended}</option>
                  </Select>
                </Field>
                <Field label={createT.contentSource}>
                  <div className="space-y-1">
                    <label className="flex items-center gap-1 p-2.5 rounded-xl border border-indigo-200 bg-indigo-50 cursor-pointer">
                      <input type="radio" name="proposal-source" checked={proposalContentSource === "ai"} onChange={() => setProposalContentSource("ai")} className="accent-indigo-600" />
                      <SparkIcon size={14} className="text-indigo-500" />
                      <div>
                        <p className="text-xs font-medium text-gray-800">{createT.generateWithAi}</p>
                        <p className="text-[11px] text-gray-400">{createT.generateWithAiHint}</p>
                      </div>
                    </label>
                    <label className="flex items-center gap-1 p-2.5 rounded-xl border border-gray-100 bg-gray-50 cursor-pointer hover:border-indigo-200 transition-colors">
                      <input type="radio" name="proposal-source" checked={proposalContentSource === "upload"} onChange={() => setProposalContentSource("upload")} className="accent-indigo-600" />
                      <DownloadIcon size={14} className="text-gray-400" />
                      <div>
                        <p className="text-xs font-medium text-gray-800">{createT.uploadFile}</p>
                        <p className="text-[11px] text-gray-400">{createT.uploadFileHint}</p>
                      </div>
                    </label>
                    <label className="flex items-center gap-1 p-2.5 rounded-xl border border-gray-100 bg-gray-50 cursor-pointer hover:border-indigo-200 transition-colors">
                      <input type="radio" name="proposal-source" checked={proposalContentSource === "manual"} onChange={() => setProposalContentSource("manual")} className="accent-indigo-600" />
                      <PenIcon size={14} className="text-gray-400" />
                      <div>
                        <p className="text-xs font-medium text-gray-800">{createT.manual}</p>
                        <p className="text-[11px] text-gray-400">{createT.manualHint}</p>
                      </div>
                    </label>
                  </div>
                </Field>
          </div>
        )}

        {createType === "Proposal" && wizardStep === 2 && (
          <div className="space-y-1.5">
            <div className="overflow-x-auto rounded-xl border border-gray-100">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="px-2 py-4 text-left">{createT.serviceUnit}</th>
                    <th className="px-2 py-4 text-left">{createT.serviceDescription}</th>
                    <th className="px-2 py-4 text-left">{createT.qty}</th>
                    <th className="px-2 py-4 text-left">{createT.unitPrice}</th>
                    <th className="px-2 py-4 text-right">{createT.subtotal}</th>
                    <th className="px-2 py-4" />
                  </tr>
                </thead>
                <tbody>
                  {pricingRows.length === 0 && (
                    <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">{createT.noPricing}</td></tr>
                  )}
                  {pricingRows.map((row) => (
                    <tr key={row.id} className="border-t border-gray-100">
                      <td className="p-2"><Input value={row.service} onChange={(e) => updatePricingRow(row.id, "service", e.target.value)} /></td>
                      <td className="p-2"><Input value={row.description} onChange={(e) => updatePricingRow(row.id, "description", e.target.value)} /></td>
                      <td className="p-2 w-20"><Input type="number" min="0" value={row.quantity} onChange={(e) => updatePricingRow(row.id, "quantity", e.target.value)} /></td>
                      <td className="p-2 w-28"><Input type="number" min="0" value={row.unitPrice} onChange={(e) => updatePricingRow(row.id, "unitPrice", e.target.value)} /></td>
                      <td className="p-2 text-right font-semibold text-gray-700">{formatUsd(Number(row.quantity || 0) * Number(row.unitPrice || 0))}</td>
                      <td className="p-2"><button type="button" onClick={() => removePricingRow(row.id)} className="p-1 rounded hover:bg-red-50"><TrashIcon size={12} className="text-red-500" /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between">
              <Btn variant="secondary" small icon={<PlusIcon size={12} />} onClick={addPricingRow}>{createT.addLineItem}</Btn>
              <div className="text-sm text-gray-700">{createT.totalAmount}: <strong>{formatUsd(pricingTotal)}</strong></div>
            </div>
          </div>
        )}

        {createType === "Proposal" && wizardStep === 3 && (
          <div className="space-y-1.5">
            <Field label={createT.adjustmentInstructions}>
              <textarea
                value={proposalCustomPrompt}
                onChange={(event) => setProposalCustomPrompt(event.target.value)}
                placeholder={createT.adjustmentInstructionsPlaceholder}
                rows={3}
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-4 text-sm text-gray-700 outline-none transition-colors placeholder:text-gray-400 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
              />
            </Field>
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-2">
              <h3 className="mb-1.5 text-sm font-semibold text-gray-900">{createT.reviewDetails}</h3>
              <div className="grid grid-cols-2 gap-1.5 text-xs">
                <div><span className="text-gray-400">{createT.title}</span><p className="font-medium text-gray-800">{proposalForm.name}</p></div>
                <div><span className="text-gray-400">{createT.customer}</span><p className="font-medium text-gray-800">{proposalForm.customer}</p></div>
                <div><span className="text-gray-400">{createT.template}</span><p className="font-medium text-gray-800">{proposalForm.template}</p></div>
                <div><span className="text-gray-400">{createT.length}</span><p className="font-medium text-gray-800">{createT[proposalLength]}</p></div>
                <div><span className="text-gray-400">{createT.proposalLanguage}</span><p className="font-medium text-gray-800">{proposalLanguageLabels[platformGenerationLanguage]}</p></div>
                <div className="col-span-2"><span className="text-gray-400">{createT.proposalDescription}</span><p className="whitespace-pre-wrap text-gray-700">{contentDescription || createT.notProvided}</p></div>
                <div className="col-span-2"><span className="text-gray-400">{createT.detailedDescription}</span><p className="whitespace-pre-wrap text-gray-700">{detailedDescription || createT.notProvided}</p></div>
                <div className="col-span-2"><span className="text-gray-400">{createT.teamSizing}</span><p className="whitespace-pre-wrap text-gray-700">{teamSizing || createT.notProvided}</p></div>
                <div className="col-span-2"><span className="text-gray-400">{createT.tags}</span><p className="text-gray-700">{proposalTags.join(", ") || createT.notProvided}</p></div>
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 p-2">
              <div className="mb-1.5 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900">{createT.reviewPricing}</h3>
                <strong className="text-sm text-indigo-700">{createT.totalAmount}: {formatUsd(pricingTotal)}</strong>
              </div>
              <div className="space-y-1">
                {pricingRows.length === 0 && <p className="text-xs text-gray-400">{createT.noPricing}</p>}
                {pricingRows.map((row) => (
                  <div key={row.id} className="flex items-start justify-between border-t border-gray-100 pt-2 text-xs first:border-0 first:pt-0">
                    <div><p className="font-medium text-gray-800">{row.service || createT.notProvided}</p><p className="text-gray-400">{row.description}</p></div>
                    <p className="font-semibold text-gray-700">{row.quantity || 0} x {formatUsd(row.unitPrice || 0)} = {formatUsd(Number(row.quantity || 0) * Number(row.unitPrice || 0))}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {isAiContentType && contentAiStep === 1 && renderAiContentForm()}

        {isAiContentType && contentAiStep === 2 && (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-indigo-100 bg-indigo-50 text-center">
            <span className="spinner mb-1.5" />
            <p className="text-sm font-semibold text-gray-900">
              {t("contentLibrary.aiFields.generating").replace("{type}", contentTypeLabel(createType))}
            </p>
          </div>
        )}

        {isAiContentType && contentAiStep === 3 && generatedContentItem && (
          <div className="space-y-1.5">
            <div
              className="generated-content-preview max-h-[52vh] overflow-y-auto rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-700"
              dangerouslySetInnerHTML={{ __html: generatedContentItem.content }}
            />
            <div className="flex justify-end gap-1">
              <Btn variant="secondary" onClick={exportGeneratedContentPdf}>{t("contentLibrary.aiFields.exportPdf")}</Btn>
              <Btn onClick={saveGeneratedContentToLibrary}>{t("contentLibrary.aiFields.saveToLibrary")}</Btn>
            </div>
          </div>
        )}
         
        {false && (createType === "Case Study" ||
          createType === "Whitepaper" ||
          createType === "Template") && (
        <Field label={createT.contentSource}>
          <div className="space-y-1">
          <label className="flex items-center gap-1 p-2.5 rounded-xl border border-gray-100 bg-gray-50 cursor-pointer hover:border-indigo-200 transition-colors">
          <input type="radio" name="source" defaultChecked className="accent-indigo-600" />
        <SparkIcon size={14} className="text-indigo-500" />
          <div>
          <p className="text-xs font-medium text-gray-800">{createT.generateWithAi}</p>
          <p className="text-xs text-gray-400">{createT.aiCreatesContent}</p>
        </div>
      </label>

      <label className="flex items-center gap-1 p-2.5 rounded-xl border border-gray-100 bg-gray-50 cursor-pointer hover:border-indigo-200 transition-colors">
        <input type="radio" name="source" className="accent-indigo-600" />
        <DownloadIcon size={14} className="text-gray-400" />
        <div>
          <p className="text-xs font-medium text-gray-800">{createT.uploadExistingFile}</p>
          <p className="text-xs text-gray-400">{createT.uploadExistingFileHint}</p>
        </div>
      </label>

      <label className="flex items-center gap-1 p-2.5 rounded-xl border border-gray-100 bg-gray-50 cursor-pointer hover:border-indigo-200 transition-colors">
        <input type="radio" name="source" className="accent-indigo-600" />
        <PenIcon size={14} className="text-gray-400" />
        <div>
          <p className="text-xs font-medium text-gray-800">{createT.writeManually}</p>
          <p className="text-xs text-gray-400">{createT.writeManuallyHint}</p>
        </div>
      </label>
    </div>
  </Field>
)}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between p-2 border-t border-gray-100 bg-gray-50 rounded-b-2xl">
        <Btn variant="ghost" onClick={closeCreateContentModal}>
          {createT.cancel}
        </Btn>

        <div className="flex gap-1">
          {!isAiContentType && (
            <Btn
              variant="secondary"
              icon={<SaveIcon size={12} />}
              onClick={saveCreateContentDraft}
            >
              {createT.saveDraft}
            </Btn>
          )}
          {createType === "Proposal" && wizardStep > 1 && (
            <Btn variant="secondary" onClick={() => setWizardStep((current) => current - 1)}>
              {createT.back}
            </Btn>
          )}
          {createType === "Proposal" && wizardStep < 3 && (
            <Btn icon={<ArrowRightIcon size={13} />} onClick={() => goToProposalStep(wizardStep + 1)} disabled={!canContinueProposalSetup}>
              {wizardStep === 1 ? createT.continuePricing : createT.continue}
            </Btn>
          )}
          {createType === "Proposal" && wizardStep === 3 && (
            <Btn icon={<SparkIcon size={13} />} onClick={runProposalGeneration} disabled={!canContinueProposalSetup}>
              {structuredEditingProposalId ? createT.regenerate : createT.generateDraft}
            </Btn>
          )}
          {isAiContentType && contentAiStep === 1 && (
            <Btn icon={<SparkIcon size={13} />} onClick={generateAiContent} disabled={contentGenerating}>
              {t("contentLibrary.aiFields.generate")}
            </Btn>
          )}
        </div>
      </div>
    </div>
  </div>
)}

{/* ── View Proposal Modal ── */}
{false && generationModal && (
  <div className="fixed inset-0 z-[60] flex items-center justify-center">
    <div className="absolute inset-0 bg-slate-900/55 backdrop-blur-sm" />
    <div className="relative w-full max-w-md mx-4 rounded-2xl bg-white shadow-2xl border border-gray-100 overflow-hidden">
      <div className="p-3 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-900">
          Generando propuesta: {generationModal.title}
        </h2>
        <p className="text-xs text-gray-400 mt-1">Tiempo estimado: 10 - 15 segundos</p>
      </div>
      <div className="p-3 space-y-1.5">
        {proposalSteps.map((step, index) => {
          const done = generationModal.completedSteps?.includes(index);
          const active = generationModal.activeStep === index && !done;
          return (
            <div key={step} className="flex items-center gap-1.5">
              <span className={`flex h-5 w-5 items-center justify-center rounded-full border text-xs ${
                done
                  ? "border-green-200 bg-green-50 text-green-600"
                  : active
                  ? "border-indigo-200 bg-indigo-50 text-indigo-600"
                  : "border-gray-200 text-gray-400"
              }`}>
                {done ? <CheckIcon size={11} /> : active ? <RefreshIcon size={11} className="animate-spin" /> : index + 1}
              </span>
              <span className={`text-xs flex-1 ${done ? "text-gray-700" : active ? "text-indigo-700 font-medium" : "text-gray-400"}`}>
                {step}
              </span>
              {done && <CheckIcon size={13} className="text-green-500" />}
            </div>
          );
        })}
        <div className="pt-2">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>{generationModal.progress}% completado</span>
            {generationModal.error && <span className="text-red-600">{generationModal.error}</span>}
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-indigo-600 rounded-full transition-all duration-300"
              style={{ width: `${generationModal.progress}%` }}
            />
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-1 p-2 bg-gray-50 border-t border-gray-100">
        <Btn variant="ghost" small onClick={() => setGenerationModal(null)}>Cancelar</Btn>
      </div>
    </div>
  </div>
)}

<ProgressModal
  title={`${createT.generatingProposal}: ${generationModal?.title || proposalForm.name}`}
  subtitle={createT.estimatedTime}
  completeLabel={createT.complete}
  retryLabel={createT.retry}
  cancelLabel={createT.cancel}
  steps={proposalSteps}
  state={generationModal}
  onCancel={() => setGenerationModal(null)}
  onRetry={retryProposalGeneration}
/>

{viewingContentItem && isGeneratedContentType(viewingContentItem.type) && (
  <div className="fixed inset-0 z-50 flex items-center justify-center">
    <div
      className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      onClick={() => setViewingContentItem(null)}
    />
    <div className={`relative mx-4 max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl shadow-2xl ${isDark ? "border border-white/10 bg-slate-800" : "bg-white"}`}>
      <div className={`flex items-center justify-between border-b p-3 ${isDark ? "border-white/10" : "border-gray-100"}`}>
        <div>
          <div className="mb-1 flex items-center gap-1">
            <h2 className={`text-lg font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>
              {viewingContentItem.title}
            </h2>
            <Badge label={contentTypeLabel(viewingContentItem.type)} color={contentPreviewBadgeColor(viewingContentItem.type)} />
          </div>
          <p className={`text-xs ${isDark ? "text-slate-400" : "text-gray-400"}`}>
            {contentTypeLabel(viewingContentItem.type)}
          </p>
        </div>
        <button
          onClick={() => setViewingContentItem(null)}
          className={`rounded-lg p-1.5 transition-colors ${isDark ? "hover:bg-slate-700" : "hover:bg-gray-100"}`}
          aria-label={t("common.close")}
        >
          <XIcon size={16} className="text-gray-400" />
        </button>
      </div>
      <div className="p-6">
        <div
          className={`content-preview-document max-h-[66vh] overflow-y-auto rounded-xl border p-6 text-sm ${isDark ? "border-white/10 bg-slate-800 text-slate-300" : "border-gray-200 bg-white text-gray-700"}`}
          dangerouslySetInnerHTML={{ __html: viewingContentItem.content || "" }}
        />
      </div>
      <div className={`flex justify-end gap-1 border-t p-3 ${isDark ? "border-white/10 bg-[#0F172A]" : "border-gray-100 bg-gray-50"}`}>
        <Btn variant="secondary" onClick={() => exportContentItemPdf(viewingContentItem)}>
          {t("contentLibrary.aiFields.exportPdf")}
        </Btn>
        <Btn onClick={() => setViewingContentItem(null)}>
          {t("common.close")}
        </Btn>
      </div>
    </div>
  </div>
)}

{viewingCampaignContent && (
  <div className="fixed inset-0 z-50 flex items-center justify-center">
    <div
      className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      onClick={() => setViewingCampaignContent(null)}
    />
    <div className={`relative mx-4 max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl shadow-2xl ${isDark ? "border border-white/10 bg-slate-800" : "bg-white"}`}>
      <div className={`flex items-center justify-between border-b p-3 ${isDark ? "border-white/10" : "border-gray-100"}`}>
        <div>
          <h2 className={`text-lg font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>
            {viewingCampaignContent.title}
          </h2>
          <p className={`text-xs ${isDark ? "text-slate-400" : "text-gray-400"}`}>
            {t("contentLibrary.socialSummaries")}
          </p>
        </div>
        <button
          onClick={() => setViewingCampaignContent(null)}
          className={`rounded-lg p-1.5 transition-colors ${isDark ? "hover:bg-slate-700" : "hover:bg-gray-100"}`}
          aria-label={t("common.close")}
        >
          <XIcon size={16} className="text-gray-400" />
        </button>
      </div>

      <div className="space-y-2 p-6">
        {(viewingCampaignContent.campaignPosts?.length
          ? viewingCampaignContent.campaignPosts
          : normalizeCampaignContent(
              viewingCampaignContent.rawContent || viewingCampaignContent.description,
              viewingCampaignContent.services?.[0],
              viewingCampaignContent.title,
            )
        ).map((post, index) => {
          const copyText = [
            post.headline,
            post.content,
            post.hashtags.join(" "),
          ].filter(Boolean).join("\n\n");
          return (
            <div key={`${post.channel}-${index}`} className={`rounded-xl border p-3 ${isDark ? "border-white/10 bg-[#0F172A]" : "border-gray-200 bg-white"}`}>
              <div className="mb-1.5 flex items-start justify-between gap-1.5">
                <div>
                  <Badge label={post.channel || t("contentLibrary.socialPost")} color={isDark ? "border border-indigo-400/20 bg-indigo-500/10 text-indigo-200" : "bg-indigo-50 text-indigo-700"} />
                  {post.headline && <h3 className={`mt-3 text-base font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>{post.headline}</h3>}
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  {publishPlatforms.map(({ platform, label }) => {
                    const connected = Boolean(socialPublishStatus?.[platform]?.connected);
                    return (
                      <Btn
                        key={platform}
                        variant={connected ? "primary" : "secondary"}
                        small
                        onClick={() => publishSocialPost(platform, post, copyText)}
                        title={connected ? `Publish to ${label}` : `Connect ${label} in Settings`}
                      >
                        {label}
                      </Btn>
                    );
                  })}
                  <Btn
                    variant="secondary"
                    small
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(copyText);
                        setToast({ type: "success", message: t("contentLibrary.postCopied") });
                      } catch {
                        setToast({ type: "error", message: t("contentLibrary.copyFailed") });
                      }
                    }}
                  >
                    {t("contentLibrary.copyPost")}
                  </Btn>
                </div>
              </div>
              <p className={`whitespace-pre-wrap text-sm leading-relaxed ${isDark ? "text-slate-200" : "text-gray-700"}`}>{post.content}</p>
              {post.hashtags.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-1">
                  {post.hashtags.map((hashtag) => (
                    <span key={hashtag} className={`rounded-full px-2.5 py-1 text-xs font-medium ${isDark ? "bg-slate-800 text-indigo-200" : "bg-indigo-50 text-indigo-700"}`}>
                      {hashtag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className={`flex justify-end border-t p-3 ${isDark ? "border-white/10 bg-[#0F172A]" : "border-gray-100 bg-gray-50"}`}>
        <Btn variant="secondary" onClick={() => setViewingCampaignContent(null)}>
          {t("common.close")}
        </Btn>
      </div>
    </div>
  </div>
)}

{viewingProposal && (
  <div className="fixed inset-0 z-50 flex items-center justify-center">
    <div
      className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      onClick={() => {
        setViewingProposal(null);
        setEditingProposal(null);
      }}
    />

    <div className={`relative rounded-2xl shadow-2xl w-full max-w-4xl mx-4 max-h-[92vh] overflow-y-auto ${isDark ? "bg-slate-800 border border-white/10" : "bg-white"}`}>
      <div className={`flex items-center justify-between p-3 border-b ${isDark ? "border-white/10" : "border-gray-100"}`}>
        <div>
          {editingProposal ? (
            <Input
              value={editingProposal.draftTitle || ""}
              onChange={(event) => setEditingProposal((current) => ({ ...current, draftTitle: event.target.value }))}
              placeholder={t("contentLibrary.proposalTitle")}
            />
          ) : (
            <h2 className={`text-lg font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>{viewingProposal.title}</h2>
          )}
          <p className={`text-xs ${isDark ? "text-slate-400" : "text-gray-400"}`}>
            {editingProposal ? t("contentLibrary.editProposal") : t("contentLibrary.proposalPreview")}
          </p>
          {!editingProposal && (
            <div className={`mt-3 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium shadow-sm ${proposalStatusColor(viewingProposal.proposal_status || "Generada")}`}>
              <select
                value={viewingProposal.proposal_status || "Generada"}
                onChange={(event) => handleProposalStatusChange(viewingProposal, event.target.value)}
                className="cursor-pointer appearance-none border-0 bg-transparent pr-5 text-xs font-medium text-current outline-none"
              >
                {PROPOSAL_STATUSES.map((proposalStatus) => (
                  <option key={proposalStatus.value} value={proposalStatus.value} className="bg-white text-slate-900">
                    {t(`contentLibrary.proposalStatuses.${proposalStatus.labelKey}`)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <button
          onClick={() => {
            setViewingProposal(null);
            setEditingProposal(null);
          }}
          className={`p-1.5 rounded-lg transition-colors ${isDark ? "hover:bg-slate-700" : "hover:bg-gray-100"}`}
        >
          <XIcon size={16} className="text-gray-400" />
        </button>
      </div>

      <div className={`p-6 ${isDark ? "text-slate-200" : "text-gray-700"}`}>
        {editingProposal ? (
          <div
            ref={proposalEditorRef}
            className="min-h-[62vh] max-h-[68vh] w-full overflow-y-auto rounded-xl border border-gray-200 bg-white p-6 text-left text-sm text-gray-700 shadow-sm prose prose-slate max-w-none"
            contentEditable
            suppressContentEditableWarning
            onInput={(event) => {
              const html = event.currentTarget?.innerHTML ?? "";
              setEditingProposal((current) => (current ? { ...current, draftContent: html } : current));
            }}
          />
        ) : (
          <ProposalDocumentPreview
            proposal={viewingProposal}
            exportRef={viewingProposalPreviewRef}
            className={`min-h-[62vh] max-h-[68vh] overflow-y-auto rounded-xl border p-6 shadow-sm ${isDark ? "border-white/10 bg-slate-800" : "border-gray-200 bg-white"}`}
          />
        )}
      </div>
      <div className={`flex justify-end gap-1 p-3 border-t rounded-b-2xl ${isDark ? "border-white/10 bg-[#0F172A]" : "border-gray-100 bg-gray-50"}`}>
        {editingProposal ? (
          <>
            <Btn variant="ghost" onClick={() => setEditingProposal(null)}>{t("common.cancel")}</Btn>
            <Btn onClick={async () => {
              try {
                // Drop the proposal's previous structuredContent before re-deriving
                // it: normalizeProposalDocument() prefers structuredContent.* over
                // re-parsing `content`, so keeping the stale structure here would
                // make it ignore everything just typed in the HTML editor.
                const { structuredContent: _staleStructured, structured_content: _staleStructuredSnake, ...editedProposalBase } = editingProposal;
                const draftContent = editingProposal.draftContent || editingProposal.content || "";
                // The big <h1> inside the editable canvas is what users actually
                // see and edit; the small title Input above it is easy to miss.
                // If they typed a new title into the document body, that wins —
                // otherwise fall back to the separate title field.
                const finalTitle = extractH1Text(draftContent) || editingProposal.draftTitle;
                const editedProposal = { ...editedProposalBase, title: finalTitle, content: draftContent };
                const structuredContent = normalizeProposalDocument(editedProposal);
                const professionalContent = proposalDocumentToHtml({ ...editedProposal, structuredContent });
                const updatedTotal = calculateProposalTotal({ ...editedProposal, structuredContent });
                await updateProposal(editingProposal.id, {
                  title: finalTitle,
                  description: editingProposal.description || "",
                  content: professionalContent,
                  structured_content: structuredContent,
                  status: editingProposal.status,
                  total_amount: updatedTotal.totalAmount,
                });
                const nextProposal = { ...viewingProposal, title: finalTitle, content: professionalContent, structuredContent, totalAmount: updatedTotal.totalAmount };
                setProposals((current) => current.map((proposal) => proposal.id === editingProposal.id ? nextProposal : proposal));
                setViewingProposal(nextProposal);
                setEditingProposal(null);
              } catch (error) {
                console.error(error);
                setToast({ type: "error", message: t("contentLibrary.saveChangesFailed") });
              }
            }}>{t("contentLibrary.saveChanges")}</Btn>
          </>
        ) : (
          <>
            <Btn variant="secondary" onClick={() => setViewingProposal(null)}>{t("common.close")}</Btn>
            <Btn variant="secondary" icon={<PenIcon size={12} />} onClick={() => openProposalHtmlEditor(viewingProposal)}>{t("contentLibrary.editProposal")}</Btn>
            <Btn variant="secondary" icon={<PenIcon size={12} />} onClick={() => openStructuredProposalEditor(viewingProposal)}>{createT.editStructure}</Btn>
            <Btn variant="secondary" onClick={() => downloadItem(viewingProposal, "docx")}>{createT.downloadDocx}</Btn>
            <Btn onClick={() => downloadItem(viewingProposal, "pdf")}>{createT.downloadPdf}</Btn>
            <Btn variant="teal" icon={<PlugIcon size={12} />} onClick={() => handleUploadToCrm(viewingProposal)} disabled={crmSending}>{crmSending ? "Sending..." : createT.uploadCrm}</Btn>
          </>
        )}
      </div>
    </div>
  </div>
)}
{/* ── Client email prompt (asked before the first CRM send) ── */}
{crmEmailPrompt && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
    <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl">
      <div className="border-b border-gray-100 p-5">
        <p className="text-sm font-semibold text-gray-900">Client email required</p>
        <p className="text-xs text-gray-500">HubSpot needs an email to create or update this client's contact.</p>
      </div>
      <div className="p-5">
        <Field label="Client email">
          <Input
            type="email"
            autoFocus
            value={crmEmailPrompt.email}
            onChange={(event) => setCrmEmailPrompt((current) => ({ ...current, email: event.target.value }))}
            placeholder="client@company.com"
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2 border-t border-gray-100 bg-gray-50 p-4">
        <Btn variant="ghost" onClick={() => setCrmEmailPrompt(null)}>{t("common.cancel")}</Btn>
        <Btn icon={<PlugIcon size={12} />} onClick={confirmCrmEmailPrompt} disabled={!crmEmailPrompt.email.trim() || crmEmailPromptSaving}>
          {crmEmailPromptSaving ? "Sending..." : "Save & send"}
        </Btn>
      </div>
    </div>
  </div>
)}
{/* ── Edit Proposal Modal ── */}
{false && editingProposal && (
  <div className="fixed inset-0 z-50 flex items-center justify-center">
    <div
      className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      onClick={() => setEditingProposal(null)}
    />

    <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-3">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        {t("contentLibrary.editProposal")}
      </h2>

      <div className="space-y-1.5">
        <Input
          value={editingProposal.draftTitle || ""}
          onChange={(e) =>
            setEditingProposal({
            ...editingProposal,
            draftTitle: e.target.value,
            })
         }
        placeholder={t("contentLibrary.proposalTitle")}
    />
      <div
        className="w-full border border-gray-300 rounded-lg px-4 py-4 text-sm text-left max-h-80 min-h-64 overflow-y-auto bg-white prose prose-slate max-w-none"
        contentEditable
        suppressContentEditableWarning
        dangerouslySetInnerHTML={{
           __html: editingProposal.draftContent || "",
        }}
          onBlur={(e) =>
          setEditingProposal({
          ...editingProposal,
          draftContent: e.currentTarget.innerHTML,
        })
      }
        placeholder={t("contentLibrary.editProposalContent")}
      />
        <div className="flex justify-end gap-1 pt-3">
          <Btn variant="ghost" onClick={() => setEditingProposal(null)}>
            {t("common.cancel")}
          </Btn>

        <Btn
          onClick={async () => {
            const editedProposal = {
              ...editingProposal,
              title: editingProposal.draftTitle,
              content: editingProposal.draftContent || editingProposal.content || "",
            };
            const structuredContent = normalizeProposalDocument(editedProposal);
            const professionalContent = proposalDocumentToHtml({ ...editedProposal, structuredContent });
            const updatedTotal = calculateProposalTotal({ ...editedProposal, structuredContent });
            try {
              const updatedProposal = await updateProposal(editingProposal.id, {
                title: editingProposal.draftTitle,
                description: editingProposal.description || "",
                content: professionalContent,
                structured_content: structuredContent,
                status: editingProposal.status,
                total_amount: updatedTotal.totalAmount,
                });

                 const refreshed = await getProposals().catch(() => null);
                 if (Array.isArray(refreshed)) {
                   setProposals(refreshed);
                 } else {
                   setProposals((prev) =>
                     prev.map((proposal) =>
                       proposal.id === editingProposal.id
                         ? {
                             ...proposal,
                             title: editingProposal.draftTitle,
                             content: professionalContent,
                             structuredContent,
                             description: editingProposal.description || proposal.description,
                             status: editingProposal.status || proposal.status,
                             totalAmount: updatedTotal.totalAmount,
                           }
                         : proposal,
                     ),
                   );
                 }

                 setEditingProposal(null);
                } catch (error) {
                  console.error(error);
                  setProposals((prev) =>
                    prev.map((proposal) =>
                      proposal.id === editingProposal.id
                        ? {
                            ...proposal,
                            title: editingProposal.draftTitle,
                            content: professionalContent,
                            structuredContent,
                            description: editingProposal.description || proposal.description,
                            status: editingProposal.status || proposal.status,
                            totalAmount: updatedTotal.totalAmount,
                          }
                        : proposal,
                    ),
                  );
                  setEditingProposal(null);
                }
              }}
            >
              {t("contentLibrary.saveChanges")}
          </Btn>
        </div>
      </div>
    </div>
  </div>
)}
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


function ContentGeneratorPage() {
  const { t, language } = useI18n();
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const defaultBookForm = {
    title: t("books.defaultTitle"),
    description: t("books.defaultDescription"),
    keywords: t("books.defaultKeywords"),
    chapterCount: 5,
  };
  const previousBookDefaultsRef = useRef(defaultBookForm);
  const [bookView, setBookView] = useState("creating");
  const [savedBooks, setSavedBooks] = useState([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [book, setBook] = useState(null);
  const [chapters, setChapters] = useState([]);
  const [activeBookStep, setActiveBookStep] = useState(1);
  const [job, setJob] = useState(null);
  const [jobTitle, setJobTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [editableChapters, setEditableChapters] = useState([]);
  const [contentDrafts, setContentDrafts] = useState({});
  const [refineText, setRefineText] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPage, setPreviewPage] = useState(0);
  const [toast, setToast] = useState("");
  const [activeChapterId, setActiveChapterId] = useState(null);
  const [assets, setAssets] = useState([]);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [loadingRefine, setLoadingRefine] = useState(false);
  const [regenerateStatus, setRegenerateStatus] = useState(null);
  const [deletedChapterIds, setDeletedChapterIds] = useState([]);
  const [form, setForm] = useState(defaultBookForm);
  const [bookLanguage, setBookLanguage] = useState(language || getStoredPreference(PREF_KEYS.language, "en"));
  const [bookLanguageManuallySelected, setBookLanguageManuallySelected] = useState(false);

  const updateForm = (field) => (event) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
  };

  useEffect(() => {
    if (!bookLanguageManuallySelected) {
      setBookLanguage(language || getStoredPreference(PREF_KEYS.language, "en"));
    }
  }, [language, bookLanguageManuallySelected]);

  useEffect(() => {
    const previousDefaults = previousBookDefaultsRef.current;
    setForm((current) => ({
      ...current,
      title: current.title === previousDefaults.title ? defaultBookForm.title : current.title,
      description: current.description === previousDefaults.description ? defaultBookForm.description : current.description,
      keywords: current.keywords === previousDefaults.keywords ? defaultBookForm.keywords : current.keywords,
    }));
    previousBookDefaultsRef.current = defaultBookForm;
  }, [language]);

  const toastTimer = useRef(null);
  function showToast(message) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2200);
  }

  async function loadLibrary() {
    setLoadingLibrary(true);
    try {
      const { data } = await api.get("/books", { suppressPermissionToast: true });
      setSavedBooks(data.books || data.data || data || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingLibrary(false);
    }
  }

  useEffect(() => {
    if (bookView === "library") loadLibrary();
  }, [bookView]);

  const formatRelativeBookDate = (value) => {
    if (!value) return "Recently";
    const raw = value?._seconds ? value._seconds * 1000 : value;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return "Recently";
    const diffMs = Date.now() - date.getTime();
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays <= 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 30) return `${diffDays} days ago`;
    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths === 1) return "1 month ago";
    if (diffMonths < 12) return `${diffMonths} months ago`;
    const diffYears = Math.floor(diffMonths / 12);
    return diffYears === 1 ? "1 year ago" : `${diffYears} years ago`;
  };

  const bookStatusColor = (status = "draft") => {
    if (status === "published") return "bg-green-100 text-green-700";
    return "bg-yellow-100 text-yellow-700";
  };

  const openSavedBook = async (bookId) => {
    const loaded = await loadBook(bookId);
    if (loaded) {
      setForm({
        title: loaded.title || "",
        description: loaded.description || "",
        keywords: Array.isArray(loaded.keywords) ? loaded.keywords.join(", ") : (loaded.keywords || ""),
        chapterCount: (loaded.chapters && loaded.chapters.length) || 5,
      });
      if (loaded.chapters && loaded.chapters.length > 0) {
        const hasContent = loaded.chapters.some((c) => c.content?.trim());
        setActiveBookStep(hasContent ? 3 : 2);
      } else {
        setActiveBookStep(1);
      }
    }
    setBookView("creating");
  };

  const deleteSavedBook = async (bookId) => {
    try {
      await api.delete(`/books/${bookId}`, { suppressPermissionToast: true });
      await loadLibrary();
    } catch (e) {
      console.error(e);
    }
  };

  async function loadAssets() {
    if (!book?.id) return;
    setLoadingAssets(true);
    try {
      const { data } = await api.get("/assets", { params: { book_id: book.id }, suppressPermissionToast: true });
      setAssets(data.items || data.assets || data.data || data || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingAssets(false);
    }
  }

  const demoChapters = () => Array.from({ length: Number(form.chapterCount) || 5 }, (_, index) => ({
    id: `demo-chapter-${index + 1}`,
    title: [
      "Fundamentos del Marketing con IA",
      "Automatización de Campañas",
      "Creación de Contenido con IA",
      "Segmentación y Personalización",
      "Medición, Análisis y Optimización",
    ][index] || `${t("books.chapter")} ${index + 1}`,
    description: [
      "Introducción al rol de la IA en marketing: casos de uso, beneficios y mitos. Tono divulgativo para un lector B2B.",
      "Cómo diseñar flujos automatizados de email, anuncios y nurturing. Incluir ejemplos de triggers y segmentos dinámicos.",
      "Frameworks para generar borradores, mantener la voz de marca y editar con IA. Tono práctico, orientado a producción.",
      "Modelos de segmentación dinámica y personalización 1:1 a escala. Explicar datos necesarios y privacidad.",
      "KPIs, atribución y ciclos de experimentación. Cerrar el libro con un plan de mejora continua.",
    ][index] || t("books.noPreviewContent"),
    orderIndex: index,
    status: "generated",
  }));

  const normalizeBookChapters = (items = []) => [...items].sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0));

  const applyBookChapters = (items = []) => {
    const sortedChapters = normalizeBookChapters(items);
    setChapters(sortedChapters);
    setEditableChapters(sortedChapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title || "",
      description: chapter.description || "",
    })));
    setContentDrafts(Object.fromEntries(sortedChapters.map((chapter) => [chapter.id, stripHtml(chapter.content || "")])));
    return sortedChapters;
  };

  const runDemoJob = (title, onComplete) => {
    const jobId = `demo-${Date.now()}`;
    setJobTitle(title);
    setJob({ id: jobId, status: "processing", progress: 10 });

    [35, 65, 100].forEach((progress, index) => {
      setTimeout(() => {
        setJob({
          id: jobId,
          status: progress === 100 ? "completed" : "processing",
          progress,
        });
        if (progress === 100) onComplete?.();
      }, (index + 1) * 650);
    });
  };

  const loadBook = async (bookId) => {
    const { data } = await api.get(`/books/${bookId}`, { suppressPermissionToast: true });
    let sortedChapters = normalizeBookChapters(data.chapters || []);
    if (sortedChapters.length === 0) {
      try {
        const chaptersResponse = await api.get(`/books/${bookId}/chapters`, { suppressPermissionToast: true });
        const chapterData = chaptersResponse.data?.chapters || chaptersResponse.data?.data || chaptersResponse.data || [];
        sortedChapters = normalizeBookChapters(Array.isArray(chapterData) ? chapterData : []);
      } catch (error) {
        if (![401, 403, 404, 500].includes(error.response?.status)) throw error;
      }
    }
    setBook(data);
    applyBookChapters(sortedChapters);
    return { ...data, chapters: sortedChapters };
  };

  useEffect(() => {
    if (!job?.id || ["completed", "failed", "error"].includes(job.status)) return undefined;

    const timer = setInterval(async () => {
      try {
        const { data } = await api.get(`/jobs/${job.id}`, { suppressPermissionToast: true });
        setJob(prev => ({ ...data, _kind: prev?._kind || '' }));
        if (data.status === "completed" && book?.id) {
          const kind = job?._kind || '';
          await loadBook(book.id);
          setContentDrafts((prev) => {
            const cleaned = {};
            Object.entries(prev).forEach(([key, value]) => { cleaned[key] = stripHtml(value); });
            return cleaned;
          });
          if (kind === 'chapters') setActiveBookStep(2);
          if (kind === 'content') {
            setActiveBookStep(3);
          }
          if (kind === 'export') {
            setActiveBookStep(4);
            await loadAssets();
          }
          setJob(prev => ({ ...data, _kind: prev?._kind || '' }));
        }
      } catch (error) {
        console.error(error);
      }
    }, 2000);

    return () => clearInterval(timer);
  }, [job?.id, job?.status, book?.id]);

  useEffect(() => {
    if (!activeChapterId || !chapters.some((chapter) => chapter.id === activeChapterId)) {
      if (chapters.length > 0) setActiveChapterId(chapters[0].id);
    }
  }, [activeChapterId, chapters]);

  useEffect(() => {
    if (activeBookStep === 4 && book?.id) loadAssets();
  }, [activeBookStep, book?.id]);

  const createDraftBook = async (forceNew = false) => {
    if (book?.id && !forceNew) return book;
    const { data } = await api.post("/books", {
        title: form.title,
        description: form.description,
        keywords: form.keywords.split(",").map((item) => item.trim()).filter(Boolean),
    }, { suppressPermissionToast: true });
    setBook(data);
    setChapters([]);
    setEditableChapters([]);
    setContentDrafts({});
    setJob(null);
    return data;
  };

  const createBook = async () => {
    setLoading(true);
    try {
      const data = await createDraftBook(true);
      await startJob(
        t("books.jobs.chapters"),
        `/books/${data.id}/chapters/generate`,
        { chapterCount: Number(form.chapterCount) || 5, language: bookLanguage, sync: true },
        "chapters",
        { bookId: data.id },
      );
      await loadBook(data.id);
      setActiveBookStep(2);
    } catch (error) {
      if (![401, 403].includes(error.response?.status)) throw error;
      const demo = demoChapters();
      setBook({
        id: `demo-book-${Date.now()}`,
        title: form.title,
        description: form.description,
        keywords: form.keywords.split(",").map((item) => item.trim()).filter(Boolean),
        status: "generated",
      });
      setChapters(demo.map((chapter) => ({ ...chapter, status: "generated", content: `<h2>${chapter.title}</h2><p>${chapter.description}</p>` })));
      setEditableChapters(demo.map((chapter) => ({ id: chapter.id, title: chapter.title, description: chapter.description || "" })));
      setContentDrafts(Object.fromEntries(demo.map((chapter) => [chapter.id, stripHtml(`<h2>${chapter.title}</h2><p>${chapter.description}</p>`)])));
      setJob(null);
      setActiveBookStep(2);
    } finally {
      setLoading(false);
    }
  };

  const startJob = async (title, endpoint, payload = {}, jobKind = "", options = {}) => {
    const targetBookId = options.bookId || book?.id;
    if (!targetBookId) return null;
    setLoading(true);
    try {
      const { data } = await api.post(endpoint, payload, { suppressPermissionToast: true, timeout: 0 });
      const jobId = data.job_id || data.jobId || data.id;
      setJobTitle(title);
      setJob({ id: jobId, status: data.status || "pending", progress: 0, _kind: jobKind });
      if (payload.sync && jobId) {
        const jobResponse = await api.get(`/jobs/${jobId}`, { suppressPermissionToast: true });
        const jobData = { ...jobResponse.data, _kind: jobKind };
        setJob(jobData);
        if (jobData.status === 'completed') {
          const latestBook = await loadBook(targetBookId);
          if (jobKind === 'chapters') {
            if ((latestBook?.chapters || []).length === 0) applyBookChapters(demoChapters());
            setActiveBookStep(2);
          }
          if (jobKind === 'content') {
            setContentDrafts((prev) => {
              const cleaned = {};
              Object.entries(prev).forEach(([k, v]) => { cleaned[k] = stripHtml(v); });
              return cleaned;
            });
            setActiveBookStep(3);
          }
          if (jobKind === 'export') {
            setActiveBookStep(4);
            await loadAssets();
          }
        }
        // Si no completó, el useEffect de polling detectará _kind y avanzará cuando termine
      }
      return data;
    } catch (error) {
      if (![401, 403, 404, 500].includes(error.response?.status)) throw error;
      if (jobKind === "chapters") {
        runDemoJob(title, () => {
          const demo = demoChapters();
          setChapters(demo);
          setEditableChapters(demo.map((chapter) => ({ id: chapter.id, title: chapter.title, description: chapter.description || "" })));
          setContentDrafts(Object.fromEntries(demo.map((chapter) => [chapter.id, stripHtml(chapter.content || "")])));
          setBook((current) => ({ ...current, status: "outlined" }));
          setActiveBookStep(2);
        });
      } else if (jobKind === "content") {
        runDemoJob(title, () => {
          setChapters((current) => {
            const next = current.map((chapter) => ({ ...chapter, status: "generated", content: chapter.content || `<h2>${chapter.title}</h2><p>${chapter.description || ""}</p>` }));
            setContentDrafts(Object.fromEntries(next.map((chapter) => [chapter.id, stripHtml(chapter.content || "")])));
            return next;
          });
          setBook((current) => ({ ...current, status: "generated" }));
          setActiveBookStep(3);
        });
      } else {
        runDemoJob(title, () => setActiveBookStep(4));
      }
      return null;
    } finally {
      setLoading(false);
    }
  };

  const generateChapters = async () => {
    let targetBook = book;
    if (!targetBook?.id) {
      setLoading(true);
      try {
        targetBook = await createDraftBook();
      } catch (error) {
        if (![401, 403].includes(error.response?.status)) throw error;
        const demoBook = {
          id: `demo-book-${Date.now()}`,
          title: form.title,
          description: form.description,
          keywords: form.keywords.split(",").map((item) => item.trim()).filter(Boolean),
          status: "draft",
        };
        setBook(demoBook);
        targetBook = demoBook;
      } finally {
        setLoading(false);
      }
    }
    const result = await startJob(
      t("books.jobs.chapters"),
      `/books/${targetBook.id}/chapters/generate`,
      { chapterCount: Number(form.chapterCount) || 5, language: bookLanguage, sync: true },
      "chapters",
      { bookId: targetBook.id },
    );
    if (targetBook?.id && !String(targetBook.id).startsWith("demo-")) {
      try { await loadBook(targetBook.id); } catch (_) {}
    }
    setActiveBookStep(2);
    return result;
  };

  const generateContent = () => startJob(
    t("books.jobs.content"),
    `/books/${book.id}/content/generate`,
    { contentType: "long", style: "professional", language: bookLanguage, sync: true },
    "content",
  );

  const exportBook = () => {
    setActiveBookStep(4);
    return startJob(
      t("books.jobs.export"),
      `/books/${book.id}/assets/whitepaper`,
      { bookId: book.id, chapterIds: chapters.map((chapter) => chapter.id), language: bookLanguage },
      "export",
    );
  };

  const generateOnePager = () => startJob(
    "Generating one-pager...",
    `/books/${book.id}/assets/one-pager`,
    {
      bookId: book.id,
      style: "professional",
      language: bookLanguage,
    },
    "export",
  );

  const generateSocialPosts = () => startJob(
    "Generating social posts...",
    `/books/${book.id}/assets/social-posts`,
    {
      bookId: book.id,
      chapterId: activeChapterId && !String(activeChapterId).startsWith("local-") && !String(activeChapterId).startsWith("demo-chapter-")
        ? activeChapterId
        : undefined,
      platforms: ["linkedin", "twitter", "facebook"],
      tone: "professional",
      language: bookLanguage,
    },
    "export",
  );

  const generateInfographic = () => startJob(
    "Generating infographic...",
    `/books/${book.id}/assets/infographic`,
    {
      bookId: book.id,
      chapterId: activeChapterId && !String(activeChapterId).startsWith("local-") && !String(activeChapterId).startsWith("demo-chapter-")
        ? activeChapterId
        : undefined,
      style: "modern",
      language: bookLanguage,
    },
    "export",
  );

  const regenerateAllAssets = async () => {
    if (!book?.id) return;
    setRegenerateStatus(Object.fromEntries(ASSET_REGENERATION_TYPES.map((asset) => [asset.key, "pending"])));

    const results = await Promise.allSettled(
      ASSET_REGENERATION_TYPES.map((asset) => api.post(
        `/books/${book.id}/${asset.path}`,
        {
          bookId: book.id,
          ...(asset.key === "whitepaper" ? { chapterIds: chapters.map((chapter) => chapter.id) } : {}),
          language: bookLanguage,
          ...(asset.forceRegenerate ? { forceRegenerate: true } : {}),
          variationInstruction: ASSET_REGENERATION_VARIATION_INSTRUCTION,
        },
        { suppressPermissionToast: true, timeout: 0 },
      )),
    );

    const nextStatus = {};
    const failed = [];
    results.forEach((result, index) => {
      const asset = ASSET_REGENERATION_TYPES[index];
      nextStatus[asset.key] = result.status === "fulfilled" ? "success" : "error";
      if (result.status === "rejected") {
        failed.push(asset);
        console.error(`regenerateAllAssets: ${asset.key} failed`, result.reason);
      }
    });
    setRegenerateStatus(nextStatus);

    await loadAssets();

    if (failed.length === 0) {
      showToast(t("books.regenerateAllSuccess"));
    } else {
      showToast(`${t("books.regenerateAllPartialError")}: ${failed.map((asset) => t(`books.${asset.labelKey}`)).join(", ")}`);
    }
  };

  const saveChapterChanges = async (stayOnStep = true) => {
    if (!book?.id) return;
    setLoading(true);
    try {
      if (editableChapters.some((chapter) => String(chapter.id).startsWith("demo-chapter-"))) {
        const nextChapters = editableChapters.map((chapter, index) => {
          const existing = chapters.find((item) => item.id === chapter.id) || {};
          return {
            ...existing,
            ...chapter,
            orderIndex: index,
            status: existing.status || "generated",
          };
        });
        applyBookChapters(nextChapters);
        if (stayOnStep) setActiveBookStep(2);
        return;
      }

      const localChapterIds = editableChapters
        .filter((chapter) => String(chapter.id).startsWith("local-"))
        .map((chapter) => chapter.id);

      const serverDeleteIds = deletedChapterIds.filter((id) => !String(id).startsWith("local-"));
      for (const chapterId of serverDeleteIds) {
        try {
          await api.delete(`/books/${book.id}/chapters/${chapterId}`, { suppressPermissionToast: true });
        } catch (e) {
          console.error('[BookConcepts] delete chapter error', e, chapterId);
        }
      }
      if (serverDeleteIds.length) setDeletedChapterIds([]);

      const idMap = {};
      for (const chapter of editableChapters) {
        if (localChapterIds.includes(chapter.id)) {
          try {
            const { data } = await api.post(
              `/books/${book.id}/chapters`,
              { title: chapter.title, description: chapter.description },
              { suppressPermissionToast: true },
            );
            if (data?.id) idMap[chapter.id] = data.id;
          } catch (e) {
            console.error('[BookConcepts] create local chapter error', e, chapter.id);
          }
        }
      }

      const updatePromises = editableChapters.map((chapter) => {
        const serverId = idMap[chapter.id] || chapter.id;
        if (String(serverId).startsWith("local-")) return Promise.resolve();
        return api.put(
          `/books/${book.id}/chapters/${serverId}`,
          { title: chapter.title, description: chapter.description },
          { suppressPermissionToast: true },
        );
      });
      await Promise.all(updatePromises);

      const orderIds = editableChapters
        .map((chapter) => idMap[chapter.id] || chapter.id)
        .filter((id) => !String(id).startsWith("local-"));
      const existingServerIds = chapters.filter((chapter) => !String(chapter.id).startsWith("local-")).map((chapter) => chapter.id);
      if (orderIds.length && orderIds.length === existingServerIds.length) {
        try {
          await api.put(
            `/books/${book.id}/chapters/reorder`,
            { chapterIds: orderIds },
            { suppressPermissionToast: true },
          );
        } catch (e) {
          console.error('[BookConcepts] reorder error', e);
        }
      }

      await loadBook(book.id);
      if (stayOnStep) setActiveBookStep(2);
    } finally {
      setLoading(false);
    }
  };

  function stripHtml(html) {
    if (!html) return "";
    return html
      .replace(/<h[1-6][^>]*>/gi, "\n\n")
      .replace(/<\/h[1-6]>/gi, "\n")
      .replace(/<p[^>]*>/gi, "")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const saveContentChanges = async () => {
    if (!book?.id) return;
    setLoading(true);
    try {
      await Promise.all(chapters.map((chapter) => api.put(
        `/books/${book.id}/chapters/${chapter.id}/content`,
        { content: contentDrafts[chapter.id] || "" },
        { suppressPermissionToast: true },
      )));
      await loadBook(book.id);
      setActiveBookStep(3);
    } finally {
      setLoading(false);
    }
  };

  async function refineActiveChapter() {
    const chapter = editableChapters?.find((item) => item.id === activeChapterId)
      || chapters.find((item) => item.id === activeChapterId);
    if (!book?.id || !chapter?.id || !refineText.trim()) return;
    setLoadingRefine(true);
    try {
      const { data } = await api.post(
        `/books/${book.id}/chapters/${chapter.id}/content/refine`,
        { instruction: refineText, language: bookLanguage },
        { suppressPermissionToast: true },
      );
      const refined = data.content || data.refinedContent || data.result || "";
      if (refined) {
        setContentDrafts((current) => ({ ...current, [chapter.id]: stripHtml(refined) }));
        showToast("Sección refinada");
      }
      setRefineText("");
    } catch (error) {
      console.error(error);
    } finally {
      setLoadingRefine(false);
    }
  }

  const canOpenStep = (step) => {
    if (step === 1) return true;
    if (step === 2) return Boolean(book?.id);
    if (step === 3) return chapters.length > 0;
    return Boolean(book?.id && chapters.length > 0);
  };

  const goToBookStep = (step) => {
    if (canOpenStep(step)) setActiveBookStep(step);
  };

  if (bookView === "library") {
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold" style={{ color: isDark ? '#F1F5F9' : '#0F172A' }}>{t("books.libraryTitle")}</h1>
            <p className="text-xs" style={{ color: isDark ? '#94A3B8' : '#64748B' }}>{t("books.subtitle")}</p>
          </div>
          <Btn onClick={() => setBookView("creating")}>{t("books.newBook")}</Btn>
        </div>

        {loadingLibrary ? (
          <div style={{ background: isDark ? '#1E293B' : '#fff', borderRadius: 14, border: `1px solid ${isDark ? '#334155' : '#eaecf3'}`, padding: '48px 24px', textAlign: 'center' }}>
            <p style={{ fontSize: 14, color: isDark ? '#94A3B8' : '#64748B', fontWeight: 500, margin: 0 }}>Loading books...</p>
          </div>
        ) : savedBooks.length === 0 ? (
          <div className="rounded-2xl border p-10 text-center shadow-sm" style={{ background: isDark ? '#1E293B' : '#fff', borderColor: isDark ? '#334155' : '#eaecf3' }}>
            <p className="text-sm font-medium" style={{ color: isDark ? '#94A3B8' : '#64748B' }}>{t("books.noBooksYet")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {savedBooks.map((savedBook) => (
              <div key={savedBook.id} className="rounded-2xl border p-5 shadow-sm" style={{ background: isDark ? '#1E293B' : '#fff', borderColor: isDark ? '#334155' : '#eaecf3' }}>
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold" style={{ color: isDark ? '#F1F5F9' : '#0F172A' }}>{savedBook.title}</p>
                    <p className="mt-1 text-xs" style={{ color: isDark ? '#94A3B8' : '#64748B' }}>{formatRelativeBookDate(savedBook.createdAt)}</p>
                  </div>
                  <Badge label={savedBook.status || "draft"} color={bookStatusColor(savedBook.status)} />
                </div>
                <p className="mb-4 line-clamp-2 text-xs" style={{ color: isDark ? '#94A3B8' : '#64748B' }}>{savedBook.description}</p>
                <div className="flex justify-end gap-2">
                  <Btn small variant="secondary" onClick={() => openSavedBook(savedBook.id)}>{t("books.open")}</Btn>
                  <Btn small variant="ghost" className="text-red-500 hover:bg-red-50 hover:text-red-700" onClick={() => deleteSavedBook(savedBook.id)}>{t("books.delete")}</Btn>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const stepLabels = [
    t("books.defineConcept"),
    t("books.defineChapters"),
    t("books.generateEditContent"),
    t("books.generateMarketingAssets"),
  ];
  const chaptersForOutline = editableChapters.length ? editableChapters : chapters;
  const activeChapter = chapters.find((chapter) => chapter.id === activeChapterId) || chapters[0];
  const activeChapterIndex = activeChapter ? chapters.findIndex((chapter) => chapter.id === activeChapter.id) : -1;
  const activeContent = activeChapter ? (contentDrafts[activeChapter.id] || activeChapter.content || "") : "";
  const generatedChapters = chapters.filter((chapter) => contentDrafts[chapter.id] || chapter.content).length;
  const totalWords = chapters.reduce((sum, chapter) => {
    const text = (contentDrafts[chapter.id] || chapter.content || "").replace(/<[^>]+>/g, " ");
    return sum + text.trim().split(/\s+/).filter(Boolean).length;
  }, 0);
  const previewPages = chapters.filter((chapter) => contentDrafts[chapter.id] || chapter.content);
  const currentPreviewChapter = previewPages[previewPage] || previewPages[0];

  return (
    <BookConceptsExperience
      activeBookStep={activeBookStep}
      activeChapterId={activeChapterId}
      setActiveChapterId={setActiveChapterId}
      assets={assets}
      book={book}
      bookLanguage={bookLanguage}
      bookLanguageManuallySelected={bookLanguageManuallySelected}
      chapters={chapters}
      chaptersForOutline={chaptersForOutline}
      contentDrafts={contentDrafts}
      createBook={createBook}
      exportBook={exportBook}
      form={form}
      generatedChapters={generatedChapters}
      generateChapters={generateChapters}
      generateContent={generateContent}
      generateInfographic={generateInfographic}
      generateOnePager={generateOnePager}
      generateSocialPosts={generateSocialPosts}
      goToBookStep={goToBookStep}
      isDark={isDark}
      job={job}
      jobTitle={jobTitle}
      language={language}
      loadAssets={loadAssets}
      loadBook={loadBook}
      loadLibrary={loadLibrary}
      loading={loading}
      loadingAssets={loadingAssets}
      previewOpen={previewOpen}
      previewPage={previewPage}
      refineActiveChapter={refineActiveChapter}
      refineText={refineText}
      regenerateAllAssets={regenerateAllAssets}
      regenerateStatus={regenerateStatus}
      saveChapterChanges={saveChapterChanges}
      saveContentChanges={saveContentChanges}
      setActiveBookStep={setActiveBookStep}
      setBookLanguage={setBookLanguage}
      setBookLanguageManuallySelected={setBookLanguageManuallySelected}
      setBookView={setBookView}
      setChapters={setChapters}
      setContentDrafts={setContentDrafts}
      setDeletedChapterIds={setDeletedChapterIds}
      setEditableChapters={setEditableChapters}
      setPreviewOpen={setPreviewOpen}
      setPreviewPage={setPreviewPage}
      setRefineText={setRefineText}
      showToast={showToast}
      t={t}
      toast={toast}
      totalWords={totalWords}
      updateForm={updateForm}
    />
  );

  return (
    <div className="space-y-5">
      <Btn variant="secondary" small onClick={() => { setBookView("library"); loadLibrary(); }}>
        ← Mis libros
      </Btn>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-500">Book Concepts</p>
          <h1 className="text-xl font-bold text-gray-900">{book?.title || t("sidebar.books")}</h1>
          <p className="text-xs text-gray-500">{book?.id ? `ID: ${book.id}` : t("books.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          {book && <Badge label={book.status || "draft"} color="bg-indigo-100 text-indigo-700" />}
          {book?.id && (
            <Btn variant="ghost" small onClick={() => loadBook(book.id)} icon={<RefreshIcon size={12} />}>
              {t("books.reload")}
            </Btn>
          )}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {stepLabels.map((label, index) => {
          const step = index + 1;
          const active = activeBookStep === step;
          return (
            <button
              key={label}
              onClick={() => goToBookStep(step)}
              disabled={!canOpenStep(step)}
              className={`rounded-xl border px-3 py-2 text-left text-xs transition-colors ${active ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-gray-100 bg-white text-gray-500 hover:bg-gray-50"} ${!canOpenStep(step) ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <span className="font-bold">{t("books.step")} {step}</span>
              <span className="block truncate">{label}</span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4">
          <Card className="p-5 space-y-3">
            <div>
              <p className="text-sm font-semibold text-gray-900">Concepto</p>
              <p className="text-xs text-gray-500">Define la base del libro y avanza por el flujo.</p>
            </div>
            <Field label={t("books.titleField")}>
              <Input value={form.title} onChange={updateForm("title")} />
            </Field>
            <Field label={t("books.description")}>
              <textarea
                rows={4}
                value={form.description}
                onChange={updateForm("description")}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </Field>
            <Field label={t("books.keywords")}>
              <Input value={form.keywords} onChange={updateForm("keywords")} />
            </Field>
            <Field label={t("books.chapterCount")}>
              <Input type="number" min={1} max={15} value={form.chapterCount} onChange={updateForm("chapterCount")} />
            </Field>
            <div className="grid grid-cols-1 gap-2 pt-2">
              <Btn onClick={createBook} disabled={loading} icon={<PlusIcon size={13} />}>
                {t("books.createBook")}
              </Btn>
              <Btn variant="teal" onClick={generateChapters} disabled={loading} icon={<SparkIcon size={13} />}>
                {t("books.generateChapters")}
              </Btn>
              <Btn variant="secondary" onClick={generateContent} disabled={!book || chapters.length === 0 || loading} icon={<PenIcon size={13} />}>
                {t("books.generateContent")}
              </Btn>
              <Btn variant="secondary" onClick={exportBook} disabled={!book || chapters.length === 0 || loading} icon={<DownloadIcon size={13} />}>
                {t("books.exportBook")}
              </Btn>
            </div>
          </Card>

          <Card className="p-5">
            <p className="text-sm font-semibold text-gray-900">Resumen</p>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                <p className="text-lg font-bold text-gray-900">{chapters.length}</p>
                <p className="text-[11px] text-gray-500">Capítulos</p>
              </div>
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                <p className="text-lg font-bold text-gray-900">{generatedChapters}</p>
                <p className="text-[11px] text-gray-500">Con texto</p>
              </div>
              <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                <p className="text-lg font-bold text-gray-900">{totalWords}</p>
                <p className="text-[11px] text-gray-500">Palabras</p>
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          {job?.id && <AsyncJobCard title={jobTitle} job={job} />}

          <Card className="p-5">
            {activeBookStep === 1 && (
              <div className="rounded-xl border border-dashed border-gray-200 p-6">
                <p className="text-sm font-semibold text-gray-900">Define the book concept</p>
                <p className="mt-1 text-xs text-gray-500">
                  Use Create Book for the fast path, or Generate Chapters to start the step-by-step review flow.
                </p>
                {book?.id && (
                  <div className="mt-4 rounded-lg bg-indigo-50 p-3 text-xs text-indigo-700">
                    Current book is saved. Continue with Step 2 to review chapters.
                  </div>
                )}
              </div>
            )}

            {activeBookStep === 2 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">Review and edit chapters</p>
                    <p className="text-xs text-gray-500">Ajusta títulos y descripciones antes de generar contenido.</p>
                  </div>
                  <Btn small onClick={saveChapterChanges} disabled={!book || chapters.length === 0 || loading}>
                    Save changes
                  </Btn>
                </div>
                {chaptersForOutline.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-200 py-12 text-center text-sm text-gray-400">
                    {t("books.emptyChapters")}
                  </div>
                ) : (
                  chaptersForOutline.map((chapter, index) => (
                    <div key={chapter.id} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="flex h-6 w-6 items-center justify-center rounded bg-indigo-100 text-xs font-bold text-indigo-700">
                          {index + 1}
                        </span>
                        <Input
                          value={chapter.title}
                          onChange={(event) => setEditableChapters((current) => current.map((item) => (
                            item.id === chapter.id ? { ...item, title: event.target.value } : item
                          )))}
                        />
                      </div>
                      <textarea
                        rows={3}
                        value={chapter.description || ""}
                        onChange={(event) => setEditableChapters((current) => current.map((item) => (
                          item.id === chapter.id ? { ...item, description: event.target.value } : item
                        )))}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  ))
                )}
              </div>
            )}

            {activeBookStep === 3 && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">Generate and edit content</p>
                    <p className="text-xs text-gray-500">Selecciona un capítulo, edita el contenido y refínalo con instrucciones.</p>
                  </div>
                  <div className="flex gap-2">
                    <Btn small variant="secondary" onClick={generateContent} disabled={!book || chapters.length === 0 || loading} icon={<PenIcon size={12} />}>
                      {t("books.generateContent")}
                    </Btn>
                    <Btn small onClick={saveContentChanges} disabled={!book || chapters.length === 0 || loading}>
                      Save changes
                    </Btn>
                    <Btn small variant="secondary" onClick={() => setPreviewOpen(true)} disabled={previewPages.length === 0} icon={<EyeIcon size={12} />}>
                      Preview
                    </Btn>
                  </div>
                </div>

                {chapters.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-200 py-12 text-center text-sm text-gray-400">
                    Generate and validate chapters before editing content.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
                    <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Índice</p>
                      <div className="space-y-1">
                        {chapters.map((chapter, index) => {
                          const selected = (activeChapter?.id || activeChapterId) === chapter.id;
                          const hasContent = Boolean(contentDrafts[chapter.id] || chapter.content);
                          return (
                            <button
                              key={chapter.id}
                              type="button"
                              onClick={() => setActiveChapterId(chapter.id)}
                              className={`w-full rounded-lg px-3 py-2 text-left text-xs transition-colors ${selected ? "bg-indigo-600 text-white" : "text-gray-600 hover:bg-white"}`}
                            >
                              <span className="block font-semibold">{index + 1}. {chapter.title}</span>
                              <span className={selected ? "text-indigo-100" : "text-gray-400"}>
                                {hasContent ? "Contenido generado" : "Pendiente"}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="rounded-xl border border-gray-100 bg-white p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                              Capítulo {activeChapterIndex + 1}
                            </p>
                            <p className="text-sm font-semibold text-gray-900">{activeChapter?.title || "Selecciona un capítulo"}</p>
                          </div>
                          {activeChapter && <Badge label={activeContent ? "generated" : "draft"} color={activeContent ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"} />}
                        </div>
                        <textarea
                          rows={16}
                          value={activeChapter ? activeContent : ""}
                          onChange={(event) => {
                            if (!activeChapter) return;
                            setContentDrafts((current) => ({ ...current, [activeChapter.id]: event.target.value }));
                          }}
                          className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          placeholder="Generated chapter HTML will appear here."
                        />
                      </div>

                      <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-4">
                        <div className="mb-2 flex items-center justify-between">
                          <p className="text-sm font-semibold text-indigo-900">✨ Refinar con IA</p>
                          <Btn small variant="secondary" onClick={refineActiveChapter} disabled={!activeChapter || !activeContent || !refineText.trim() || loadingRefine}>
                            {loadingRefine ? "Refinando..." : "Aplicar"}
                          </Btn>
                        </div>
                        <textarea
                          rows={3}
                          value={refineText}
                          onChange={(event) => setRefineText(event.target.value)}
                          className="w-full rounded-lg border border-indigo-100 bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          placeholder="Ej: Mejora la claridad, agrega tono profesional y resume los párrafos largos."
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeBookStep === 4 && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">Generate marketing assets</p>
                    <p className="text-xs text-gray-500">Crea, previsualiza y descarga los materiales asociados al libro.</p>
                  </div>
                  <div className="flex gap-2">
                    <Btn small variant="secondary" onClick={loadAssets} disabled={!book || loadingAssets} icon={<RefreshIcon size={12} />}>
                      Refresh
                    </Btn>
                    <Btn small onClick={exportBook} disabled={!book || chapters.length === 0 || loading} icon={<SparkIcon size={12} />}>
                      {t("books.generate")}
                    </Btn>
                  </div>
                </div>

                {loadingAssets ? (
                  <div className="rounded-xl border border-dashed border-gray-200 py-12 text-center">
                    <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
                  </div>
                ) : assets.length > 0 ? (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {assets.map((asset) => (
                      <div key={asset.id || asset.url || asset.name} className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                        <div className="mb-3 flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-gray-900">{asset.title || asset.name || asset.type || "Marketing asset"}</p>
                            <p className="mt-1 text-xs text-gray-500">{asset.format || asset.contentType || "Generated asset"}</p>
                          </div>
                          <Badge label={asset.status || "ready"} color="bg-green-100 text-green-700" />
                        </div>
                        <div className="flex gap-2">
                          <Btn small variant="secondary" icon={<EyeIcon size={12} />} disabled={!asset.url} onClick={() => asset.url && window.open(asset.url, "_blank", "noopener,noreferrer")}>
                            {t("books.preview")}
                          </Btn>
                          <Btn small variant="secondary" icon={<DownloadIcon size={12} />} disabled={!asset.url} onClick={() => asset.url && window.open(asset.url, "_blank", "noopener,noreferrer")}>
                            {t("books.download")}
                          </Btn>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    {["One-Pager", "Whitepaper", "Social Summaries", "Infographic"].map((asset) => (
                      <div key={asset} className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <p className="text-sm font-semibold text-gray-900">{asset}</p>
                          <Badge label={t("books.readyToGenerate")} color="bg-indigo-100 text-indigo-700" />
                        </div>
                        <Field label={t("books.template")}>
                          <Select>
                            <option>{t("books.defaultTemplate")} {asset}</option>
                            <option>{t("books.salesStyle")}</option>
                          </Select>
                        </Field>
                        <div className="flex gap-2">
                          <Btn small icon={<SparkIcon size={12} />} onClick={asset === "One-Pager" ? generateOnePager : asset === "Social Summaries" ? generateSocialPosts : asset === "Infographic" ? generateInfographic : exportBook} disabled={!book || loading}>{t("books.generate")}</Btn>
                          <Btn small variant="secondary" icon={<EyeIcon size={12} />} disabled>{t("books.preview")}</Btn>
                          <Btn small variant="secondary" icon={<DownloadIcon size={12} />} disabled>{t("books.download")}</Btn>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 rounded-lg bg-gray-900 px-4 py-2 text-xs font-semibold text-white shadow-lg">
          {toast}
        </div>
      )}

      {previewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/50 p-4">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <div>
                <p className="text-sm font-semibold text-gray-900">{book?.title || "Preview"}</p>
                <p className="text-xs text-gray-500">
                  {currentPreviewChapter ? `${previewPage + 1} / ${previewPages.length}` : "No content"}
                </p>
              </div>
              <Btn small variant="ghost" onClick={() => setPreviewOpen(false)}>
                ✕
              </Btn>
            </div>
            <div className="max-h-[68vh] overflow-y-auto p-6">
              {currentPreviewChapter ? (
                <div>
                  <h2 className="mb-4 text-lg font-bold text-gray-900">{currentPreviewChapter.title}</h2>
                  <div
                    className="prose prose-sm max-w-none text-gray-700"
                    dangerouslySetInnerHTML={{ __html: contentDrafts[currentPreviewChapter.id] || currentPreviewChapter.content || "" }}
                  />
                </div>
              ) : (
                <p className="text-sm text-gray-400">No hay contenido para previsualizar.</p>
              )}
            </div>
            <div className="flex items-center justify-between border-t border-gray-100 px-5 py-4">
              <Btn small variant="secondary" disabled={previewPage <= 0} onClick={() => setPreviewPage((current) => Math.max(current - 1, 0))}>
                Anterior
              </Btn>
              <Btn small variant="secondary" disabled={previewPage >= previewPages.length - 1} onClick={() => setPreviewPage((current) => Math.min(current + 1, previewPages.length - 1))}>
                Siguiente
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-5">
      <Btn variant="secondary" small onClick={() => { setBookView("library"); loadLibrary(); }}>
        ← Mis libros
      </Btn>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("sidebar.books")}</h1>
          <p className="text-xs text-gray-500">{t("books.subtitle")}</p>
        </div>
        {book && <Badge label={book.status || "draft"} color="bg-indigo-100 text-indigo-700" />}
      </div>
      <div className="grid grid-cols-4 gap-2">
        {[t("books.defineConcept"), t("books.defineChapters"), t("books.generateEditContent"), t("books.generateMarketingAssets")].map((label, index) => (
          <button
            key={label}
            onClick={() => goToBookStep(index + 1)}
            disabled={!canOpenStep(index + 1)}
            className={`rounded-xl border px-3 py-2 text-left text-xs ${activeBookStep === index + 1 ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-gray-100 bg-white text-gray-500"} ${!canOpenStep(index + 1) ? "cursor-not-allowed opacity-50" : ""}`}
          >
            <span className="font-bold">{t("books.step")} {index + 1}</span>
            <span className="block">{label}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4">
        <Card className="p-5 space-y-3">
          <Field label={t("books.titleField")}>
            <Input value={form.title} onChange={updateForm("title")} />
          </Field>
          <Field label={t("books.description")}>
            <textarea
              rows={4}
              value={form.description}
              onChange={updateForm("description")}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </Field>
          <Field label={t("books.keywords")}>
            <Input value={form.keywords} onChange={updateForm("keywords")} />
          </Field>
          <Field label={t("books.chapterCount")}>
            <Input type="number" min={1} max={15} value={form.chapterCount} onChange={updateForm("chapterCount")} />
          </Field>

          <div className="grid grid-cols-1 gap-2 pt-2">
            <Btn onClick={createBook} disabled={loading} icon={<PlusIcon size={13} />}>
              {t("books.createBook")}
            </Btn>
            <Btn variant="teal" onClick={generateChapters} disabled={loading} icon={<SparkIcon size={13} />}>
              {t("books.generateChapters")}
            </Btn>
            <Btn variant="secondary" onClick={generateContent} disabled={!book || chapters.length === 0 || loading} icon={<PenIcon size={13} />}>
              {t("books.generateContent")}
            </Btn>
            <Btn variant="secondary" onClick={exportBook} disabled={!book || chapters.length === 0 || loading} icon={<DownloadIcon size={13} />}>
              {t("books.exportBook")}
            </Btn>
          </div>
        </Card>

        <div className="space-y-4">
          {job?.id && <AsyncJobCard title={jobTitle} job={job} />}

          <Card className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-semibold text-gray-900">{book?.title || t("books.noBook")}</p>
                <p className="text-xs text-gray-500">{book?.id ? `ID: ${book.id}` : t("books.createHint")}</p>
              </div>
              {book?.id && (
                <Btn variant="ghost" small onClick={() => loadBook(book.id)} icon={<RefreshIcon size={12} />}>
                  {t("books.reload")}
                </Btn>
              )}
            </div>

            {activeBookStep === 1 && (
              <div className="rounded-xl border border-dashed border-gray-200 p-6">
                <p className="text-sm font-semibold text-gray-900">Define the book concept</p>
                <p className="mt-1 text-xs text-gray-500">
                  Use Create Book for the fast path, or Generate Chapters to start the step-by-step review flow.
                </p>
                {book?.id && (
                  <div className="mt-4 rounded-lg bg-indigo-50 p-3 text-xs text-indigo-700">
                    Current book is saved. Continue with Step 2 to review chapters.
                  </div>
                )}
              </div>
            )}

            {activeBookStep === 2 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-900">Review and edit chapters</p>
                  <Btn small onClick={saveChapterChanges} disabled={!book || chapters.length === 0 || loading}>
                    Save changes
                  </Btn>
                </div>
                {editableChapters.length === 0 ? (
                  <div className="py-12 text-center text-sm text-gray-400 border border-dashed border-gray-200 rounded-xl">
                    {t("books.emptyChapters")}
                  </div>
                ) : (
                  editableChapters.map((chapter, index) => (
                    <div key={chapter.id} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="w-6 h-6 rounded bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
                          {index + 1}
                        </span>
                        <Input
                          value={chapter.title}
                          onChange={(event) => setEditableChapters((current) => current.map((item) => (
                            item.id === chapter.id ? { ...item, title: event.target.value } : item
                          )))}
                        />
                      </div>
                      <textarea
                        rows={3}
                        value={chapter.description}
                        onChange={(event) => setEditableChapters((current) => current.map((item) => (
                          item.id === chapter.id ? { ...item, description: event.target.value } : item
                        )))}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  ))
                )}
              </div>
            )}

            {activeBookStep === 3 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-gray-900">Generate and edit content</p>
                  <div className="flex gap-2">
                    <Btn small variant="secondary" onClick={generateContent} disabled={!book || chapters.length === 0 || loading} icon={<PenIcon size={12} />}>
                      {t("books.generateContent")}
                    </Btn>
                    <Btn small onClick={saveContentChanges} disabled={!book || chapters.length === 0 || loading}>
                      Save changes
                    </Btn>
                  </div>
                </div>
                {chapters.length === 0 ? (
                  <div className="py-12 text-center text-sm text-gray-400 border border-dashed border-gray-200 rounded-xl">
                    Generate and validate chapters before editing content.
                  </div>
                ) : (
                  chapters.map((chapter, index) => (
                    <div key={chapter.id} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <p className="text-xs font-semibold text-gray-700">{index + 1}. {chapter.title}</p>
                        {(contentDrafts[chapter.id] || chapter.content) && (
                          <Btn small variant="secondary" onClick={() => refineChapterWithAi(chapter)} disabled={loading}>
                            ✨ Refinar con IA
                          </Btn>
                        )}
                      </div>
                      <textarea
                        rows={8}
                        value={contentDrafts[chapter.id] || ""}
                        onChange={(event) => setContentDrafts((current) => ({ ...current, [chapter.id]: event.target.value }))}
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="Generated chapter HTML will appear here."
                      />
                    </div>
                  ))
                )}
              </div>
            )}

            {activeBookStep === 4 && (
              <div className="space-y-3">
                <p className="text-sm font-semibold text-gray-900">Generate marketing assets</p>
                <div className="grid grid-cols-3 gap-3">
                  {["One-Pager", "Whitepaper", "Social Summaries", "Infographic"].map((asset) => (
                    <div key={asset} className="rounded-xl border border-gray-100 bg-gray-50 p-4">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-sm font-semibold text-gray-900">{asset}</p>
                        <Badge label={t("books.readyToGenerate")} color="bg-indigo-100 text-indigo-700" />
                      </div>
                      <Field label={t("books.template")}><Select><option>{t("books.defaultTemplate")} {asset}</option><option>{t("books.salesStyle")}</option></Select></Field>
                      <div className="flex gap-2">
                        <Btn small icon={<SparkIcon size={12} />} onClick={asset === "One-Pager" ? generateOnePager : asset === "Social Summaries" ? generateSocialPosts : asset === "Infographic" ? generateInfographic : exportBook} disabled={!book || loading}>{t("books.generate")}</Btn>
                        <Btn small variant="secondary" icon={<EyeIcon size={12} />} disabled>{t("books.preview")}</Btn>
                        <Btn small variant="secondary" icon={<DownloadIcon size={12} />} disabled>{t("books.download")}</Btn>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function BookConceptsExperience({
  activeBookStep,
  activeChapterId,
  setActiveChapterId,
  assets,
  book,
  bookLanguage,
  bookLanguageManuallySelected,
  chapters,
  chaptersForOutline,
  contentDrafts,
  createBook,
  exportBook,
  form,
  generatedChapters,
  generateChapters,
  generateContent,
  generateInfographic,
  generateOnePager,
  generateSocialPosts,
  goToBookStep,
  isDark,
  job,
  jobTitle,
  language,
  loadAssets,
  loadBook,
  loadLibrary,
  loading,
  loadingAssets,
  previewOpen,
  previewPage,
  refineActiveChapter,
  refineText,
  regenerateAllAssets,
  regenerateStatus,
  saveChapterChanges,
  saveContentChanges,
  setActiveBookStep,
  setBookLanguage,
  setBookLanguageManuallySelected,
  setBookView,
  setChapters,
  setContentDrafts,
  setDeletedChapterIds,
  setEditableChapters,
  setPreviewOpen,
  setPreviewPage,
  setRefineText,
  showToast,
  t,
  toast,
  totalWords,
  updateForm,
}) {
  const bt = (key) => t(`books.${key}`);
  const bookInputStyle = { background: isDark ? '#0F172A' : '#fff', color: isDark ? '#F1F5F9' : '#0F172A', borderColor: isDark ? '#334155' : '#e3e6ee' };
  const bookPanelStyle = { background: isDark ? '#1E293B' : '#fff', borderColor: isDark ? '#334155' : '#eaecf3' };
  const bookTextPrimary = isDark ? '#F1F5F9' : '#0F172A';
  const bookTextSecondary = isDark ? '#94A3B8' : '#64748B';
  const keywordsLabel = language === "es" ? "Palabras clave" : language === "pt" ? "Palavras-chave" : bt("keywordsLabel");
  const bookLanguageLabels = {
    en: "English",
    es: "Español",
    pt: "Português",
  };
  const keywords = form.keywords.split(",").map((item) => item.trim()).filter(Boolean);
  const previewChapters = chapters.length ? chapters : chaptersForOutline;
  const completedSteps = [
    false,
    Boolean(book?.id && activeBookStep > 1),
    Boolean(chapters.length && activeBookStep > 2),
    Boolean(generatedChapters && activeBookStep > 3),
    false,
  ];
  const previewCount = previewChapters.filter((chapter) => contentDrafts[chapter.id] || chapter.content).length || generatedChapters;
  const previewItems = [
    { type: "cover", label: bt("cover") },
    { type: "index", label: bt("index") },
    ...previewChapters.map((chapter, index) => ({ type: "chapter", chapter, index, label: chapter.title || `${bt("chapter")} ${index + 1}` })),
  ];
  const currentPreview = previewItems[Math.min(previewPage, Math.max(previewItems.length - 1, 0))] || previewItems[0];

  const plainText = (value = "") => String(value)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const sanitizeAssetHtml = (html = "") => String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript:/gi, "");

  const parseAssetJson = (value) => {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const truncatePreviewText = (value = "", maxLength = 520) => {
    const text = plainText(value);
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength).replace(/\s+\S*$/, "").trim()}...`;
  };

  const buildHtmlAssetPreview = (html = "") => {
    const safeHtml = sanitizeAssetHtml(html);
    if (typeof document === "undefined") {
      return truncatePreviewText(safeHtml);
    }
    const container = document.createElement("div");
    container.innerHTML = safeHtml;
    const nodes = Array.from(container.querySelectorAll("h1, h2, h3, p, li, blockquote")).filter((node) => plainText(node.textContent));
    if (!nodes.length) {
      return truncatePreviewText(safeHtml);
    }

    const preview = document.createElement("div");
    let usedChars = 0;
    for (const node of nodes.slice(0, 7)) {
      const text = plainText(node.textContent);
      if (!text) continue;
      if (usedChars > 0 && usedChars + text.length > 620) break;
      const clone = node.cloneNode(true);
      preview.appendChild(clone);
      usedChars += text.length;
    }
    return preview.innerHTML || truncatePreviewText(safeHtml);
  };

  const buildMarketingAssetPreview = (content, type, fallback) => {
    const raw = typeof content === "string" ? content.trim() : content;
    const normalizedType = String(type || "").toLowerCase();
    if (normalizedType === "social_post" || normalizedType === "infographic") {
      return {
        body: raw || fallback,
        isHtml: false,
        isFallback: !raw,
      };
    }
    if (!raw) {
      return {
        body: fallback,
        isHtml: false,
        isFallback: true,
      };
    }
    if (typeof raw === "string" && /<\/?[a-z][\s\S]*>/i.test(raw)) {
      return {
        body: buildHtmlAssetPreview(raw),
        isHtml: true,
        isFallback: false,
      };
    }
    return {
      body: truncatePreviewText(raw),
      isHtml: false,
      isFallback: false,
    };
  };

  const marketingAssets = assets.length ? assets.map((asset) => ({
    ...(() => {
      const preview = buildMarketingAssetPreview(asset.content, asset.type, asset.description || bt("assetGenericBody"));
      return {
        id: asset.id,
        type: asset.type,
        badge: asset.type || asset.format || "Asset",
        title: asset.title || asset.name || bt("assetGenericTitle"),
        body: preview.body,
        isHtmlPreview: preview.isHtml,
        isFallbackPreview: preview.isFallback,
        downloadUrl: asset.downloadUrl || asset.url || null,
        tone: "indigo",
      };
    })(),
  })) : [
    {
      badge: "LinkedIn",
      title: bt("assetLinkedInTitle"),
      body: bt("assetLinkedInBody"),
      tone: "indigo",
    },
    {
      badge: "Email",
      title: bt("assetEmailTitle"),
      body: bt("assetEmailBody"),
      tone: "purple",
    },
    {
      badge: "Landing",
      title: bt("assetLandingTitle"),
      body: bt("assetLandingBody"),
      tone: "green",
    },
    {
      badge: "Ads",
      title: bt("assetAdTitle"),
      body: bt("assetAdBody"),
      tone: "orange",
    },
  ];

  const fallbackChapterText = (chapter) => chapter?.description || bt("noPreviewContent");
  const escapeRegExp = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const previewChapterText = (chapter, index) => {
    let text = plainText(contentDrafts[chapter.id] || chapter.content) || fallbackChapterText(chapter);
    const title = plainText(chapter.title);
    if (title && text.toLowerCase().startsWith(title.toLowerCase())) {
      text = text.slice(title.length).replace(/^[:\s\-\u2013\u2014]+/, "").trim();
    }
    text = text.replace(/^(?:chapter|cap[ií]tulo|capitulo)\s*\d+\s*[:.\-–—]?\s*/i, "").trim();
    if (title) {
      text = text.replace(new RegExp(`^${escapeRegExp(title)}\\s*[:.\\-\\u2013\\u2014]?\\s*`, "i"), "").trim();
    }
    return text || fallbackChapterText(chapter);
  };
  const copyText = async (text) => {
    try {
      await navigator.clipboard?.writeText(text);
      showToast(bt("copied"));
    } catch {
      showToast(bt("copyFailed"));
    }
  };

  // Chapter actions: add, move, delete (client-first, persist on save)
  const addChapter = async () => {
    // optimistic UI: add a local empty chapter immediately so user can edit
    const newId = `local-${Date.now()}`;
    const newChapter = { id: newId, title: "", description: "", orderIndex: (editableChapters.length || chapters.length) };
    setEditableChapters((cur) => [...cur, { id: newId, title: newChapter.title, description: newChapter.description }]);
    setChapters((cur) => [...cur, newChapter]);
    setActiveChapterId(newId);
    showToast(bt("added") || "Capítulo añadido");
    console.debug('[BookConcepts] addChapter local id', newId);

    // If we have a server book, try to persist in background and refresh
    if (!book?.id) return;
    setLoading(true);
    try {
      const { data } = await api.post(
        `/books/${book.id}/chapters`,
        { title: newChapter.title, description: newChapter.description },
        { suppressPermissionToast: true },
      );
      if (data && data.id) {
        await loadBook(book.id);
        setActiveChapterId(data.id);
      }
    } catch (e) {
      console.error('[BookConcepts] addChapter error', e);
      showToast(bt("addFailed") || "No se pudo agregar capítulo en el servidor");
    } finally {
      setLoading(false);
    }
  };

  const moveChapter = (fromIndex, toIndex) => {
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    setEditableChapters((current) => {
      const copy = [...current];
      const [item] = copy.splice(fromIndex, 1);
      if (!item) return current;
      copy.splice(toIndex, 0, item);
      return copy;
    });
    setChapters((current) => {
      const copy = [...current];
      const [item] = copy.splice(fromIndex, 1);
      if (!item) return current;
      copy.splice(toIndex, 0, item);
      return copy;
    });
  };

  const deleteChapter = async (chapterId) => {
    // optimistic removal from UI
    setEditableChapters((current) => current.filter((c) => c.id !== chapterId));
    setChapters((current) => current.filter((c) => c.id !== chapterId));
    setDeletedChapterIds((cur) => {
      if (cur.includes(chapterId)) return cur;
      return [...cur, chapterId];
    });
    showToast(bt("deleted") || "Capítulo eliminado");
    console.debug('[BookConcepts] deleteChapter queued id', chapterId);

    // If local/demo id, nothing to call on server
    if (!book?.id || String(chapterId).startsWith("demo-chapter-") || String(chapterId).startsWith("local-")) {
      return;
    }

    setLoading(true);
    try {
      await api.delete(`/books/${book.id}/chapters/${chapterId}`, { suppressPermissionToast: true });
      // ensure server state matches
      await loadBook(book.id);
      // remove from deleted list
      setDeletedChapterIds((cur) => cur.filter((id) => id !== chapterId));
      showToast(bt("deleted") || "Capítulo borrado");
    } catch (e) {
      console.error('[BookConcepts] deleteChapter error', e);
      showToast(bt("deleteFailed") || "No se pudo borrar capítulo en el servidor");
      // reload to restore state from server
      try { await loadBook(book.id); } catch (_) {}
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1440px] space-y-4 px-2 pb-10 lg:px-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => { setBookView("library"); loadLibrary(); }}
            className="inline-flex h-11 items-center gap-2 rounded-xl border px-5 text-sm font-semibold shadow-sm"
            style={{
              background: isDark ? '#1E293B' : '#fff',
              borderColor: isDark ? '#334155' : '#e5e7eb',
              color: isDark ? '#F1F5F9' : '#374151',
            }}
          >
            <span className="text-lg leading-none">&larr;</span>
            {bt("backToBooks")}
          </button>

          <header>
            <h1 className="text-[17px] font-bold tracking-[-0.02em]" style={{ color: isDark ? '#F1F5F9' : '#0f172a' }}>{t("sidebar.books")}</h1>
            <p className="mt-1 text-[12.5px]" style={{ color: isDark ? '#94A3B8' : '#64748b' }}>{bt("workflowSubtitle")}</p>
          </header>
        </div>

        <div className="flex flex-col items-end gap-5">
          <button
            type="button"
            onClick={() => { setPreviewPage(0); setPreviewOpen(true); }}
            disabled={previewItems.length <= 2}
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#0f172a] px-6 text-sm font-bold text-white shadow-sm hover:bg-[#111827] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <EyeIcon size={16} />
            {bt("bookPreviewTitle")}
          </button>
          {book && (
            <span className="rounded-full bg-emerald-50 px-5 py-2 text-sm font-semibold text-emerald-600">
              {bt("generatedContent")}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-[14px] lg:grid-cols-4">
        {[bt("defineConcept"), bt("defineChapters"), bt("generateEditContent"), bt("generateMarketingAssets")].map((label, index) => {
          const step = index + 1;
          const active = activeBookStep === step;
          const done = completedSteps[step];
          return (
            <button
              key={label}
              type="button"
              onClick={() => goToBookStep(step)}
              disabled={step > 1 && !book?.id}
              className={`min-h-[88px] rounded-xl border px-5 py-4 text-left shadow-sm transition-colors ${step > 1 && !book?.id ? "cursor-not-allowed opacity-70" : ""}`}
              style={
                active
                  ? { borderColor: isDark ? '#3730A3' : '#c7d2fe', background: isDark ? 'rgba(55,48,163,0.18)' : '#eef2ff', color: isDark ? '#A5B4FC' : '#4f46e5' }
                  : { borderColor: isDark ? '#334155' : '#f3f4f6', background: isDark ? '#1E293B' : '#fff', color: isDark ? '#94A3B8' : '#94a3b8' }
              }
            >
              <div className="flex items-start gap-3">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-black"
                  style={
                    done
                      ? { background: isDark ? 'rgba(16,185,129,0.15)' : '#ecfdf5', color: '#10b981' }
                      : active
                        ? { background: isDark ? '#3730A3' : '#4f46e5', color: '#fff' }
                        : { background: isDark ? '#334155' : '#f1f5f9', color: isDark ? '#94A3B8' : '#94a3b8' }
                  }
                >
                  {done ? <CheckIcon size={16} /> : step}
                </span>
                <span>
                  <span
                    className="block text-base font-bold"
                    style={{ color: active ? (isDark ? '#A5B4FC' : '#4f46e5') : done ? (isDark ? '#CBD5E1' : '#334155') : (isDark ? '#94A3B8' : '#94a3b8') }}
                  >
                    {bt("step")} {step}
                  </span>
                  <span className="mt-1 block text-sm">{label}</span>
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        <div className="rounded-2xl border p-5 shadow-sm" style={bookPanelStyle}>
          <div className="space-y-3">
            <div className="mb-[18px]">
              <label className="block text-xs font-medium mb-1" style={{ color: bookTextSecondary }}>{bt("titleField")}</label>
              <input value={form.title} onChange={updateForm("title")} className="w-full h-10 rounded-lg border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" style={bookInputStyle} />
            </div>
            <div className="mb-[18px]">
              <label className="block text-xs font-medium mb-1" style={{ color: bookTextSecondary }}>{bt("description")}</label>
              <textarea
                rows={4}
                value={form.description}
                onChange={updateForm("description")}
                className="w-full rounded-xl border px-4 py-3 text-sm leading-6 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                style={bookInputStyle}
              />
            </div>
            <div className="mb-[18px]">
              <label className="block text-xs font-medium mb-1" style={{ color: bookTextSecondary }}>{keywordsLabel}</label>
              <input value={form.keywords} onChange={updateForm("keywords")} className="w-full h-10 rounded-lg border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" style={bookInputStyle} />
            </div>
            <div className="mb-[18px]">
              <label className="block text-xs font-medium mb-1" style={{ color: bookTextSecondary }}>{bt("chapterCount")}</label>
              <input type="number" min={1} max={15} value={form.chapterCount} onChange={updateForm("chapterCount")} className="w-full h-10 rounded-lg border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" style={bookInputStyle} />
            </div>
            <div className="mb-[18px]">
              <label className="block text-xs font-medium mb-1" style={{ color: bookTextSecondary }}>
                {language === "es" ? "Idioma de creación" : language === "pt" ? "Idioma de criação" : "Creation language"}
              </label>
              <select
                value={bookLanguage}
                onChange={(event) => {
                  setBookLanguage(event.target.value);
                  setBookLanguageManuallySelected(true);
                }}
                className="w-full h-10 rounded-lg border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                style={bookInputStyle}
              >
                {Object.entries(bookLanguageLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}{!bookLanguageManuallySelected && bookLanguage === value ? ` (${language === "es" ? "predeterminado" : language === "pt" ? "padrão" : "default"})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-1 gap-2 pt-1">
              <button type="button" onClick={createBook} disabled={loading} title={bt("createBookHint")} className="flex h-11 items-center justify-center gap-3 rounded-xl bg-indigo-600 px-4 text-sm font-bold text-white shadow-md shadow-indigo-600/20 hover:bg-indigo-700 disabled:opacity-60">
                <PlusIcon size={17} /> {bt("createBook")}
              </button>
              <button type="button" onClick={generateChapters} disabled={loading} title={bt("generateChaptersHint")} className="flex h-11 items-center justify-center gap-3 rounded-xl bg-emerald-500 px-4 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-60">
                <SparkIcon size={16} /> {bt("generateChapters")}
              </button>
              <button type="button" onClick={generateContent} disabled={!book || chapters.length === 0 || loading} title={bt("generateContentHint")} className="flex h-11 items-center justify-center gap-3 rounded-xl border px-4 text-sm font-bold hover:bg-gray-50 disabled:opacity-50" style={{ borderColor: isDark ? '#334155' : '#e5e7eb', background: isDark ? '#0F172A' : '#fff', color: isDark ? '#F1F5F9' : '#334155' }}>
                <PenIcon size={16} /> {bt("generateContent")}
              </button>
              <button type="button" onClick={exportBook} disabled={!book || chapters.length === 0 || loading} title={bt("exportBookHint")} className="flex h-11 items-center justify-center gap-3 rounded-xl border px-4 text-sm font-bold hover:bg-gray-50 disabled:opacity-50" style={{ borderColor: isDark ? '#334155' : '#e5e7eb', background: isDark ? '#0F172A' : '#fff', color: isDark ? '#F1F5F9' : '#334155' }}>
                <DownloadIcon size={16} /> {bt("exportBook")}
              </button>
              {chapters.length > 0 && (
                <button type="button" onClick={() => setActiveBookStep(2)} className="flex h-11 items-center justify-center gap-3 rounded-xl border border-indigo-500/30 bg-indigo-50/50 px-4 text-sm font-bold text-indigo-600 hover:bg-indigo-50">
                  {bt("defineChapters")} &rarr;
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-2xl border p-6 shadow-sm" style={bookPanelStyle}>
          <div className="mb-5 flex items-start justify-between gap-4 border-b pb-5" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
            <div>
              <h2 className="text-[14px] font-bold" style={{ color: bookTextPrimary }}>{book?.title || form.title}</h2>
              <p className="mt-1 text-[11.5px]" style={{ color: bookTextSecondary }}>ID: {book?.id || "f32d04c4-7b29-421a-abec-c4bf93617326"}</p>
            </div>
            {book?.id && (
              <button type="button" onClick={() => loadBook(book.id)} className="inline-flex items-center gap-2 text-sm font-bold text-indigo-500 hover:text-indigo-700">
                <RefreshIcon size={16} /> {bt("reload")}
              </button>
            )}
          </div>

          {job?.id && <AsyncJobCard title={jobTitle} job={job} statusLabel={bt("status")} />}

          {activeBookStep === 1 && (
            <div className="space-y-4">
              <div className="rounded-2xl border p-5" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
                <h3 className="text-[14px] font-bold" style={{ color: bookTextPrimary }}>{bt("defineConceptTitle")}</h3>
                <p className="mt-2 text-[13px] leading-[1.6]" style={{ color: bookTextSecondary }}>
                  {bt("defineConceptPrefix")} <strong style={{ color: bookTextPrimary }}>{bt("createBook")}</strong> {bt("defineConceptMiddle")} <strong style={{ color: bookTextPrimary }}>{bt("generateChapters")}</strong> {bt("defineConceptSuffix")}
                </p>
                {book?.id && (
                  <div className="mt-4 flex items-center gap-3 rounded-xl px-5 py-3 text-sm font-bold" style={{ background: isDark ? 'rgba(79,70,229,0.15)' : '#eef2ff', color: isDark ? '#A5B4FC' : '#4338ca' }}>
                    <CheckIcon size={18} />
                    {bt("savedMessage")}
                  </div>
                )}
              </div>
              {(loading || (job && job.status !== 'completed' && job.status !== 'failed')) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: '#eef0fe', border: '1px solid #dfe2fc', borderRadius: 11, marginBottom: 14 }}>
                  <span style={{ width: 16, height: 16, border: '2.4px solid rgba(99,102,241,.3)', borderTopColor: '#6366f1', borderRadius: '50%', display: 'inline-block', animation: 'spin .7s linear infinite', flexShrink: 0 }} />
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: '#4f46e5' }}>
                    {jobTitle || bt("processing")}
                  </span>
                  {job?.progress != null && job?.status !== 'completed' && job?.status !== 'failed' && (
                    <span style={{ marginLeft: 'auto', fontSize: 12.5, color: '#6366f1', fontWeight: 600 }}>
                      {Math.round(job.progress)}%
                    </span>
                  )}
                </div>
              )}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                {[
                  [bt("chapters").toUpperCase(), chapters.length || Number(form.chapterCount) || 0],
                  [bt("withContent").toUpperCase(), generatedChapters],
                  [bt("words").toUpperCase(), totalWords],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border p-4" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
                    <p className="text-[11px] font-bold" style={{ color: bookTextSecondary }}>{label}</p>
                    <p className="mt-[6px] text-[18px] font-bold" style={{ color: bookTextPrimary }}>{value}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeBookStep === 2 && (
            <div className="space-y-5">
              {(loading || (job && job.status !== 'completed' && job.status !== 'failed')) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: '#eef0fe', border: '1px solid #dfe2fc', borderRadius: 11, marginBottom: 14 }}>
                  <span style={{ width: 16, height: 16, border: '2.4px solid rgba(99,102,241,.3)', borderTopColor: '#6366f1', borderRadius: '50%', display: 'inline-block', animation: 'spin .7s linear infinite', flexShrink: 0 }} />
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: '#4f46e5' }}>
                    {jobTitle || bt("processing")}
                  </span>
                  {job?.progress != null && job?.status !== 'completed' && job?.status !== 'failed' && (
                    <span style={{ marginLeft: 'auto', fontSize: 12.5, color: '#6366f1', fontWeight: 600 }}>
                      {Math.round(job.progress)}%
                    </span>
                  )}
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-black" style={{ color: bookTextPrimary }}>{bt("reviewEditChapters")}</h3>
                <div className="flex gap-2">
                  <button type="button" onClick={addChapter} className="inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-bold" style={{ background: isDark ? '#334155' : '#f1f5f9', color: isDark ? '#F1F5F9' : '#334155' }}>
                    <PlusIcon size={15} /> {bt("add")}
                  </button>
                  <button type="button" onClick={async () => {
                    await saveChapterChanges(true);
                    showToast(bt("savedMessage") || "Cambios guardados");
                  }} disabled={!book || chaptersForOutline.length === 0 || loading} className="h-10 rounded-lg bg-indigo-600 px-5 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50">
                    {bt("saveChanges")}
                  </button>
                </div>
              </div>
              {chaptersForOutline.length === 0 ? (
                <div className="rounded-2xl border border-dashed py-16 text-center text-sm" style={{ borderColor: isDark ? '#334155' : '#e5e7eb', color: bookTextSecondary }}>
                  {t("books.emptyChapters")}
                </div>
              ) : (
                <div className="space-y-4">
                  {chaptersForOutline.map((chapter, index) => (
                    <div key={chapter.id} className="grid grid-cols-[26px_1fr_34px] gap-3 rounded-2xl border p-4" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
                      <div className="flex flex-col items-center gap-3 pt-1">
                        <span style={{ color: isDark ? '#475569' : '#cbd5e1' }}>::</span>
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg text-xs font-black" style={{ background: isDark ? 'rgba(79,70,229,0.15)' : '#eef2ff', color: isDark ? '#A5B4FC' : '#4f46e5' }}>{index + 1}</span>
                      </div>
                      <div className="space-y-2">
                        <input
                          value={chapter.title}
                          onChange={(event) => setEditableChapters((current) => current.map((item) => (
                            item.id === chapter.id ? { ...item, title: event.target.value } : item
                          )))}
                          className="w-full h-10 rounded-lg border px-3 py-1.5 text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          style={bookInputStyle}
                        />
                        <textarea
                          ref={(el) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }}
                          rows={2}
                          value={chapter.description || ""}
                          onChange={(event) => {
                            const el = event.target;
                            el.style.height = 'auto';
                            el.style.height = `${el.scrollHeight}px`;
                            setEditableChapters((current) => current.map((item) => (
                              item.id === chapter.id ? { ...item, description: event.target.value } : item
                            )));
                          }}
                          className="w-full resize-none overflow-hidden rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          style={bookInputStyle}
                        />
                      </div>
                      <div className="flex flex-col items-center gap-2">
                        <button type="button" onClick={() => moveChapter(index, index - 1)} disabled={index === 0} className="flex h-8 w-8 items-center justify-center rounded-lg border" style={{ borderColor: isDark ? '#334155' : '#f3f4f6', color: isDark ? '#475569' : '#cbd5e1' }}>⌃</button>
                        <button type="button" onClick={() => moveChapter(index, index + 1)} disabled={index === (chaptersForOutline.length - 1)} className="flex h-8 w-8 items-center justify-center rounded-lg border" style={{ borderColor: isDark ? '#334155' : '#f3f4f6', color: isDark ? '#475569' : '#cbd5e1' }}>⌄</button>
                        <button type="button" onClick={() => deleteChapter(chapter.id)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-red-100 text-red-400"><TrashIcon size={14} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex justify-end pt-1">
                <button type="button" onClick={async () => {
                  try {
                    await saveChapterChanges(false);
                    setActiveBookStep(3);
                    const hasContent = chapters.some((c) => (contentDrafts[c.id] || c.content)?.trim());
                    if (!hasContent) {
                      await generateContent();
                    }
                  } catch(e) {
                    console.error('[BookConcepts] Error en confirm chapters:', e?.message, e?.response?.status);
                  }
                }} disabled={!book || chaptersForOutline.length === 0 || loading} className="rounded-xl bg-emerald-500 px-7 py-3 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-50">
                  {bt("confirmChapters")} &rarr;
                </button>
              </div>
            </div>
          )}

          {activeBookStep === 3 && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-black" style={{ color: bookTextPrimary }}>{bt("generateEditContentTitle")}</h3>
                  <p className="text-sm" style={{ color: bookTextSecondary }}>{bt("generateEditContentHelp")}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={generateContent} disabled={!book || chapters.length === 0 || loading} className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-500 px-4 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-50">
                    <SparkIcon size={15} /> {bt("generateContent")}
                  </button>
                  <button type="button" onClick={saveContentChanges} disabled={!book || chapters.length === 0 || loading} className="h-10 rounded-lg bg-indigo-600 px-5 text-sm font-bold text-white disabled:opacity-50">{bt("saveChanges")}</button>
                  <button type="button" onClick={() => setActiveBookStep(4)} disabled={chapters.length === 0} className="h-10 rounded-lg border border-indigo-200 bg-indigo-50 px-5 text-sm font-bold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50">{bt("marketingAssetsTitle")} &rarr;</button>
                </div>
              </div>
              {(loading || (job && job.status !== 'completed' && job.status !== 'failed')) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: '#eef0fe', border: '1px solid #dfe2fc', borderRadius: 11, marginBottom: 14 }}>
                  <span style={{ width: 16, height: 16, border: '2.4px solid rgba(99,102,241,.3)', borderTopColor: '#6366f1', borderRadius: '50%', display: 'inline-block', animation: 'spin .7s linear infinite', flexShrink: 0 }} />
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: '#4f46e5' }}>
                    {jobTitle || bt("processing")}
                  </span>
                  {job?.progress != null && (
                    <span style={{ marginLeft: 'auto', fontSize: 12.5, color: '#6366f1', fontWeight: 600 }}>
                      {Math.round(job.progress)}%
                    </span>
                  )}
                </div>
              )}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
                <div className="space-y-2 rounded-xl border p-3" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
                  {chapters.map((chapter, index) => {
                    const selected = (activeChapterId || chapters[0]?.id) === chapter.id;
                    return (
                      <button
                        key={chapter.id}
                        type="button"
                        onClick={() => setActiveChapterId(chapter.id)}
                        className="w-full rounded-lg px-3 py-2 text-left text-sm font-semibold transition-colors"
                        style={selected ? { background: isDark ? '#1E3A5F' : '#eef0fe', color: isDark ? '#F1F5F9' : '#4338ca' } : { color: bookTextSecondary }}
                      >
                        {index + 1}. {chapter.title}
                      </button>
                    );
                  })}
                </div>
                <div className="space-y-3">
                  {(chapters.length ? chapters : [{ id: "empty", title: bt("contentLabel"), content: "" }]).map((chapter) => {
                    const isActive = chapters.length === 0 || (activeChapterId || chapters[0]?.id) === chapter.id;
                    return (
                      <div key={chapter.id} className={isActive ? "" : "hidden"}>
                        <p className="mb-2 text-sm font-bold" style={{ color: bookTextPrimary }}>{chapter.title}</p>
                        <textarea
                          rows={14}
                          value={contentDrafts[chapter.id] || chapter.content || ""}
                          onChange={(event) => setContentDrafts((current) => ({ ...current, [chapter.id]: event.target.value }))}
                          className="w-full rounded-xl border px-4 py-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          style={bookInputStyle}
                          placeholder={bt("emptyChapters")}
                        />
                      </div>
                    );
                  })}
                  <div className="rounded-xl border p-4" style={{ borderColor: isDark ? 'rgba(99,102,241,0.3)' : '#e0e7ff', background: isDark ? 'rgba(99,102,241,0.1)' : '#eef2ff' }}>
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-sm font-bold" style={{ color: isDark ? '#A5B4FC' : '#312e81' }}>{bt("refineWithAi")}</p>
                      <button type="button" onClick={refineActiveChapter} disabled={!refineText.trim()} className="rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-50" style={{ background: isDark ? '#1E293B' : '#fff', color: isDark ? '#A5B4FC' : '#4f46e5' }}>{bt("apply")}</button>
                    </div>
                    <textarea rows={3} value={refineText} onChange={(event) => setRefineText(event.target.value)} className="w-full rounded-lg border px-3 py-2 text-sm" style={bookInputStyle} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeBookStep === 4 && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-xl font-black" style={{ color: bookTextPrimary }}>{bt("marketingAssetsTitle")}</h3>
                  <p className="mt-1 text-sm" style={{ color: bookTextSecondary }}>{bt("marketingAssetsHelp")}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={loadAssets} disabled={!book || loadingAssets} className="inline-flex h-11 items-center gap-2 rounded-xl border px-4 text-sm font-bold disabled:opacity-50" style={{ borderColor: isDark ? '#334155' : '#e5e7eb', color: bookTextSecondary }}>
                    <RefreshIcon size={15} /> {bt("reload")}
                  </button>
                  <button type="button" onClick={regenerateAllAssets} disabled={!book || chapters.length === 0 || loading || Object.values(regenerateStatus || {}).includes("pending")} className="inline-flex h-11 items-center gap-2 rounded-xl bg-emerald-500 px-5 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-50">
                    <SparkIcon size={15} /> {bt("regenerateAll")}
                  </button>
                </div>
              </div>
              {regenerateStatus && (
                <div className="flex flex-wrap gap-2">
                  {ASSET_REGENERATION_TYPES.map((asset) => {
                    const status = regenerateStatus[asset.key];
                    const color = status === "success" ? { background: isDark ? 'rgba(16,185,129,0.15)' : '#ecfdf5', color: '#059669' }
                      : status === "error" ? { background: isDark ? 'rgba(239,68,68,0.15)' : '#fef2f2', color: '#dc2626' }
                      : { background: isDark ? 'rgba(99,102,241,0.15)' : '#eef2ff', color: '#4f46e5' };
                    return (
                      <span key={asset.key} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold" style={color}>
                        {status === "pending" && <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
                        {bt(asset.labelKey)}
                      </span>
                    );
                  })}
                </div>
              )}
              {loadingAssets ? (
                <div className="rounded-xl border border-dashed py-12 text-center" style={{ borderColor: isDark ? '#334155' : '#e5e7eb' }}>
                  <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                  {marketingAssets.map((asset) => (
                    <div key={asset.id || `${asset.badge}-${asset.title}`} className="rounded-2xl border p-5" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
                      <div className="mb-4 flex items-center justify-between">
                        <span className={`rounded-lg px-3 py-1 text-xs font-bold ${
                          asset.tone === "green" ? "bg-emerald-50 text-emerald-600" : asset.tone === "orange" ? "bg-orange-50 text-orange-600" : asset.tone === "purple" ? "bg-purple-50 text-purple-600" : "bg-indigo-50 text-indigo-600"
                        }`}>{asset.badge}</span>
                        {asset.downloadUrl ? (
                          <a href={asset.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-bold text-indigo-600 hover:text-indigo-700">
                            <DownloadIcon size={15} /> {bt("download")}
                          </a>
                        ) : (
                          <button type="button" onClick={() => copyText(asset.body)} className="inline-flex items-center gap-2 text-sm font-bold text-slate-400 hover:text-indigo-600">
                            <FileIcon size={15} /> {bt("copy")}
                          </button>
                        )}
                      </div>
                      <h4 className="text-lg font-black" style={{ color: bookTextPrimary }}>{asset.title}</h4>
                      {asset.isHtmlPreview ? (
                        <div
                          className="mt-3 max-h-44 overflow-hidden text-sm leading-6 [&_blockquote]:mt-2 [&_blockquote]:border-l-2 [&_blockquote]:border-indigo-300 [&_blockquote]:pl-3 [&_h1]:text-base [&_h1]:font-black [&_h2]:mt-2 [&_h2]:text-sm [&_h2]:font-bold [&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-bold [&_li]:mt-1 [&_ol]:mt-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mt-2 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5 [&_.cta]:mt-3 [&_.cta]:inline-block [&_.cta]:rounded-lg [&_.cta]:bg-[#4f46e5] [&_.cta]:px-3 [&_.cta]:py-2 [&_.cta]:font-bold [&_.cta]:text-white"
                          style={{ color: bookTextSecondary }}
                          dangerouslySetInnerHTML={{ __html: asset.body }}
                        />
                      ) : asset.type === "social_post" ? (
                        <div className="mt-3 space-y-2">
                          {(parseAssetJson(asset.body) || []).map((post, index) => (
                            <div key={`${post.platform}-${index}`} className="rounded-xl border p-3" style={{ borderColor: isDark ? '#334155' : '#e5e7eb', background: isDark ? '#0F172A' : '#fff' }}>
                              <div className="mb-1.5 flex items-center justify-between gap-2">
                                <span className="rounded-lg px-2 py-0.5 text-[11px] font-bold uppercase" style={{ background: isDark ? 'rgba(79,70,229,0.15)' : '#eef2ff', color: isDark ? '#A5B4FC' : '#4f46e5' }}>
                                  {post.platform}
                                </span>
                                <span className="text-[11px]" style={{ color: bookTextSecondary }}>{post.characterCount ?? (post.content || "").length} {bt("characters")}</span>
                              </div>
                              <p className="whitespace-pre-line text-sm leading-6" style={{ color: bookTextPrimary }}>{post.content}</p>
                            </div>
                          ))}
                        </div>
                      ) : asset.type === "infographic" && parseAssetJson(asset.body) ? (
                        (() => {
                          const data = parseAssetJson(asset.body);
                          return (
                            <div className="mt-3 space-y-3">
                              {(data.title || data.subtitle) && (
                                <div>
                                  {data.title && <p className="text-base font-black" style={{ color: bookTextPrimary }}>{data.title}</p>}
                                  {data.subtitle && <p className="text-sm" style={{ color: bookTextSecondary }}>{data.subtitle}</p>}
                                </div>
                              )}
                              {(data.sections || []).map((section, index) => (
                                <div key={index} className="rounded-xl border p-3" style={{ borderColor: isDark ? '#334155' : '#e5e7eb' }}>
                                  <div className="flex items-center justify-between gap-2">
                                    <p className="text-sm font-bold" style={{ color: bookTextPrimary }}>{section.heading}</p>
                                    {section.stat && <span className="text-sm font-black" style={{ color: '#4f46e5' }}>{section.stat}</span>}
                                  </div>
                                  {section.description && <p className="mt-1 text-xs leading-5" style={{ color: bookTextSecondary }}>{section.description}</p>}
                                </div>
                              ))}
                              {Array.isArray(data.keyPoints) && data.keyPoints.length > 0 && (
                                <ul className="list-disc space-y-1 pl-5 text-sm" style={{ color: bookTextSecondary }}>
                                  {data.keyPoints.map((point, index) => <li key={index}>{point}</li>)}
                                </ul>
                              )}
                              {data.callToAction && (
                                <p className="rounded-lg px-3 py-2 text-sm font-bold text-white" style={{ background: '#4f46e5' }}>
                                  {data.callToAction}
                                </p>
                              )}
                              {asset.downloadUrl && (
                                <a href={asset.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-bold text-indigo-600 hover:text-indigo-700">
                                  <DownloadIcon size={15} /> {bt("download")}
                                </a>
                              )}
                            </div>
                          );
                        })()
                      ) : (
                        <p className={`mt-3 whitespace-pre-line text-sm leading-6 ${asset.isFallbackPreview ? "line-clamp-2" : "line-clamp-6"}`} style={{ color: bookTextSecondary }}>{asset.body}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-5 right-5 z-[60] rounded-lg bg-gray-900 px-4 py-2 text-xs font-semibold text-white shadow-lg">
          {toast}
        </div>
      )}

      {previewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 backdrop-blur-sm" style={{ background: 'rgba(0,0,0,0.75)' }}>
          <div className="flex h-[86vh] w-full max-w-[1320px] flex-col overflow-hidden rounded-3xl shadow-2xl" style={{ background: isDark ? '#1E293B' : '#fff' }}>
            <div className="flex items-center justify-between border-b px-[18px] py-3" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
              <div className="flex items-center gap-3">
                <EyeIcon size={20} className="text-indigo-600" />
                <h3 className="text-[13.5px] font-black" style={{ color: bookTextPrimary }}>{bt("bookPreviewTitle")}</h3>
                <span className="text-sm" style={{ color: bookTextSecondary }}>· {previewCount}/{previewChapters.length || form.chapterCount} {bt("withContent").toLowerCase()}</span>
              </div>
              <button type="button" onClick={() => setPreviewOpen(false)} className="flex h-12 w-12 items-center justify-center rounded-xl" style={{ background: isDark ? '#334155' : '#f1f5f9', color: isDark ? '#F1F5F9' : '#64748b' }}>
                <XIcon size={26} />
              </button>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr]" style={{ background: isDark ? '#0F172A' : '#f1f5f9' }}>
              <aside className="overflow-y-auto px-[10px] py-[14px]" style={{ background: isDark ? 'rgba(30,41,59,0.7)' : 'rgba(255,255,255,0.7)' }}>
                {previewItems.map((item, index) => {
                  const active = previewPage === index;
                  return (
                    <button
                      key={`${item.type}-${item.label}-${index}`}
                      type="button"
                      onClick={() => setPreviewPage(index)}
                      className="mb-2 flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left text-[12.5px] font-bold"
                      style={active ? { background: isDark ? '#1E3A5F' : '#eef0fe', color: isDark ? '#F1F5F9' : '#4f46e5' } : { color: bookTextSecondary }}
                    >
                      {item.type === "chapter" && (
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-black" style={active ? { background: isDark ? '#3730A3' : '#4f46e5', color: '#fff' } : { background: isDark ? '#334155' : '#f1f5f9', color: isDark ? '#94A3B8' : '#94a3b8' }}>
                          {item.index + 1}
                        </span>
                      )}
                      <span className="line-clamp-2">{item.label}</span>
                    </button>
                  );
                })}
              </aside>
              <main className="overflow-auto px-10 py-12">
                {currentPreview?.type === "cover" && (
                  <section className="mx-auto flex min-h-[700px] w-[560px] flex-col justify-center rounded-md bg-[#111827] px-16 py-16 text-white shadow-2xl shadow-slate-400/50">
                    <p className="mb-36 text-center text-[13px] font-bold uppercase tracking-[0.24em] text-emerald-300">NoonDalton · AI Marketing</p>
                    <h2 className="text-[44px] font-black leading-tight">{form.title}</h2>
                    <p className="mt-6 text-[15.5px] leading-8 text-slate-300">{form.description}</p>
                    <div className="mt-8 flex flex-wrap gap-3">
                      {keywords.map((keyword) => (
                        <span key={keyword} className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm font-bold text-slate-200">{keyword}</span>
                      ))}
                    </div>
                    <div className="mt-12 border-t border-white/10 pt-8 text-[13.5px] text-slate-400">{previewChapters.length || form.chapterCount} {bt("chapters").toLowerCase()} · {bt("writtenWithAi")}</div>
                  </section>
                )}
                {currentPreview?.type === "index" && (
                  <section className="mx-auto min-h-[700px] w-[560px] rounded-md bg-white px-16 py-16 shadow-xl shadow-slate-300/50">
                    <h2 className="font-serif text-[30px] font-black" style={{ color: bookTextPrimary }}>{bt("index")}</h2>
                    <div className="mt-4 h-1 w-16 rounded bg-indigo-600" />
                    <div className="mt-14 space-y-0">
                      {previewChapters.map((chapter, index) => (
                        <div key={chapter.id} className="grid grid-cols-[40px_1fr_74px] items-center gap-4 border-b border-gray-100 py-3.5">
                          <span className="font-serif text-[15px] font-black text-indigo-600">{index + 1}</span>
                          <span className="font-serif text-[16px] text-gray-900">{chapter.title}</span>
                          <span className="rounded-full bg-emerald-50 px-3 py-1 text-center text-sm font-bold text-emerald-600">{bt("ready")}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                {currentPreview?.type === "chapter" && (
                  <section className="mx-auto min-h-[700px] w-[560px] rounded-md bg-white px-16 py-16 shadow-xl shadow-slate-300/50">
                    <p className="text-[13px] font-black uppercase tracking-[0.22em] text-indigo-600">{bt("chapter")} {currentPreview.index + 1}</p>
                    <h2 className="mt-2.5 font-serif text-[30px] font-black leading-tight" style={{ color: bookTextPrimary }}>{currentPreview.chapter.title}</h2>
                    <div className="my-6 h-1 w-16 rounded bg-indigo-600" />
                    <div className="font-serif text-[16px] leading-[1.78] text-slate-700">
                      {previewChapterText(currentPreview.chapter, currentPreview.index)
                        .split(/\n{2,}|(?<=\.)\s+(?=[A-ZÁÉÍÓÚÑ])/)
                        .slice(0, 3)
                        .map((paragraph, index) => <p key={index} className="mb-[18px]">{paragraph}</p>)}
                    </div>
                  </section>
                )}
              </main>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


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

