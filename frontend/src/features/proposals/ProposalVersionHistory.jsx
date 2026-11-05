import { useCallback, useEffect, useState } from "react";
import { History, Loader2, RotateCcw, Save, X } from "lucide-react";
import {
  createProposalVersion,
  getProposalVersion,
  listProposalVersions,
  restoreProposalVersion,
} from "@/api/proposalsApi";
import { ProposalDocumentPreview } from "@/features/proposals/ProposalDocumentPreview";
import { useI18n } from "@/hooks/useI18n";

// RF-VTA-11: historial de versiones de una propuesta. Lista (versión, fecha, autor),
// vista previa de una versión anterior y restauración. Restaurar guarda antes el
// estado actual en el historial, así que siempre se puede deshacer.
const LOCALES = { es: "es-ES", pt: "pt-BR", en: "en-US" };

export function formatVersionDate(value, language) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(LOCALES[language] || LOCALES.en, { dateStyle: "medium", timeStyle: "short" });
}

export function ProposalVersionHistory({ proposal, onClose, onRestored }) {
  const { t, language } = useI18n();
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [loadingSelected, setLoadingSelected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const isSigned = proposal?.proposal_status === "firmada";

  const loadVersions = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await listProposalVersions(proposal.id);
      setVersions(data?.items || []);
    } catch (err) {
      console.error(err);
      setError(t("proposalVersions.errors.load"));
    } finally {
      setLoading(false);
    }
  }, [proposal.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadVersions();
  }, [loadVersions]);

  const errorFrom = (err, fallbackKey) => {
    const detail = err?.response?.data?.detail;
    return typeof detail === "string" && detail ? detail : t(fallbackKey);
  };

  const selectVersion = async (version) => {
    setError("");
    setLoadingSelected(true);
    setSelected({ ...version });
    try {
      const { data } = await getProposalVersion(proposal.id, version.id);
      setSelected(data);
    } catch (err) {
      console.error(err);
      setSelected(null);
      setError(t("proposalVersions.errors.load"));
    } finally {
      setLoadingSelected(false);
    }
  };

  const saveVersion = async () => {
    setError("");
    setBusy(true);
    try {
      await createProposalVersion(proposal.id);
      await loadVersions();
    } catch (err) {
      console.error(err);
      setError(errorFrom(err, "proposalVersions.errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!selected) return;
    if (!window.confirm(t("proposalVersions.confirmRestore").replace("{version}", selected.version))) return;
    setError("");
    setBusy(true);
    try {
      const { data } = await restoreProposalVersion(proposal.id, selected.id);
      onRestored?.(data);
      onClose?.();
    } catch (err) {
      console.error(err);
      setError(errorFrom(err, "proposalVersions.errors.restore"));
    } finally {
      setBusy(false);
    }
  };

  const sourceLabel = (source) => t(`proposalVersions.source.${source || "manual"}`);
  const previewProposal = selected && selected.content !== undefined
    ? {
        ...proposal,
        title: selected.title ?? proposal.title,
        content: selected.content ?? "",
        structuredContent: selected.structured_content ?? undefined,
        structured_content: selected.structured_content ?? undefined,
      }
    : null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-gray-900/50 p-4" data-testid="proposal-version-history">
      <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-slate-800">
        <div className="flex items-center justify-between gap-3 border-b border-gray-100 p-3 dark:border-white/10">
          <div className="flex items-center gap-2">
            <History size={16} className="text-slate-500" />
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">{t("proposalVersions.title")}</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={saveVersion}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-white/10 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              <Save size={13} /> {t("proposalVersions.saveVersion")}
            </button>
            <button type="button" onClick={onClose} aria-label={t("common.close")} className="rounded-lg p-1.5 hover:bg-gray-100 dark:hover:bg-slate-700">
              <X size={16} className="text-gray-400" />
            </button>
          </div>
        </div>

        {error && <p className="px-4 pt-3 text-xs text-rose-600 dark:text-rose-400" role="alert">{error}</p>}

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4 md:flex-row">
          <ul className="max-h-60 w-full shrink-0 space-y-2 overflow-y-auto md:max-h-none md:w-72" data-testid="version-list">
            {loading && (
              <li className="flex items-center gap-2 text-xs text-slate-500"><Loader2 size={14} className="animate-spin" /> {t("proposalVersions.loading")}</li>
            )}
            {!loading && versions.length === 0 && (
              <li className="text-xs text-slate-500">{t("proposalVersions.empty")}</li>
            )}
            {versions.map((version) => (
              <li key={version.id}>
                <button
                  type="button"
                  onClick={() => selectVersion(version)}
                  className={`w-full rounded-lg border p-3 text-left text-xs transition-colors ${
                    selected?.id === version.id
                      ? "border-teal-500 bg-teal-50 dark:bg-teal-500/10"
                      : "border-gray-200 hover:bg-gray-50 dark:border-white/10 dark:hover:bg-slate-700"
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-gray-900 dark:text-white">v{version.version} · {version.label}</span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-slate-700 dark:text-slate-300">{sourceLabel(version.source)}</span>
                  </span>
                  <span className="mt-1 block text-slate-500 dark:text-slate-400">{formatVersionDate(version.createdAt, language)}</span>
                  <span className="block text-slate-500 dark:text-slate-400">
                    {t("proposalVersions.by")} {version.authorName || version.authorEmail || t("proposalVersions.unknownAuthor")}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-gray-200 p-4 dark:border-white/10">
            {!selected && <p className="text-xs text-slate-500">{t("proposalVersions.selectHint")}</p>}
            {selected && loadingSelected && (
              <p className="flex items-center gap-2 text-xs text-slate-500"><Loader2 size={14} className="animate-spin" /> {t("proposalVersions.loading")}</p>
            )}
            {previewProposal && !loadingSelected && (
              <>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    v{selected.version} · {formatVersionDate(selected.createdAt, language)}
                  </p>
                  <button
                    type="button"
                    onClick={restore}
                    disabled={busy || isSigned}
                    title={isSigned ? t("proposalVersions.restoreBlockedSigned") : undefined}
                    className="inline-flex items-center gap-1 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RotateCcw size={13} /> {t("proposalVersions.restore")}
                  </button>
                </div>
                <ProposalDocumentPreview proposal={previewProposal} className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm" />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
