/**
 * KnowledgeBaseTab — RF-VTA-01: the company loads its historical proposals
 * (PDF, Word, CSV, Excel) that the AI uses as RAG context when generating
 * new proposals. Mounted by Dashboard.jsx's Settings page ("knowledge" tab).
 */
import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { FileText, FileSpreadsheet, Trash2, UploadCloud, Loader2 } from "lucide-react";

import { knowledgeApi } from "@/api/axios";
import { useI18n } from "@/hooks/useI18n";

const ACCEPT = ".pdf,.docx,.csv,.xlsx,.txt,.md";
const SPREADSHEET_TYPES = new Set(["csv", "xlsx"]);

function getApiErrorMessage(error, fallback) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (detail?.failed?.length) return detail.failed.map((f) => `${f.filename}: ${f.error}`).join(" · ");
  return error?.message || fallback;
}

const formatSize = (bytes = 0) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export default function KnowledgeBaseTab({ isDark }) {
  const { t } = useI18n();
  const inputRef = useRef(null);
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [service, setService] = useState("");
  const [client, setClient] = useState("");

  const load = async () => {
    try {
      const { data } = await knowledgeApi.list();
      setDocs(data.items || []);
    } catch (error) {
      toast.error(getApiErrorMessage(error, "Error"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const upload = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setUploading(true);
    try {
      const { data } = await knowledgeApi.upload(files, { service: service.trim(), client: client.trim() });
      if (data.uploaded.length) toast.success(`${data.uploaded.length} ${t("settings.kbUploaded")}`);
      data.failed.forEach((f) => toast.error(`${f.filename}: ${f.error}`));
      await load();
    } catch (error) {
      if (error?.response?.status === 403) toast.error(t("settings.kbManagerOnly"));
      else toast.error(getApiErrorMessage(error, "Error"));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = async (doc) => {
    if (!window.confirm(`${t("settings.kbConfirmDelete")}\n${doc.title}`)) return;
    try {
      await knowledgeApi.remove(doc.id);
      setDocs((prev) => prev.filter((d) => d.id !== doc.id));
    } catch (error) {
      if (error?.response?.status === 403) toast.error(t("settings.kbManagerOnly"));
      else toast.error(getApiErrorMessage(error, "Error"));
    }
  };

  const card = isDark ? "bg-slate-800 border-white/10 text-slate-100" : "bg-white border-gray-100 text-gray-900";
  const input = `w-full border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
    isDark ? "bg-slate-900 border-white/10 text-slate-100" : "border-gray-300"
  }`;

  return (
    <div className={`rounded-2xl border shadow-sm p-4 space-y-3 ${card}`}>
      <div>
        <h2 className="text-sm font-semibold">{t("settings.kbTitle")}</h2>
        <p className="text-xs text-gray-500">{t("settings.kbDescription")}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input className={input} placeholder={t("settings.kbService")} value={service} onChange={(e) => setService(e.target.value)} />
        <input className={input} placeholder={t("settings.kbClient")} value={client} onChange={(e) => setClient(e.target.value)} />
      </div>

      <label
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); upload(e.dataTransfer.files); }}
        className="flex flex-col items-center gap-1 border-2 border-dashed border-indigo-300 rounded-xl p-5 cursor-pointer hover:bg-indigo-50/40 text-xs text-gray-500"
      >
        {uploading ? <Loader2 size={20} className="animate-spin" /> : <UploadCloud size={20} />}
        <span>{t("settings.kbDrop")}</span>
        <span className="text-[10px]">PDF · DOCX · CSV · XLSX · TXT · MD (≤ 10 MB)</span>
        <input ref={inputRef} type="file" multiple accept={ACCEPT} className="hidden" disabled={uploading}
               onChange={(e) => upload(e.target.files)} />
      </label>

      {loading ? (
        <Loader2 size={16} className="animate-spin text-gray-400" />
      ) : docs.length === 0 ? (
        <p className="text-xs text-gray-500">{t("settings.kbEmpty")}</p>
      ) : (
        <ul className="divide-y divide-gray-100/20">
          {docs.map((doc) => {
            const Icon = SPREADSHEET_TYPES.has(doc.fileType) ? FileSpreadsheet : FileText;
            return (
              <li key={doc.id} className="flex items-center gap-2 py-2 text-xs">
                <Icon size={16} className="text-indigo-500 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{doc.title}</div>
                  <div className="text-[10px] text-gray-500 truncate">
                    {[doc.fileType?.toUpperCase(), formatSize(doc.sizeBytes), `${t("settings.kbChunks")}: ${doc.chunkCount}`, doc.service, doc.client]
                      .filter(Boolean).join(" · ")}
                  </div>
                </div>
                <button onClick={() => remove(doc)} className="p-1 text-gray-400 hover:text-red-600" aria-label="delete">
                  <Trash2 size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
