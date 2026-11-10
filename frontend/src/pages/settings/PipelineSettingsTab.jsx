/**
 * PipelineSettingsTab — configuration UI for the 3-agent prospecting pipeline
 * (keywords/industries, job sources CRUD, SMTP and the Hunter key). Mounted by
 * Dashboard.jsx's Settings page as the "pipeline" tab. The former "automation
 * thresholds" section was removed: none of its fields had any effect.
 */
import { useEffect, useId, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  Radar, Search, Globe, Mail, Code, Rss, Plug, Briefcase,
  Pencil, Trash2, Plus, Save, Loader2, KeyRound, Undo2,
} from "lucide-react";

import { pipelineApi } from "@/api/axios";
import { logApiError } from "@/api/apiLogging";
import { useI18n } from "@/hooks/useI18n";

const SOURCE_TYPE_FIELD_KEYS = {
  api: [
    { key: "base_url", labelKey: "sourceFieldBaseUrl", placeholder: "https://api.ejemplo.com/jobs" },
    { key: "api_key", labelKey: "sourceFieldApiKey", type: "password" },
  ],
  rss: [
    { key: "feed_url", labelKey: "sourceFieldFeedUrl", placeholder: "https://indeed.com/rss?q=outsourcing" },
    // Must match RSS_TITLE_FORMATS in backend/app/schemas/pipeline.py. The
    // first option is the backend default when the field is absent.
    {
      key: "title_format",
      labelKey: "sourceFieldTitleFormat",
      hintKey: "sourceFieldTitleFormatHint",
      options: [
        { value: "none", labelKey: "titleFormatNone" },
        { value: "company_colon_title", labelKey: "titleFormatCompanyColonTitle" },
        { value: "title_dash_company", labelKey: "titleFormatTitleDashCompany" },
      ],
    },
  ],
  scraper: [
    { key: "url", labelKey: "sourceFieldUrl", placeholder: "https://remote.co/remote-jobs" },
    { key: "selectors", labelKey: "sourceFieldCssSelectors", placeholder: ".job-title, .company-name" },
  ],
  webhook: [],
  // JSearch (RapidAPI): the URL and query settings live in the backend
  // (country, language, num_pages, date_posted keep their defaults there),
  // so the only thing to configure here is the key.
  jsearch: [
    { key: "api_key", labelKey: "sourceFieldApiKey", type: "password", hintKey: "sourceFieldJsearchApiKeyHint" },
  ],
};

const SOURCE_TYPE_ICON = { api: Code, rss: Rss, scraper: Globe, webhook: Plug, jsearch: Briefcase };

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getApiErrorMessage(error, fallback) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const firstMessage = detail
      .map((item) => item?.msg || item?.message || (typeof item === "string" ? item : ""))
      .find(Boolean);
    if (firstMessage) return firstMessage;
  }
  return error?.message || fallback;
}

const Card = ({ children, className = "" }) => (
  <div className={`bg-white rounded-2xl border border-gray-100 shadow-sm ${className}`}>{children}</div>
);

const Btn = ({ variant = "primary", children, icon, className = "", small, ...props }) => {
  const variants = {
    primary: "bg-indigo-600 text-white hover:bg-indigo-700",
    secondary: "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50",
  };
  return (
    <button
      className={`inline-flex items-center gap-1.5 font-medium rounded-lg transition-colors text-xs ${small ? "px-2.5 py-1.5" : "px-3.5 py-2"} ${variants[variant] || variants.primary} ${className}`}
      {...props}
    >
      {icon}{children}
    </button>
  );
};

const Input = ({ className = "", ...props }) => (
  <input className={`w-full border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 ${className}`} {...props} />
);

const Select = ({ children, ...props }) => (
  <select className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500" {...props}>
    {children}
  </select>
);

// hintBelow puts the hint after the control, so the label and the control
// line up with the neighbouring column; hintId lets the control point at it
// with aria-describedby.
const Field = ({ label, hint, hintBelow = false, hintId, children }) => (
  <div className="mb-[18px]">
    <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
    {hint && !hintBelow && <p id={hintId} className="text-xs text-gray-400 mb-1">{hint}</p>}
    {children}
    {hint && hintBelow && <p id={hintId} className="text-xs text-gray-400 mt-1">{hint}</p>}
  </div>
);

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

function TagInput({ value = [], onChange, placeholder }) {
  const [draft, setDraft] = useState("");

  const addTag = (raw) => {
    const tag = raw.trim();
    if (!tag || value.includes(tag)) return;
    onChange([...value, tag]);
    setDraft("");
  };

  const removeTag = (tag) => onChange(value.filter((item) => item !== tag));

  const handleKeyDown = (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTag(draft);
    } else if (event.key === "Backspace" && !draft && value.length) {
      removeTag(value[value.length - 1]);
    }
  };

  return (
    <div className="flex flex-wrap gap-1.5 p-2 border border-gray-300 rounded-lg bg-white min-h-[36px] focus-within:ring-2 focus-within:ring-indigo-500">
      {value.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-medium">
          {tag}
          <button type="button" onClick={() => removeTag(tag)} className="hover:text-indigo-900" aria-label={`Remove ${tag}`}>×</button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => addTag(draft)}
        placeholder={value.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[100px] outline-none text-xs bg-transparent placeholder-gray-400"
      />
    </div>
  );
}

const DEFAULT_SMTP = { smtp_host: "", smtp_port: 587, smtp_user: "", sender_email: "", sender_name: "" };

export default function PipelineSettingsTab({ isDark = false }) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState(true);
  const [keywords, setKeywords] = useState([]);
  const [industries, setIndustries] = useState([]);
  const [excludedCompanies, setExcludedCompanies] = useState([]);
  // Tag lists are saved on their own, one request at a time (tagSaveQueue).
  // confirmedTags = last value the server confirmed; latestTags = what the
  // screen shows. Each queued save sends the latest value, so quick edits are
  // coalesced and the last one wins; a failure restores the confirmed list.
  const confirmedTags = useRef({ keywords: [], industries: [], excluded_companies: [] });
  const latestTags = useRef({ keywords: [], industries: [], excluded_companies: [] });
  const tagSaveQueue = useRef(Promise.resolve());
  const tagSavesPending = useRef(0);
  const tagSaveFailed = useRef(false);
  const [tagSaveStatus, setTagSaveStatus] = useState("idle"); // idle | saving | saved
  const [sources, setSources] = useState([]);
  const [smtp, setSmtp] = useState(DEFAULT_SMTP);
  const [smtpPasswordConfigured, setSmtpPasswordConfigured] = useState(false);
  const [smtpPasswordInput, setSmtpPasswordInput] = useState("");
  const smtpPasswordHintId = useId();
  // Hunter API key (RF15): write-only like smtp_password. The field always
  // starts empty — the API never returns the key, only whether one is set.
  // "Borrar clave" only marks it; "" is sent when the user presses Save.
  const [hunterKeyConfigured, setHunterKeyConfigured] = useState(false);
  const [hunterKeyInput, setHunterKeyInput] = useState("");
  const [hunterKeyClearPending, setHunterKeyClearPending] = useState(false);
  const [sourceFormOpen, setSourceFormOpen] = useState(false);
  const [sourceForm, setSourceForm] = useState({ id: null, name: "", source_type: "rss", config: {} });
  const [sourceTesting, setSourceTesting] = useState(null);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const { data } = await pipelineApi.getConfig();
      const loadedTags = {
        keywords: data?.keywords || [],
        industries: data?.industries || [],
        excluded_companies: data?.excluded_companies || [],
      };
      confirmedTags.current = { ...loadedTags };
      latestTags.current = { ...loadedTags };
      setKeywords(loadedTags.keywords);
      setIndustries(loadedTags.industries);
      setExcludedCompanies(loadedTags.excluded_companies);
      setSources(data?.sources || []);
      setSmtp({
        smtp_host: data?.smtp_host || "",
        smtp_port: data?.smtp_port || 587,
        smtp_user: data?.smtp_user || "",
        sender_email: data?.sender_email || "",
        sender_name: data?.sender_name || "",
      });
      setSmtpPasswordConfigured(Boolean(data?.smtp_password_configured));
      setSmtpPasswordInput("");
      setHunterKeyConfigured(Boolean(data?.hunter_api_key_configured));
      setHunterKeyInput("");
      setHunterKeyClearPending(false);
      setActive(data?.is_active ?? true);
    } catch (error) {
      logApiError("PipelineSettings", error);
      toast.error(t("settings.pipelineTab.toastLoadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const saveConfig = async () => {
    // Trim incidental leading/trailing whitespace on free-text fields.
    // smtp_password is intentionally left untouched below — a password's
    // own spaces can be meaningful.
    const trimmedUser = smtp.smtp_user.trim();
    const trimmedSenderEmail = smtp.sender_email.trim();
    const trimmedSenderName = smtp.sender_name.trim();

    if (trimmedSenderEmail && !EMAIL_REGEX.test(trimmedSenderEmail)) {
      toast.error(t("settings.pipelineTab.toastInvalidEmail"));
      return;
    }

    setSaving(true);
    try {
      // keywords / industries / excluded_companies are not sent: they are
      // saved on their own as soon as a tag is added or removed (commitTags).
      const payload = {
        smtp_host: smtp.smtp_host,
        smtp_port: smtp.smtp_port,
        smtp_user: trimmedUser,
        sender_email: trimmedSenderEmail,
        sender_name: trimmedSenderName,
        is_active: active,
      };
      // A whitespace-only password is treated as "not provided" (keeps the
      // saved password) — only a non-blank value is sent.
      if (smtpPasswordInput.trim()) {
        payload.smtp_password = smtpPasswordInput;
      }
      // The Hunter key is sent only when the user typed one (trimmed) or asked
      // to clear it (""); otherwise it is left out and the stored one stays.
      if (hunterKeyInput.trim()) {
        payload.hunter_api_key = hunterKeyInput.trim();
      } else if (hunterKeyClearPending) {
        payload.hunter_api_key = "";
      }
      const { data } = await pipelineApi.updateConfig(payload);
      setSmtp({
        smtp_host: data?.smtp_host || "",
        smtp_port: data?.smtp_port || 587,
        smtp_user: data?.smtp_user || "",
        sender_email: data?.sender_email || "",
        sender_name: data?.sender_name || "",
      });
      setSmtpPasswordConfigured(Boolean(data?.smtp_password_configured));
      setSmtpPasswordInput("");
      setHunterKeyConfigured(Boolean(data?.hunter_api_key_configured));
      setHunterKeyInput("");
      setHunterKeyClearPending(false);
      toast.success(t("settings.pipelineTab.toastSaved"));
    } catch (error) {
      // Not logged: the request carried smtp_password / hunter_api_key.
      toast.error(error?.response?.status === 503
        ? t("settings.pipelineTab.toastEncryptionUnavailable")
        : getApiErrorMessage(error, t("settings.pipelineTab.toastSaveError")));
    } finally {
      setSaving(false);
    }
  };

  const openNewSourceForm = () => {
    setSourceForm({ id: null, name: "", source_type: "rss", config: {} });
    setSourceFormOpen(true);
  };

  const openEditSourceForm = (source) => {
    setSourceForm({
      id: source.id,
      name: source.name,
      source_type: source.source_type,
      config: source.config || {},
      // The API never returns a stored secret; the empty field keeps it (RF13-D-004).
      configuredSecretFields: source.configured_secret_fields || [],
    });
    setSourceFormOpen(true);
  };

  const saveSourceForm = async () => {
    if (!sourceForm.name.trim()) {
      toast.error(t("settings.pipelineTab.toastSourceNameRequired"));
      return;
    }
    let config = sourceForm.config;
    if (sourceForm.source_type === "jsearch") {
      // Only the key is sent; an empty field keeps the stored one (RF13-D-004).
      const apiKey = (sourceForm.config?.api_key || "").trim();
      if (!apiKey && !sourceForm.configuredSecretFields?.includes("api_key")) {
        toast.error(t("settings.pipelineTab.toastApiKeyRequired"));
        return;
      }
      config = apiKey ? { api_key: apiKey } : {};
    }
    try {
      const payload = { name: sourceForm.name.trim(), source_type: sourceForm.source_type, config };
      const { data } = sourceForm.id
        ? await pipelineApi.updateSource(sourceForm.id, payload)
        : await pipelineApi.createSource(payload);
      setSources(data?.sources || []);
      setSourceFormOpen(false);
      toast.success(t("settings.pipelineTab.toastSourceSaved"));
    } catch (error) {
      logApiError("PipelineSettings", error);
      toast.error(getApiErrorMessage(error, t("settings.pipelineTab.toastSourceSaveError")));
    }
  };

  const deleteSource = async (sourceId) => {
    try {
      await pipelineApi.deleteSource(sourceId);
      setSources((current) => current.filter((source) => source.id !== sourceId));
      toast.success(t("settings.pipelineTab.toastSourceRemoved"));
    } catch (error) {
      logApiError("PipelineSettings", error);
      toast.error(getApiErrorMessage(error, t("settings.pipelineTab.toastSourceRemoveError")));
    }
  };

  const testSource = async (sourceId) => {
    setSourceTesting(sourceId);
    try {
      // The probe reads the keywords stored in Firestore: wait for the tag
      // saves in flight so it uses exactly what the screen shows.
      await tagSaveQueue.current;
      // The source is actually read (RF13-D-001); the server sends data, the text is built here.
      const { data } = await pipelineApi.testSource(sourceId);
      const warnings = (data?.warnings || []).join(" · ");
      if (data?.ok) {
        const message = t("settings.pipelineTab.toastSourceResponds").replace("{n}", data.postings_read ?? 0);
        toast.success(warnings ? `${message} (${warnings})` : message);
      } else {
        toast.error(t("settings.pipelineTab.toastSourceNotResponding").replace("{reason}", data?.reason || "—"));
      }
    } catch (error) {
      const missingFields = error?.response?.data?.detail?.missing_fields;
      const message = Array.isArray(missingFields) && missingFields.length
        ? t("settings.pipelineTab.toastMissingFields").replace("{fields}", missingFields.join(", "))
        : getApiErrorMessage(error, t("settings.pipelineTab.toastSourceTestFailed"));
      toast.error(message);
    } finally {
      setSourceTesting(null);
    }
  };

  const TAG_SETTERS = { keywords: setKeywords, industries: setIndustries, excluded_companies: setExcludedCompanies };

  const sameTags = (a = [], b = []) => a.length === b.length && a.every((tag, index) => tag === b[index]);

  // Save one tag list right away (PUT /pipeline/config with only that field).
  const commitTags = (field, nextTags) => {
    const setTags = TAG_SETTERS[field];
    latestTags.current = { ...latestTags.current, [field]: nextTags };
    setTags(nextTags);
    tagSavesPending.current += 1;
    setTagSaveStatus("saving");

    const run = async () => {
      const sending = latestTags.current[field];
      // An earlier save already sent this value (quick edits coalesce).
      if (sameTags(sending, confirmedTags.current[field])) return;
      try {
        const { data } = await pipelineApi.updateConfig({ [field]: sending });
        const saved = Array.isArray(data?.[field]) ? data[field] : sending;
        confirmedTags.current = { ...confirmedTags.current, [field]: saved };
        // Only adopt the server copy when nothing newer was typed meanwhile.
        if (sameTags(latestTags.current[field], sending)) {
          latestTags.current = { ...latestTags.current, [field]: saved };
          setTags(saved);
        }
      } catch (error) {
        logApiError("PipelineSettings", error);
        tagSaveFailed.current = true;
        const restored = confirmedTags.current[field];
        latestTags.current = { ...latestTags.current, [field]: restored };
        setTags(restored);
        toast.error(t("settings.pipelineTab.tagsSaveError"));
      }
    };

    tagSaveQueue.current = tagSaveQueue.current.then(run).finally(() => {
      tagSavesPending.current -= 1;
      if (tagSavesPending.current === 0) {
        setTagSaveStatus(tagSaveFailed.current ? "idle" : "saved");
        tagSaveFailed.current = false;
      }
    });
  };

  const tagSaveStatusText = {
    saving: t("settings.pipelineTab.tagsSaving"),
    saved: t("settings.pipelineTab.tagsSaved"),
  }[tagSaveStatus] || "";

  const smtpPasswordHint = t(smtpPasswordConfigured
    ? "settings.pipelineTab.passwordConfiguredHint"
    : "settings.pipelineTab.passwordNotConfiguredHint");

  return (
    <>
      <div className={`flex items-center justify-between p-3.5 rounded-2xl border ${active ? "border-green-200 bg-green-50" : "border-gray-200 bg-gray-50"}`}>
        <div className="flex items-center gap-1.5">
          <Radar size={18} className={active ? "text-green-600" : "text-gray-400"} />
          <div>
            <p className="text-xs font-semibold text-gray-900">{t("settings.pipelineTab.statusTitle")}</p>
            <p className="text-xs text-gray-500">{active ? t("settings.pipelineTab.statusActive") : t("settings.pipelineTab.statusInactive")}</p>
          </div>
        </div>
        <button onClick={() => setActive(!active)} className="relative w-11 h-6 rounded-full transition-colors" style={{ backgroundColor: active ? "#16a34a" : "#d1d5db" }}>
          <span className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform" style={{ transform: active ? "translateX(20px)" : "translateX(0)" }} />
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 size={20} className="animate-spin text-indigo-600" /></div>
      ) : (
        <>
          <SettingsSection
            isDark={isDark}
            title={t("settings.pipelineTab.keywordsTitle")}
            IconComp={Search}
            desc={t("settings.pipelineTab.keywordsDesc")}
            badge={<span role="status" aria-live="polite" className="text-xs text-gray-500">{tagSaveStatusText}</span>}
          >
            <Field label={t("settings.pipelineTab.serviceKeywordsLabel")} hint={t("settings.pipelineTab.pressEnterHint")}>
              <TagInput value={keywords} onChange={(next) => commitTags("keywords", next)} placeholder={t("settings.pipelineTab.addKeywordPlaceholder")} />
            </Field>
            <Field label={t("settings.pipelineTab.targetIndustriesLabel")} hint={t("settings.pipelineTab.targetIndustriesHint")}>
              <TagInput value={industries} onChange={(next) => commitTags("industries", next)} placeholder={t("settings.pipelineTab.addIndustryPlaceholder")} />
            </Field>
            <Field label={t("settings.pipelineTab.excludedCompaniesLabel")} hint={t("settings.pipelineTab.excludedCompaniesHint")}>
              <TagInput value={excludedCompanies} onChange={(next) => commitTags("excluded_companies", next)} placeholder={t("settings.pipelineTab.addCompanyPlaceholder")} />
            </Field>
          </SettingsSection>

          <SettingsSection isDark={isDark} title={t("settings.pipelineTab.sourcesTitle")} IconComp={Globe} desc={t("settings.pipelineTab.sourcesDesc")} badge={<Btn small icon={<Plus size={12} />} onClick={openNewSourceForm}>{t("settings.pipelineTab.addSourceButton")}</Btn>}>
            {sources.length === 0 && !sourceFormOpen && (
              <p className="text-xs text-gray-400 py-2">{t("settings.pipelineTab.noSourcesYet")}</p>
            )}
            <div className="space-y-1">
              {sources.map((source) => {
                const SourceIcon = SOURCE_TYPE_ICON[source.source_type] || Globe;
                const summaryUrl = source.config?.feed_url || source.config?.base_url || source.config?.url || "";
                return (
                  <div key={source.id} className="flex items-center justify-between p-2 rounded-xl border border-gray-100 bg-gray-50 group hover:border-indigo-200">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center text-violet-600 bg-violet-50 shrink-0"><SourceIcon size={14} /></div>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-gray-800 truncate">{source.name}</p>
                        <p className="text-xs text-gray-400 truncate">
                          {source.source_type.toUpperCase()}{summaryUrl ? ` · ${summaryUrl}` : ""}{source.enabled === false ? ` · ${t("settings.pipelineTab.disabledSuffix")}` : ""}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
                      <button className="p-1.5 rounded hover:bg-gray-100" onClick={() => testSource(source.id)} disabled={sourceTesting === source.id} title={t("settings.pipelineTab.testConnectionTitle")}>
                        {sourceTesting === source.id ? <Loader2 size={11} className="animate-spin text-gray-400" /> : <Plug size={11} className="text-gray-400" />}
                      </button>
                      <button className="p-1.5 rounded hover:bg-gray-100" onClick={() => openEditSourceForm(source)} title={t("settings.pipelineTab.editTitle")}><Pencil size={11} className="text-gray-400" /></button>
                      <button className="p-1.5 rounded hover:bg-red-50" onClick={() => deleteSource(source.id)} title={t("settings.pipelineTab.deleteTitle")}><Trash2 size={11} className="text-gray-400" /></button>
                    </div>
                  </div>
                );
              })}
            </div>

            {sourceFormOpen && (
              <div className="mt-2 p-2.5 rounded-xl border border-indigo-200 bg-indigo-50/40 space-y-1.5">
                <div className="grid grid-cols-2 gap-1.5">
                  <Field label={t("settings.pipelineTab.sourceNameLabel")}><Input value={sourceForm.name} onChange={(event) => setSourceForm((form) => ({ ...form, name: event.target.value }))} placeholder="Indeed RSS Feed" /></Field>
                  <Field label={t("settings.pipelineTab.sourceTypeLabel")}>
                    <Select value={sourceForm.source_type} onChange={(event) => setSourceForm((form) => ({ ...form, source_type: event.target.value, config: {} }))}>
                      <option value="api">API</option>
                      <option value="rss">RSS</option>
                      <option value="scraper">Scraper</option>
                      <option value="webhook">Webhook</option>
                      <option value="jsearch">{t("settings.pipelineTab.sourceTypeJsearch")}</option>
                    </Select>
                  </Field>
                </div>
                {SOURCE_TYPE_FIELD_KEYS[sourceForm.source_type].map((field) => {
                  const setFieldValue = (event) => setSourceForm((form) => ({ ...form, config: { ...form.config, [field.key]: event.target.value } }));
                  return (
                    <Field
                      key={field.key}
                      label={t(`settings.pipelineTab.${field.labelKey}`)}
                      hint={field.hintKey ? t(`settings.pipelineTab.${field.hintKey}`) : undefined}
                    >
                      {field.options ? (
                        <Select
                          aria-label={t(`settings.pipelineTab.${field.labelKey}`)}
                          value={sourceForm.config?.[field.key] || field.options[0].value}
                          onChange={setFieldValue}
                        >
                          {field.options.map((option) => (
                            <option key={option.value} value={option.value}>{t(`settings.pipelineTab.${option.labelKey}`)}</option>
                          ))}
                        </Select>
                      ) : (
                        <Input
                          type={field.type || "text"}
                          placeholder={sourceForm.configuredSecretFields?.includes(field.key)
                            ? t("settings.pipelineTab.secretKeptPlaceholder")
                            : field.placeholder}
                          value={sourceForm.config?.[field.key] || ""}
                          onChange={setFieldValue}
                        />
                      )}
                    </Field>
                  );
                })}
                <div className="flex justify-end gap-1.5 pt-1">
                  <Btn variant="secondary" small onClick={() => setSourceFormOpen(false)}>{t("settings.pipelineTab.cancelButton")}</Btn>
                  <Btn small icon={<Save size={12} />} onClick={saveSourceForm}>{sourceForm.id ? t("settings.pipelineTab.updateSourceButton") : t("settings.pipelineTab.addSourceButton")}</Btn>
                </div>
              </div>
            )}
          </SettingsSection>

          <SettingsSection isDark={isDark} title={t("settings.pipelineTab.smtpTitle")} IconComp={Mail} desc={t("settings.pipelineTab.smtpDesc")}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-1.5">
              <Field label={t("settings.pipelineTab.smtpServerLabel")}><Input value={smtp.smtp_host} onChange={(event) => setSmtp((s) => ({ ...s, smtp_host: event.target.value }))} placeholder="smtp.gmail.com" /></Field>
              <Field label={t("settings.pipelineTab.portLabel")}><Input type="number" value={smtp.smtp_port} onChange={(event) => setSmtp((s) => ({ ...s, smtp_port: Number(event.target.value) || 587 }))} /></Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-1.5">
              <Field label={t("settings.pipelineTab.usernameLabel")}><Input value={smtp.smtp_user} onChange={(event) => setSmtp((s) => ({ ...s, smtp_user: event.target.value }))} placeholder="sales@noondalton.com" /></Field>
              <Field
                label={t("settings.pipelineTab.passwordLabel")}
                hint={smtpPasswordHint}
                hintBelow
                hintId={smtpPasswordHintId}
              >
                <Input
                  type="password"
                  aria-describedby={smtpPasswordHint ? smtpPasswordHintId : undefined}
                  value={smtpPasswordInput}
                  onChange={(event) => setSmtpPasswordInput(event.target.value)}
                  placeholder={smtpPasswordConfigured ? "••••••••" : t("settings.pipelineTab.enterPasswordPlaceholder")}
                  autoComplete="new-password"
                />
              </Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-1.5">
              <Field label={t("settings.pipelineTab.senderEmailLabel")}><Input value={smtp.sender_email} onChange={(event) => setSmtp((s) => ({ ...s, sender_email: event.target.value }))} placeholder="sales@noondalton.com" /></Field>
              <Field label={t("settings.pipelineTab.senderNameLabel")}><Input value={smtp.sender_name} onChange={(event) => setSmtp((s) => ({ ...s, sender_name: event.target.value }))} placeholder="NoonDalton Sales" /></Field>
            </div>
          </SettingsSection>

          <SettingsSection
            isDark={isDark}
            title={t("settings.pipelineTab.hunterTitle")}
            IconComp={KeyRound}
            desc={t("settings.pipelineTab.hunterDesc")}
            badge={(
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${hunterKeyConfigured ? "bg-emerald-100 text-emerald-800" : "bg-gray-100 text-gray-600"}`}>
                {t(hunterKeyConfigured ? "settings.pipelineTab.hunterStatusConfigured" : "settings.pipelineTab.hunterStatusNotConfigured")}
              </span>
            )}
          >
            <Field
              label={t("settings.pipelineTab.hunterKeyLabel")}
              hint={t(hunterKeyConfigured ? "settings.pipelineTab.hunterConfiguredHint" : "settings.pipelineTab.hunterNotConfiguredHint")}
            >
              <Input
                type="password"
                aria-label={t("settings.pipelineTab.hunterKeyLabel")}
                value={hunterKeyInput}
                onChange={(event) => {
                  setHunterKeyInput(event.target.value);
                  if (event.target.value.trim()) setHunterKeyClearPending(false); // a new key replaces "clear"
                }}
                placeholder={hunterKeyConfigured ? "••••••••" : t("settings.pipelineTab.hunterKeyPlaceholder")}
                autoComplete="new-password"
                spellCheck={false}
              />
            </Field>
            {hunterKeyConfigured && !hunterKeyClearPending && !hunterKeyInput.trim() && (
              <Btn variant="secondary" small icon={<Trash2 size={12} />} onClick={() => setHunterKeyClearPending(true)}>
                {t("settings.pipelineTab.hunterClear")}
              </Btn>
            )}
            {hunterKeyClearPending && (
              <div role="status" className="flex flex-wrap items-center gap-1.5 text-xs text-amber-800">
                <span>{t("settings.pipelineTab.hunterClearPending")}</span>
                <Btn variant="secondary" small icon={<Undo2 size={12} />} onClick={() => setHunterKeyClearPending(false)}>
                  {t("settings.pipelineTab.hunterUndoClear")}
                </Btn>
              </div>
            )}
          </SettingsSection>

          <div className="flex justify-end pb-2">
            <Btn icon={<Save size={13} />} onClick={saveConfig} disabled={saving}>{saving ? t("settings.pipelineTab.savingButton") : t("settings.pipelineTab.saveButton")}</Btn>
          </div>
        </>
      )}
    </>
  );
}
