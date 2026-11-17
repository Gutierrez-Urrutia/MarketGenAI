/**
 * ProposalTemplatesTab — RF-VTA-07: plantillas de propuesta reutilizables.
 * Se clasifican por línea de servicio e industria, usan variables {nombre} y
 * siempre traen un bloque editable de condiciones comerciales.
 * Mounted by SettingsPage ("templates" tab).
 */
import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Download, Loader2, Pencil, Save, Trash2, UploadCloud, X } from "lucide-react";

import { templatesApi } from "@/api/axios";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { catalogLabel, extractVariables, insertVariable } from "@/features/proposals/templateVariables";
import { useI18n } from "@/hooks/useI18n";

const ACCEPT = ".txt,.md,.html,.htm,.docx,.pdf";
// Settings ya muestra sus propios avisos; sin esto axios agrega un toast genérico en los 403.
const QUIET = { suppressPermissionToast: true };

const SAMPLE_CONTENT = {
  es: "# Propuesta para {cliente_empresa}\n\nAtención: {cliente_nombre}\nServicio: {servicio} · Industria: {industria}\n\n## Resumen ejecutivo\n\n## Alcance\n\nFecha: {fecha} · Referencia: {referencia}",
  en: "# Proposal for {cliente_empresa}\n\nAttention: {cliente_nombre}\nService: {servicio} · Industry: {industria}\n\n## Executive summary\n\n## Scope\n\nDate: {fecha} · Reference: {referencia}",
  pt: "# Proposta para {cliente_empresa}\n\nAtenção: {cliente_nombre}\nServiço: {servicio} · Indústria: {industria}\n\n## Resumo executivo\n\n## Escopo\n\nData: {fecha} · Referência: {referencia}",
};

function getApiErrorMessage(error, fallback) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const first = detail.map((item) => item?.msg || (typeof item === "string" ? item : "")).find(Boolean);
    if (first) return first;
  }
  return error?.message || fallback;
}

const emptyForm = (catalog, language) => ({
  id: null,
  name: "",
  description: "",
  serviceType: "other",
  industry: "general",
  content: SAMPLE_CONTENT[language] || SAMPLE_CONTENT.es,
  commercialTerms: catalog?.defaultCommercialTerms?.[language] || catalog?.defaultCommercialTerms?.es || "",
});

export default function ProposalTemplatesTab({ isDark }) {
  const { t, language } = useI18n();
  const fieldRefs = { content: useRef(null), commercialTerms: useRef(null) };
  const [catalog, setCatalog] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ serviceType: "", industry: "" });
  const [form, setForm] = useState(() => emptyForm(null, language));
  const [activeField, setActiveField] = useState("content");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    templatesApi.catalog(QUIET)
      .then(({ data }) => {
        setCatalog(data);
        // El texto base llega con el catálogo: se carga en el formulario nuevo si aún está vacío.
        setForm((current) => (current.id || current.commercialTerms
          ? current
          : { ...current, commercialTerms: data.defaultCommercialTerms?.[language] || data.defaultCommercialTerms?.es || "" }));
      })
      .catch((error) => toast.error(getApiErrorMessage(error, t("settings.templateLoadFailed"))));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al montar; `t` cambia en cada render
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    templatesApi.list({
      type: "proposal",
      serviceType: filters.serviceType || undefined,
      industry: filters.industry || undefined,
      limit: 100,
    }, QUIET)
      .then(({ data }) => { if (!cancelled) setTemplates(data?.items || []); })
      .catch((error) => { if (!cancelled) toast.error(getApiErrorMessage(error, t("settings.templateLoadFailed"))); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` cambia en cada render
  }, [filters.serviceType, filters.industry]);

  const serviceOptions = catalog?.serviceTypes || [];
  const industryOptions = catalog?.industries || [];
  const standardVariables = catalog?.standardVariables || { customer: [], proposal: [] };
  const standardNames = new Set([...(standardVariables.customer || []), ...(standardVariables.proposal || [])]);
  const usedVariables = extractVariables(form.content, form.commercialTerms);
  const customVariables = usedVariables.filter((name) => !standardNames.has(name));
  const labelOf = (options, value) => catalogLabel(options.find((option) => option.value === value), language) || value;

  const update = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));
  const resetForm = () => setForm(emptyForm(catalog, language));

  const edit = (template) => {
    setForm({
      id: template.id,
      name: template.name || "",
      description: template.description || "",
      serviceType: template.serviceType || "other",
      industry: template.industry || "general",
      content: template.content || "",
      commercialTerms: template.commercialTerms || "",
    });
    setActiveField("content");
  };

  const addVariable = (name) => {
    const element = fieldRefs[activeField].current;
    const { text, cursor } = insertVariable(form[activeField], name, element?.selectionStart, element?.selectionEnd);
    setForm((current) => ({ ...current, [activeField]: text }));
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange?.(cursor, cursor);
    });
  };

  const save = async () => {
    if (form.name.trim().length < 2) return toast.error(t("settings.templateNameRequired"));
    if (!form.content.trim()) return toast.error(t("settings.templateContentRequired"));
    if (!form.commercialTerms.trim()) return toast.error(t("settings.templateTermsRequired"));
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      type: "proposal",
      description: form.description.trim() || null,
      serviceType: form.serviceType,
      industry: form.industry,
      content: form.content,
      commercialTerms: form.commercialTerms,
      variables: usedVariables,
    };
    try {
      const { data } = form.id
        ? await templatesApi.update(form.id, payload, QUIET)
        : await templatesApi.create(payload, QUIET);
      const matchesFilters = (!filters.serviceType || data.serviceType === filters.serviceType)
        && (!filters.industry || data.industry === filters.industry);
      setTemplates((current) => {
        const others = current.filter((template) => template.id !== data.id);
        if (!matchesFilters) return others;
        return form.id ? current.map((template) => (template.id === data.id ? data : template)) : [data, ...others];
      });
      resetForm();
      toast.success(t("settings.templateSaved"));
    } catch (error) {
      toast.error(getApiErrorMessage(error, t("settings.templateSaveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await templatesApi.delete(deleting.id, QUIET);
      setTemplates((current) => current.filter((template) => template.id !== deleting.id));
      if (form.id === deleting.id) resetForm();
      toast.success(t("settings.templateDeleted"));
      setDeleting(null);
    } catch (error) {
      toast.error(getApiErrorMessage(error, t("settings.templateDeleteFailed")));
    } finally {
      setDeleteBusy(false);
    }
  };

  const upload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const { data } = await templatesApi.extract(file, QUIET);
      setForm((current) => ({
        ...emptyForm(catalog, language),
        serviceType: current.serviceType,
        industry: current.industry,
        name: data?.name || file.name.replace(/\.[^.]+$/, ""),
        content: data?.content || "",
      }));
      toast.success(t("settings.templateUploadLoaded"));
    } catch (error) {
      toast.error(getApiErrorMessage(error, t("settings.templateUploadFailed")));
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  };

  const exportTemplate = (template) => {
    const text = [template.content || "", template.commercialTerms ? `\n\n---\n${t("settings.templateCommercialTerms")}\n\n${template.commercialTerms}` : ""].join("");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${template.name || "template"}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const card = isDark ? "bg-slate-800 border-white/10 text-slate-100" : "bg-white border-gray-100 text-gray-900";
  const panel = isDark ? "rounded-xl border border-white/10 bg-slate-900 p-3" : "rounded-xl border border-gray-100 bg-gray-50 p-3";
  const input = `w-full border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
    isDark ? "bg-slate-900 border-white/10 text-slate-100" : "border-gray-300 bg-white"
  }`;
  const label = "block text-xs font-medium mb-1";
  const chip = isDark ? "bg-slate-900 text-slate-200 border-white/10 hover:bg-slate-700" : "bg-indigo-50 text-indigo-700 border-transparent hover:bg-indigo-100";
  const tag = isDark ? "bg-slate-800 text-slate-300 border border-white/10" : "bg-white text-gray-600 border border-gray-200";
  const button = "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60";
  const secondaryButton = `${button} ${isDark ? "border border-white/10 text-slate-200 hover:bg-slate-700" : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"}`;

  return (
    <div className={`rounded-2xl border shadow-sm p-4 space-y-4 ${card}`}>
      <div>
        <h2 className="text-sm font-semibold">{t("settings.templatesTitle")}</h2>
        <p className="text-xs text-gray-500">{t("settings.templatesDescription")}</p>
      </div>

      {/* Filtros */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="text-xs">
          <span className={label}>{t("settings.templateFilterService")}</span>
          <select className={input} value={filters.serviceType} onChange={(e) => setFilters((f) => ({ ...f, serviceType: e.target.value }))}>
            <option value="">{t("settings.templateAll")}</option>
            {serviceOptions.map((option) => <option key={option.value} value={option.value}>{catalogLabel(option, language)}</option>)}
          </select>
        </label>
        <label className="text-xs">
          <span className={label}>{t("settings.templateFilterIndustry")}</span>
          <select className={input} value={filters.industry} onChange={(e) => setFilters((f) => ({ ...f, industry: e.target.value }))}>
            <option value="">{t("settings.templateAll")}</option>
            {industryOptions.map((option) => <option key={option.value} value={option.value}>{catalogLabel(option, language)}</option>)}
          </select>
        </label>
      </div>

      {/* Listado */}
      {loading ? (
        <Loader2 size={16} className="animate-spin text-gray-400" />
      ) : templates.length === 0 ? (
        <p className="text-xs text-gray-500">{t("settings.noTemplatesYet")}</p>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
          {templates.map((template) => (
            <li key={template.id} className={`${panel} flex flex-col gap-2`}>
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-semibold">{template.name}</p>
                {template.isPublic && <span className="shrink-0 rounded px-2 py-0.5 text-[10px] bg-green-100 text-green-700">{t("settings.templatePublic")}</span>}
              </div>
              <div className="flex flex-wrap gap-1">
                <span className={`rounded px-2 py-0.5 text-[10px] ${tag}`}>{labelOf(serviceOptions, template.serviceType)}</span>
                <span className={`rounded px-2 py-0.5 text-[10px] ${tag}`}>{labelOf(industryOptions, template.industry)}</span>
              </div>
              {template.description && <p className="text-xs text-gray-500 line-clamp-2">{template.description}</p>}
              <div className="mt-auto flex items-center justify-between gap-1 pt-1">
                <span className="text-[10px] text-gray-500">{t("settings.templateUses").replace("{count}", template.usageCount ?? 0)}</span>
                <div className="flex gap-1">
                  <button type="button" className="p-1.5 rounded text-gray-400 hover:text-indigo-600" onClick={() => edit(template)} aria-label={`${t("settings.templateEdit")} ${template.name}`} title={t("settings.templateEdit")}><Pencil size={13} /></button>
                  <button type="button" className="p-1.5 rounded text-gray-400 hover:text-gray-700" onClick={() => exportTemplate(template)} aria-label={`${t("settings.templateExport")} ${template.name}`} title={t("settings.templateExport")}><Download size={13} /></button>
                  <button type="button" className="p-1.5 rounded text-gray-400 hover:text-red-600" onClick={() => setDeleting(template)} aria-label={`${t("settings.templateDelete")} ${template.name}`} title={t("settings.templateDelete")}><Trash2 size={13} /></button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Editor */}
      <div className={`${panel} space-y-3`}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold">{form.id ? t("settings.templateEditing") : t("settings.templateNew")}</h3>
          <label className={`${secondaryButton} cursor-pointer`}>
            {uploading ? <Loader2 size={13} className="animate-spin" /> : <UploadCloud size={13} />}
            {t("settings.templateUpload")}
            <input type="file" accept={ACCEPT} className="hidden" disabled={uploading} onChange={upload} />
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="text-xs">
            <span className={label}>{t("settings.templateName")}</span>
            <input className={input} value={form.name} onChange={update("name")} maxLength={200} />
          </label>
          <label className="text-xs">
            <span className={label}>{t("settings.templateDescription")}</span>
            <input className={input} value={form.description} onChange={update("description")} />
          </label>
          <label className="text-xs">
            <span className={label}>{t("settings.templateService")}</span>
            <select className={input} value={form.serviceType} onChange={update("serviceType")}>
              {serviceOptions.map((option) => <option key={option.value} value={option.value}>{catalogLabel(option, language)}</option>)}
            </select>
          </label>
          <label className="text-xs">
            <span className={label}>{t("settings.templateIndustry")}</span>
            <select className={input} value={form.industry} onChange={update("industry")}>
              {industryOptions.map((option) => <option key={option.value} value={option.value}>{catalogLabel(option, language)}</option>)}
            </select>
          </label>
        </div>

        <div>
          <p className={label}>{t("settings.templateStandardVars")}</p>
          <p className="text-[10px] text-gray-500 mb-1">{t("settings.templateStandardVarsHint")}</p>
          {[["customer", "templateVarGroupCustomer"], ["proposal", "templateVarGroupProposal"]].map(([group, groupKey]) => (
            <div key={group} className="flex flex-wrap items-center gap-1 mb-1">
              <span className="text-[10px] text-gray-500 w-20 shrink-0">{t(`settings.${groupKey}`)}</span>
              {(standardVariables[group] || []).map((name) => (
                <button key={name} type="button" onClick={() => addVariable(name)} title={t(`settings.templateVars.${name}`)}
                        className={`rounded border px-2 py-0.5 text-[11px] font-mono ${chip}`}>
                  {`{${name}}`}
                </button>
              ))}
            </div>
          ))}
        </div>

        <label className="block text-xs">
          <span className={label}>{t("settings.templateContent")}</span>
          <textarea ref={fieldRefs.content} className={`${input} min-h-40 font-mono`} value={form.content}
                    onChange={update("content")} onFocus={() => setActiveField("content")} />
        </label>

        <label className="block text-xs">
          <span className={label}>{t("settings.templateCommercialTerms")}</span>
          <span className="block text-[10px] text-gray-500 mb-1">{t("settings.templateCommercialTermsHint")}</span>
          <textarea ref={fieldRefs.commercialTerms} className={`${input} min-h-32`} value={form.commercialTerms}
                    onChange={update("commercialTerms")} onFocus={() => setActiveField("commercialTerms")} />
        </label>

        {customVariables.length > 0 && (
          <div className="text-xs">
            <p className={label}>{t("settings.templateCustomVars")}</p>
            <p className="text-[10px] text-gray-500 mb-1">{t("settings.templateCustomVarsHint")}</p>
            <div className="flex flex-wrap gap-1">
              {customVariables.map((name) => <code key={name} className={`rounded px-2 py-0.5 text-[11px] ${tag}`}>{`{${name}}`}</code>)}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          {form.id ? (
            <button type="button" className={secondaryButton} onClick={resetForm} disabled={saving}><X size={13} />{t("settings.templateCancelEdit")}</button>
          ) : <span />}
          <button type="button" className={`${button} bg-indigo-600 text-white hover:bg-indigo-700`} onClick={save} disabled={saving}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {form.id ? t("settings.templateUpdate") : t("settings.templateSave")}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(deleting)}
        title={t("settings.templateDeleteTitle")}
        message={t("settings.templateDeleteMessage").replace("{name}", deleting?.name || "")}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("settings.templateDelete")}
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
        busy={deleteBusy}
      />
    </div>
  );
}
