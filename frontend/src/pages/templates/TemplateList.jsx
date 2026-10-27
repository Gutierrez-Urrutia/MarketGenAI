/**
 * TemplateList — Sprint 6: manage reusable content templates.
 * Templates have a type (book_concept, chapter, proposal, social_post, one_pager)
 * and support {variable} placeholder substitution.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Plus, Pencil, Trash2, Copy, FileText, Search } from "lucide-react";

import { templatesApi } from "@/api/axios";
import Button from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import Modal from "@/components/ui/Modal";
import TagInput from "@/components/ui/TagInput";

const TYPE_LABELS = {
  book_concept: "Concepto de libro",
  chapter:      "Capítulo",
  proposal:     "Propuesta",
  social_post:  "Post social",
  one_pager:    "One-Pager",
};

// ── Template form (create / edit) ─────────────────────────────────────────────
function TemplateFormModal({ open, onClose, template }) {
  const qc = useQueryClient();
  const isEditing = Boolean(template);
  const [form, setForm] = useState(() => template ?? {
    name: "", type: "chapter", description: "", content: "", variables: [], isPublic: false,
  });

  const upd = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const saveMut = useMutation({
    mutationFn: (data) => isEditing
      ? templatesApi.update(template.id, data)
      : templatesApi.create(data),
    onSuccess: () => {
      toast.success(isEditing ? "Plantilla actualizada" : "Plantilla creada");
      qc.invalidateQueries({ queryKey: ["templates"] });
      onClose();
    },
    onError: () => toast.error("Error al guardar la plantilla"),
  });

  return (
    <Modal open={open} onClose={onClose} title={isEditing ? "Editar plantilla" : "Nueva plantilla"} maxWidth="2xl">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Nombre *</label>
            <input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              value={form.name} onChange={upd("name")} placeholder="Mi plantilla de propuesta" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Tipo *</label>
            <select className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              value={form.type} onChange={upd("type")}>
              {Object.entries(TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Descripción</label>
          <input className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            value={form.description || ""} onChange={upd("description")} />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Variables disponibles
            <span className="ml-1 text-gray-400 font-normal">(se pueden usar como {"{variable}"} en el contenido)</span>
          </label>
          <TagInput
            value={form.variables || []}
            onChange={(v) => setForm({ ...form, variables: v })}
            placeholder="client_name, product, date…"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Contenido de la plantilla *
            <span className="ml-1 text-gray-400 font-normal">Usa {"{variable}"} para las partes dinámicas</span>
          </label>
          <textarea
            rows={10}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500 resize-y"
            value={form.content}
            onChange={upd("content")}
            placeholder={"Hola {client_name},\n\nAdjunto la propuesta para {product}…"}
          />
        </div>

        <div className="flex items-center gap-2">
          <input type="checkbox" id="isPublic" checked={form.isPublic}
            onChange={(e) => setForm({ ...form, isPublic: e.target.checked })}
            className="rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
          <label htmlFor="isPublic" className="text-sm text-gray-600">
            Compartir con todos los usuarios de la organización
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancelar</Button>
          <Button variant="primary" size="sm" isLoading={saveMut.isPending}
            onClick={() => form.name && form.content && saveMut.mutate(form)}>
            {isEditing ? "Guardar cambios" : "Crear plantilla"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function TemplateList() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ["templates", search, typeFilter],
    queryFn: () => templatesApi.list({
      search: search || undefined,
      type:   typeFilter || undefined,
      limit:  50,
    }).then((r) => r.data),
  });

  const templates = data?.items ?? [];

  const deleteMut = useMutation({
    mutationFn: (id) => templatesApi.delete(id),
    onSuccess: () => { toast.success("Eliminada"); qc.invalidateQueries({ queryKey: ["templates"] }); setDeleting(null); },
    onError: () => toast.error("Error al eliminar"),
  });

  const duplicate = async (t) => {
    try {
      await templatesApi.create({ ...t, name: `${t.name} (copia)`, id: undefined, isPublic: false });
      toast.success("Plantilla duplicada");
      qc.invalidateQueries({ queryKey: ["templates"] });
    } catch {
      toast.error("Error al duplicar");
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Plantillas</h1>
          <p className="text-sm text-gray-500 mt-0.5">Plantillas reutilizables para propuestas, capítulos y más</p>
        </div>
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => { setEditing(null); setShowForm(true); }}>
          Nueva plantilla
        </Button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            className="pl-8 pr-4 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 w-48"
            placeholder="Buscar…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          className="border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-600 focus:outline-none focus:ring-2 focus:ring-primary-500"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="">Todos los tipos</option>
          {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {/* Template grid */}
      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : templates.length === 0 ? (
        <div className="flex flex-col items-center py-20 text-gray-400">
          <FileText size={40} className="mb-3 opacity-40" />
          <p className="text-sm">Sin plantillas. Crea la primera.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((t) => (
            <div key={t.id} className="bg-white rounded-2xl border border-gray-100 shadow-card p-5 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-gray-900">{t.name}</p>
                  <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 text-xs">
                    {TYPE_LABELS[t.type] ?? t.type}
                  </span>
                </div>
                {t.isPublic && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-600 flex-shrink-0">
                    Pública
                  </span>
                )}
              </div>
              {t.description && <p className="text-xs text-gray-500 line-clamp-2">{t.description}</p>}
              {t.variables?.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {t.variables.map((v) => (
                    <code key={v} className="text-xs bg-primary-50 text-primary-600 px-1.5 py-0.5 rounded">{`{${v}}`}</code>
                  ))}
                </div>
              )}
              <div className="flex items-center justify-between text-xs text-gray-400 border-t border-gray-50 pt-2">
                <span>{t.usageCount ?? 0} usos</span>
                <div className="flex gap-1">
                  <button onClick={() => duplicate(t)} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors" title="Duplicar">
                    <Copy size={13} />
                  </button>
                  <button onClick={() => { setEditing(t); setShowForm(true); }} className="p-1.5 rounded hover:bg-primary-50 text-gray-400 hover:text-primary-600 transition-colors" title="Editar">
                    <Pencil size={13} />
                  </button>
                  <button onClick={() => setDeleting(t)} className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-600 transition-colors" title="Eliminar">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Form modal */}
      {showForm && (
        <TemplateFormModal
          open={showForm}
          onClose={() => { setShowForm(false); setEditing(null); }}
          template={editing}
        />
      )}

      {/* Delete confirmation */}
      <Modal open={Boolean(deleting)} onClose={() => setDeleting(null)} title="Eliminar plantilla">
        <p className="text-sm text-gray-600 mb-5">
          ¿Eliminar la plantilla <strong>{deleting?.name}</strong>? Esta acción no se puede deshacer.
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
