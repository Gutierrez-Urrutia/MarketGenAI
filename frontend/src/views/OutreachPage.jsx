import { Badge, Btn, Card, Field, Input, Select } from "@/components/dashboard/ui";
import { CheckIcon, ClockIcon, InboxIcon, LinkIcon, PenIcon, RefreshIcon, SparkIcon, XIcon } from "@/components/dashboard/icons";
import api, { campaignsApi, outreachEmailsApi } from "@/api/axios";
import { completeCampaignFlowSteps } from "@/utils/campaignContent";
import { fetchOptional } from "@/utils/dashboardData";
import { normalizeStageName } from "@/features/opportunities/opportunityHelpers";
import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import ProspectingEmailDetail, { EmailStatusBadge } from "@/features/outreach/ProspectingEmailDetail";
import {
  copyText, copyToClipboard, describeEmailError, isActive, languageLabel,
} from "@/features/outreach/prospectingEmails";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/context/ThemeContext";

export function OutreachPage({ navigationState = {}, onNavigate = () => {}, onOutreachBadgeChange = () => {}, campaignFlow = null, setCampaignFlow = () => {} }) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const [tab, setTab] = useState(navigationState.tab || "review");
  const [historyFilter, setHistoryFilter] = useState(navigationState.statusFilter || "all");
  const [selected, setSelected] = useState(null);
  const [reviewEmails, setReviewEmails] = useState([]);
  const [history, setHistory] = useState([]);
  const [loadingOutreach, setLoadingOutreach] = useState(true);
  const [outreachBusy, setOutreachBusy] = useState(false);
  const [generatingResponse, setGeneratingResponse] = useState(false);
  const [generatingCampaignMessages, setGeneratingCampaignMessages] = useState(false);
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [simulateForm, setSimulateForm] = useState({
    contact_message: t("outreachPage.simulate.defaultMessage"),
    name: "Jordan Lee",
    company: "Acme Growth",
    role: "VP Marketing",
  });
  // Prospecting emails (RF-VTA-16): their own collection and API, shown in the
  // same queue as the replies. «Aprobar todo» / «Rechazar todo» never touch them.
  const [prospectingEmails, setProspectingEmails] = useState([]);
  const [kindFilter, setKindFilter] = useState(navigationState.kind || "all");
  const [selectedProspectingId, setSelectedProspectingId] = useState(null);
  const [prospectingBusy, setProspectingBusy] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState(null);
  const activeProspecting = useMemo(() => prospectingEmails.filter(isActive), [prospectingEmails]);
  const closedProspecting = useMemo(() => prospectingEmails.filter((email) => !isActive(email)), [prospectingEmails]);

  const loadProspecting = async () => {
    try {
      const { data } = await outreachEmailsApi.list();
      setProspectingEmails(data?.items || []);
    } catch {
      setProspectingEmails([]);
    }
  };

  useEffect(() => {
    loadProspecting();
  }, []);

  useEffect(() => {
    if (navigationState.kind) setKindFilter(navigationState.kind);
  }, [navigationState.kind]);

  // The sidebar badge counts pending replies plus active prospecting emails.
  useEffect(() => {
    onOutreachBadgeChange(reviewEmails.length + activeProspecting.length);
  }, [reviewEmails.length, activeProspecting.length, onOutreachBadgeChange]);

  const replaceProspecting = (updated) => {
    if (!updated?.id) return;
    setProspectingEmails((list) => list.map((email) => (email.id === updated.id ? { ...email, ...updated } : email)));
  };

  const showEmailError = (error) => {
    const described = describeEmailError(error);
    toast.error(t(described.key));
    if (["invalid_email_transition", "email_not_found", "contact_not_found"].includes(described.code)) {
      loadProspecting();
    }
  };

  const PROSPECTING_ACTIONS = {
    approve: { call: outreachEmailsApi.approve, done: "outreachPage.prospecting.messages.approved" },
    reject: { call: outreachEmailsApi.reject, done: "outreachPage.prospecting.messages.rejected" },
    markSent: { call: outreachEmailsApi.markSent, done: "outreachPage.prospecting.messages.sent" },
  };

  const decideProspecting = async (email, action) => {
    if (prospectingBusy) return;
    setProspectingBusy(true);
    try {
      const { data } = await PROSPECTING_ACTIONS[action].call(email.id);
      replaceProspecting(data);
      toast.success(t(PROSPECTING_ACTIONS[action].done));
    } catch (error) {
      showEmailError(error);
    } finally {
      setProspectingBusy(false);
    }
  };

  const regenerateProspecting = async (email, language) => {
    if (prospectingBusy || regeneratingId) return;
    setRegeneratingId(email.id);
    try {
      const { data } = await outreachEmailsApi.regenerate(email.id, language);
      replaceProspecting(data);
      toast.success(t("outreachPage.prospecting.messages.regenerated"));
    } catch (error) {
      showEmailError(error);
      if (describeEmailError(error).timedOut) loadProspecting();
    } finally {
      setRegeneratingId(null);
    }
  };

  // Never calls the API nor changes the email: only the clipboard.
  const copyProspecting = async (email) => {
    const copied = await copyToClipboard(copyText(email));
    if (copied) toast.success(t("outreachPage.prospecting.messages.copied"));
    else toast.error(t("outreachPage.prospecting.messages.copyFailed"));
  };

  useEffect(() => {
    if (navigationState.tab) setTab(navigationState.tab);
    if (navigationState.statusFilter) setHistoryFilter(navigationState.statusFilter);
  }, [navigationState.tab, navigationState.statusFilter]);

  useEffect(() => {
    let cancelled = false;
    setLoadingOutreach(true);
    fetchOptional("/outreach", null).then((data) => {
      if (cancelled) return;
      const nextReviewEmails = data !== null ? (data.reviewQueue ?? []) : [];
      const nextHistory = data !== null ? (data.history ?? []) : [];
      setReviewEmails(nextReviewEmails);
      setHistory(nextHistory);
      setSelected(nextReviewEmails.length ? 0 : null);
      setLoadingOutreach(false);
    });
    return () => {
      cancelled = true;
    };
  }, [onOutreachBadgeChange]);

  useEffect(() => {
    if (!reviewEmails.length) {
      setSelected(null);
    } else if (selected === null || selected >= reviewEmails.length) {
      setSelected(0);
    }
  }, [reviewEmails.length, selected]);

  const filteredHistory = historyFilter === "all"
    ? history
    : history.filter((item) => normalizeStageName(item.st || item.status) === normalizeStageName(historyFilter));
  const historyStatusLabel = (status) => ({
    Sent: t("outreachPage.filters.sent"),
    Opened: t("outreachPage.filters.opened"),
    Replied: t("outreachPage.filters.replied"),
    Bounced: t("outreachPage.filters.bounced"),
    sent: t("outreachPage.filters.sent"),
    rejected: t("outreachPage.history.statusRejected"),
  }[status] || status);
  const historyStatusColor = (item) => item.stc || (item.status === "rejected" ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-600");
  const reviewName = (item = {}) => item.name || item.to || "";
  const reviewContent = (item = {}) => item.content || item.preview || "";
  const responseTypeLabel = (type) => (type ? t(`outreachPage.responseTypes.${type}`) : "");
  const reviewContentRef = (item = {}) => item.contentRef || responseTypeLabel(item.response_type) || t("outreachPage.queue.fallbackContentRef");
  const reviewScore = (item = {}) => Number.parseInt(item.score, 10) || 0;
  const campaignApprovedMessages = campaignFlow?.currentStep === 5 && history.some((item) => (
    (!campaignFlow.campaignId || item.campaign_id === campaignFlow.campaignId)
    && (item.status === "sent" || item.st === "Sent")
  ));
  const generateCampaignOutreach = async () => {
    if (!campaignFlow?.selectedOpportunities?.length || campaignFlow?.autoGenerated) return;
    setGeneratingCampaignMessages(true);
    try {
      await api.post("/outreach/generate-from-campaign", {
        campaign_id: campaignFlow.campaignId,
        campaign_name: campaignFlow.campaignName,
        objective: campaignFlow.brief?.objective || "lead_generation",
        channels: campaignFlow.brief?.channels || ["email_outreach"],
        context: campaignFlow.brief?.context || "",
        opportunities: campaignFlow.selectedOpportunities.map((opportunity) => ({
          id: opportunity.id,
          company: opportunity.company || opportunity.name,
          contact: opportunity.contactName || opportunity.contact || "",
          role: opportunity.contactRole || opportunity.role || "",
          industry: opportunity.industry || "",
          score: opportunity.score || 0,
          stage: opportunity.stage || "",
        })),
        assets: campaignFlow.selectedAssets || [],
      });

      setCampaignFlow((prev) => ({ ...prev, autoGenerated: true }));

      const updated = await api.get("/outreach/review-queue").then((response) => response.data);
      setReviewEmails(updated);
      setSelected(updated.length ? 0 : null);
      setTab("review");
    } catch (e) {
      console.error("Error generating campaign outreach:", e);
    } finally {
      setGeneratingCampaignMessages(false);
    }
  };

  useEffect(() => {
    if (
      campaignFlow?.currentStep === 5
      && campaignFlow?.selectedOpportunities?.length > 0
      && !campaignFlow?.autoGenerated
    ) {
      generateCampaignOutreach();
    }
  }, [campaignFlow?.currentStep]);
  const removeFromReview = (item) => {
    setReviewEmails((prev) => {
      const next = prev.filter((email) => email !== item && email.id !== item.id);
      return next;
    });
    setSelected(null);
  };
  const activateCampaignFlow = async () => {
    if (!campaignFlow?.campaignId) return;
    setOutreachBusy(true);
    try {
      await campaignsApi.update(campaignFlow.campaignId, { status: "active" });
      setCampaignFlow((prev) => completeCampaignFlowSteps(prev, [5, 6], 7));
      window.dispatchEvent(new CustomEvent("marketgen:campaigns-updated"));
      onNavigate("reports");
    } finally {
      setOutreachBusy(false);
    }
  };

  const handleApprove = async (item) => {
    if (!item) return;
    setOutreachBusy(true);
    try {
      let updated = { ...item, status: "sent", sent_at: new Date().toISOString() };
      if (item.id) {
        const res = await api.patch(`/outreach/review-queue/${item.id}/approve`);
        updated = res.data || updated;
      }
      removeFromReview(item);
      setHistory((prev) => [updated, ...prev]);
      if (campaignFlow?.currentStep === 5) {
        setCampaignFlow((prev) => completeCampaignFlowSteps(prev, [5], 6));
      }
    } finally {
      setOutreachBusy(false);
    }
  };
  const handleReject = async (item) => {
    if (!item) return;
    setOutreachBusy(true);
    try {
      if (item.id) await api.patch(`/outreach/review-queue/${item.id}/reject`);
      removeFromReview(item);
    } finally {
      setOutreachBusy(false);
    }
  };
  const handleRegenerate = async (item) => {
    if (!item?.id) return;
    setOutreachBusy(true);
    try {
      const res = await api.patch(`/outreach/review-queue/${item.id}/regenerate`);
      setReviewEmails((prev) => prev.map((email) => email.id === item.id ? { ...email, content: res.data.content } : email));
    } finally {
      setOutreachBusy(false);
    }
  };
  const handleApproveAll = async () => {
    setOutreachBusy(true);
    try {
      await Promise.all(reviewEmails.filter((email) => email.id).map((email) => api.patch(`/outreach/review-queue/${email.id}/approve`)));
      setHistory((prev) => [...reviewEmails.map((email) => ({ ...email, status: "sent", sent_at: new Date().toISOString() })), ...prev]);
      setReviewEmails([]);
      setSelected(null);
      if (campaignFlow?.currentStep === 5) {
        setCampaignFlow((prev) => completeCampaignFlowSteps(prev, [5], 6));
      }
    } finally {
      setOutreachBusy(false);
    }
  };
  const handleRejectAll = async () => {
    setOutreachBusy(true);
    try {
      await Promise.all(reviewEmails.filter((email) => email.id).map((email) => api.patch(`/outreach/review-queue/${email.id}/reject`)));
      setReviewEmails([]);
      setSelected(null);
    } finally {
      setOutreachBusy(false);
    }
  };
  const handleRestoreOutreach = async (item) => {
    if (!item?.id) return;
    setOutreachBusy(true);
    try {
      await api.patch(`/outreach/history/${item.id}/restore`);
      setHistory((prev) => prev.filter((email) => email.id !== item.id));
      setReviewEmails((prev) => {
        const next = [{ ...item, status: "pending", sent_at: null }, ...prev];
        return next;
      });
      setSelected(0);
    } finally {
      setOutreachBusy(false);
    }
  };
  const handleDeleteOutreach = async (item) => {
    if (!item?.id) return;
    setOutreachBusy(true);
    try {
      await api.delete(`/outreach/history/${item.id}`);
      setHistory((prev) => prev.filter((email) => email.id !== item.id));
    } finally {
      setOutreachBusy(false);
    }
  };
  const generateSimulatedResponse = async () => {
    setOutreachBusy(true);
    setGeneratingResponse(true);
    try {
      const res = await api.post("/outreach/review-queue/generate-response", simulateForm);
      const item = res.data;
      setReviewEmails((prev) => {
        const next = [item, ...prev];
        return next;
      });
      setSelected(0);
      setSimulateOpen(false);
    } finally {
      setOutreachBusy(false);
      setGeneratingResponse(false);
    }
  };

  const selectedProspecting = activeProspecting.find((email) => email.id === selectedProspectingId) || null;
  const shownProspecting = kindFilter === "prospecting"
    ? (selectedProspecting || activeProspecting[0] || null)
    : kindFilter === "all"
      ? (selectedProspecting || (selected === null && !reviewEmails.length ? activeProspecting[0] || null : null))
      : null;
  const e = shownProspecting || kindFilter === "prospecting" || selected === null ? null : reviewEmails[selected];
  const showBulk = kindFilter !== "prospecting";
  const bulkScope = activeProspecting.length > 0
    ? ` ${t("outreachPage.prospecting.bulkScope").replace("{count}", String(reviewEmails.length))}`
    : "";

  return (
    <div className="space-y-2 relative">
      {campaignFlow?.currentStep === 5 && (
        <div className="flow-step-banner">
          <span>✏️ {t("outreachPage.campaign.step5")}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => setCampaignFlow((prev) => completeCampaignFlowSteps(prev, [5], 6))}
              style={{ background: "transparent", color: "rgb(var(--brand-600))", border: "1px solid rgb(var(--brand-600))", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: "0.85em" }}
            >
              {t("outreachPage.campaign.skipToActivate")}
            </button>
            {campaignApprovedMessages && (
              <button
                type="button"
                onClick={async () => {
                  setCampaignFlow((prev) => completeCampaignFlowSteps(prev, [5, 6], 7));
                  if (campaignFlow.campaignId) {
                    campaignsApi.update(campaignFlow.campaignId, { status: "active" })
                      .catch((e) => console.error(e));
                  }
                  onNavigate("reports");
                }}
              >
                {t("outreachPage.campaign.activateCampaign")} →
              </button>
            )}
          </div>
        </div>
      )}
      {campaignFlow?.currentStep === 6 && (
        <div className="flow-step-banner">
          <span>🚀 {t("outreachPage.campaign.step6")}</span>
          <button type="button" onClick={activateCampaignFlow} disabled={outreachBusy || !campaignFlow.campaignId}>
            {t("outreachPage.campaign.activateCampaign")}
          </button>
        </div>
      )}
      {generatingCampaignMessages && (
        <div style={{
          position: "absolute", inset: 0, background: "rgba(255,255,255,0.9)",
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", gap: 16, zIndex: 10, borderRadius: 8,
        }}>
          <div className="spinner" style={{ width: 32, height: 32, borderWidth: 3 }} />
          <p style={{ color: "rgb(var(--brand-600))", fontWeight: 600 }}>
            {t("outreachPage.campaign.generatingMessages").replace("{count}", String(campaignFlow?.selectedOpportunities?.length ?? 0))}
          </p>
          <p style={{ color: "#94A3B8", fontSize: "0.85em" }}>
            {t("outreachPage.campaign.generatingHint")}
          </p>
        </div>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("outreachPage.title")}</h1>
          <p className="text-xs text-gray-500">{t("outreachPage.subtitle")}</p>
        </div>
        {tab === "review" && (
          <div className="flex gap-1">
            <Btn variant="secondary" small icon={<SparkIcon size={12} />} onClick={() => setSimulateOpen(true)}>{t("outreachPage.queue.simulate")}</Btn>
            {showBulk && (
              <>
                <Btn variant="destructive" small icon={<XIcon size={12} />} onClick={handleRejectAll} disabled={outreachBusy || reviewEmails.length === 0}>{t("outreachPage.rejectAll")}{bulkScope}</Btn>
                <Btn variant="teal" small icon={<CheckIcon size={12} />} onClick={handleApproveAll} disabled={outreachBusy || reviewEmails.length === 0}>{t("outreachPage.approveAll")}{bulkScope}</Btn>
              </>
            )}
          </div>
        )}
      </div>

      {loadingOutreach && (
        <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #eaecf3", padding: "48px 24px", textAlign: "center" }}>
          <p style={{ fontSize: 14, color: "#94a3b8", fontWeight: 500, margin: 0 }}>{t("outreachPage.queue.loading")}</p>
        </div>
      )}

      <div className={`flex gap-1 p-1 rounded-xl w-fit ${isDark ? "bg-slate-800 border border-white/10" : "bg-gray-100"}`}>
        <button onClick={() => setTab("review")} className={`flex items-center gap-1 px-4 py-4 rounded-lg text-xs font-medium transition-colors ${tab === "review" ? isDark ? "bg-slate-700 text-white" : "bg-white text-gray-900 shadow-sm" : isDark ? "text-slate-300 hover:text-white" : "text-gray-500"}`}>
          <InboxIcon size={13} />{t("outreachPage.reviewQueue")}
          <span className="bg-amber-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">{reviewEmails.length + activeProspecting.length}</span>
        </button>
        <button onClick={() => setTab("history")} className={`flex items-center gap-1 px-4 py-4 rounded-lg text-xs font-medium transition-colors ${tab === "history" ? isDark ? "bg-slate-700 text-white" : "bg-white text-gray-900 shadow-sm" : isDark ? "text-slate-300 hover:text-white" : "text-gray-500"}`}>
          <ClockIcon size={13} />{t("outreachPage.sentHistory")}
        </button>
      </div>

      {tab === "review" && (
        <div className="grid gap-2" style={{gridTemplateColumns:"2fr 3fr"}}>
          <div className="space-y-1">
            <div className="flex gap-1" role="group" aria-label={t("outreachPage.prospecting.filters.all")}>
              {[
                ["all", t("outreachPage.prospecting.filters.all")],
                ["prospecting", t("outreachPage.prospecting.filters.prospecting")],
                ["replies", t("outreachPage.prospecting.filters.replies")],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={kindFilter === key}
                  onClick={() => setKindFilter(key)}
                  className={`px-3 py-1 rounded-full text-xs font-medium ${kindFilter === key ? "bg-indigo-600 text-white" : isDark ? "bg-slate-800 text-slate-300 border border-white/10" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {kindFilter !== "replies" && activeProspecting.map((email) => (
              <div
                key={`p-${email.id}`}
                data-testid="prospecting-item"
                onClick={() => { setSelectedProspectingId(email.id); setSelected(null); }}
                className={`p-2 rounded-xl border cursor-pointer transition-colors ${shownProspecting?.id === email.id ? isDark ? "border-indigo-500/40 bg-slate-900" : "border-indigo-300 bg-indigo-50" : isDark ? "border-white/10 bg-slate-800 hover:border-white/20" : "border-gray-100 bg-white hover:border-gray-200"}`}
              >
                <div className="flex items-center justify-between mb-1 gap-1">
                  <p className="text-xs font-semibold text-gray-900">{email.contact_name}</p>
                  <EmailStatusBadge status={email.status} t={t} />
                </div>
                <p className="text-xs text-gray-500">{email.job_title} · {email.company_name}</p>
                <p className="text-xs text-gray-400 mt-1 truncate">{email.subject}</p>
                <div className="flex items-center gap-1 mt-1.5">
                  <Badge label={t("outreachPage.prospecting.kind.prospecting")} color={isDark ? "bg-indigo-500/10 text-indigo-200 border border-indigo-400/20" : "bg-indigo-100 text-indigo-700"} />
                  <span className="text-xs text-gray-500">{languageLabel(email.language)}</span>
                </div>
              </div>
            ))}
            {kindFilter === "prospecting" && !activeProspecting.length && (
              <Card className="p-3 text-center">
                <p className="text-sm font-semibold text-gray-900">{t("outreachPage.prospecting.emptyQueue")}</p>
              </Card>
            )}
            {kindFilter !== "prospecting" && !loadingOutreach && reviewEmails.length === 0 && (kindFilter === "replies" || !activeProspecting.length) && (
              <Card className="p-3 text-center">
                <p className="text-sm font-semibold text-gray-900">{t("outreachPage.queue.emptyTitle")}</p>
                <p className="mb-1.5 text-xs text-gray-500">{t("outreachPage.queue.emptyHint")}</p>
                <Btn variant="secondary" small icon={<SparkIcon size={12} />} onClick={() => setSimulateOpen(true)}>{t("outreachPage.queue.simulate")}</Btn>
              </Card>
            )}
            {kindFilter !== "prospecting" && reviewEmails.map((em, i) => (
              <div key={em.id || i} data-testid="reply-item" onClick={() => { setSelected(i); setSelectedProspectingId(null); }}
                className={`p-2 rounded-xl border cursor-pointer transition-colors ${e && selected === i ? isDark ? "border-indigo-500/40 bg-slate-900" : "border-indigo-300 bg-indigo-50" : isDark ? "border-white/10 bg-slate-800 hover:border-white/20" : "border-gray-100 bg-white hover:border-gray-200"}`}>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs font-semibold text-gray-900">{reviewName(em)}</p>
                  <span className={`text-xs font-bold ${reviewScore(em) >= 80 ? "text-green-600" : "text-amber-600"}`}>{t("outreachPage.confidenceShort")}: {reviewScore(em)}%</span>
                </div>
                <p className="text-xs text-gray-500">{em.role} · {em.company}</p>
                <p className="text-xs text-gray-400 mt-1 truncate">{em.subject}</p>
                <div className="flex items-center gap-1 mt-1.5">
                  <Badge label={t("outreachPage.prospecting.kind.reply")} color={isDark ? "bg-slate-700 text-slate-200" : "bg-gray-100 text-gray-600"} />
                  {reviewScore(em) >= 80 && <Badge label={t("outreachPage.highScore")} color={isDark ? "bg-green-500/10 text-green-200 border border-green-400/20" : "bg-green-100 text-green-700"} />}
                  <span className="text-xs text-indigo-500 flex items-center gap-0.5"><LinkIcon size={9} />{reviewContentRef(em)}</span>
                </div>
              </div>
            ))}
          </div>

          <Card className="p-3">
            {shownProspecting ? (
              <ProspectingEmailDetail
                email={shownProspecting}
                t={t}
                busy={prospectingBusy}
                regenerating={regeneratingId === shownProspecting.id}
                onApprove={(email) => decideProspecting(email, "approve")}
                onReject={(email) => decideProspecting(email, "reject")}
                onMarkSent={(email) => decideProspecting(email, "markSent")}
                onRegenerate={regenerateProspecting}
                onCopy={copyProspecting}
              />
            ) : !e ? (
              <div className="py-10 text-center">
                <p className="text-sm font-semibold text-gray-900">{t("outreachPage.queue.selectTitle")}</p>
                <p className="text-xs text-gray-500">{t("outreachPage.queue.selectHint")}</p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{reviewName(e)}</p>
                    <p className="text-xs text-gray-500">{e.role} @ {e.company}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className={`text-sm font-bold ${reviewScore(e) >= 80 ? "text-green-600" : "text-amber-600"}`}>{t("outreachPage.confidenceShort")}: {reviewScore(e)}%</span>
                    <Badge label={reviewScore(e) >= 80 ? t("outreachPage.highConfidence") : t("outreachPage.reviewSuggested")} color={isDark ? reviewScore(e) >= 80 ? "bg-green-500/10 text-green-200 border border-green-400/20" : "bg-amber-500/10 text-amber-200 border border-amber-400/20" : reviewScore(e) >= 80 ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"} />
                  </div>
                </div>
                <div className="flex gap-1.5 mb-1.5">
                  <div className={`flex-1 p-2 rounded-lg ${isDark ? "bg-slate-900 border border-white/10" : "bg-gray-50"}`}>
                    <p className="text-xs text-gray-500">{t("outreachPage.opportunity")}</p>
                    <p className="text-xs font-medium text-gray-800">{e.vacancy || e.contact_message || t("outreachPage.queue.fallbackOpportunity")} @ {e.company}</p>
                  </div>
                  <div className={`flex-1 p-2 rounded-lg ${isDark ? "bg-slate-900 border border-white/10" : "bg-indigo-50"}`}>
                    <p className="text-xs text-indigo-400">{t("outreachPage.contentReferenced")}</p>
                    <p className="text-xs font-medium text-indigo-700 flex items-center gap-1"><LinkIcon size={10} />{reviewContentRef(e)}</p>
                  </div>
                </div>
                <div className="mb-[18px]">
                  <p className="text-xs text-gray-500 mb-1">{t("outreachPage.subject")}</p>
                  <p className="text-xs font-semibold text-gray-900">{e.subject}</p>
                </div>
                <div className={`mb-4 p-2 rounded-lg ${isDark ? "bg-slate-900 border border-white/10" : "bg-white border border-gray-200"}`}>
                  <pre className={`text-xs whitespace-pre-wrap font-sans leading-relaxed ${isDark ? "text-slate-200" : "text-gray-700"}`}>{reviewContent(e)}</pre>
                </div>
                <div className="flex gap-1 justify-end">
                  <Btn variant="ghost" small icon={<RefreshIcon size={12} />} onClick={() => handleRegenerate(e)} disabled={outreachBusy || !e.id}>{t("outreachPage.regenerate")}</Btn>
                  <Btn variant="secondary" small icon={<PenIcon size={12} />}>{t("outreachPage.edit")}</Btn>
                  <Btn variant="destructive" small icon={<XIcon size={12} />} onClick={() => handleReject(e)} disabled={outreachBusy}>{t("outreachPage.reject")}</Btn>
                  <Btn variant="teal" icon={<CheckIcon size={13} />} onClick={() => handleApprove(e)} disabled={outreachBusy}>{t("outreachPage.approveSend")}</Btn>
                </div>
              </>
            )}
          </Card>
        </div>
      )}

      {tab === "history" && (
        <>
          <div className="flex gap-1">{["all","sent","opened","replied","bounced","rejected"].map((filterKey)=>(
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
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.approvedBy")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.sent")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.score")}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t("outreachPage.history.actions")}</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {filteredHistory.map((o) => (
                  <tr key={o.id || o.name} className="group hover:bg-slate-50 cursor-pointer">
                    <td className="px-4 py-4 font-medium text-gray-900">{o.name || o.to}</td>
                    <td className="px-4 py-4 text-gray-600">{o.co || o.company}</td>
                    <td className="px-4 py-4 text-gray-500 truncate max-w-[180px]">{o.subj || o.subject}</td>
                    <td className="px-4 py-4"><span className="text-xs text-indigo-600 flex items-center gap-1"><LinkIcon size={10} />{o.contentRef || responseTypeLabel(o.response_type) || o.content}</span></td>
                    <td className="px-4 py-4"><Badge label={historyStatusLabel(o.st || o.status)} color={historyStatusColor(o)} /></td>
                    <td className="px-4 py-4">
                      {o.approvedByName ? (
                        <Badge label={`✓ ${o.approvedByName}`} color="bg-green-100 text-green-700" />
                      ) : o.rejectedByName ? (
                        <Badge label={`✗ ${o.rejectedByName}`} color="bg-red-100 text-red-700" />
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-gray-500">{o.date || String(o.sent_at || "").slice(0, 10)}</td>
                    <td className="px-4 py-4 font-semibold text-indigo-600">{String(o.score || "").includes("%") ? o.score : `${o.score || 0}%`}</td>
                    <td className="px-4 py-4">
                      <div className="flex justify-end gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                        {o.status === "rejected" && (
                          <button
                            type="button"
                            onClick={() => handleRestoreOutreach(o)}
                            disabled={outreachBusy}
                            className="rounded-md border border-indigo-300 bg-transparent px-2.5 py-1 text-xs font-medium text-indigo-600 transition hover:border-indigo-400 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            ↩ {t("outreachPage.history.restore")}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDeleteOutreach(o)}
                          disabled={outreachBusy}
                          className="rounded-md border border-red-200 bg-transparent px-2.5 py-1 text-xs font-medium text-red-600 transition hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={t("outreachPage.history.deleteAria")}
                        >
                          🗑
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card className="p-3 space-y-2">
            <p className="text-sm font-semibold text-gray-900">{t("outreachPage.prospecting.table.title")}</p>
            {closedProspecting.length === 0 ? (
              <p className="text-xs text-gray-500">{t("outreachPage.prospecting.table.empty")}</p>
            ) : (
              <table className="w-full text-xs" data-testid="prospecting-history">
                <thead><tr className="bg-slate-50 text-slate-600 uppercase">
                  <th className="px-3 py-2 text-left font-medium">{t("outreachPage.prospecting.table.contact")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("outreachPage.prospecting.table.company")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("outreachPage.prospecting.table.subject")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("outreachPage.prospecting.table.status")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("outreachPage.prospecting.table.language")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("outreachPage.prospecting.table.decidedBy")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("outreachPage.prospecting.table.date")}</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {closedProspecting.map((email) => {
                    const decidedBy = email.status === "sent" ? email.sent_marked_by_name : email.rejected_by_name;
                    const decidedAt = email.status === "sent" ? email.sent_at : email.rejected_at;
                    return (
                      <tr key={email.id}>
                        <td className="px-3 py-2 font-medium text-gray-900">{email.contact_name}</td>
                        <td className="px-3 py-2 text-gray-600">{email.company_name}</td>
                        <td className="px-3 py-2 text-gray-500 truncate max-w-[200px]">{email.subject}</td>
                        <td className="px-3 py-2"><EmailStatusBadge status={email.status} t={t} /></td>
                        <td className="px-3 py-2 text-gray-600">{languageLabel(email.language)}</td>
                        <td className="px-3 py-2 text-gray-600">{decidedBy || "—"}</td>
                        <td className="px-3 py-2 text-gray-500">{String(decidedAt || "").slice(0, 10)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}

      {simulateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <style>{`
            .spinner {
              display: inline-block;
              width: 14px;
              height: 14px;
              border: 2px solid rgba(255,255,255,0.3);
              border-top-color: white;
              border-radius: 50%;
              animation: spin 0.7s linear infinite;
              margin-right: 6px;
            }
            @keyframes spin {
              to { transform: rotate(360deg); }
            }
          `}</style>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setSimulateOpen(false)} />
          <div className={`relative w-full max-w-lg rounded-2xl shadow-2xl ${isDark ? "bg-slate-800 border border-white/10" : "bg-white"}`}>
            <div className={`flex items-center justify-between p-3 border-b ${isDark ? "border-white/10" : "border-gray-100"}`}>
              <div>
                <p className={`text-sm font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>{t("outreachPage.queue.simulate")}</p>
                <p className="text-xs text-gray-500">{t("outreachPage.simulate.subtitle")}</p>
              </div>
              <button onClick={() => setSimulateOpen(false)} className={`p-1.5 rounded-lg transition-colors ${isDark ? "hover:bg-slate-700" : "hover:bg-gray-100"}`}>
                <XIcon size={16} className="text-gray-400" />
              </button>
            </div>
            <div className="space-y-1.5 p-3">
              <Field label={t("outreachPage.simulate.contactMessage")}>
                <textarea
                  className="min-h-28 w-full rounded-lg border border-gray-200 px-3 py-4 text-sm outline-none focus:border-indigo-400"
                  value={simulateForm.contact_message}
                  onChange={(event) => setSimulateForm((current) => ({ ...current, contact_message: event.target.value }))}
                />
              </Field>
              <div className="grid grid-cols-3 gap-1.5">
                <Field label={t("outreachPage.simulate.name")}><Input value={simulateForm.name} onChange={(event) => setSimulateForm((current) => ({ ...current, name: event.target.value }))} /></Field>
                <Field label={t("outreachPage.simulate.company")}><Input value={simulateForm.company} onChange={(event) => setSimulateForm((current) => ({ ...current, company: event.target.value }))} /></Field>
                <Field label={t("outreachPage.simulate.role")}><Input value={simulateForm.role} onChange={(event) => setSimulateForm((current) => ({ ...current, role: event.target.value }))} /></Field>
              </div>
            </div>
            <div className={`flex justify-end gap-1 p-3 border-t ${isDark ? "border-white/10 bg-slate-900" : "border-gray-100 bg-gray-50"}`}>
              <Btn variant="ghost" onClick={() => setSimulateOpen(false)} disabled={outreachBusy}>{t("common.cancel")}</Btn>
              <Btn onClick={generateSimulatedResponse} disabled={generatingResponse || outreachBusy || !simulateForm.contact_message.trim() || !simulateForm.name.trim() || !simulateForm.company.trim()}>
                {generatingResponse
                  ? <><span className="spinner" /> {t("outreachPage.simulate.generating")}</>
                  : <><span>✦</span> {t("outreachPage.simulate.generate")}</>}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
