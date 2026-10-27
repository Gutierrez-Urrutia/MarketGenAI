import { useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { CheckCircle2, ChevronLeft, GripVertical, Pencil, Plus, Trash2, Wand2 } from 'lucide-react'
import { v4 as uuidv4 } from 'uuid'
import toast from 'react-hot-toast'

import { booksApi } from '@/api/axios'
import Button from '@/components/ui/Button'
import JobProgressCard from '@/components/ui/JobProgressCard'

function ChapterRow({ chapter, index, onEdit, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: chapter.id })

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
      className="group flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <button
        {...attributes}
        {...listeners}
        className="mt-0.5 cursor-grab text-slate-300 hover:text-slate-500 active:cursor-grabbing"
        aria-label="Reordenar capitulo"
      >
        <GripVertical size={20} />
      </button>

      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-50 text-xs font-bold text-primary-600">
        {index + 1}
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-slate-900">{chapter.title}</p>
        {chapter.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{chapter.description}</p>
        )}
      </div>

      <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={() => onEdit(chapter)}
          className="rounded-lg p-1.5 text-slate-400 hover:bg-primary-50 hover:text-primary-600"
          aria-label="Editar capitulo"
        >
          <Pencil size={15} />
        </button>
        <button
          onClick={() => onDelete(chapter.id)}
          className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
          aria-label="Eliminar capitulo"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  )
}

function EditChapterModal({ chapter, onSave, onClose }) {
  const [title, setTitle] = useState(chapter?.title ?? '')
  const [description, setDescription] = useState(chapter?.description ?? '')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md space-y-4 rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="text-base font-semibold text-slate-900">Editar capitulo</h3>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Titulo</span>
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary-500"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Descripcion breve</span>
          <textarea
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary-500"
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => title.trim() && onSave({ ...chapter, title: title.trim(), description })}
          >
            Guardar
          </Button>
        </div>
      </div>
    </div>
  )
}

export default function BookChapters({
  bookId,
  chapters,
  onChaptersChange,
  onGenerate,
  onBack,
  isGenerating = false,
  progress = 0,
  job,
}) {
  const [editingChapter, setEditingChapter] = useState(null)

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return
    const oldIndex = chapters.findIndex((chapter) => chapter.id === active.id)
    const newIndex = chapters.findIndex((chapter) => chapter.id === over.id)
    onChaptersChange(
      arrayMove(chapters, oldIndex, newIndex).map((chapter, index) => ({
        ...chapter,
        orderIndex: index,
      })),
    )
  }

  const addChapter = async () => {
    const fallback = {
      id: uuidv4(),
      title: `Capitulo ${chapters.length + 1}`,
      description: '',
      orderIndex: chapters.length,
    }

    if (!bookId) {
      onChaptersChange([...chapters, fallback])
      setEditingChapter(fallback)
      return
    }

    try {
      const { data } = await booksApi.addChapter(bookId, {
        title: fallback.title,
        description: fallback.description,
      })
      onChaptersChange([...chapters, data])
      setEditingChapter(data)
    } catch {
      toast.error('No se pudo crear el capitulo')
    }
  }

  const deleteChapter = async (chapterId) => {
    try {
      if (bookId) await booksApi.deleteChapter(bookId, chapterId)
      onChaptersChange(
        chapters
          .filter((chapter) => chapter.id !== chapterId)
          .map((chapter, index) => ({ ...chapter, orderIndex: index })),
      )
    } catch {
      toast.error('No se pudo eliminar el capitulo')
    }
  }

  const saveChapter = async (updated) => {
    try {
      const saved = bookId
        ? (await booksApi.updateChapter(bookId, updated.id, {
            title: updated.title,
            description: updated.description,
          })).data
        : updated

      onChaptersChange(chapters.map((chapter) => (chapter.id === saved.id ? { ...chapter, ...saved } : chapter)))
      setEditingChapter(null)
    } catch {
      toast.error('No se pudo guardar el capitulo')
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">Estructura de capitulos</h3>
          <p className="mt-0.5 text-sm text-slate-500">Edita, agrega, elimina o reordena antes de generar contenido.</p>
        </div>
        <button
          onClick={addChapter}
          className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-primary-300 px-3 py-1.5 text-sm font-medium text-primary-600 transition-colors hover:bg-primary-50"
        >
          <Plus size={15} />
          Anadir capitulo
        </button>
      </div>

      {chapters.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-200 py-12 text-slate-400">
          <CheckCircle2 size={36} className="mb-2 opacity-40" />
          <p className="text-sm">Sin capitulos. Anade uno o vuelve al paso anterior.</p>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={chapters.map((chapter) => chapter.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {chapters.map((chapter, index) => (
                <ChapterRow
                  key={chapter.id}
                  chapter={chapter}
                  index={index}
                  onEdit={setEditingChapter}
                  onDelete={deleteChapter}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {isGenerating && (
        <JobProgressCard title="Generando contenido con IA" job={job} progress={progress} />
      )}

      <div className="flex items-center justify-between border-t border-slate-100 pt-2">
        <Button variant="ghost" size="md" onClick={onBack} icon={<ChevronLeft size={16} />} disabled={isGenerating}>
          Volver
        </Button>
        <Button
          variant="teal"
          size="lg"
          onClick={onGenerate}
          loading={isGenerating}
          disabled={chapters.length === 0 || isGenerating}
          icon={<Wand2 size={18} />}
        >
          {isGenerating ? 'Generando...' : 'Confirmar y generar contenido'}
        </Button>
      </div>

      {editingChapter && (
        <EditChapterModal
          chapter={editingChapter}
          onSave={saveChapter}
          onClose={() => setEditingChapter(null)}
        />
      )}
    </div>
  )
}
