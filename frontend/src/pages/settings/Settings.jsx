/**
 * Settings — org-level configuration: CRM integration, LLM model, social connections.
 */
import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Save, Plug, Bot, Share2, Key, Settings as SettingsIcon, Palette } from "lucide-react";

import { settingsApi } from "@/api/axios";
import Button from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useI18n } from "@/hooks/useI18n";
import { useLanguage } from "@/context/LanguageContext";
import { useTheme } from "@/context/ThemeContext";

const LLM_MODELS = [
  { value: "deepseek-chat", label: "DeepSeek Chat" },
  { value: "deepseek-reasoner", label: "DeepSeek Reasoner" },
];

const SECTION = ({ title, icon: Icon, children }) => (
  <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-100 dark:border-slate-700 shadow-card p-6 transition-colors">
    <div className="flex items-center gap-2 mb-5 pb-4 border-b border-gray-100 dark:border-slate-700">
      <div className="w-8 h-8 rounded-lg bg-primary-50 dark:bg-primary-900 flex items-center justify-center transition-colors">
        <Icon size={16} className="text-primary-600 dark:text-primary-400" />
      </div>
      <h2 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h2>
    </div>
    {children}
  </div>
);

const Field = ({ label, hint, children }) => (
  <div className="mb-4">
    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{label}</label>
    {hint && <p className="text-xs text-gray-400 dark:text-gray-500 mb-1.5">{hint}</p>}
    {children}
  </div>
);

export default function Settings() {
  const { t } = useI18n();
  const { language, changeLanguage } = useLanguage();
  const { theme, changeTheme } = useTheme();

  const [form, setForm] = useState({
    language: language,
    theme: theme,
    llm: { model: "deepseek-chat", temperature: 0.7, maxOutputTokens: 8192 },
    crm: { provider: "none", apiKey: "", baseUrl: "" },
    socialConnections: [],
  });

  const { data, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsApi.get().then((r) => r.data),
  });

  useEffect(() => {
    if (data) {
      setForm((prev) => ({
        ...prev,
        ...data,
        language: data.language || language,
        theme: data.theme || theme,
      }));
    }
  }, [data, language, theme]);

  const saveMut = useMutation({
    mutationFn: (d) => settingsApi.put(d),
    onSuccess: () => toast.success(t("settings.saved")),
    onError: () => toast.error(t("messages.errorSaving")),
  });

  const upd = (section, field) => (e) =>
    setForm((prev) => ({ ...prev, [section]: { ...prev[section], [field]: e.target.value } }));

  const handleLanguageChange = (newLang) => {
    setForm((prev) => ({ ...prev, language: newLang }));
    changeLanguage(newLang);
  };

  const handleThemeChange = (newTheme) => {
    setForm((prev) => ({ ...prev, theme: newTheme }));
    changeTheme(newTheme);
  };

  if (isLoading) return <div className="flex justify-center py-20"><Spinner /></div>;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="mb-2">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t("settings.title")}</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{t("settings.generalSettings")}</p>
      </div>

      {/* General Settings */}
      <SECTION title={t("settings.generalSettings")} icon={SettingsIcon}>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t("settings.language")}>
            <select
              className="w-full border border-gray-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-slate-800 text-gray-900 dark:text-white transition-colors"
              value={form.language}
              onChange={(e) => handleLanguageChange(e.target.value)}
            >
              <option value="en">{t("settings.englishLanguage")}</option>
              <option value="es">{t("settings.spanishLanguage")}</option>
              <option value="pt">{t("settings.portugueseLanguage")}</option>
            </select>
          </Field>

          <Field label={t("settings.theme")}>
            <select
              className="w-full border border-gray-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-slate-800 text-gray-900 dark:text-white transition-colors"
              value={form.theme}
              onChange={(e) => handleThemeChange(e.target.value)}
            >
              <option value="light">{t("settings.lightMode")}</option>
              <option value="dark">{t("settings.darkMode")}</option>
              <option value="system">{t("settings.systemMode")}</option>
            </select>
          </Field>
        </div>
      </SECTION>

      {/* LLM Settings */}
      <SECTION title={t("settings.llmSettings")} icon={Bot}>
        <Field label={t("settings.model")} hint={t("messages.errorFetching")}>
          <select
            className="w-full border border-gray-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-slate-800 text-gray-900 dark:text-white transition-colors"
            value={form.llm?.model}
            onChange={upd("llm", "model")}
          >
            {LLM_MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label={t("settings.temperature")} hint={t("settings.deterministic")}>
            <input
              type="number" min={0} max={1} step={0.05}
              className="w-full border border-gray-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-slate-800 text-gray-900 dark:text-white transition-colors"
              value={form.llm?.temperature ?? 0.7}
              onChange={upd("llm", "temperature")}
            />
          </Field>
          <Field label={t("settings.maxTokens")}>
            <input
              type="number" min={1024} max={65536} step={1024}
              className="w-full border border-gray-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-slate-800 text-gray-900 dark:text-white transition-colors"
              value={form.llm?.maxOutputTokens ?? 8192}
              onChange={upd("llm", "maxOutputTokens")}
            />
          </Field>
        </div>
      </SECTION>

      {/* CRM Integration */}
      <SECTION title={t("settings.crmIntegration")} icon={Plug}>
        <Field label={t("settings.crmProvider")}>
          <select
            className="w-full border border-gray-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-slate-800 text-gray-900 dark:text-white transition-colors"
            value={form.crm?.provider ?? "none"}
            onChange={upd("crm", "provider")}
          >
            <option value="none">{t("settings.noCRM")}</option>
            <option value="hubspot">HubSpot</option>
            <option value="salesforce">Salesforce</option>
            <option value="pipedrive">Pipedrive</option>
            <option value="custom">API personalizada</option>
          </select>
        </Field>

        {form.crm?.provider !== "none" && (
          <>
            <Field label={t("settings.apiKey")} hint={t("settings.encrypted")}>
              <div className="relative">
                <Key size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
                <input
                  type="password"
                  className="w-full pl-9 border border-gray-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-slate-800 text-gray-900 dark:text-white transition-colors"
                  value={form.crm?.apiKey ?? ""}
                  onChange={upd("crm", "apiKey")}
                  placeholder="••••••••••••"
                  autoComplete="off"
                />
              </div>
            </Field>
            {form.crm?.provider === "custom" && (
              <Field label="URL base de la API">
                <input
                  className="w-full border border-gray-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-slate-800 text-gray-900 dark:text-white transition-colors"
                  value={form.crm?.baseUrl ?? ""}
                  onChange={upd("crm", "baseUrl")}
                  placeholder="https://api.mi-crm.com/v1"
                />
              </Field>
            )}
          </>
        )}
      </SECTION>

      {/* Social Connections */}
      <SECTION title={t("settings.socialConnections")} icon={Share2}>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Conecta tus redes para publicar contenido directamente desde la plataforma.
        </p>
        <div className="space-y-3">
          {[
            { id: "linkedin", label: "LinkedIn", color: "bg-blue-600" },
            { id: "twitter",  label: "Twitter / X", color: "bg-black dark:bg-slate-700" },
            { id: "instagram", label: "Instagram", color: "bg-pink-500" },
          ].map((net) => {
            const connected = (form.socialConnections ?? []).includes(net.id);
            return (
              <div key={net.id} className="flex items-center justify-between p-3 rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 transition-colors">
                <div className="flex items-center gap-3">
                  <div className={`w-6 h-6 rounded ${net.color}`} />
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{net.label}</span>
                </div>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full transition-colors ${
                  connected ? "bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-200" : "bg-gray-100 dark:bg-slate-700 text-gray-400 dark:text-gray-500"
                }`}>
                  {connected ? t("settings.connected") : t("settings.notConnected")}
                </span>
              </div>
            );
          })}
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
            {t("settings.comingSoon")}
          </p>
        </div>
      </SECTION>

      {/* Save */}
      <div className="flex justify-end">
        <Button
          variant="primary"
          size="lg"
          isLoading={saveMut.isPending}
          onClick={() => saveMut.mutate(form)}
          icon={<Save size={16} />}
        >
          {t("settings.save")}
        </Button>
      </div>
    </div>
  );
}
