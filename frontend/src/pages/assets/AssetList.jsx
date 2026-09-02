/**
 * AssetList — Sprint 4: Marketing assets hub.
 *
 * Allows users to:
 *   - View all generated assets (one-pagers, whitepapers, social posts, infographics)
 *   - Trigger generation from a selected book
 *   - Download ready assets
 *   - Delete assets
 */
import {
  getProposals,
  createProposal,
  updateProposal,
  deleteProposal,
} from "@/api/proposalsApi";
import { getTemplates } from "@/api/templatesApi";
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import toast from "react-hot-toast";
import {
  FileText, Download, Trash2, Wand2, Image, Share2,
  Layers, Search, ChevronDown, Loader2, Plus,
} from "lucide-react";

import { assetsApi, booksApi, proposalsApi } from "@/api/axios";
import { useJobPolling } from "@/hooks/useJobPolling";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import Modal from "@/components/ui/Modal";

const DELETED_ASSET_LIST_PROPOSALS_KEY = "marketgen_deleted_asset_list_proposal_ids";

const readDeletedAssetListProposalIds = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(DELETED_ASSET_LIST_PROPOSALS_KEY) || "[]");
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
};

const writeDeletedAssetListProposalIds = (ids) => {
  localStorage.setItem(DELETED_ASSET_LIST_PROPOSALS_KEY, JSON.stringify([...new Set(ids)]));
};

// ── Asset type config ─────────────────────────────────────────────────────────
const ASSET_TYPES = {
  proposal: {
  label: "Proposal",
  icon: FileText,
  color: "text-teal-500 bg-teal-50",
},
  one_pager:   { label: "One-Pager",      icon: FileText, color: "text-indigo-500 bg-indigo-50" },
  whitepaper:  { label: "White Paper",    icon: Layers,   color: "text-teal-500 bg-teal-50" },
  social_post: { label: "Social Posts",   icon: Share2,   color: "text-pink-500 bg-pink-50" },
  infographic: { label: "Infografía",     icon: Image,    color: "text-amber-500 bg-amber-50" },
};

// ── Generate modal ────────────────────────────────────────────────────────────
function GenerateModal({ open, onClose, onGenerated }) {
  const [selectedBook, setSelectedBook] = useState("");
  const [assetType, setAssetType] = useState("one_pager");
  const [jobId, setJobId] = useState(null);
  const [isStarting, setIsStarting] = useState(false);

  const { data: books = [] } = useQuery({
    queryKey: ["books-for-assets"],
    queryFn:  () => booksApi.list({ limit: 50 }).then((r) => r.data?.items ?? []),
    enabled:  open,
  });

  useJobPolling(jobId, {
    onProgress: () => {},
    onComplete: () => {
      setJobId(null);
      setIsStarting(false);
      toast.success("¡Asset generado!");
      onGenerated();
      onClose();
    },
    onError: (err) => {
      toast.error(`Error: ${err}`);
      setJobId(null);
      setIsStarting(false);
    },
  });

  const generate = async () => {
    if (!selectedBook) { toast.error("Selecciona un libro"); return; }
    setIsStarting(true);
    try {
      let res;
      const body = { bookId: selectedBook };
      switch (assetType) {
        case "one_pager":   res = await assetsApi.generateOnePager(selectedBook, body);   break;
        case "whitepaper":  res = await assetsApi.generateWhitepaper(selectedBook, body); break;
        case "social_post": res = await assetsApi.generateSocialPosts(selectedBook, body); break;
        case "infographic": res = await assetsApi.generateInfographic(selectedBook, body); break;
        case "proposal":
        res = await createProposal({
        title: "Nueva Proposal",
        description: "Creada desde Content Library",
        status: "draft",
            });
        break;
        default: return;
      }
      setJobId(res.data.job_id);
    } catch {
      toast.error("Error al iniciar la generación");
      setIsStarting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Generar nuevo asset">
      <div className="space-y-4">
        {/* Asset type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Tipo de asset</label>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(ASSET_TYPES).map(([key, cfg]) => {
              const Icon = cfg.icon;
              return (
                <button
                  key={key}
                  onClick={() => setAssetType(key)}
                  className={`flex items-center gap-2 p-3 rounded-xl border-2 text-sm font-medium transition-colors ${
                    assetType === key
                      ? "border-primary-500 bg-primary-50 text-primary-700"
                      : "border-gray-100 text-gray-600 hover:border-gray-200 hover:bg-gray-50"
                  }`}
                >
                  <Icon size={16} />
                  {cfg.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Book selector */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Libro fuente</label>
          <select
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            value={selectedBook}
            onChange={(e) => setSelectedBook(e.target.value)}
          >
            <option value="">Selecciona un libro…</option>
            {books.map((b) => (
              <option key={b.id} value={b.id}>{b.title}</option>
            ))}
          </select>
        </div>

        {/* Progress */}
        {jobId && (
          <div className="flex items-center gap-2 text-sm text-teal-600 bg-teal-50 rounded-lg p-3">
            <Loader2 size={14} className="animate-spin" />
            <span>Generando con IA… esto puede tardar un momento.</span>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isStarting}>
            Cancelar
          </Button>
          <Button
            variant="teal"
            size="sm"
            onClick={generate}
            isLoading={isStarting}
            icon={<Wand2 size={14} />}
          >
            Generar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Social posts preview modal ────────────────────────────────────────────────
function SocialPostsModal({ open, onClose, asset }) {
  const [downloading, setDownloading] = useState(false);
  if (!asset) return null;
  let parsed = asset.type === "social_post" ? [] : null;
  try { parsed = JSON.parse(asset.content || (asset.type === "social_post" ? "[]" : "{}")); } catch { /* ignore */ }
  const posts = Array.isArray(parsed) ? parsed : [];
  const infographic = asset.type === "infographic" && parsed && !Array.isArray(parsed) ? parsed : null;
  const canDownloadPdf = asset.downloadUrl || asset.mimeType === "application/pdf";

  const download = async () => {
    try {
      setDownloading(true);
      const res = await assetsApi.download(asset.id);
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${asset.type}-${asset.id}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error("Error al descargar");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={asset.type === "infographic" ? "Infografía generada" : "Social Posts generados"} maxWidth="lg">
      <div className="space-y-4">
        {asset.type === "infographic" && infographic ? (
          <>
            <div className="rounded-2xl border border-indigo-100 bg-indigo-50 p-5">
              {infographic.title && <p className="text-lg font-bold text-slate-950">{infographic.title}</p>}
              {infographic.subtitle && <p className="mt-1 text-sm text-slate-600">{infographic.subtitle}</p>}
            </div>
            {(infographic.sections || []).map((section, i) => (
              <div key={i} className="rounded-xl border border-gray-100 bg-white p-4">
                <div className="mb-2 flex items-start justify-between gap-3">
                  <p className="text-sm font-bold text-slate-900">{section.heading}</p>
                  {section.stat && <span className="shrink-0 text-lg font-black text-indigo-600">{section.stat}</span>}
                </div>
                {section.description && <p className="text-sm leading-6 text-slate-600">{section.description}</p>}
              </div>
            ))}
            {Array.isArray(infographic.keyPoints) && infographic.keyPoints.length > 0 && (
              <ul className="list-disc space-y-1 rounded-xl border border-gray-100 bg-gray-50 p-4 pl-8 text-sm text-slate-700">
                {infographic.keyPoints.map((point, i) => <li key={i}>{point}</li>)}
              </ul>
            )}
            {infographic.callToAction && (
              <p className="rounded-xl bg-indigo-600 px-4 py-3 text-sm font-bold text-white">{infographic.callToAction}</p>
            )}
            {canDownloadPdf && (
              <Button variant="secondary" size="sm" isLoading={downloading} onClick={download} icon={<Download size={13} />}>
                Descargar PDF
              </Button>
            )}
          </>
        ) : (
          posts.map((p, i) => (
            <div key={i} className="border border-gray-100 rounded-xl p-4 bg-gray-50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-gray-400">{p.platform}</span>
                <span className="text-xs text-gray-400">{p.characterCount} chars</span>
              </div>
              <p className="text-sm text-gray-800 whitespace-pre-wrap">{p.content}</p>
            </div>
          ))
        )}
        {!infographic && posts.length === 0 && <p className="text-sm text-gray-400 text-center py-8">Sin contenido disponible</p>}
      </div>
    </Modal>
  );
}

// ── Asset card ────────────────────────────────────────────────────────────────
function AssetCard({ asset, onDelete, onPreview }) {
  const cfg = ASSET_TYPES[asset.type] ?? ASSET_TYPES.one_pager;
  const Icon = cfg.icon;
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    try {
      setDownloading(true);
      const res = await assetsApi.download(asset.id);
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${asset.type}-${asset.id}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error("Error al descargar");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-5 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${cfg.color}`}>
          <Icon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900 truncate">{asset.title || cfg.label}</p>
          <p className="text-xs text-gray-400 mt-0.5">
            {asset.createdAt ? format(new Date(asset.createdAt), "d MMM yyyy", { locale: es }) : "—"}
          </p>
        </div>
        <Badge status={asset.status ?? "pending"} />
      </div>

      {asset.status === "ready" && (
        <div className="flex gap-2">
          {asset.type === "social_post" || asset.type === "infographic" ? (
            <Button variant="secondary" size="sm" className="flex-1" onClick={() => onPreview(asset)}>
              Ver contenido
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className="flex-1"
              isLoading={downloading}
              onClick={download}
              icon={<Download size={13} />}
            >
              Descargar
            </Button>
          )}
          {asset.type === "infographic" && (asset.downloadUrl || asset.mimeType === "application/pdf") ? (
            <Button
              variant="secondary"
              size="sm"
              isLoading={downloading}
              onClick={download}
              icon={<Download size={13} />}
            >
              PDF
            </Button>
          ) : null}
          <button
            onClick={() => onDelete(asset)}
            className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}

      {asset.status === "pending" || asset.status === "generating" ? (
        <div className="flex items-center gap-2 text-xs text-teal-600">
          <Loader2 size={12} className="animate-spin" />
          Generando…
        </div>
      ) : null}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function AssetList() {
  const qc = useQueryClient();
  const [typeFilter, setTypeFilter] = useState("");
  const [showGenerate, setShowGenerate] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [previewing, setPreviewing] = useState(null);
  const [contentTitle, setContentTitle] = useState("");
  const [contentDescription, setContentDescription] = useState("");
  const [templates, setTemplates] = useState([]);
  const [deletedProposalIds, setDeletedProposalIds] = useState(readDeletedAssetListProposalIds);

  const { data, isLoading } = useQuery({
    queryKey: ["assets", typeFilter],
    queryFn:  () => assetsApi.list({ asset_type: typeFilter || undefined, limit: 50 }).then((r) => r.data),
    refetchInterval: 5000, // auto-refresh to pick up status changes
  });

  const { data: proposalsData } = useQuery({
  queryKey: ["content-library-proposals"],
  queryFn: () => proposalsApi.list().then((r) => r.data),
  });

  useEffect(() => {
  const loadTemplates = async () => {
    try {
      const data = await getTemplates();
      setTemplates(data);
    } catch (error) {
      console.error(error);
    }
  };

  loadTemplates();
  }, []);

  const assets = data?.items ?? [];

  const proposals = (proposalsData ?? []).filter((proposal) => !deletedProposalIds.includes(proposal.id));

  const handleDeleteProposal = async (proposal) => {
  if (!window.confirm("Delete this asset from Content Library?")) return;
  setDeletedProposalIds((current) => {
    const next = [...new Set([...current, proposal.id])];
    writeDeletedAssetListProposalIds(next);
    return next;
  });
  qc.setQueryData(["content-library-proposals"], (current = []) =>
    Array.isArray(current) ? current.filter((item) => item.id !== proposal.id) : current,
  );
  toast.success("Asset deleted");

  try {
    await deleteProposal(proposal.id);
    qc.invalidateQueries({ queryKey: ["content-library-proposals"] });
  } catch (error) {
    console.warn("Backend delete failed; proposal remains deleted locally.", error);
  }
};

const handleEditProposal = async (proposal) => {
  const newTitle = prompt("Nuevo título:", proposal.title);
  const newDescription = prompt("Nueva descripción:", proposal.description || "");

  if (!newTitle) return;

  await updateProposal(proposal.id, {
    title: newTitle,
    description: newDescription,
    status: proposal.status || "draft",
  });

  qc.invalidateQueries({ queryKey: ["content-library-proposals"] });
};

  const deleteMut = useMutation({
    mutationFn: (id) => assetsApi.delete(id),
    onSuccess: () => { toast.success("Asset eliminado"); qc.invalidateQueries({ queryKey: ["assets"] }); setDeleting(null); },
    onError: () => toast.error("Error al eliminar"),
  });

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Marketing Assets</h1>
          <p className="text-sm text-gray-500 mt-0.5">One-pagers, whitepapers, social posts e infografías generados con IA</p>
        </div>
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => setShowGenerate(true)}>
          Generar asset
        </Button>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-5 flex-wrap">
        {[{ key: "", label: "Todos" }, ...Object.entries(ASSET_TYPES).map(([k, v]) => ({ key: k, label: v.label }))].map((t) => (
          <button
            key={t.key}
            onClick={() => setTypeFilter(t.key)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              typeFilter === t.key
                ? "bg-primary-600 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : assets.length === 0 ? (
        <div className="flex flex-col items-center py-20 text-gray-400">
          <Wand2 size={40} className="mb-3 opacity-40" />
          <p className="text-sm">Sin assets. Genera el primero con el botón de arriba.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {assets.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              onDelete={setDeleting}
              onPreview={setPreviewing}
            />
          ))}
          {proposals.map((proposal) => (
  <div
    key={proposal.id}
    className="bg-white rounded-2xl border border-gray-100 shadow-card p-5"
  >
    <div className="flex items-center justify-between mb-3">
      <span className="text-xs font-semibold px-2 py-1 rounded-full bg-teal-50 text-teal-600">
        Proposal
      </span>

      <span className="text-xs text-slate-400">
        {proposal.status || "draft"}
      </span>
    </div>

    <h3 className="text-lg font-semibold text-slate-900">
      {proposal.title}
    </h3>

    <p className="text-sm text-slate-500 mt-2">
      {proposal.description || "Sin descripción"}
    </p>

      <div className="flex justify-end mt-4">
        <button
          onClick={() => handleDeleteProposal(proposal)}
          className="text-xs px-3 py-1 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
        >
          Eliminar
        </button>
      </div>
      
    <div className="flex gap-2 mt-4">
  <button
    onClick={() => handleEditProposal(proposal)}
    className="text-xs px-2 py-1 rounded bg-slate-100 text-slate-600 hover:bg-slate-200"
  >
    Editar
  </button>

  <button
    onClick={() => handleDeleteProposal(proposal)}
    className="text-xs px-2 py-1 rounded bg-red-50 text-red-600 hover:bg-red-100"
  >
    Eliminar
  </button>
    </div>
  </div>
  ))}
    {templates.map((template) => (
  <div
    key={template.id}
    className="bg-white rounded-2xl border border-gray-100 shadow-card p-5"
    >
    <div className="flex items-center justify-between mb-3">
      <span className="text-xs font-semibold px-2 py-1 rounded-full bg-amber-50 text-amber-600">
        Template
      </span>

      <span className="text-xs text-slate-400">
        active
        </span>
      </div>

     <h3 className="text-lg font-semibold text-slate-900">
      {template.title}
      </h3>

        <p className="text-sm text-slate-500 mt-2">
        {template.description || "Sin descripción"}
       </p>
      </div>
      ))}
        </div>
      )}

      {/* Modals */}
      <GenerateModal
        open={showGenerate}
        onClose={() => setShowGenerate(false)}
        onGenerated={() => qc.invalidateQueries({ queryKey: ["assets"] })}
      />

      <SocialPostsModal
        open={Boolean(previewing && (previewing.type === "social_post" || previewing.type === "infographic"))}
        onClose={() => setPreviewing(null)}
        asset={previewing}
      />

      <Modal open={Boolean(deleting)} onClose={() => setDeleting(null)} title="Eliminar asset">
        <p className="text-sm text-gray-600 mb-5">
          ¿Eliminar <strong>{deleting?.title}</strong>? Esta acción no se puede deshacer.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => setDeleting(null)}>Cancelar</Button>
          <Button variant="destructive" size="sm" isLoading={deleteMut.isPending}
            onClick={() => deleteMut.mutate(deleting.id)}>
            Eliminar
          </Button>
        </div>
      </Modal>
    </div>
  );
}
