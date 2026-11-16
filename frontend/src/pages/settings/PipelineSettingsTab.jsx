/**
 * PipelineSettingsTab — configuration UI for the 3-agent prospecting pipeline
 * (keywords/industries, job sources CRUD, the sending mailbox and the Hunter
 * key). Mounted by Dashboard.jsx's Settings page as the "pipeline" tab. The
 * former "automation thresholds" section and the "Prospecting Pipeline" on/off
 * toggle were removed: none of them had any effect (scanning is manual; the
 * scheduled scan is RF-VTA-17, deferred).
 *
 * Each card saves on its own (there is no global save button): the tag lists
 * right away, the daily limit with «Save limit», Hunter with «Save key» and
 * each source with its own form button.
 *
 * Sending mailbox card (RF-VTA-16, real send): the user's own Microsoft 365 /
 * Outlook mailbox, connected by OAuth (GET /mail-connection/status). «Connect»
 * / «Reconnect» go to Microsoft's consent page (POST /mail-connection/start);
 * Microsoft answers to the backend, which sends the browser back with the
 * result (features/mailConnection/redirectResult.js), shown here once.
 * «Test» reads the mailbox without sending; «Disconnect» forgets it. No token
 * ever reaches the frontend. «Real email sending» is a switch saved right
 * away (off by default; the server's own switch is shown read-only).
 */
import { useEffect, useId, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  Search, Globe, Mail, Code, Rss, Plug, Briefcase,
  Pencil, Trash2, Plus, Save, Loader2, KeyRound, Undo2, RefreshCw,
} from "lucide-react";

import { mailConnectionApi, pipelineApi } from "@/api/axios";
import { logApiError } from "@/api/apiLogging";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { MAIL_CONNECTION_CONNECTED, openAuthorizeUrl, takeMailConnectionResult } from "@/features/mailConnection/redirectResult";
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
        // The container already shows the focus ring (focus-within); drop the
        // global input:focus-visible shadow so the field has a single border.
        className="flex-1 min-w-[100px] outline-none focus-visible:shadow-none text-xs bg-transparent placeholder-gray-400"
      />
    </div>
  );
}

// Serialized auto-save: one request at a time, in order. `status` is
// "saving" while any is pending, then "saved" — or "idle" if one of the batch
// failed (the caller already restored the value and showed the error).
// `run` returns false on failure.
function useAutoSaveQueue() {
  const queue = useRef(Promise.resolve());
  const pending = useRef(0);
  const failed = useRef(false);
  const [status, setStatus] = useState("idle"); // idle | saving | saved

  const enqueue = (run) => {
    pending.current += 1;
    setStatus("saving");
    queue.current = queue.current
      .then(async () => { if ((await run()) === false) failed.current = true; })
      .catch(() => { failed.current = true; })
      .finally(() => {
        pending.current -= 1;
        if (pending.current === 0) {
          setStatus(failed.current ? "idle" : "saved");
          failed.current = false;
        }
      });
  };

  return { queue, status, enqueue };
}

const DAILY_LIMIT_DEFAULT = 50;
const DAILY_LIMIT_MAX = 100;
// Codes of the mailbox connection (routers/mail_connection.py): refusals of
// start and test (detail.code) and the callback's mail_connection_error.
// rateLimited and generic are client-side.
export const MAILBOX_ERROR_CODES = [
  // start
  "mail_oauth_not_configured", "mail_endpoints_not_allowed", "encryption_not_configured",
  // test
  "mailbox_not_connected", "mailbox_reconnect_required", "missing_permissions", "mailbox_auth_failed",
  "mail_service_unavailable", "mail_throttled", "mail_service_timeout", "mailbox_without_address",
  // callback
  "invalid_state", "consent_denied", "admin_consent_required", "authorization_failed", "server_error",
  // client
  "rateLimited", "generic",
];
const mailboxErrorKey = (code) => `settings.pipelineTab.mailboxErrors.${MAILBOX_ERROR_CODES.includes(code) ? code : "generic"}`;
const mailboxErrorCode = (error) => {
  const code = error?.response?.data?.detail?.code;
  if (MAILBOX_ERROR_CODES.includes(code)) return code;
  if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT") return "mail_service_timeout";
  return error?.response?.status === 429 ? "rateLimited" : "generic";
};
const fillText = (text, params) => Object.entries(params).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), text);

/** The daily limit typed by the user, or null when it is not an integer 1..100. */
export function parseDailyLimit(raw) {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value >= 1 && value <= DAILY_LIMIT_MAX ? value : null;
}

// What the mailbox card shows about real sending, from a /pipeline/config response.
const realSendStateOf = (data) => ({
  enabled: Boolean(data?.outreach_real_send_enabled),
  serverEnabled: Boolean(data?.outreach_real_send_server_enabled),
});

export default function PipelineSettingsTab({ isDark = false }) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [keywords, setKeywords] = useState([]);
  const [industries, setIndustries] = useState([]);
  const [excludedCompanies, setExcludedCompanies] = useState([]);
  // Tag lists are saved on their own, one request at a time (tagSaveQueue).
  // confirmedTags = last value the server confirmed; latestTags = what the
  // screen shows. Each queued save sends the latest value, so quick edits are
  // coalesced and the last one wins; a failure restores the confirmed list.
  const confirmedTags = useRef({ keywords: [], industries: [], excluded_companies: [] });
  const latestTags = useRef({ keywords: [], industries: [], excluded_companies: [] });
  const tagSaves = useAutoSaveQueue();
  const [sources, setSources] = useState([]);
  // Sending mailbox: GET /mail-connection/status (null while loading),
  // whether that read failed, the action in flight (connect | test |
  // disconnect) and the result of a connection just made (shown once).
  const [mailbox, setMailbox] = useState(null);
  const [mailboxLoadFailed, setMailboxLoadFailed] = useState(false);
  const [mailboxBusy, setMailboxBusy] = useState(null);
  const [mailboxResult, setMailboxResult] = useState(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  // Hunter API key (RF15): write-only. The field always
  // starts empty — the API never returns the key, only whether one is set.
  // "Borrar clave" only marks it; "" is sent when the user presses Save.
  const [hunterKeyConfigured, setHunterKeyConfigured] = useState(false);
  const [hunterKeyInput, setHunterKeyInput] = useState("");
  const [hunterKeyClearPending, setHunterKeyClearPending] = useState(false);
  const [hunterSaving, setHunterSaving] = useState(false);
  const [realSend, setRealSend] = useState(realSendStateOf(null));
  const [realSendSaving, setRealSendSaving] = useState(false);
  const [dailyLimit, setDailyLimit] = useState(String(DAILY_LIMIT_DEFAULT));
  const [dailyLimitSaving, setDailyLimitSaving] = useState(false);
  const mailboxConsentId = useId();
  const realSendHintId = useId();
  const dailyLimitHintId = useId();
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
      setRealSend(realSendStateOf(data));
      setDailyLimit(String(data?.outreach_daily_send_limit || DAILY_LIMIT_DEFAULT));
      setHunterKeyConfigured(Boolean(data?.hunter_api_key_configured));
      setHunterKeyInput("");
      setHunterKeyClearPending(false);
    } catch (error) {
      logApiError("PipelineSettings", error);
      toast.error(t("settings.pipelineTab.toastLoadError"));
    } finally {
      setLoading(false);
    }
  };

  const loadMailbox = async () => {
    try {
      const { data } = await mailConnectionApi.status();
      setMailbox(data || null);
      setMailboxLoadFailed(!data);
    } catch {
      // Not logged: the answer carries the mailbox address.
      setMailbox(null);
      setMailboxLoadFailed(true);
    }
  };

  useEffect(() => {
    loadConfig();
    loadMailbox();
    // Back from Microsoft's consent page: the result is shown once.
    const result = takeMailConnectionResult();
    if (result) setMailboxResult(result);
  }, []);

  // «Connect» / «Reconnect»: Microsoft's consent page, in this tab.
  const connectMailbox = async () => {
    if (mailboxBusy) return;
    setMailboxBusy("connect");
    setMailboxResult(null);
    try {
      const { data } = await mailConnectionApi.start();
      if (!openAuthorizeUrl(data?.authorize_url)) throw new Error("no authorize_url");
      // The page is leaving: the button stays busy.
    } catch (error) {
      toast.error(t(mailboxErrorKey(mailboxErrorCode(error))));
      setMailboxBusy(null);
    }
  };

  // «Test»: reads the mailbox on Microsoft's side; nothing is sent.
  const testMailbox = async () => {
    if (mailboxBusy) return;
    setMailboxBusy("test");
    try {
      const { data } = await mailConnectionApi.test();
      toast.success(fillText(t("settings.pipelineTab.mailboxTestOk"), { address: data?.address || "" }));
    } catch (error) {
      const code = mailboxErrorCode(error);
      toast.error(t(mailboxErrorKey(code)));
      // The connection itself may have changed (flagged to reconnect, or gone).
      if (["mailbox_reconnect_required", "mailbox_not_connected"].includes(code)) loadMailbox();
    } finally {
      setMailboxBusy(null);
    }
  };

  // «Disconnect»: the stored tokens are deleted on the server.
  const disconnectMailbox = async () => {
    setConfirmDisconnect(false);
    if (mailboxBusy) return;
    setMailboxBusy("disconnect");
    setMailboxResult(null);
    try {
      await mailConnectionApi.delete();
      toast.success(t("settings.pipelineTab.mailboxDisconnected"));
    } catch {
      toast.error(t("settings.pipelineTab.mailboxDisconnectError"));
    } finally {
      await loadMailbox();
      setMailboxBusy(null);
    }
  };

  // «Save limit»: sends only the daily limit.
  const saveDailyLimit = async () => {
    const limit = parseDailyLimit(dailyLimit);
    if (limit === null) {
      toast.error(t("settings.pipelineTab.dailyLimitInvalid"));
      return;
    }
    setDailyLimitSaving(true);
    try {
      const { data } = await pipelineApi.updateConfig({ outreach_daily_send_limit: limit });
      setDailyLimit(String(data?.outreach_daily_send_limit || limit));
      toast.success(t("settings.pipelineTab.dailyLimitSaved"));
    } catch (error) {
      toast.error(getApiErrorMessage(error, t("settings.pipelineTab.dailyLimitSaveError")));
    } finally {
      setDailyLimitSaving(false);
    }
  };

  // «Real email sending» switch: saved right away, alone.
  const toggleRealSend = async () => {
    if (realSendSaving) return;
    const next = !realSend.enabled;
    setRealSendSaving(true);
    try {
      const { data } = await pipelineApi.updateConfig({ outreach_real_send_enabled: next });
      setRealSend(realSendStateOf(data));
      toast.success(t("settings.pipelineTab.realSendSaved"));
    } catch (error) {
      toast.error(getApiErrorMessage(error, t("settings.pipelineTab.realSendSaveError")));
    } finally {
      setRealSendSaving(false);
    }
  };

  // Something to apply: a typed key (trimmed) or a pending "Clear key".
  const hunterHasChange = Boolean(hunterKeyInput.trim()) || hunterKeyClearPending;

  // Hunter card's own save: sends only hunter_api_key and resets only this
  // card, so unsaved edits in other cards are neither sent nor lost.
  const saveHunterKey = async () => {
    if (!hunterHasChange) return;
    const typedKey = hunterKeyInput.trim();
    setHunterSaving(true);
    try {
      const { data } = await pipelineApi.updateConfig({ hunter_api_key: typedKey || "" });
      setHunterKeyConfigured(Boolean(data?.hunter_api_key_configured));
      setHunterKeyInput("");
      setHunterKeyClearPending(false);
      toast.success(t(typedKey ? "settings.pipelineTab.hunterSaved" : "settings.pipelineTab.hunterCleared"));
    } catch (error) {
      // Not logged: the request carried hunter_api_key.
      toast.error(error?.response?.status === 503
        ? t("settings.pipelineTab.toastEncryptionUnavailable")
        : getApiErrorMessage(error, t("settings.pipelineTab.hunterSaveError")));
    } finally {
      setHunterSaving(false);
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
      await tagSaves.queue.current;
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

    tagSaves.enqueue(async () => {
      const sending = latestTags.current[field];
      // An earlier save already sent this value (quick edits coalesce).
      if (sameTags(sending, confirmedTags.current[field])) return true;
      try {
        const { data } = await pipelineApi.updateConfig({ [field]: sending });
        const saved = Array.isArray(data?.[field]) ? data[field] : sending;
        confirmedTags.current = { ...confirmedTags.current, [field]: saved };
        // Only adopt the server copy when nothing newer was typed meanwhile.
        if (sameTags(latestTags.current[field], sending)) {
          latestTags.current = { ...latestTags.current, [field]: saved };
          setTags(saved);
        }
        return true;
      } catch (error) {
        logApiError("PipelineSettings", error);
        const restored = confirmedTags.current[field];
        latestTags.current = { ...latestTags.current, [field]: restored };
        setTags(restored);
        toast.error(t("settings.pipelineTab.tagsSaveError"));
        return false;
      }
    });
  };

  const autoSaveText = (status) => ({
    saving: t("settings.pipelineTab.autoSaving"),
    saved: t("settings.pipelineTab.autoSaved"),
  }[status] || "");

  // What the mailbox card shows: loading | error | not_connected | reconnect | connected.
  const mailboxState = mailboxLoadFailed
    ? "error"
    : !mailbox ? "loading"
      : !mailbox.connected ? "not_connected"
        : mailbox.needs_reconnect ? "reconnect" : "connected";
  const MAILBOX_BADGE = {
    loading: ["mailboxStatusLoading", "bg-gray-100 text-gray-600"],
    error: ["mailboxStatusUnknown", "bg-gray-100 text-gray-600"],
    not_connected: ["mailboxNotConnected", "bg-amber-100 text-amber-800"],
    reconnect: ["mailboxNeedsReconnect", "bg-red-100 text-red-800"],
    connected: ["mailboxConnected", "bg-emerald-100 text-emerald-800"],
  };
  const [mailboxBadgeKey, mailboxBadgeClass] = MAILBOX_BADGE[mailboxState];
  const oauthConfigured = mailbox?.oauth_configured !== false;
  const busyIcon = (action, Icon) => (mailboxBusy === action ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />);

  return (
    <>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 size={20} className="animate-spin text-indigo-600" /></div>
      ) : (
        <>
          <SettingsSection
            isDark={isDark}
            title={t("settings.pipelineTab.keywordsTitle")}
            IconComp={Search}
            desc={t("settings.pipelineTab.keywordsDesc")}
            badge={<span role="status" aria-live="polite" className="text-xs text-gray-500">{autoSaveText(tagSaves.status)}</span>}
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

          <SettingsSection
            isDark={isDark}
            title={t("settings.pipelineTab.mailboxTitle")}
            IconComp={Mail}
            desc={t("settings.pipelineTab.mailboxDesc")}
            badge={(
              <span data-testid="mailbox-badge" className={`px-2 py-0.5 rounded-full text-xs font-medium ${mailboxBadgeClass}`}>
                {t(`settings.pipelineTab.${mailboxBadgeKey}`)}
              </span>
            )}
          >
            {mailboxResult && (
              mailboxResult === MAIL_CONNECTION_CONNECTED ? (
                <p role="status" className="mb-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800" data-testid="mailbox-result">
                  {t("settings.pipelineTab.mailboxConnectedNotice")}
                </p>
              ) : (
                <p role="alert" className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800" data-testid="mailbox-result">
                  {fillText(t("settings.pipelineTab.mailboxConnectFailed"), { reason: t(mailboxErrorKey(mailboxResult)) })}
                </p>
              )
            )}
            {mailboxState === "error" && (
              <p role="alert" className="mb-2 text-xs text-red-800" data-testid="mailbox-load-error">{t("settings.pipelineTab.mailboxLoadError")}</p>
            )}
            {mailbox && !oauthConfigured && (
              <p role="note" className="mb-2 text-xs text-amber-800" data-testid="mailbox-oauth-off">{t("settings.pipelineTab.mailboxOauthNotConfigured")}</p>
            )}
            {(mailboxState === "connected" || mailboxState === "reconnect") && (
              <div className="mb-2 text-xs" data-testid="mailbox-account">
                <p className="text-gray-500">{t("settings.pipelineTab.mailboxAccountLabel")}</p>
                {mailbox.display_name && <p className="font-medium text-gray-800" data-testid="mailbox-display-name">{mailbox.display_name}</p>}
                <p className="text-gray-700 [overflow-wrap:anywhere]" data-testid="mailbox-address">{mailbox.address || "—"}</p>
              </div>
            )}
            {mailboxState === "reconnect" && (
              <p role="alert" className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800" data-testid="mailbox-reconnect-note">
                {t("settings.pipelineTab.mailboxReconnectNote")}
              </p>
            )}
            <p id={mailboxConsentId} className="mb-2 text-xs text-gray-500" data-testid="mailbox-consent">{t("settings.pipelineTab.mailboxConsent")}</p>
            <div className="mb-[18px] flex flex-wrap justify-end gap-1.5">
              {mailboxState === "not_connected" && (
                <Btn
                  small
                  className="disabled:opacity-50 disabled:cursor-not-allowed"
                  icon={busyIcon("connect", Mail)}
                  onClick={connectMailbox}
                  disabled={Boolean(mailboxBusy) || !oauthConfigured}
                  aria-busy={mailboxBusy === "connect" || undefined}
                  aria-describedby={mailboxConsentId}
                >
                  {t("settings.pipelineTab.mailboxConnectButton")}
                </Btn>
              )}
              {mailboxState === "reconnect" && (
                <Btn
                  small
                  className="disabled:opacity-50 disabled:cursor-not-allowed"
                  icon={busyIcon("connect", RefreshCw)}
                  onClick={connectMailbox}
                  disabled={Boolean(mailboxBusy) || !oauthConfigured}
                  aria-busy={mailboxBusy === "connect" || undefined}
                  aria-describedby={mailboxConsentId}
                >
                  {t("settings.pipelineTab.mailboxReconnectButton")}
                </Btn>
              )}
              {mailboxState === "connected" && (
                <Btn
                  variant="secondary"
                  small
                  className="disabled:opacity-50 disabled:cursor-not-allowed"
                  icon={busyIcon("test", Plug)}
                  onClick={testMailbox}
                  disabled={Boolean(mailboxBusy)}
                  aria-busy={mailboxBusy === "test" || undefined}
                >
                  {mailboxBusy === "test" ? t("settings.pipelineTab.mailboxTesting") : t("settings.pipelineTab.mailboxTestButton")}
                </Btn>
              )}
              {(mailboxState === "connected" || mailboxState === "reconnect") && (
                <Btn
                  variant="secondary"
                  small
                  className="disabled:opacity-50 disabled:cursor-not-allowed"
                  icon={busyIcon("disconnect", Trash2)}
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={Boolean(mailboxBusy)}
                  aria-busy={mailboxBusy === "disconnect" || undefined}
                >
                  {t("settings.pipelineTab.mailboxDisconnectButton")}
                </Btn>
              )}
            </div>
            <ConfirmDialog
              open={confirmDisconnect}
              title={t("settings.pipelineTab.mailboxDisconnectTitle")}
              message={t("settings.pipelineTab.mailboxDisconnectMessage")}
              cancelLabel={t("settings.pipelineTab.cancelButton")}
              confirmLabel={t("settings.pipelineTab.mailboxDisconnectButton")}
              onCancel={() => setConfirmDisconnect(false)}
              onConfirm={disconnectMailbox}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-1.5">
              <Field label={t("settings.pipelineTab.dailyLimitLabel")} hint={t("settings.pipelineTab.dailyLimitHint")} hintBelow hintId={dailyLimitHintId}>
                <div className="flex gap-1.5">
                  <Input
                    type="number"
                    min={1}
                    max={DAILY_LIMIT_MAX}
                    step={1}
                    aria-label={t("settings.pipelineTab.dailyLimitLabel")}
                    aria-describedby={dailyLimitHintId}
                    value={dailyLimit}
                    onChange={(event) => setDailyLimit(event.target.value)}
                  />
                  <Btn small className="shrink-0 disabled:opacity-50 disabled:cursor-not-allowed" icon={<Save size={12} />} onClick={saveDailyLimit} disabled={dailyLimitSaving}>
                    {dailyLimitSaving ? t("settings.pipelineTab.savingButton") : t("settings.pipelineTab.dailyLimitSaveButton")}
                  </Btn>
                </div>
              </Field>
              <div className="mb-[18px]">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={realSend.enabled}
                    aria-label={t("settings.pipelineTab.realSendLabel")}
                    aria-describedby={realSendHintId}
                    disabled={realSendSaving}
                    onClick={toggleRealSend}
                    className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${realSend.enabled ? "bg-indigo-600" : "bg-gray-300"}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${realSend.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
                  </button>
                  <span className="text-xs font-medium text-gray-700">{t("settings.pipelineTab.realSendLabel")}</span>
                </div>
                <p id={realSendHintId} className="mt-1 text-xs text-gray-400">{t("settings.pipelineTab.realSendHint")}</p>
                {!realSend.serverEnabled && (
                  <p role="note" className="mt-1 text-xs text-amber-800" data-testid="real-send-server-off">{t("settings.pipelineTab.realSendServerOff")}</p>
                )}
              </div>
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
            <div className="flex flex-wrap items-center gap-1.5">
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
              <Btn
                small
                className="ml-auto disabled:opacity-50 disabled:cursor-not-allowed"
                icon={<Save size={12} />}
                onClick={saveHunterKey}
                disabled={!hunterHasChange || hunterSaving}
              >
                {hunterSaving ? t("settings.pipelineTab.savingButton") : t("settings.pipelineTab.hunterSaveButton")}
              </Btn>
            </div>
          </SettingsSection>
        </>
      )}
    </>
  );
}
