import { ArrowRightIcon, BookIcon, BriefIcon, CheckIcon, DownloadIcon, EyeIcon, FileIcon, LayersIcon, LinkIcon, PenIcon, PlugIcon, PlusIcon, RefreshIcon, SaveIcon, Share2Icon, SparkIcon, TrashIcon, XIcon } from "@/components/dashboard/icons";
import { Badge, Btn, Card, Field, Input, Select } from "@/components/dashboard/ui";
import { Footer } from "docx";
import Modal from "@/components/ui/Modal";
import { PREF_KEYS, getContentItemKey, getStoredPreference, readDeletedContentIds, readLocalContentProposals, saveLocalContentProposal, writeDeletedContentIds } from "@/utils/localStore";
import { PROPOSAL_STATUSES, PROPOSAL_STATUS_COLOR_CLASSES } from "@/features/proposals/proposalStatus";
import { ProgressModal } from "@/components/dashboard/ProgressModal";
import { ProposalDocumentPreview } from "@/features/proposals/ProposalDocumentPreview";
import { ToastStack, useToastQueue } from "@/components/dashboard/toasts";
import api, { socialApi } from "@/api/axios";
import { calculateProposalTotal, cleanStructuredText, formatUsd, normalizeLineItem, normalizeProposalDocument } from "@/features/proposals/proposalDocument";
import { cleanProposalHtml, stripHtml } from "@/utils/htmlText";
import { completeCampaignFlowSteps, normalizeCampaignContent } from "@/utils/campaignContent";
import { createProposal, deleteProposal, generateProposalById, getProposals, sendProposalToCrm, updateProposal, updateProposalStatus } from "@/api/proposalsApi";
import { downloadBlob, exportProposalDocument, sanitizeDownloadName } from "@/features/proposals/proposalExport";
import html2pdf from "html2pdf.js";
import { proposalDocumentToHtml } from "@/features/proposals/proposalHtml";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useLanguage } from "@/context/LanguageContext";
import { useTheme } from "@/context/ThemeContext";

function extractH1Text(html = "") {
  const match = cleanProposalHtml(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return match ? stripHtml(match[1]).trim() : "";
}

/* ═══════════════════════════════════════════════════════════════ */
/*  PAGE: CONTENT LIBRARY (merged Assets, Proposals, Templates)    */
/* ═══════════════════════════════════════════════════════════════ */
export function ContentLibraryPage({ navigationState = {}, onNavigate = () => {}, campaignFlow = null, setCampaignFlow = () => {} }) {
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
