/**
 * SalesEnablementPage — RF-VTA-08: borradores de casos de éxito, comparativas y respuestas a
 * objeciones, generados solo a partir de los documentos que el usuario cargó. Los borradores
 * se guardan y se editan como texto plano.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Loader2 } from "lucide-react";

import { enablementApi, opportunitiesApi } from "@/api/axios";
import { Btn, Card } from "@/components/dashboard/ui";
import { downloadBlob, sanitizeDownloadName } from "@/features/proposals/proposalExport";
import { useI18n } from "@/hooks/useI18n";

const TYPES = ["case_study", "comparison", "objection"];
const LANGUAGES = [["es", "Español"], ["en", "English"], ["pt", "Português"]];
const PLACEHOLDER = /\[COMPLETAR:[^\]]*\]/g;

const fieldClass = "w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500";

export const countPending = (text) => (String(text || "").match(PLACEHOLDER) || []).length;

function errorMessage(error, fallback) {
  const detail = error?.response?.data?.detail;
  return typeof detail === "string" && detail.trim() ? detail : fallback;
}

export function SalesEnablementPage() {
  const { t, language } = useI18n();
  const tRef = useRef(t); // useI18n devuelve un t nuevo en cada render: no debe disparar la recarga
  tRef.current = t;
  const [drafts, setDrafts] = useState([]);
  const [opportunities, setOpportunities] = useState([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [editText, setEditText] = useState("");
  const [form, setForm] = useState({ type: "case_study", topic: "", clientName: "", opportunityId: "", instructions: "", language: language || "es" });

  const selected = useMemo(() => drafts.find((d) => d.id === selectedId) || null, [drafts, selectedId]);
  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  const load = useCallback(async () => {
    try {
      const { data } = await enablementApi.list(filter || undefined);
      setDrafts(Array.isArray(data) ? data : []);
    } catch (error) {
      toast.error(errorMessage(error, tRef.current("enablement.err")));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    opportunitiesApi.list().then(({ data }) => {
      const items = Array.isArray(data) ? data : data?.items || [];
      setOpportunities(items);
    }).catch(() => setOpportunities([]));
  }, []);

  useEffect(() => { setEditText(selected?.content || ""); }, [selected?.id, selected?.updatedAt]);

  const generate = async (event) => {
    event.preventDefault();
    if (form.topic.trim().length < 3) return;
    setGenerating(true);
    try {
      const payload = {
        type: form.type,
        topic: form.topic.trim(),
        language: form.language,
        ...(form.clientName.trim() && { clientName: form.clientName.trim() }),
        ...(form.opportunityId && { opportunityId: form.opportunityId }),
        ...(form.instructions.trim() && { instructions: form.instructions.trim() }),
      };
      const { data } = await enablementApi.generate(payload);
      setDrafts((prev) => [data, ...prev.filter((d) => d.id !== data.id)]);
      setSelectedId(data.id);
    } catch (error) {
      const noSources = error?.response?.status === 422 && typeof error.response.data?.detail === "string";
      toast.error(noSources ? t("enablement.noSources") : errorMessage(error, t("enablement.err")));
    } finally {
      setGenerating(false);
    }
  };

  const save = async () => {
    if (!selected || !editText.trim()) return;
    setSaving(true);
    try {
      const { data } = await enablementApi.update(selected.id, { content: editText });
      setDrafts((prev) => prev.map((d) => (d.id === data.id ? data : d)));
      toast.success(t("enablement.saved"));
    } catch (error) {
      toast.error(errorMessage(error, t("enablement.err")));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (draft) => {
    if (!window.confirm(`${t("enablement.confirm")}\n${draft.title}`)) return;
    try {
      await enablementApi.remove(draft.id);
      setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
      if (selectedId === draft.id) setSelectedId(null);
    } catch (error) {
      toast.error(errorMessage(error, t("enablement.err")));
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(editText);
      toast.success(t("enablement.copied"));
    } catch {
      toast.error(t("enablement.err"));
    }
  };

  const download = async () => {
    try {
      const { data } = await enablementApi.exportDocx(selected.id, editText);
      downloadBlob(data, `${sanitizeDownloadName(selected.title)}.docx`);
    } catch {
      toast.error(t("enablement.err"));
    }
  };

  const pending = countPending(editText);
  const dirty = selected && editText !== selected.content;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-slate-900">{t("enablement.title")}</h1>
        <p className="text-sm text-slate-500">{t("enablement.sub")}</p>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <Card className="p-5">
          <form onSubmit={generate} className="space-y-3">
            <div role="radiogroup" aria-label={t("enablement.title")} className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-white/10">
              {TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  role="radio"
                  aria-checked={form.type === type}
                  onClick={() => setForm((prev) => ({ ...prev, type }))}
                  className={`rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${form.type === type ? "bg-white text-brand-700 shadow-sm dark:bg-brand-600 dark:text-white" : "text-slate-500 hover:text-slate-700 dark:text-slate-300 dark:hover:text-white"}`}
                >
                  {t(`enablement.types.${type}`)}
                </button>
              ))}
            </div>

            <label className="block text-xs font-medium text-slate-600">
              {t(`enablement.topic.${form.type}`)}
              <textarea
                rows={form.type === "objection" ? 3 : 2}
                maxLength={500}
                required
                className={`${fieldClass} mt-1`}
                placeholder={t(`enablement.ph.${form.type}`)}
                value={form.topic}
                onChange={set("topic")}
              />
            </label>

            <label className="block text-xs font-medium text-slate-600">
              {t("enablement.opp")}
              <select className={`${fieldClass} mt-1`} value={form.opportunityId} onChange={set("opportunityId")}>
                <option value="">{t("enablement.noOpp")}</option>
                {opportunities.map((o) => <option key={o.id} value={o.id}>{o.company}{o.job ? ` — ${o.job}` : ""}</option>)}
              </select>
            </label>

            <label className="block text-xs font-medium text-slate-600">
              {t("enablement.client")}
              <input className={`${fieldClass} mt-1`} maxLength={200} value={form.clientName} onChange={set("clientName")} />
            </label>

            <label className="block text-xs font-medium text-slate-600">
              {t("enablement.instr")}
              <textarea rows={2} maxLength={1000} className={`${fieldClass} mt-1`} value={form.instructions} onChange={set("instructions")} />
            </label>

            <label className="block text-xs font-medium text-slate-600">
              {t("enablement.lang")}
              <select className={`${fieldClass} mt-1`} value={form.language} onChange={set("language")}>
                {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </label>

            <Btn type="submit" disabled={generating || form.topic.trim().length < 3} className="w-full justify-center disabled:opacity-60">
              {generating && <Loader2 size={14} className="animate-spin" />}
              {generating ? t("enablement.gening") : t("enablement.gen")}
            </Btn>
          </form>
        </Card>

        <div className="space-y-5">
          {selected && (
            <Card className="space-y-3 p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700 dark:bg-brand-500/20 dark:text-brand-200">{t(`enablement.types.${selected.type}`)}</span>
                  <h2 className="mt-1 truncate text-base font-semibold text-slate-900">{selected.title}</h2>
                </div>
                <div className="flex gap-2">
                  <Btn variant="secondary" small onClick={copy}>{t("enablement.copy")}</Btn>
                  <Btn variant="secondary" small onClick={() => remove(selected)}>{t("enablement.delete")}</Btn>
                </div>
              </div>

              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">{t("enablement.warn")}</p>

              <textarea
                aria-label={t("enablement.edit")}
                rows={16}
                className={`${fieldClass} font-mono leading-relaxed`}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
              />

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-slate-500">
                  {pending > 0 && <span className="mr-3 font-medium text-amber-700 dark:text-amber-300">{t("enablement.pending")}: {pending}</span>}
                  {selected.sources?.length > 0 && (
                    <span>{t("enablement.sources")}: {selected.sources.map((s) => s.title).join(" · ")}</span>
                  )}
                </div>
                <Btn onClick={save} disabled={!dirty || saving || !editText.trim()} className="disabled:opacity-60">
                  {saving && <Loader2 size={14} className="animate-spin" />}
                  {t("enablement.save")}
                </Btn>
              </div>
            </Card>
          )}

          <Card className="p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-900">{t("enablement.drafts")}</h2>
              <select aria-label={t("enablement.filterAll")} className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700" value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="">{t("enablement.filterAll")}</option>
                {TYPES.map((type) => <option key={type} value={type}>{t(`enablement.types.${type}`)}</option>)}
              </select>
            </div>
            {loading ? (
              <Loader2 size={16} className="animate-spin text-slate-400" />
            ) : drafts.length === 0 ? (
              <p className="text-xs text-slate-500">{t("enablement.empty")}</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {drafts.map((draft) => (
                  <li key={draft.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(draft.id)}
                      className={`flex w-full items-center gap-3 px-2 py-2.5 text-left text-xs transition-colors hover:bg-slate-50 ${draft.id === selectedId ? "bg-brand-50 dark:bg-brand-500/15" : ""}`}
                    >
                      <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-white/10 dark:text-slate-300">{t(`enablement.types.${draft.type}`)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-slate-900">{draft.title}</span>
                        <span className="block truncate text-slate-500">{[draft.clientName, draft.topic].filter(Boolean).join(" · ")}</span>
                      </span>
                      <span className="shrink-0 text-slate-400">{draft.createdAt ? new Date(draft.createdAt).toLocaleDateString() : ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
