/**
 * ProposalList — list, create, download, and delete commercial proposals.
 */
import { useEffect, useState } from "react";
import { getProposals } from "../../api/proposalsApi";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import toast from "react-hot-toast";
import { Plus, Download, Trash2, FileText, Wand2, Search } from "lucide-react";

import { proposalsApi } from "@/api/axios";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import Modal from "@/components/ui/Modal";

// ── New proposal form (inside modal) ──────────────────────────────────────────
function NewProposalModal({ open, onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ title: "", clientName: "", description: "" });

  const createMut = useMutation({
    mutationFn: (data) => proposalsApi.create(data),
    onSuccess: () => {
      toast.success("Propuesta creada");
      qc.invalidateQueries({ queryKey: ["proposals"] });
      onClose();
    },
    onError: () => toast.error("Error al crear la propuesta"),
  });

  return (
    <Modal open={open} onClose={onClose} title="Nueva propuesta">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Título *</label>
          <input
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="Propuesta de marketing digital 2026"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Cliente *</label>
          <input
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            value={form.clientName}
            onChange={(e) => setForm({ ...form, clientName: e.target.value })}
            placeholder="Empresa cliente"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Descripción breve</label>
          <textarea
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            size="sm"
            isLoading={createMut.isPending}
            onClick={() => form.title && form.clientName && createMut.mutate(form)}
          >
            Crear propuesta
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ProposalList() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [downloading, setDownloading] = useState(null);
  const [backendProposals, setBackendProposals] = useState([]);

  useEffect(() => {
  const loadProposals = async () => {
    try {
      const data = await getProposals();
      console.log("Proposals:", data);
      setBackendProposals(data);
    } catch (error) {
      console.error(error);
      }
    };

  loadProposals();
  }, []);
  const { data: proposals = [], isLoading } = useQuery({
    queryKey: ["proposals", search],
    queryFn: () => proposalsApi.list({ search, limit: 50 }).then((r) => r.data?.items ?? []),
  });

  const deleteMut = useMutation({
    mutationFn: (id) => proposalsApi.delete(id),
    onSuccess: () => { toast.success("Eliminada"); qc.invalidateQueries({ queryKey: ["proposals"] }); setDeleting(null); },
    onError: () => toast.error("Error al eliminar"),
  });

  const download = async (id, format) => {
    try {
      setDownloading(id);
      const res = await proposalsApi.export(id, format);
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = `propuesta-${id}.${format}`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error("Error al descargar");
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Propuestas</h1>
          <p className="text-sm text-slate-500">
            Proposals conectadas desde backend: {backendProposals.length}
          </p>
          <p className="text-sm text-gray-500 mt-0.5">Crea y gestiona propuestas comerciales con IA</p>
        </div>
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => setShowNew(true)}>
          Nueva propuesta
        </Button>
      </div>

      {/* Search */}
      <div className="relative mb-5 max-w-sm">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          className="w-full pl-9 pr-4 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          placeholder="Buscar propuestas…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : proposals.length === 0 ? (
        <div className="flex flex-col items-center py-20 text-gray-400">
          <FileText size={40} className="mb-3 opacity-40" />
          <p className="text-sm">Sin propuestas. Crea la primera.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left">Título</th>
                <th className="px-4 py-3 text-left">Cliente</th>
                <th className="px-4 py-3 text-left">Estado</th>
                <th className="px-4 py-3 text-left">Actualizado</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {proposals.map((p) => (
                <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900 max-w-xs truncate">
                    <Link to={`/proposals/${p.id}`} className="hover:text-primary-600 transition-colors">
                      {p.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{p.clientName}</td>
                  <td className="px-4 py-3"><Badge status={p.status ?? "draft"} /></td>
                  <td className="px-4 py-3 text-gray-400">
                    {p.updatedAt ? format(new Date(p.updatedAt), "d MMM yyyy", { locale: es }) : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        title="Descargar PDF"
                        onClick={() => download(p.id, "pdf")}
                        disabled={downloading === p.id}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-primary-50 transition-colors disabled:opacity-40"
                      >
                        {downloading === p.id ? <Spinner size="xs" /> : <Download size={15} />}
                      </button>
                      <button
                        title="Eliminar"
                        onClick={() => setDeleting(p)}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* New modal */}
      <NewProposalModal open={showNew} onClose={() => setShowNew(false)} />

      {/* Delete confirmation */}
      <Modal open={Boolean(deleting)} onClose={() => setDeleting(null)} title="Eliminar propuesta">
        <p className="text-sm text-gray-600 mb-5">
          ¿Estás seguro de que deseas eliminar <strong>{deleting?.title}</strong>? Esta acción no se puede deshacer.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => setDeleting(null)}>Cancelar</Button>
          <Button
            variant="destructive"
            size="sm"
            isLoading={deleteMut.isPending}
            onClick={() => deleteMut.mutate(deleting.id)}
          >
            Eliminar
          </Button>
        </div>
      </Modal>
    </div>
  );
}
