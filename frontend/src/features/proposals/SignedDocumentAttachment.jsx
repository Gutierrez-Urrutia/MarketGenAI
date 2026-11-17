import { useRef, useState } from "react";
import { FileCheck2, Loader2, UploadCloud } from "lucide-react";
import { getSignedDocumentLink, removeSignedDocument, uploadSignedDocument } from "@/api/proposalsApi";
import { useI18n } from "@/hooks/useI18n";

// RF-VTA-06 (etapa diferida): adjuntar el documento firmado a la propuesta, sin
// proveedor de e-signature. Se puede subir o reemplazar en cualquier estado,
// incluida `firmada` — el único lugar que exige que ya exista un adjunto es la
// transición a `firmada` en el backend. Quitar sin reemplazo (sin subir uno
// nuevo) no se permite una vez firmada: dejaría la propuesta firmada sin el
// documento que sustenta ese estado (el backend también lo bloquea con 409).
export function SignedDocumentAttachment({ proposal, onChange }) {
  const { t } = useI18n();
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // La URL del archivo no viaja con la propuesta (abriría el documento sin sesión): solo la bandera.
  const hasDocument = Boolean(proposal?.hasSignedDocument);
  const documentName = proposal?.signedDocumentName;
  const canRemove = proposal?.proposal_status !== "firmada";

  const pickFile = () => inputRef.current?.click();

  const handleFile = async (files) => {
    const file = files?.[0];
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      const { data } = await uploadSignedDocument(proposal.id, file);
      onChange?.(data);
    } catch (err) {
      console.error(err);
      const detail = err?.response?.data?.detail;
      setError(typeof detail === "string" && detail ? detail : t("signedDocument.errors.generic"));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleView = async () => {
    setError("");
    try {
      const { data } = await getSignedDocumentLink(proposal.id);
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      console.error(err);
      setError(t("signedDocument.errors.generic"));
    }
  };

  const handleRemove = async () => {
    setError("");
    setBusy(true);
    try {
      const { data } = await removeSignedDocument(proposal.id);
      onChange?.(data);
    } catch (err) {
      console.error(err);
      setError(t("signedDocument.errors.generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" data-testid="signed-document-attachment">
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,application/pdf"
        className="hidden"
        disabled={busy}
        onChange={(event) => handleFile(event.target.files)}
      />

      {hasDocument ? (
        <>
          <button
            type="button"
            onClick={handleView}
            className="inline-flex items-center gap-1 text-emerald-700 hover:underline dark:text-emerald-400"
          >
            <FileCheck2 size={14} />
            <span className="truncate max-w-[12rem]">{documentName || t("signedDocument.view")}</span>
          </button>
          <button
            type="button"
            onClick={pickFile}
            disabled={busy}
            className="text-slate-500 hover:underline disabled:cursor-wait disabled:opacity-60 dark:text-slate-400"
          >
            {busy ? t("signedDocument.uploading") : t("signedDocument.replace")}
          </button>
          {canRemove && (
            <button
              type="button"
              onClick={handleRemove}
              disabled={busy}
              className="text-rose-600 hover:underline disabled:cursor-wait disabled:opacity-60 dark:text-rose-400"
            >
              {t("signedDocument.remove")}
            </button>
          )}
        </>
      ) : (
        <button
          type="button"
          onClick={pickFile}
          disabled={busy}
          className="inline-flex items-center gap-1 text-slate-500 hover:underline disabled:cursor-wait disabled:opacity-60 dark:text-slate-400"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <UploadCloud size={14} />}
          {busy ? t("signedDocument.uploading") : t("signedDocument.upload")}
        </button>
      )}

      {error && <span className="text-rose-600 dark:text-rose-400">{error}</span>}
    </div>
  );
}
