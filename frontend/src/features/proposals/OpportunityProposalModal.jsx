import { ProposalDocumentPreview } from "@/features/proposals/ProposalDocumentPreview";
import { calculateProposalTotal, formatUsd, normalizeLineItem, normalizeProposalDocument } from "@/features/proposals/proposalDocument";
import { createProposal, generateProposalById, updateProposal } from "@/api/proposalsApi";
import { ProposalTemplateFields, useProposalTemplatePicker } from "@/features/proposals/ProposalTemplatePicker";
import { announceProposalGeneration } from "@/features/proposals/generationNotifier";
import { exportProposalDocument } from "@/features/proposals/proposalExport";
import { proposalDocumentToHtml } from "@/features/proposals/proposalHtml";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useLanguage } from "@/context/LanguageContext";
import { useTheme } from "@/context/ThemeContext";
import { ProgressModal } from "@/components/dashboard/ProgressModal";
import { ArrowRightIcon, DownloadIcon, PenIcon, PlusIcon, SaveIcon, SparkIcon, TrashIcon, XIcon } from "@/components/dashboard/icons";
import { ToastStack, useToastQueue } from "@/components/dashboard/toasts";
import { Btn, Field, Input, Select } from "@/components/dashboard/ui";
import { PREF_KEYS, getStoredPreference } from "@/utils/localStore";

export function OpportunityProposalModal({ opportunity, onClose }) {
  const { t } = useI18n();
  const { language: activeLanguage } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const [step, setStep] = useState(1);
  const [pricingRows, setPricingRows] = useState([]);
  const [generationModal, setGenerationModal] = useState(null);
  const [proposal, setProposal] = useState(null);
  const [draftContent, setDraftContent] = useState("");
  const [editingPreview, setEditingPreview] = useState(false);
  const [customerEmail, setCustomerEmail] = useState("");
  const [teamSizing, setTeamSizing] = useState("");
  const templatePicker = useProposalTemplatePicker(); // RF-VTA-07
  const mountedRef = useRef(true);
  const backgroundRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const { toasts, setToast, removeToast, pauseToast, resumeToast } = useToastQueue();
  const proposalPreviewRef = useRef(null);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const opportunityTags = opportunity?.kw || opportunity?.tags || [];
  const contentUsed = opportunity?.content && opportunity.content !== "—" && opportunity.content !== "â€”" ? opportunity.content : t("opportunitiesPage.proposalModal.none");
  const proposalForm = {
    name: ({
      es: `Propuesta de ${opportunity?.job || "servicios"} – ${opportunity?.company || ""}`,
      pt: `Proposta de ${opportunity?.job || "serviços"} – ${opportunity?.company || ""}`,
    })[activeLanguage] || `Proposal: ${opportunity?.job || "services"} – ${opportunity?.company || ""}`,
    customer: opportunity?.company || "",
    customerEmail,
    customerCompany: opportunity?.company || "",
    template: templatePicker.templateName,
    date: new Date().toISOString().slice(0, 10),
    tags: opportunityTags.join(", "),
  };
  const opportunitySummary = `${opportunity?.company} is evaluating support for ${opportunity?.job}. Primary tags: ${opportunityTags.join(", ") || "not specified"}.`;
  const pricingTotal = calculateProposalTotal({ pricingRows }).totalAmount;
  const progressSteps = t("opportunitiesPage.proposalModal.steps");
  const [proposalLanguage, setProposalLanguage] = useState(activeLanguage || getStoredPreference(PREF_KEYS.language, "en"));
  useEffect(() => {
    setProposalLanguage(activeLanguage || getStoredPreference(PREF_KEYS.language, "en"));
  }, [activeLanguage]);
  const opportunityLanguageLabels = {
    en: "English",
    es: "Español",
    pt: "Português",
  };
  const proposalLength = "standard";

  const updatePricingRow = (id, field, value) => {
    setPricingRows((current) => current.map((row) => row.id === id ? { ...row, [field]: value } : row));
  };
  const addPricingRow = () => {
    setPricingRows((current) => [...current, { id: Date.now(), service: "", description: "", quantity: 1, unitPrice: 0 }]);
  };
  const removePricingRow = (id) => setPricingRows((current) => current.filter((row) => row.id !== id));

  const getOpportunityProfile = () => {
    const text = [
      opportunity?.company,
      opportunity?.job,
      opportunity?.role,
      opportunity?.content,
      ...opportunityTags,
    ].join(" ").toLowerCase();

    if (/hospital|clinic|health|healthcare|medical|patient|medtech/.test(text)) {
      return {
        industry: "Healthcare",
        executiveFocus: "improve patient support, operational responsiveness, and back-office reliability without increasing administrative load on clinical teams",
        problems: [
          "High-volume administrative work competes with patient-facing priorities.",
          "Support and documentation workflows depend on manual handoffs across teams.",
          "Leadership needs better visibility into service levels, response times, and follow-up quality.",
        ],
        solution: "Deploy an AI-assisted operations layer that triages inbound requests, structures documentation tasks, routes exceptions to the right team, and gives managers a clear view of throughput and quality.",
        technologies: ["AI workflow orchestration", "Document classification", "CRM/helpdesk integration", "Human-in-the-loop quality review", "Operational analytics dashboard"],
        roi: "Reduced administrative backlog, faster response cycles, fewer missed follow-ups, and more consistent patient or stakeholder communication.",
      };
    }

    if (/restaurant|food|pizzeria|pizza|hospitality|dining|kitchen/.test(text)) {
      return {
        industry: "Restaurant & Hospitality",
        executiveFocus: "increase booking, ordering, and customer follow-up efficiency while keeping service quality consistent during peak demand",
        problems: [
          "Customer inquiries, catering requests, and follow-ups are handled inconsistently during busy periods.",
          "Manual coordination between front-of-house, operations, and marketing slows response time.",
          "The business needs repeatable outreach and customer engagement without adding management overhead.",
        ],
        solution: "Implement AI-assisted customer engagement workflows for inquiry intake, follow-up messaging, local campaign content, and operational task routing.",
        technologies: ["AI customer response assistant", "Campaign content generator", "Lightweight CRM pipeline", "Automation triggers", "Performance reporting"],
        roi: "Faster response to customer requests, higher conversion from inquiries, better repeat-customer engagement, and less manual coordination for managers.",
      };
    }

    if (/finance|fintech|bank|accounting|payable|invoice|data entry|back office/.test(text)) {
      return {
        industry: "Finance & Back Office",
        executiveFocus: "scale finance operations with stronger accuracy, faster processing, and better audit visibility",
        problems: [
          "Manual data entry and reconciliation create cycle-time and quality risks.",
          "Back-office demand fluctuates while accuracy requirements remain high.",
          "Managers need clearer visibility into throughput, exceptions, and service performance.",
        ],
        solution: "Introduce an AI-enabled BPO workflow that structures incoming work, validates data, flags exceptions, and supports specialists with reusable operating procedures.",
        technologies: ["AI data extraction", "Exception detection", "Workflow automation", "Secure document handling", "KPI reporting"],
        roi: "Lower processing cost per transaction, improved accuracy, faster turnaround, and stronger operational controls.",
      };
    }

    if (/retail|ecommerce|store|customer|support|sales|inventory/.test(text)) {
      return {
        industry: "Retail & Customer Operations",
        executiveFocus: "improve customer support, sales follow-up, and operational responsiveness across distributed retail workflows",
        problems: [
          "Customer and operational requests arrive through multiple channels with inconsistent follow-up.",
          "Manual support workflows limit responsiveness during demand spikes.",
          "Teams need reusable content and process visibility to improve conversion and retention.",
        ],
        solution: "Create an AI-assisted operations workflow for customer triage, follow-up content, sales enablement assets, and performance tracking.",
        technologies: ["AI support triage", "CRM workflow automation", "Content personalization", "Knowledge base retrieval", "Conversion analytics"],
        roi: "Higher follow-up consistency, faster support resolution, improved conversion from warm opportunities, and better visibility into customer demand.",
      };
    }

    return {
      industry: "B2B Operations",
      executiveFocus: "turn a qualified opportunity into a structured, measurable operating model supported by AI and specialist delivery",
      problems: [
        "The opportunity requires faster execution without adding unnecessary management complexity.",
        "Current workflows depend on manual coordination and inconsistent follow-up.",
        "Leadership needs a clearer path from initial interest to measurable business impact.",
      ],
      solution: "Deploy a practical AI-assisted workflow that combines specialist delivery, reusable content, structured follow-up, and performance reporting.",
      technologies: ["Workflow automation", "CRM-ready opportunity tracking", "Content generation", "Human quality review", "Performance dashboard"],
      roi: "Shorter sales and delivery cycles, improved follow-up quality, lower manual effort, and clearer conversion metrics.",
    };
  };

  const buildOpportunityProposalData = () => {
    const profile = getOpportunityProfile();
    return {
      title: proposalForm.name,
      client: proposalForm.customer,
      contact: opportunity?.contact || "",
      stage: opportunity?.stage || "N/A",
      score: opportunity?.score,
      totalAmount: pricingTotal,
      industry: templatePicker.industryLabel || profile.industry,
      serviceLine: templatePicker.serviceTypeLabel || proposalForm.template,
      executiveSummary: `${proposalForm.customer} has a qualified opportunity to ${profile.executiveFocus}. NoonDalton proposes a focused AI-enabled delivery model that combines workflow automation, specialist execution, and management visibility. This proposal is based on the current opportunity for ${opportunity?.job || "the identified need"}, with a pipeline stage of ${opportunity?.stage || "N/A"} and a qualification score of ${opportunity?.score || "N/A"}%.`,
      problemsIdentified: profile.problems,
      proposedSolution: `${profile.solution} The solution will be configured around ${opportunityTags.length ? opportunityTags.join(", ") : "the client's core operating requirements"} and will use relevant existing content such as ${contentUsed} when appropriate.`,
      technologiesUsed: profile.technologies,
      lineItems: pricingRows.map(normalizeLineItem),
      expectedROI: `${profile.roi} Success will be measured through operational throughput, response time, quality indicators, and conversion progress from the current opportunity stage.`,
      nextSteps: [
        `Confirm scope and priority workflows with ${opportunity?.contact || "the client contact"}.`,
        "Validate pricing assumptions and service volumes.",
        "Approve implementation timeline and kickoff responsibilities.",
        "Prepare the final proposal package for stakeholder review.",
      ],
    };
  };

  const buildOpportunityProposalHtml = (structuredContent = buildOpportunityProposalData()) =>
    proposalDocumentToHtml({ ...structuredContent, structuredContent, pricingRows, totalAmount: structuredContent.totalAmount });

  const buildOpportunityBackendPayload = (structuredContent, total) => ({
    title: proposalForm.name,
    description: opportunitySummary,
    proposal_description: opportunitySummary,
    detailed_description: [
      `Opportunity: ${opportunity?.job || "N/A"}`,
      `Company: ${opportunity?.company || "N/A"}`,
      `Contact: ${opportunity?.contact || "N/A"}`,
      `Role: ${opportunity?.role || "N/A"}`,
      `Keywords: ${opportunityTags.join(", ") || "N/A"}`,
      `Content used: ${contentUsed}`,
    ].join("\n"),
    team_sizing: "",
    length: proposalLength,
    language: proposalLanguage,
    custom_prompt: `Generate a proposal for this opportunity using the provided company, role, stage, score, keywords, and content context. Keep the proposal specific to ${opportunity?.company || "the client"} and the opportunity ${opportunity?.job || "identified"}.`,
    status: "draft",
    customer_name: proposalForm.customer,
    clientName: proposalForm.customer,
    clientEmail: proposalForm.customerEmail || undefined,
    clientCompany: proposalForm.customerCompany || undefined,
    template: proposalForm.template,
    ...templatePicker.persistenceFields(),
    tags: opportunityTags,
    pricing_rows: pricingRows,
    lineItems: pricingRows.map(normalizeLineItem),
    total_amount: total.totalAmount,
    structured_content: {
      ...structuredContent,
      length: proposalLength,
      language: proposalLanguage,
    },
    opportunity: {
      company: opportunity?.company,
      title: opportunity?.job,
      contact: opportunity?.contact,
      role: opportunity?.role,
      stage: opportunity?.stage,
      score: opportunity?.score,
      contentUsed,
      lastActivity: opportunity?.date,
    },
  });

  // Tras «Continuar en segundo plano» el modal puede estar cerrado: el resultado se avisa por toast global.
  const inBackground = () => backgroundRef.current || !mountedRef.current;

  const generateProposal = async () => {
    backgroundRef.current = false;
    setGenerationModal({ title: proposalForm.name, activeStep: 0, completedSteps: [], progress: 5 });
    try {
      const savingDraftStep = Math.max(0, progressSteps.length - 2);
      for (let index = 0; index < savingDraftStep; index += 1) {
        setGenerationModal((current) => ({
          ...current,
          activeStep: index,
          progress: Math.round((index / savingDraftStep) * 82) + 5,
        }));
        await wait(450);
        setGenerationModal((current) => ({
          ...current,
          completedSteps: [...new Set([...(current?.completedSteps || []), index])],
          progress: Math.round(((index + 1) / savingDraftStep) * 85),
        }));
      }
      setGenerationModal((current) => ({
        ...current,
        activeStep: savingDraftStep,
        progress: 90,
      }));

      const structuredContent = buildOpportunityProposalData();
      const total = calculateProposalTotal({ pricingRows });
      const draftProposal = await createProposal(buildOpportunityBackendPayload(structuredContent, total));
      const generatedBackendProposal = await generateProposalById(draftProposal.id, {
        title: proposalForm.name,
        description: opportunitySummary,
        proposalDescription: opportunitySummary,
        proposal_description: opportunitySummary,
        detailedDescription: [
          `Opportunity: ${opportunity?.job || "N/A"}`,
          `Company: ${opportunity?.company || "N/A"}`,
          `Contact: ${opportunity?.contact || "N/A"}`,
          `Role: ${opportunity?.role || "N/A"}`,
                  `Keywords: ${opportunityTags.join(", ") || "N/A"}`,
          `Content used: ${contentUsed}`,
        ].join("\n"),
        teamSizing: teamSizing.trim(),
        length: proposalLength,
        clientName: proposalForm.customer,
        customer: proposalForm.customer,
        template: proposalForm.template,
        ...templatePicker.generationFields(),
        tags: opportunityTags,
        lineItems: pricingRows.map(normalizeLineItem),
        totalAmount: total.totalAmount,
        language: proposalLanguage,
        customPrompt: `Generate a proposal for this opportunity using the provided company, role, stage, score, keywords, and content context. Keep the proposal specific to ${opportunity?.company || "the client"} and the opportunity ${opportunity?.job || "identified"}.`,
      });
      const backendStructuredContent = normalizeProposalDocument({
        ...generatedBackendProposal,
        structuredContent: generatedBackendProposal.structuredContent || generatedBackendProposal.structured_content,
        pricingRows: generatedBackendProposal.pricingRows || generatedBackendProposal.pricing_rows || pricingRows,
        lineItems: generatedBackendProposal.lineItems || pricingRows,
        totalAmount: generatedBackendProposal.totalAmount ?? generatedBackendProposal.total_amount ?? total.totalAmount,
        language: generatedBackendProposal.language || proposalLanguage,
      });
      const content = proposalDocumentToHtml({
        ...generatedBackendProposal,
        structuredContent: backendStructuredContent,
        pricingRows,
        totalAmount: backendStructuredContent.totalAmount,
      });
      const generatedProposal = {
        ...generatedBackendProposal,
        id: generatedBackendProposal.id || draftProposal.id,
        title: proposalForm.name,
        type: "Proposal",
        status: "generated",
        description: opportunitySummary,
        content,
        structuredContent: backendStructuredContent,
        ...backendStructuredContent,
        customerName: proposalForm.customer,
        date: proposalForm.date,
        template: proposalForm.template,
        pricingRows,
        totalAmount: backendStructuredContent.totalAmount ?? total.totalAmount,
        tags: opportunityTags,
        length: proposalLength,
        language: proposalLanguage,
        opportunity: {
          company: opportunity?.company,
          title: opportunity?.job,
          contact: opportunity?.contact,
          role: opportunity?.role,
          stage: opportunity?.stage,
          score: opportunity?.score,
          contentUsed,
          lastActivity: opportunity?.date,
        },
        updated: "Today",
      };
      if (inBackground()) {
        announceProposalGeneration({ ok: true, message: `${t("opportunitiesPage.proposalModal.readyToast")}: ${proposalForm.name}` });
        return;
      }
      setDraftContent(content);
      setProposal(generatedProposal);
      setStep(3);
      setGenerationModal((current) => ({
        ...current,
        activeStep: progressSteps.length - 1,
        completedSteps: progressSteps.map((_, index) => index),
        progress: 100,
        error: null,
      }));
      await wait(250);
      setGenerationModal(null);
    } catch (error) {
      console.error(error);
      if (inBackground()) {
        announceProposalGeneration({ ok: false, message: `${t("opportunitiesPage.proposalModal.failedToast")}: ${proposalForm.name}` });
        return;
      }
      setGenerationModal((current) => ({ ...current, error: t("opportunitiesPage.proposalModal.errorGenerating") }));
    }
  };

  const continueInBackground = () => {
    backgroundRef.current = true;
    setGenerationModal(null);
    onClose();
  };

  const saveDraft = async () => {
    if (!proposal) return;
    if (!proposal.id) {
      setToast({ type: "error", message: t("opportunitiesPage.proposalModal.errorGenerating") });
      return;
    }
    const nextProposal = { ...proposal, content: draftContent || proposal.content };
    const structuredContent = normalizeProposalDocument(nextProposal);
    const total = calculateProposalTotal(nextProposal);
    const updatedProposal = {
      ...nextProposal,
      structuredContent,
      ...structuredContent,
      content: proposalDocumentToHtml({ ...nextProposal, structuredContent }),
      status: "draft",
      totalAmount: total.totalAmount,
      updated: "Today",
    };
    try {
      await updateProposal(proposal.id, {
        title: updatedProposal.title,
        description: updatedProposal.description || "",
        content: updatedProposal.content,
        structured_content: structuredContent,
        status: "draft",
        total_amount: total.totalAmount,
      });
      setProposal(updatedProposal);
      setToast(t("opportunitiesPage.proposalModal.draftSaved"));
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: t("opportunitiesPage.proposalModal.errorGenerating") });
    }
  };

  const downloadDraft = async (format) => {
    if (!proposal) return;
    await exportProposalDocument({ ...proposal, content: draftContent || proposal.content }, format, proposalPreviewRef.current);
  };

  if (!opportunity) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <ToastStack
        toasts={toasts}
        onClose={removeToast}
        onMouseEnter={pauseToast}
        onMouseLeave={resumeToast}
      />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-4xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{t("opportunitiesPage.proposalModal.title")}</h2>
            <p className="text-xs text-gray-500">{opportunity.company} · {opportunity.job}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100"><XIcon size={16} className="text-gray-400" /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {[t("opportunitiesPage.proposalModal.opportunityContext"), t("opportunitiesPage.proposalModal.pricing"), t("opportunitiesPage.proposalModal.proposalPreview")].map((label, index) => (
              <button
                key={label}
                onClick={() => proposal || index < 2 ? setStep(index + 1) : null}
                className={`rounded-lg border px-2 py-2 text-xs font-medium ${step === index + 1 ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-gray-100 bg-gray-50 text-gray-500"}`}
              >
                {t("opportunitiesPage.proposalModal.step")} {index + 1}<br />{label}
              </button>
            ))}
          </div>

          {step === 1 && (
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("opportunitiesPage.proposalModal.customer")}><Input value={proposalForm.customer} readOnly /></Field>
              <Field label="Client email" hint="Used to send this proposal to your CRM">
                <Input type="email" value={customerEmail} onChange={(event) => setCustomerEmail(event.target.value)} placeholder="client@company.com" />
              </Field>
              <Field label={t("opportunitiesPage.proposalModal.proposalName")}><Input value={proposalForm.name} readOnly /></Field>
              <ProposalTemplateFields picker={templatePicker} />
              <Field label={t("opportunitiesPage.proposalModal.tags")}><Input value={proposalForm.tags} readOnly /></Field>
              <Field label={activeLanguage === "es" ? "Idioma de la propuesta" : activeLanguage === "pt" ? "Idioma da proposta" : "Proposal language"}>
                <Select value={proposalLanguage} onChange={(event) => setProposalLanguage(event.target.value)}>
                  {Object.entries(opportunityLanguageLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </Select>
              </Field>
              <div className="col-span-2">
                <Field label={t("opportunitiesPage.proposalModal.teamSizing")} hint={t("opportunitiesPage.proposalModal.teamSizingHint")}>
                  <Input aria-label={t("opportunitiesPage.proposalModal.teamSizing")} value={teamSizing} onChange={(event) => setTeamSizing(event.target.value)} maxLength={300} />
                </Field>
              </div>
              <div className="col-span-2">
                <Field label={t("opportunitiesPage.proposalModal.opportunityContext")}>
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-xs text-gray-700">
                    <div className="grid grid-cols-4 gap-3">
                      <div><span className="text-gray-400">{t("opportunitiesPage.proposalModal.opportunity")}</span><p className="font-semibold text-gray-900">{opportunity?.job}</p></div>
                      <div><span className="text-gray-400">{t("opportunitiesPage.proposalModal.contact")}</span><p className="font-semibold text-gray-900">{opportunity?.contact}</p></div>
                      <div><span className="text-gray-400">{t("opportunitiesPage.proposalModal.role")}</span><p className="font-semibold text-gray-900">{opportunity?.role}</p></div>
                      <div><span className="text-gray-400">{t("opportunitiesPage.proposalModal.score")}</span><p className="font-semibold text-gray-900">{opportunity?.score}%</p></div>
                    </div>
                    <p className="mt-3 leading-relaxed">{opportunitySummary}</p>
                  </div>
                </Field>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <div className="overflow-x-auto border border-gray-100 rounded-xl">
                <table className="min-w-full text-xs">
                  <thead className="bg-gray-50 text-gray-500">
                    <tr>
                      <th className="px-2 py-2 text-left">{t("opportunitiesPage.proposalModal.serviceUnit")}</th>
                      <th className="px-2 py-2 text-left">{t("opportunitiesPage.proposalModal.description")}</th>
                      <th className="px-2 py-2 text-left">{t("opportunitiesPage.proposalModal.qty")}</th>
                      <th className="px-2 py-2 text-left">{t("opportunitiesPage.proposalModal.unitPrice")}</th>
                      <th className="px-2 py-2 text-right">{t("opportunitiesPage.proposalModal.subtotal")}</th>
                      <th className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {pricingRows.length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-400">{t("opportunitiesPage.proposalModal.noPricing")}</td></tr>
                    )}
                    {pricingRows.map((row) => (
                      <tr key={row.id} className="border-t border-gray-100">
                        <td className="p-2"><Input value={row.service} onChange={(e) => updatePricingRow(row.id, "service", e.target.value)} /></td>
                        <td className="p-2"><Input value={row.description} onChange={(e) => updatePricingRow(row.id, "description", e.target.value)} /></td>
                        <td className="p-2 w-20"><Input type="number" min="0" value={row.quantity} onChange={(e) => updatePricingRow(row.id, "quantity", e.target.value)} /></td>
                        <td className="p-2 w-28"><Input type="number" min="0" value={row.unitPrice} onChange={(e) => updatePricingRow(row.id, "unitPrice", e.target.value)} /></td>
                        <td className="p-2 text-right font-semibold text-gray-700">{formatUsd(Number(row.quantity || 0) * Number(row.unitPrice || 0))}</td>
                        <td className="p-2"><button onClick={() => removePricingRow(row.id)} className="p-1 rounded hover:bg-red-50"><TrashIcon size={12} className="text-red-500" /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between">
                <Btn variant="secondary" small icon={<PlusIcon size={12} />} onClick={addPricingRow}>{t("opportunitiesPage.proposalModal.addLineItem")}</Btn>
                <div className="text-sm text-gray-700">{t("opportunitiesPage.proposalModal.totalAmount")}: <strong>{pricingTotal ? formatUsd(pricingTotal) : t("opportunitiesPage.proposalModal.notCalculated")}</strong></div>
              </div>
            </div>
          )}

          {step === 3 && proposal && (
            <div className="space-y-4">
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">{t("opportunitiesPage.proposalModal.reviewNotice")}</p>
              {Array.isArray(proposal.sources) && proposal.sources.length > 0 && (
                <p className="text-xs text-gray-500">{t("opportunitiesPage.proposalModal.sourcesUsed")}: {proposal.sources.map((source) => source.title).join(", ")}</p>
              )}
              <div className={`rounded-2xl border overflow-hidden ${isDark ? "border-white/10" : "border-gray-100"}`}>
                {editingPreview ? (
                  <div
                    className={`max-h-[55vh] overflow-y-auto rounded-xl border p-6 text-sm shadow-sm prose max-w-none ${isDark ? "border-white/10 bg-slate-800 text-slate-100 prose-invert" : "border-indigo-200 bg-white text-gray-800 ring-2 ring-indigo-100 prose-slate"}`}
                    contentEditable
                    suppressContentEditableWarning
                    dangerouslySetInnerHTML={{ __html: draftContent }}
                    onBlur={(e) => setDraftContent(e.currentTarget.innerHTML)}
                  />
                ) : (
                  <ProposalDocumentPreview
                    proposal={{ ...proposal, content: draftContent || proposal.content }}
                    exportRef={proposalPreviewRef}
                    className={`max-h-[55vh] overflow-y-auto rounded-xl border p-8 shadow-sm ${isDark ? "border-white/10 bg-slate-800 text-slate-100" : "border-gray-200 bg-white text-gray-800"}`}
                  />
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between p-5 border-t border-gray-100 bg-gray-50 rounded-b-2xl">
          <Btn variant="ghost" onClick={onClose}>{t("opportunitiesPage.proposalModal.close")}</Btn>
          <div className="flex gap-2">
            {step === 1 && <Btn icon={<ArrowRightIcon size={13} />} onClick={() => setStep(2)}>{t("opportunitiesPage.proposalModal.continuePricing")}</Btn>}
            {step === 2 && <Btn icon={<SparkIcon size={13} />} onClick={generateProposal}>{t("opportunitiesPage.proposalModal.generateDraft")}</Btn>}
            {step === 3 && proposal && (
              <>
                <Btn variant="secondary" icon={<PenIcon size={12} />} onClick={() => setEditingPreview((current) => !current)}>
                  {editingPreview ? t("opportunitiesPage.proposalModal.doneEditing") : t("opportunitiesPage.proposalModal.edit")}
                </Btn>
                <Btn variant="secondary" icon={<SaveIcon size={12} />} onClick={saveDraft}>{t("opportunitiesPage.proposalModal.saveDraft")}</Btn>
                <Btn variant="secondary" icon={<DownloadIcon size={12} />} onClick={() => downloadDraft("docx")}>{t("opportunitiesPage.proposalModal.exportDocx")}</Btn>
                <Btn icon={<DownloadIcon size={12} />} onClick={() => downloadDraft("pdf")}>{t("opportunitiesPage.proposalModal.exportPdf")}</Btn>
                <Btn variant="secondary" disabled>{t("opportunitiesPage.proposalModal.crmNext")}</Btn>
              </>
            )}
          </div>
        </div>
      </div>
      <ProgressModal
        title={`${t("opportunitiesPage.proposalModal.generating")}: ${generationModal?.title || proposalForm.name}`}
        steps={progressSteps}
        state={generationModal}
        subtitle={t("opportunitiesPage.proposalModal.backgroundNote")}
        cancelLabel={t("opportunitiesPage.proposalModal.background")}
        completeLabel={t("opportunitiesPage.proposalModal.completeLabel")}
        retryLabel={t("opportunitiesPage.proposalModal.retryLabel")}
        onCancel={continueInBackground}
        onRetry={generateProposal}
      />
    </div>
  );
}
