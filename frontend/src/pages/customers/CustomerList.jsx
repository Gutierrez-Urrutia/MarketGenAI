/**
 * CustomerList — CRM-lite: list, create, import CSV, and delete customers.
 */
import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import toast from "react-hot-toast";
import { Plus, Upload, Trash2, Users, Search, Mail, Building2 } from "lucide-react";

import { customersApi } from "@/api/axios";
import Button from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import Modal from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";

// ── New customer form ────────────────────────────────────────────────────────
function NewCustomerModal({ open, onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", email: "", company: "", phone: "", notes: "" });
  const upd = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const createMut = useMutation({
    mutationFn: (data) => customersApi.create(data),
    onSuccess: () => {
      toast.success("Cliente añadido");
      qc.invalidateQueries({ queryKey: ["customers"] });
      setForm({ name: "", email: "", company: "", phone: "", notes: "" });
      onClose();
    },
    onError: () => toast.error("Error al crear el cliente"),
  });

  return (
    <Modal open={open} onClose={onClose} title="Nuevo cliente" maxWidth="lg">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Nombre completo *</label>
            <input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              value={form.name} onChange={upd("name")} placeholder="Ana García" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
            <input type="email" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              value={form.email} onChange={upd("email")} placeholder="ana@empresa.com" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Empresa</label>
            <input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              value={form.company} onChange={upd("company")} placeholder="Empresa S.A." />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Teléfono</label>
            <input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              value={form.phone} onChange={upd("phone")} placeholder="+34 600 000 000" />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Notas</label>
          <textarea rows={2} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-500"
            value={form.notes} onChange={upd("notes")} />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancelar</Button>
          <Button variant="primary" size="sm" isLoading={createMut.isPending}
            onClick={() => form.name && form.email && createMut.mutate(form)}>
            Añadir cliente
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function CustomerList() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [page, setPage] = useState(1);
  const limit = 20;
  const fileRef = useRef(null);

  const { data, isLoading } = useQuery({
    queryKey: ["customers", search, page],
    queryFn: () => customersApi.list({ search, limit, offset: (page - 1) * limit }).then((r) => r.data),
    keepPreviousData: true,
  });

  const customers = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / limit);

  const deleteMut = useMutation({
    mutationFn: (id) => customersApi.delete(id),
    onSuccess: () => { toast.success("Eliminado"); qc.invalidateQueries({ queryKey: ["customers"] }); setDeleting(null); },
    onError: () => toast.error("Error al eliminar"),
  });

  const importMut = useMutation({
    mutationFn: (file) => customersApi.import(file),
    onSuccess: (res) => {
      toast.success(`${res.data?.imported ?? 0} clientes importados`);
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: () => toast.error("Error al importar CSV"),
  });

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) importMut.mutate(file);
    e.target.value = "";
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Clientes</h1>
          <p className="text-sm text-gray-500 mt-0.5">{total.toLocaleString()} clientes en total</p>
        </div>
        <div className="flex gap-2">
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFileChange} />
          <Button variant="secondary" icon={<Upload size={15} />} isLoading={importMut.isPending}
            onClick={() => fileRef.current?.click()}>
            Importar CSV
          </Button>
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setShowNew(true)}>
            Añadir cliente
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative mb-5 max-w-sm">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          className="w-full pl-9 pr-4 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          placeholder="Buscar por nombre o empresa…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : customers.length === 0 ? (
        <div className="flex flex-col items-center py-20 text-gray-400">
          <Users size={40} className="mb-3 opacity-40" />
          <p className="text-sm">Sin clientes. Añade el primero o importa un CSV.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 font-semibold uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left">Nombre</th>
                <th className="px-4 py-3 text-left">Email</th>
                <th className="px-4 py-3 text-left">Empresa</th>
                <th className="px-4 py-3 text-left">Añadido</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {customers.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900">{c.name}</td>
                  <td className="px-4 py-3">
                    <a href={`mailto:${c.email}`} className="text-primary-600 hover:underline flex items-center gap-1">
                      <Mail size={12} />
                      {c.email}
                    </a>
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {c.company && (
                      <span className="flex items-center gap-1">
                        <Building2 size={12} className="text-gray-400" />
                        {c.company}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400">
                    {c.createdAt ? format(new Date(c.createdAt), "d MMM yyyy", { locale: es }) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => setDeleting(c)}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors">
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 bg-gray-50">
              <span className="text-xs text-gray-400">
                Mostrando {(page - 1) * limit + 1}–{Math.min(page * limit, total)} de {total}
              </span>
              <div className="flex gap-1">
                <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Anterior
                </Button>
                <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Siguiente
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <NewCustomerModal open={showNew} onClose={() => setShowNew(false)} />

      <Modal open={Boolean(deleting)} onClose={() => setDeleting(null)} title="Eliminar cliente">
        <p className="text-sm text-gray-600 mb-5">
          ¿Eliminar a <strong>{deleting?.name}</strong>? Esta acción no se puede deshacer.
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
