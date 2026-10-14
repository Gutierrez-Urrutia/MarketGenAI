import { Badge, Btn, Card, Field, Input, Select, TagInput } from "@/components/dashboard/ui";
import { BotIcon, CheckIcon, DownloadIcon, FileIcon, GearIcon, KeyIcon, LayersIcon, PenIcon, PlayIcon, PlugIcon, SaveIcon, Share2Icon, ShieldIcon, SlidersIcon, TagIcon, TrashIcon, XIcon, ZapIcon } from "@/components/dashboard/icons";
import { DATE_FORMAT_OPTIONS, PREF_KEYS, TIMEZONE_OPTIONS, getBrowserTimezone, getStoredPreference } from "@/utils/localStore";
import { Footer } from "docx";
import KnowledgeBaseTab from "@/pages/settings/KnowledgeBaseTab";
import Modal from "@/components/ui/Modal";
import PipelineSettingsTab from "@/pages/settings/PipelineSettingsTab";
import { ToastStack, useToastQueue } from "@/components/dashboard/toasts";
import api, { crmApi, settingsApi, socialApi } from "@/api/axios";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useLanguage } from "@/context/LanguageContext";
import { useTheme } from "@/context/ThemeContext";

const SettingsSection = ({ title, IconComp, desc, badge, isDark, children }) => (
  <Card className="p-3">
    <div className="flex items-center justify-between mb-2 pb-3 border-b border-gray-100">
      <div className="flex items-center gap-1">
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${isDark ? "bg-slate-900 text-slate-200 border border-white/10" : "bg-indigo-50 text-indigo-600"}`}>
          <IconComp size={14} />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          {desc && <p className="text-xs text-gray-400">{desc}</p>}
        </div>
      </div>
      {badge}
    </div>
    {children}
  </Card>
);

export function SettingsPage({ navigationState = {} }) {
  const { t } = useI18n();
  const { language, changeLanguage } = useLanguage();
  const { theme, changeTheme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const [tab, setTab] = useState(navigationState.tab || "general");
  const [socialModal, setSocialModal] = useState(null); // null or channel object
  const [socialConnectionForm, setSocialConnectionForm] = useState({ email: "", handle: "", accessToken: "" });
  const [model, setModel] = useState(getStoredPreference(PREF_KEYS.model, "deepseek"));
  const [timezone, setTimezone] = useState(getStoredPreference(PREF_KEYS.timezone, getBrowserTimezone()));
  const [dateFormat, setDateFormat] = useState(getStoredPreference(PREF_KEYS.dateFormat, "DD/MM/YYYY"));
  const [socialStatus, setSocialStatus] = useState(null);
  const [socialBusy, setSocialBusy] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [crmStatus, setCrmStatus] = useState(null);
  const [crmModal, setCrmModal] = useState(null); // null or { provider, l, c, ok }
  const [crmForm, setCrmForm] = useState({ apiKey: "", consumerKey: "", consumerSecret: "", loginUrl: "" });
  const [crmTestStatus, setCrmTestStatus] = useState(null);
  const [crmTestMessage, setCrmTestMessage] = useState("");
  const [crmSaving, setCrmSaving] = useState(false);
  const [crmActiveSaving, setCrmActiveSaving] = useState(false);
  const [settingsTemplates, setSettingsTemplates] = useState([]);
  const [editingTemplateId, setEditingTemplateId] = useState(null);
  const [templateNameDraft, setTemplateNameDraft] = useState("");
  const [templateEditorContent, setTemplateEditorContent] = useState(
    "# Proposal for {{customer_name}}\n\n## Executive Summary\n\n## Pricing\n{{line_item_table}}\n\nTotal: {{total_amount}}\n\nDate: {{date}}"
  );
  const [templateSaving, setTemplateSaving] = useState(false);
  const [templateUploading, setTemplateUploading] = useState(false);
  const { toasts, setToast, removeToast, pauseToast, resumeToast } = useToastQueue();

  const loadSettingsTemplates = () => {
    api.get("/templates", { suppressPermissionToast: true })
      .then(({ data }) => setSettingsTemplates(data?.items || []))
      .catch((error) => console.error(error));
  };

  useEffect(() => {
    loadSettingsTemplates();
  }, []);

  const getApiErrorMessage = (error, fallback) => {
    const detail = error?.response?.data?.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (Array.isArray(detail)) {
      const firstMessage = detail
        .map((item) => item?.msg || item?.message || (typeof item === "string" ? item : ""))
        .find(Boolean);
      if (firstMessage) return firstMessage;
    }
    return error?.message || fallback;
  };

  const resetTemplateEditor = () => {
    setEditingTemplateId(null);
    setTemplateNameDraft("");
    setTemplateEditorContent(
      "# Proposal for {{customer_name}}\n\n## Executive Summary\n\n## Pricing\n{{line_item_table}}\n\nTotal: {{total_amount}}\n\nDate: {{date}}"
    );
  };

  const saveSettingsTemplate = async () => {
    if (!templateNameDraft.trim()) {
      setToast({ type: "error", message: t("settings.templateNameRequired") });
      return;
    }
    setTemplateSaving(true);
    try {
      const payload = {
        name: templateNameDraft.trim(),
        type: "proposal",
        content: templateEditorContent,
      };
      const { data } = editingTemplateId
        ? await api.put(`/templates/${editingTemplateId}`, payload, { suppressPermissionToast: true })
        : await api.post("/templates", payload, { suppressPermissionToast: true });
      setSettingsTemplates((current) => {
        if (editingTemplateId) {
          return current.map((template) => template.id === editingTemplateId ? data : template);
        }
        return [data, ...current.filter((template) => template.id !== data.id)];
      });
      resetTemplateEditor();
      setToast({ type: "success", message: t("settings.templateSaved") });
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: getApiErrorMessage(error, t("settings.templateSaveFailed")) });
    } finally {
      setTemplateSaving(false);
    }
  };

  const uploadTemplateFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setTemplateUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const { data } = await api.post("/templates/extract", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        suppressPermissionToast: true,
      });
      setEditingTemplateId(null);
      setTemplateNameDraft(data?.name || file.name.replace(/\.[^.]+$/, ""));
      setTemplateEditorContent(data?.content || "");
      setToast({ type: "success", message: "Template content loaded. Review it before saving." });
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: getApiErrorMessage(error, "Could not read the uploaded template.") });
    } finally {
      setTemplateUploading(false);
      event.target.value = "";
    }
  };

  const refreshSocialStatus = async () => {
    try {
      const { data } = await socialApi.status();
      setSocialStatus(data);
    } catch (error) {
      console.error(error);
    }
  };

  useEffect(() => {
    refreshSocialStatus();
  }, []);

  const refreshCrmStatus = async () => {
    try {
      const { data } = await crmApi.status();
      setCrmStatus(data);
    } catch (error) {
      console.error(error);
    }
  };

  useEffect(() => {
    refreshCrmStatus();
  }, []);

  useEffect(() => {
    let mounted = true;
    settingsApi.get()
      .then(({ data }) => {
        if (!mounted) return;
        const savedTimezone = data?.timezone || getStoredPreference(PREF_KEYS.timezone, getBrowserTimezone());
        const savedDateFormat = data?.dateFormat || getStoredPreference(PREF_KEYS.dateFormat, "DD/MM/YYYY");
        setTimezone(savedTimezone);
        setDateFormat(savedDateFormat);
        localStorage.setItem(PREF_KEYS.timezone, savedTimezone);
        localStorage.setItem(PREF_KEYS.dateFormat, savedDateFormat);
      })
      .catch((error) => console.error(error));
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (navigationState.tab) setTab(navigationState.tab);
  }, [navigationState.tab]);

  const connectFacebook = async () => {
    setSocialBusy(true);
    try {
      const { data } = await socialApi.connectFacebook();
      if (data?.authUrl) {
        window.location.assign(data.authUrl);
      } else {
        setToast({ type: "error", message: t("settings.socialConnectFailed") });
      }
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: error.response?.data?.detail || t("settings.socialConnectFailed") });
    } finally {
      setSocialBusy(false);
    }
  };

  const openSocialModal = (channel) => {
    setSocialModal(channel);
    setSocialConnectionForm({
      email: "",
      handle: channel.user && channel.user !== "Configured token" ? channel.user : "",
      accessToken: "",
    });
  };

  const saveManualSocialConnection = async () => {
    if (!socialModal?.platform) return;
    setSocialBusy(true);
    try {
      await socialApi.connectManual(socialModal.platform, socialConnectionForm);
      await refreshSocialStatus();
      setSocialModal(null);
      setToast({ type: "success", message: `${socialModal.l} connected.` });
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: error.response?.data?.detail || t("settings.socialConnectFailed") });
    } finally {
      setSocialBusy(false);
    }
  };

  const disconnectSocialPlatform = async (platform = socialModal?.platform || "facebook") => {
    setSocialBusy(true);
    try {
      await socialApi.disconnect(platform);
      setSocialModal(null);
      await refreshSocialStatus();
      setToast({ type: "success", message: t("settings.socialDisconnected") });
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: t("settings.socialConnectFailed") });
    } finally {
      setSocialBusy(false);
    }
  };

  const savePreference = (key, value, setter) => {
    setter(value);
    localStorage.setItem(key, value);
    window.dispatchEvent(new CustomEvent("marketgen:prefs"));
  };

  const saveLanguagePreference = (value) => {
    changeLanguage(value);
    window.dispatchEvent(new CustomEvent("marketgen:prefs"));
  };

  const saveThemePreference = (value) => {
    changeTheme(value);
    window.dispatchEvent(new CustomEvent("marketgen:prefs"));
  };

  const handleSaveSettings = async () => {
    setSettingsSaving(true);
    try {
      await settingsApi.update({
        language,
        theme,
        timezone,
        dateFormat,
        llm: { model },
      });
      setToast({ type: "success", message: t("settings.saved") });
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: "Could not save settings." });
    } finally {
      setSettingsSaving(false);
    }
  };

  const openCrmModal = (entry) => {
    const saved = crmStatus?.connections?.[entry.provider] || {};
    setCrmModal(entry);
    setCrmForm({
      apiKey: saved.apiKeyLast4 ? `••••${saved.apiKeyLast4}` : "",
      consumerKey: saved.consumerKeyLast4 ? `••••${saved.consumerKeyLast4}` : "",
      consumerSecret: saved.consumerSecretLast4 ? `••••${saved.consumerSecretLast4}` : "",
      loginUrl: saved.loginUrl || "",
    });
    setCrmTestStatus(null);
    setCrmTestMessage("");
  };

  const crmIntegrationReady = crmModal?.provider === "salesforce"
    ? Boolean(crmForm.consumerKey.trim() && crmForm.consumerSecret.trim() && crmForm.loginUrl.trim())
    : Boolean(crmForm.apiKey.trim());

  const testCrmConnection = async () => {
    if (!crmModal) return;
    setCrmTestStatus("testing");
    setCrmTestMessage("");
    const payload = crmModal.provider === "salesforce"
      ? { provider: "salesforce", consumerKey: crmForm.consumerKey, consumerSecret: crmForm.consumerSecret, loginUrl: crmForm.loginUrl }
      : { provider: "hubspot", apiKey: crmForm.apiKey };
    try {
      const { data } = await crmApi.testConnection(payload);
      setCrmTestStatus("connected");
      setCrmTestMessage(data.message || "Conexión exitosa");
    } catch (err) {
      setCrmTestStatus("error");
      setCrmTestMessage(err.response?.data?.detail || "Error al conectar");
    }
  };

  const saveCrmConnection = async () => {
    if (!crmModal) return;
    setCrmSaving(true);
    try {
      const payload = crmModal.provider === "salesforce"
        ? { consumerKey: crmForm.consumerKey, consumerSecret: crmForm.consumerSecret, loginUrl: crmForm.loginUrl }
        : { apiKey: crmForm.apiKey };
      await crmApi.connect(crmModal.provider, payload);
      await refreshCrmStatus();
      setCrmModal(null);
      setToast({ type: "success", message: t("settings.saved") });
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: getApiErrorMessage(error, "Could not save the CRM integration.") });
    } finally {
      setCrmSaving(false);
    }
  };

  const disconnectCrmProvider = async (provider = crmModal?.provider) => {
    if (!provider) return;
    setCrmSaving(true);
    try {
      await crmApi.disconnect(provider);
      await refreshCrmStatus();
      setCrmModal(null);
      setToast({ type: "success", message: t("settings.socialDisconnected") });
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: getApiErrorMessage(error, "Could not disconnect.") });
    } finally {
      setCrmSaving(false);
    }
  };

  const setActiveCrmProvider = async (value) => {
    setCrmActiveSaving(true);
    try {
      const { data } = await crmApi.setActiveProvider(value);
      setCrmStatus(data);
      setToast({ type: "success", message: t("settings.saved") });
    } catch (error) {
      console.error(error);
      setToast({ type: "error", message: getApiErrorMessage(error, "Could not update active CRM provider.") });
    } finally {
      setCrmActiveSaving(false);
    }
  };

  const crmProviders = [
    {
      provider: "hubspot",
      l: "HubSpot",
      c: "bg-orange-500",
      ok: Boolean(crmStatus?.connections?.hubspot?.connected),
      detail: crmStatus?.connections?.hubspot?.apiKeyLast4 ? `Key ••••${crmStatus.connections.hubspot.apiKeyLast4}` : "",
    },
    {
      provider: "salesforce",
      l: "Salesforce",
      c: "bg-blue-400",
      ok: Boolean(crmStatus?.connections?.salesforce?.connected),
      detail: crmStatus?.connections?.salesforce?.loginUrl || "",
    },
  ];

  const socialChannels = [
    { platform: "linkedin", l: "LinkedIn", c: "bg-blue-600", ok: Boolean(socialStatus?.linkedin?.connected), user: socialStatus?.linkedin?.user || "" },
    { platform: "facebook", l: "Facebook", c: "bg-blue-500", ok: Boolean(socialStatus?.facebook?.connected), user: socialStatus?.facebook?.user || socialStatus?.facebook?.pageName || "" },
    { platform: "twitter", l: "Twitter / X", c: "bg-gray-900", ok: Boolean(socialStatus?.twitter?.connected), user: socialStatus?.twitter?.user || "" },
    { l: "Instagram", c: "bg-gradient-to-tr from-yellow-400 via-pink-500 to-purple-600", ok: Boolean(socialStatus?.instagram?.connected), user: socialStatus?.instagram?.username || "", linkedToFacebook: true },
  ];
  const settingsControlClass = isDark
    ? "w-full border border-white/10 rounded-lg px-3 py-1.5 text-xs bg-slate-800 text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 file:mr-3 file:rounded-md file:border-0 file:bg-slate-700 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-white"
    : "w-full border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500";
  const settingsPanelClass = isDark
    ? "rounded-xl border border-white/10 bg-slate-800 p-2"
    : "rounded-xl border border-gray-100 bg-gray-50 p-2";
  const settingsTabClass = (active) => `flex-1 flex items-center justify-center gap-1 px-3 py-4 rounded-lg text-xs font-medium transition-colors ${
    active
      ? isDark ? "bg-slate-700 text-white" : "bg-white text-gray-900 shadow-sm"
      : isDark ? "bg-transparent text-slate-300 hover:bg-slate-700/60" : "text-gray-500"
  }`;
  const settingsOptionClass = (active) => `px-3 py-4 rounded-lg border text-xs font-medium capitalize transition-colors ${
    active
      ? isDark ? "border-white/10 bg-slate-700 text-white" : "border-indigo-300 bg-indigo-50 text-indigo-700"
      : isDark ? "border-white/10 bg-slate-800 text-slate-300 hover:bg-slate-700" : "border-gray-200 text-gray-600"
  }`;
  const settingsStatusBadgeColor = (status) => {
    const normalized = String(status || "").toLowerCase();
    if (!isDark) {
      if (normalized.includes("connect") && !normalized.includes("not")) return "bg-green-100 text-green-700";
      if (normalized.includes("default")) return "bg-indigo-100 text-indigo-700";
      if (normalized.includes("draft")) return "bg-gray-100 text-gray-600";
      return "bg-gray-100 text-gray-400";
    }
    if (normalized.includes("connect") && !normalized.includes("not")) return "bg-green-500/10 text-green-200 border border-green-400/20";
    if (normalized.includes("default")) return "bg-indigo-500/10 text-indigo-200 border border-indigo-400/20";
    if (normalized.includes("draft")) return "bg-slate-900 text-slate-300 border border-white/10";
    if (normalized.includes("not")) return "bg-slate-900 text-slate-400 border border-white/10";
    return "bg-slate-900 text-slate-300 border border-white/10";
  };
  return (
    <div className="space-y-2">
      <ToastStack
        toasts={toasts}
        onClose={removeToast}
        onMouseEnter={pauseToast}
        onMouseLeave={resumeToast}
      />
      <div>
        <h1 className="text-xl font-bold text-gray-900">{t("settings.title")}</h1>
        <p className="text-xs text-gray-500">{t("settings.subtitle")}</p>
      </div>
      <div className={`flex gap-1 rounded-xl p-1 ${isDark ? "bg-slate-800 border border-white/10" : "bg-gray-100"}`}>
        <button onClick={() => setTab("general")} className={settingsTabClass(tab === "general")}><BotIcon size={13} />{t("settings.general")}</button>
        <button onClick={() => setTab("templates")} className={settingsTabClass(tab === "templates")}><FileIcon size={13} />{t("settings.templates")}</button>
        <button onClick={() => setTab("integrations")} className={settingsTabClass(tab === "integrations")}><PlugIcon size={13} />{t("settings.integrations")}</button>
        <button onClick={() => setTab("pipeline")} className={settingsTabClass(tab === "pipeline")}><LayersIcon size={13} />{t("settings.pipeline")}</button>
        <button onClick={() => setTab("knowledge")} className={settingsTabClass(tab === "knowledge")}><FileIcon size={13} />{t("settings.kbTab")}</button>
      </div>

      {tab === "general" && (<>
        <SettingsSection isDark={isDark} title={t("settings.appearance")} IconComp={SlidersIcon} desc={t("settings.appearanceDescription")}>
          <Field label={t("settings.theme")}>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
              {["light", "dark", "noon", "system"].map((option) => (
                <button
                  key={option}
                  onClick={() => saveThemePreference(option)}
                  className={settingsOptionClass(theme === option)}
                >
                  {t(`settings.${option}Mode`)}
                </button>
              ))}
            </div>
          </Field>
          <Field label={t("settings.applicationLanguage")}>
            <Select
              className={settingsControlClass}
              value={language}
              onChange={(event) => saveLanguagePreference(event.target.value)}
            >
              <option value="en">English (Default)</option>
              <option value="es">Español</option>
              <option value="pt">Português</option>
            </Select>
          </Field>
          <p className="text-xs text-gray-400">{t("settings.generatedDocumentsLanguage")}</p>
          <div className="grid grid-cols-2 gap-1.5 mt-3">
            <Field label={t("settings.timezone")}>
              <Select
                className={settingsControlClass}
                value={timezone}
                onChange={(event) => savePreference(PREF_KEYS.timezone, event.target.value, setTimezone)}
              >
                {!TIMEZONE_OPTIONS.some((option) => option.value === timezone) && (
                  <option value={timezone}>{timezone}</option>
                )}
                {TIMEZONE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
            </Field>
            <Field label={t("settings.dateFormat")}>
              <Select
                className={settingsControlClass}
                value={dateFormat}
                onChange={(event) => savePreference(PREF_KEYS.dateFormat, event.target.value, setDateFormat)}
              >
                {DATE_FORMAT_OPTIONS.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </Select>
            </Field>
          </div>
        </SettingsSection>
        <SettingsSection isDark={isDark} title={t("settings.aiModel")} IconComp={BotIcon}>
          <Field label={t("settings.defaultModel")}>
            <Select
              className={settingsControlClass}
              value={model}
              onChange={(event) => savePreference(PREF_KEYS.model, event.target.value, setModel)}
            >
              <option value="deepseek">DeepSeek (default)</option>
              <option value="deepseek-reasoner">DeepSeek Reasoner</option>
            </Select>
          </Field>
          <p style={{ fontSize: 12.5, color: "#94a3b8", marginTop: 6 }}>
            {t("settings.aiModelNote")}
          </p>
        </SettingsSection>
        <SettingsSection isDark={isDark} title={t("settings.integrations")} IconComp={PlugIcon}>
          <Field label={t("settings.crmProvider")}>
            <Select
              className={settingsControlClass}
              value={crmStatus?.activeProvider || "none"}
              onChange={(event) => setActiveCrmProvider(event.target.value)}
              disabled={crmActiveSaving}
            >
              <option value="none">{t("settings.noCRM")}</option>
              {crmStatus?.connections?.hubspot?.connected && <option value="hubspot">HubSpot</option>}
              {crmStatus?.connections?.salesforce?.connected && <option value="salesforce">Salesforce</option>}
            </Select>
          </Field>
          <p className="text-xs text-gray-400 mt-1">{t("settings.integrationDescription")}</p>
        </SettingsSection>
        <SettingsSection isDark={isDark} title={t("settings.socialConnections")} IconComp={Share2Icon} desc={t("settings.socialDescription")}>
          <div className="grid grid-cols-2 gap-1">
            {socialChannels.map(n => (
              <div key={n.l} className={`flex items-center justify-between group transition-colors ${settingsPanelClass}`}>
                <div className="flex items-center gap-1.5">
                  <div className={`w-7 h-7 rounded-lg ${n.c} flex items-center justify-center`}>
                    <span className="text-white text-xs font-bold">{n.l[0]}</span>
                  </div>
                  <div>
                    <span className={`text-xs font-medium ${isDark ? "text-slate-200" : "text-gray-800"}`}>{n.l}</span>
                    {n.ok && <p className="text-xs text-gray-400">@{n.user}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Badge label={n.ok ? t("settings.connected") : t("settings.notConnected")} color={settingsStatusBadgeColor(n.ok ? "Connected" : "Not connected")} />
                  <button onClick={() => openSocialModal(n)} className={`p-1.5 rounded-lg border border-transparent transition-colors ${isDark ? "hover:bg-slate-700 hover:border-white/10" : "hover:bg-white hover:border-gray-200"}`}>
                    <GearIcon size={12} className="text-gray-400" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </SettingsSection>
        <div className="flex justify-end">
          <Btn icon={<SaveIcon size={13} />} onClick={handleSaveSettings} disabled={settingsSaving}>
            {settingsSaving ? "Saving..." : t("settings.saveSettings")}
          </Btn>
        </div>

        {/* ── Social Channel Credentials Modal ── */}
        {socialModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setSocialModal(null)} />
            <div className={`relative rounded-2xl shadow-2xl w-full max-w-md mx-4 ${isDark ? "bg-slate-800 border border-white/10" : "bg-white"}`}>
              {/* Header */}
              <div className={`flex items-center justify-between p-3 border-b ${isDark ? "border-white/10" : "border-gray-100"}`}>
                <div className="flex items-center gap-1.5">
                  <div className={`w-9 h-9 rounded-xl ${socialModal.c} flex items-center justify-center`}>
                    <span className="text-white text-sm font-bold">{socialModal.l[0]}</span>
                  </div>
                  <div>
                    <h2 className={`text-sm font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>{socialModal.l}</h2>
                    <p className="text-xs text-gray-400">{socialModal.ok ? "Edit connection settings" : "Connect your account"}</p>
                  </div>
                </div>
                <button onClick={() => setSocialModal(null)} className={`p-1.5 rounded-lg transition-colors ${isDark ? "hover:bg-slate-700" : "hover:bg-gray-100"}`}><XIcon size={16} className="text-gray-400" /></button>
              </div>

              {/* Body */}
              <div className="p-3 space-y-2">
                {socialModal.ok && (
                  <div className={`flex items-center gap-1 p-2.5 rounded-xl border ${isDark ? "bg-green-500/10 border-green-400/20" : "bg-green-50 border-green-100"}`}>
                    <CheckIcon size={14} className="text-green-600" />
                    <span className="text-xs text-green-700 font-medium">{t("settings.socialConnectedAs").replace("{name}", socialModal.user || socialModal.l)}</span>
                  </div>
                )}

                {socialModal.l === "Facebook" && (
                  <>
                    <div className={`p-2 rounded-xl border ${isDark ? "bg-slate-900 border-white/10" : "bg-blue-50 border-blue-100"}`}>
                      <div className="flex items-start gap-1">
                        <ShieldIcon size={14} className="text-blue-500 mt-0.5 shrink-0" />
                        <div className="text-xs text-blue-700">
                          <p className="font-medium mb-0.5">{t("settings.socialOauthRecommended")}</p>
                          <p>{t("settings.socialFacebookOauthHint")}</p>
                        </div>
                      </div>
                    </div>
                    {!socialModal.ok && (
                      <Btn variant="primary" className="w-full justify-center" icon={<KeyIcon size={13} />} onClick={connectFacebook} disabled={socialBusy}>
                        {t("settings.socialConnectWithFacebook")}
                      </Btn>
                    )}
                  </>
                )}

                {["facebook", "linkedin", "twitter"].includes(socialModal.platform) && (
                  <div className="space-y-1.5">
                    <div className={`p-2 rounded-xl border text-xs ${isDark ? "bg-slate-900 border-white/10 text-slate-300" : "bg-gray-50 border-gray-100 text-gray-600"}`}>
                      Add an email/handle to enable publishing from generated social posts. If you have a provider token, you can store it here; tokens are never shown back in the UI.
                    </div>
                    <Field label="Account email">
                      <Input
                        className={settingsControlClass}
                        value={socialConnectionForm.email}
                        onChange={(event) => setSocialConnectionForm((current) => ({ ...current, email: event.target.value }))}
                        placeholder="name@company.com"
                      />
                    </Field>
                    <Field label="Handle or page name">
                      <Input
                        className={settingsControlClass}
                        value={socialConnectionForm.handle}
                        onChange={(event) => setSocialConnectionForm((current) => ({ ...current, handle: event.target.value }))}
                        placeholder={socialModal.platform === "twitter" ? "@company" : "Company page"}
                      />
                    </Field>
                    <Field label="Access token (optional)">
                      <Input
                        className={settingsControlClass}
                        type="password"
                        value={socialConnectionForm.accessToken}
                        onChange={(event) => setSocialConnectionForm((current) => ({ ...current, accessToken: event.target.value }))}
                        placeholder="Paste token only if you want this account-specific connection"
                      />
                    </Field>
                  </div>
                )}

                {socialModal.l === "Instagram" && (
                  <div className={`p-2 rounded-xl border text-xs ${isDark ? "bg-slate-900 border-white/10 text-slate-300" : "bg-gray-50 border-gray-100 text-gray-600"}`}>
                    {t("settings.socialInstagramHint")}
                  </div>
                )}

                {socialModal.comingSoon && (
                  <div className={`p-2 rounded-xl border text-xs ${isDark ? "bg-slate-900 border-white/10 text-slate-300" : "bg-gray-50 border-gray-100 text-gray-600"}`}>
                    {t("settings.socialComingSoon")}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className={`flex items-center justify-between p-3 border-t rounded-b-2xl ${isDark ? "border-white/10 bg-slate-900" : "border-gray-100 bg-gray-50"}`}>
                <div>
                  {socialModal.l === "Facebook" && socialModal.ok && (
                    <Btn variant="ghost" className="text-red-500 hover:text-red-700 hover:bg-red-50" icon={<TrashIcon size={12} />} onClick={() => disconnectSocialPlatform("facebook")} disabled={socialBusy}>
                      {t("settings.disconnect")}
                    </Btn>
                  )}
                  {["linkedin", "twitter"].includes(socialModal.platform) && socialModal.ok && (
                    <Btn variant="ghost" className="text-red-500 hover:text-red-700 hover:bg-red-50" icon={<TrashIcon size={12} />} onClick={() => disconnectSocialPlatform(socialModal.platform)} disabled={socialBusy}>
                      {t("settings.disconnect")}
                    </Btn>
                  )}
                </div>
                <div className="flex gap-1">
                  <Btn variant="secondary" onClick={() => setSocialModal(null)}>{t("common.cancel")}</Btn>
                  {["facebook", "linkedin", "twitter"].includes(socialModal.platform) && (
                    <Btn icon={<SaveIcon size={12} />} onClick={saveManualSocialConnection} disabled={socialBusy}>
                      {socialModal.ok ? "Save connection" : "Connect"}
                    </Btn>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </>)}

      {tab === "templates" && (<>
        <SettingsSection isDark={isDark} title="Proposal Templates" IconComp={FileIcon} desc="Reusable commercial document structures with placeholders">
          <div className="grid grid-cols-3 gap-1.5 mb-4">
            {settingsTemplates.length === 0 && (
              <p className="col-span-3 text-xs text-gray-400">{t("settings.noTemplatesYet")}</p>
            )}
            {settingsTemplates.map((template, index) => (
              <div key={template.id} className={settingsPanelClass}>
                <div className="flex items-center justify-between">
                  <p className={`text-xs font-semibold ${isDark ? "text-slate-200" : "text-gray-800"}`}>{template.name}</p>
                  <Badge label={index === 0 ? "Default" : "Draft"} color={settingsStatusBadgeColor(index === 0 ? "Default" : "Draft")} />
                </div>
                <p className="mt-2 text-xs text-gray-400">{template.description || "Uses customer, pricing table, ROI, timeline, and next steps sections."}</p>
                <div className="flex gap-1 mt-3">
                  <Btn small variant="secondary" icon={<PenIcon size={11} />} onClick={() => {
                    setTemplateNameDraft(template.name || template.title || "");
                    setTemplateEditorContent(template.content || "");
                    setEditingTemplateId(template.id);
                  }}>Edit</Btn>
                  <Btn small variant="secondary" icon={<DownloadIcon size={11} />} onClick={() => {
                    const blob = new Blob([template.content || ""], { type: "text/plain" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `${template.name || template.title || "template"}.txt`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}>Export</Btn>
                </div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <Field label="Upload template">
              <Input
                className={settingsControlClass}
                type="file"
                accept=".txt,.md,.html,.htm,.docx,.pdf"
                onChange={uploadTemplateFile}
                disabled={templateUploading}
              />
            </Field>
            <Field label="Create proposal template"><Input className={settingsControlClass} placeholder="Template name" value={templateNameDraft} onChange={(event) => setTemplateNameDraft(event.target.value)} /></Field>
          </div>
          <Field label="Template editor placeholders">
            <div className="flex flex-wrap gap-1 mb-1">
              {["{{customer_name}}", "{{total_amount}}", "{{line_item_table}}", "{{date}}"].map((token) => <span key={token} className={`rounded border px-2 py-1 text-xs font-medium ${isDark ? "bg-slate-900 text-slate-200 border-white/10" : "bg-indigo-50 text-indigo-700 border-transparent"}`}>{token}</span>)}
            </div>
            <textarea className={`${settingsControlClass} min-h-36`} value={templateEditorContent} onChange={(event) => setTemplateEditorContent(event.target.value)} />
          </Field>
          <div className="flex items-center justify-between gap-2">
            {editingTemplateId ? (
              <Btn variant="secondary" icon={<XIcon size={13} />} onClick={resetTemplateEditor} disabled={templateSaving}>New Template</Btn>
            ) : <span />}
            <Btn icon={<SaveIcon size={13} />} onClick={saveSettingsTemplate} disabled={templateSaving}>
              {editingTemplateId ? "Update Template" : "Save Template"}
            </Btn>
          </div>
        </SettingsSection>
      </>)}

      {tab === "integrations" && (<>
        <SettingsSection isDark={isDark} title="CRM Integration" IconComp={PlugIcon} desc="Connect proposal upload and opportunity sync">
          <div className="grid grid-cols-2 gap-1">
            {crmProviders.map((p) => (
              <div key={p.provider} className={`flex items-center justify-between ${settingsPanelClass}`}>
                <div className="flex items-center gap-1.5">
                  <div className={`w-7 h-7 rounded-lg ${p.c} flex items-center justify-center`}>
                    <span className="text-white text-xs font-bold">{p.l[0]}</span>
                  </div>
                  <div>
                    <span className={`text-xs font-medium ${isDark ? "text-slate-200" : "text-gray-800"}`}>{p.l}</span>
                    {p.ok && p.detail && <p className="text-xs text-gray-400">{p.detail}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Badge label={p.ok ? t("settings.connected") : t("settings.notConnected")} color={settingsStatusBadgeColor(p.ok ? "Connected" : "Not connected")} />
                  <button onClick={() => openCrmModal(p)} className={`p-1.5 rounded-lg border border-transparent transition-colors ${isDark ? "hover:bg-slate-700 hover:border-white/10" : "hover:bg-white hover:border-gray-200"}`}>
                    <GearIcon size={12} className="text-gray-400" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </SettingsSection>
        <SettingsSection isDark={isDark} title="Social Connections" IconComp={Share2Icon} desc="Publishing destinations for generated social assets">
          <div className="grid grid-cols-3 gap-1">
            {socialChannels.map((channel) => (
              <div key={channel.l} className={`flex items-center justify-between ${settingsPanelClass}`}>
                <div>
                  <span className={`text-xs font-medium ${isDark ? "text-slate-200" : "text-gray-800"}`}>{channel.l}</span>
                  {channel.ok && channel.user && <p className="text-xs text-gray-400">{channel.user}</p>}
                </div>
                <div className="flex items-center gap-1">
                  <Badge label={channel.ok ? "Connected" : "Not connected"} color={settingsStatusBadgeColor(channel.ok ? "Connected" : "Not connected")} />
                  <button onClick={() => openSocialModal(channel)} className={`p-1.5 rounded-lg border border-transparent transition-colors ${isDark ? "hover:bg-slate-700 hover:border-white/10" : "hover:bg-white hover:border-gray-200"}`}>
                    <GearIcon size={12} className="text-gray-400" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </SettingsSection>
      </>)}

      {tab === "integrations" && socialModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setSocialModal(null)} />
          <div className={`relative rounded-2xl shadow-2xl w-full max-w-md mx-4 ${isDark ? "bg-slate-800 border border-white/10" : "bg-white"}`}>
            <div className={`flex items-center justify-between p-3 border-b ${isDark ? "border-white/10" : "border-gray-100"}`}>
              <div>
                <h2 className={`text-sm font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>{socialModal.l}</h2>
                <p className="text-xs text-gray-400">{socialModal.ok ? "Edit connection settings" : "Connect your account"}</p>
              </div>
              <button onClick={() => setSocialModal(null)} className={`p-1.5 rounded-lg transition-colors ${isDark ? "hover:bg-slate-700" : "hover:bg-gray-100"}`}><XIcon size={16} className="text-gray-400" /></button>
            </div>
            <div className="p-3 space-y-1.5">
              {socialModal.ok && (
                <div className={`flex items-center gap-1 p-2.5 rounded-xl border ${isDark ? "bg-green-500/10 border-green-400/20" : "bg-green-50 border-green-100"}`}>
                  <CheckIcon size={14} className="text-green-600" />
                  <span className="text-xs text-green-700 font-medium">{t("settings.socialConnectedAs").replace("{name}", socialModal.user || socialModal.l)}</span>
                </div>
              )}
              {socialModal.platform ? (
                <>
                  <Field label="Account email">
                    <Input className={settingsControlClass} value={socialConnectionForm.email} onChange={(event) => setSocialConnectionForm((current) => ({ ...current, email: event.target.value }))} placeholder="name@company.com" />
                  </Field>
                  <Field label="Handle or page name">
                    <Input className={settingsControlClass} value={socialConnectionForm.handle} onChange={(event) => setSocialConnectionForm((current) => ({ ...current, handle: event.target.value }))} placeholder={socialModal.platform === "twitter" ? "@company" : "Company page"} />
                  </Field>
                  <Field label="Access token (optional)">
                    <Input className={settingsControlClass} type="password" value={socialConnectionForm.accessToken} onChange={(event) => setSocialConnectionForm((current) => ({ ...current, accessToken: event.target.value }))} placeholder="Paste token only if needed" />
                  </Field>
                  {socialModal.platform === "facebook" && !socialModal.ok && (
                    <Btn variant="secondary" className="w-full justify-center" icon={<KeyIcon size={13} />} onClick={connectFacebook} disabled={socialBusy}>
                      {t("settings.socialConnectWithFacebook")}
                    </Btn>
                  )}
                </>
              ) : (
                <div className={`p-2 rounded-xl border text-xs ${isDark ? "bg-slate-900 border-white/10 text-slate-300" : "bg-gray-50 border-gray-100 text-gray-600"}`}>
                  {socialModal.linkedToFacebook ? t("settings.socialInstagramHint") : t("settings.socialComingSoon")}
                </div>
              )}
            </div>
            <div className={`flex items-center justify-between p-3 border-t rounded-b-2xl ${isDark ? "border-white/10 bg-slate-900" : "border-gray-100 bg-gray-50"}`}>
              <div>
                {socialModal.platform && socialModal.ok && (
                  <Btn variant="ghost" className="text-red-500 hover:text-red-700 hover:bg-red-50" icon={<TrashIcon size={12} />} onClick={() => disconnectSocialPlatform(socialModal.platform)} disabled={socialBusy}>
                    {t("settings.disconnect")}
                  </Btn>
                )}
              </div>
              <div className="flex gap-1">
                <Btn variant="secondary" onClick={() => setSocialModal(null)}>{t("common.cancel")}</Btn>
                {socialModal.platform && (
                  <Btn icon={<SaveIcon size={12} />} onClick={saveManualSocialConnection} disabled={socialBusy}>
                    {socialModal.ok ? "Save connection" : "Connect"}
                  </Btn>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "integrations" && crmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setCrmModal(null)} />
          <div className={`relative rounded-2xl shadow-2xl w-full max-w-md mx-4 ${isDark ? "bg-slate-800 border border-white/10" : "bg-white"}`}>
            <div className={`flex items-center justify-between p-3 border-b ${isDark ? "border-white/10" : "border-gray-100"}`}>
              <div className="flex items-center gap-1.5">
                <div className={`w-9 h-9 rounded-xl ${crmModal.c} flex items-center justify-center`}>
                  <span className="text-white text-sm font-bold">{crmModal.l[0]}</span>
                </div>
                <div>
                  <h2 className={`text-sm font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>{crmModal.l}</h2>
                  <p className="text-xs text-gray-400">{crmModal.ok ? "Edit connection settings" : "Connect your account"}</p>
                </div>
              </div>
              <button onClick={() => setCrmModal(null)} className={`p-1.5 rounded-lg transition-colors ${isDark ? "hover:bg-slate-700" : "hover:bg-gray-100"}`}><XIcon size={16} className="text-gray-400" /></button>
            </div>
            <div className="p-3 space-y-1.5">
              {crmModal.provider === "salesforce" ? (<>
                <Field label="Consumer Key"><Input className={settingsControlClass} type="password" value={crmForm.consumerKey} onChange={(event) => setCrmForm((current) => ({ ...current, consumerKey: event.target.value }))} placeholder="Connected App Consumer Key" /></Field>
                <Field label="Consumer Secret"><Input className={settingsControlClass} type="password" value={crmForm.consumerSecret} onChange={(event) => setCrmForm((current) => ({ ...current, consumerSecret: event.target.value }))} placeholder="Connected App Consumer Secret" /></Field>
                <Field label="Login URL">
                  <Input className={settingsControlClass} value={crmForm.loginUrl} onChange={(event) => setCrmForm((current) => ({ ...current, loginUrl: event.target.value }))} placeholder="https://login.salesforce.com" />
                  <p className="text-xs text-gray-400 mt-1">Use https://test.salesforce.com for a sandbox, or your org's My Domain URL.</p>
                </Field>
              </>) : (
                <Field label="CRM API key"><Input className={settingsControlClass} type="password" value={crmForm.apiKey} onChange={(event) => setCrmForm((current) => ({ ...current, apiKey: event.target.value }))} placeholder="Paste CRM API key" /></Field>
              )}
              {crmTestStatus === "connected" && (
                <span style={{ color: "#16a34a", fontSize: 13, fontWeight: 600 }}>✓ {crmTestMessage}</span>
              )}
              {crmTestStatus === "error" && (
                <span style={{ color: "#dc2626", fontSize: 13, fontWeight: 600 }}>✗ {crmTestMessage}</span>
              )}
            </div>
            <div className={`flex items-center justify-between p-3 border-t rounded-b-2xl ${isDark ? "border-white/10 bg-slate-900" : "border-gray-100 bg-gray-50"}`}>
              <div>
                {crmModal.ok && (
                  <Btn variant="ghost" className="text-red-500 hover:text-red-700 hover:bg-red-50" icon={<TrashIcon size={12} />} onClick={() => disconnectCrmProvider()} disabled={crmSaving}>
                    {t("settings.disconnect")}
                  </Btn>
                )}
              </div>
              <div className="flex gap-1">
                <Btn variant="secondary" icon={crmTestStatus === "testing" ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <PlayIcon size={12} />} onClick={testCrmConnection} disabled={!crmIntegrationReady || crmTestStatus === "testing"}>{crmTestStatus === "testing" ? "Testing..." : "Test Connection"}</Btn>
                <Btn variant="secondary" onClick={() => setCrmModal(null)}>{t("common.cancel")}</Btn>
                <Btn icon={<SaveIcon size={12} />} onClick={saveCrmConnection} disabled={!crmIntegrationReady || crmSaving}>{crmSaving ? "Saving..." : "Save"}</Btn>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "pipeline" && <PipelineSettingsTab isDark={isDark} />}
      {tab === "knowledge" && <KnowledgeBaseTab isDark={isDark} />}

      {tab === "content" && (<>
        <SettingsSection isDark={isDark} title="Auto-Tagging Rules" IconComp={TagIcon} desc="Define how content is tagged so agents can match it to opportunities">
          <p className="text-xs text-gray-500 mb-1.5">Content is automatically tagged by industry and service line. The email composer uses these tags to find the most relevant case studies, proposals, and templates for each opportunity.</p>
          <Field label="Industry tags"><TagInput tags={["finance","healthcare","retail","technology","logistics"]} placeholder="Add industry..." /></Field>
          <Field label="Service line tags"><TagInput tags={["data entry","customer support","accounting","back office","outsourcing","virtual assistant"]} placeholder="Add service..." /></Field>
        </SettingsSection>
        <SettingsSection isDark={isDark} title="Content Matching" IconComp={ZapIcon} desc="How the email composer selects content for personalization">
          <Field label="Matching strategy">
            <Select>
              <option>Best match (industry + service + recency)</option>
              <option>Industry match only</option>
              <option>Service match only</option>
              <option>Manual only (no auto-matching)</option>
            </Select>
          </Field>
          <Field label="Minimum relevance score" hint="Content below this score won't be included in emails">
            <Input defaultValue="0.6" />
          </Field>
          <div className="mt-2 p-2 rounded-xl bg-blue-50 border border-blue-100">
            <p className="text-xs text-blue-800 font-medium mb-1">How it works</p>
            <div className="space-y-1 text-xs text-blue-700">
              <p>1. Scout detects a job posting and extracts industry + service keywords</p>
              <p>2. The system searches your Content Library for items with matching tags</p>
              <p>3. Composer weaves the best-matching content into the personalized email</p>
              <p>4. You see which content was used in the Review Queue and Outreach History</p>
            </div>
          </div>
        </SettingsSection>
        <div className="flex justify-end"><Btn icon={<SaveIcon size={13} />}>Save Content Settings</Btn></div>
      </>)}
    </div>
  );
}
