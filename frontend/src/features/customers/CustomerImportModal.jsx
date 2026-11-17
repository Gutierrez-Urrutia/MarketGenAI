/**
 * CustomerImportModal — importa clientes desde un CSV con las columnas
 * name, email, company, phone, notes, industry y size (RF-VTA-03).
 * Las filas inválidas se informan con su número y no detienen el resto.
 */
import { useRef, useState } from "react";

import { customersApi } from "@/api/customersApi";
import { Button, Modal } from "@/components/ui";
import { useI18n } from "@/hooks/useI18n";

export function CustomerImportModal({ open, onClose, onImported }) {
  const { t } = useI18n();
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const reset = () => { setFile(null); setResult(null); setError(""); };
  const close = () => { reset(); onClose(); };

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const { data } = await customersApi.importCsv(file);
      setResult(data);
      if (data?.imported > 0) onImported();
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : t("customersPage.importFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title={t("customersPage.importTitle")} maxWidth="lg">
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{t("customersPage.importHint")}</p>
        <code className="block rounded bg-slate-50 px-3 py-2 text-xs text-slate-700">name,email,company,phone,industry,size</code>

        <div className="flex items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            aria-label={t("customersPage.importChoose")}
            className="text-sm"
            onChange={(event) => { setFile(event.target.files?.[0] || null); setResult(null); setError(""); }}
          />
        </div>

        {error && <p className="text-sm text-red-500" role="alert">{error}</p>}

        {result && (
          <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm" data-testid="import-result">
            <p className="font-medium text-slate-900">{t("customersPage.importedCount").replace("{count}", String(result.imported ?? 0))}</p>
            {result.errors?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-amber-700">{t("customersPage.importErrors").replace("{count}", String(result.errors.length))}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-slate-600">
                  {result.errors.map((message) => <li key={message}>{message}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>{t("customersPage.close")}</Button>
          <Button onClick={upload} disabled={!file} loading={busy}>{t("customersPage.importAction")}</Button>
        </div>
      </div>
    </Modal>
  );
}
