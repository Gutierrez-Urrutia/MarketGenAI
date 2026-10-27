/**
 * Book Concepts list page — /books
 */
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Pencil, Trash2, Search, Send } from 'lucide-react'
import toast from 'react-hot-toast'

import { booksApi, publishingApi } from '@/api/axios'
import { useJobPolling } from '@/hooks/useJobPolling'
import { Button }   from '@/components/ui/Button'
import { Badge }    from '@/components/ui/Badge'
import { Spinner }  from '@/components/ui/Spinner'
import { Card }     from '@/components/ui/Card'
import PublishModal from './PublishModal'

const STATUS_OPTIONS = ['', 'draft', 'outlined', 'generated', 'published']

export default function BookList() {
  const navigate     = useNavigate()
  const queryClient  = useQueryClient()
  const [search,  setSearch]  = useState('')
  const [status,  setStatus]  = useState('')
  const [page,    setPage]    = useState(1)
  const [toDelete, setToDelete] = useState(null)
  const [toPublish, setToPublish] = useState(null)
  const [publishJobId, setPublishJobId] = useState(null)

  const { data, isLoading } = useQuery({
    queryKey: ['books', { search, status, page }],
    queryFn:  () => booksApi.list({ search, status, page, limit: 20 }).then(r => r.data),
    keepPreviousData: true,
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => booksApi.delete(id),
    onSuccess:  () => {
      toast.success('Book concept eliminado.')
      queryClient.invalidateQueries({ queryKey: ['books'] })
      setToDelete(null)
    },
    onError: () => toast.error('Error al eliminar el book concept.'),
  })

  const publishMutation = useMutation({
    mutationFn: ({ bookId, payload }) => publishingApi.publish(bookId, payload),
    onSuccess: (response) => {
      setPublishJobId(response.data.job_id)
      toast.success('Publicacion enviada al worker.')
      setToPublish(null)
    },
    onError: (err) => {
      toast.error(err?.response?.data?.detail ?? 'Error al iniciar la publicacion.')
    },
  })

  useJobPolling(publishJobId, {
    onComplete: () => {
      setPublishJobId(null)
      queryClient.invalidateQueries({ queryKey: ['books'] })
      queryClient.invalidateQueries({ queryKey: ['publish-status'] })
      toast.success('Publicacion multicanal completada.')
    },
    onError: (err) => {
      setPublishJobId(null)
      toast.error(`Publicacion fallida: ${err}`)
    },
  })

  const books = data?.data || []
  const total = data?.total || 0

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Book Concepts</h1>
          <p className="text-slate-500 text-sm">{total} concepto{total !== 1 ? 's' : ''}</p>
        </div>
        <Button icon={<Plus size={16} />} onClick={() => navigate('/books/new')}>
          Nuevo Book
        </Button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 max-w-xs">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            placeholder="Buscar por título..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <select
          value={status}
          onChange={e => { setStatus(e.target.value); setPage(1) }}
          className="px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          <option value="">Todos los estados</option>
          {STATUS_OPTIONS.slice(1).map(s => (
            <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <Card className="p-0 overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : books.length === 0 ? (
          <div className="text-center py-16 text-slate-400">
            <p className="text-lg">No hay book concepts todavía.</p>
            <Link to="/books/new" className="mt-2 inline-block text-primary-600 text-sm hover:underline">
              Crear el primero →
            </Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Título</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Estado</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600 hidden md:table-cell">Capítulos</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600 hidden md:table-cell">Modificado</th>
                <th className="text-right px-4 py-3 font-medium text-slate-600">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {books.map(book => (
                <tr key={book.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-3">
                    <Link to={`/books/${book.id}`} className="font-medium text-slate-900 hover:text-primary-600">
                      {book.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Badge status={book.status} />
                  </td>
                  <td className="px-4 py-3 text-slate-500 hidden md:table-cell">
                    {book.chapterCount ?? 0}
                  </td>
                  <td className="px-4 py-3 text-slate-500 hidden md:table-cell">
                    {new Date(book.updatedAt?._seconds * 1000 || book.updatedAt).toLocaleDateString('es-ES')}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => navigate(`/books/${book.id}`)}
                        className="p-1.5 rounded-md text-slate-400 hover:text-primary-600 hover:bg-primary-50"
                        title="Editar"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        onClick={() => setToPublish(book)}
                        disabled={!['generated', 'published'].includes(book.status)}
                        className="p-1.5 rounded-md text-slate-400 hover:text-teal-600 hover:bg-teal-50 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                        title="Publicar"
                      >
                        <Send size={15} />
                      </button>
                      <button
                        onClick={() => setToDelete(book)}
                        className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50"
                        title="Eliminar"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Delete modal */}
      {toDelete && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full">
            <h3 className="text-base font-semibold text-slate-900 mb-2">Eliminar book concept</h3>
            <p className="text-sm text-slate-600 mb-6">
              ¿Estás seguro de que deseas eliminar <strong>{toDelete.title}</strong>? Esta acción no se puede deshacer.
            </p>
            <div className="flex gap-3 justify-end">
              <Button variant="secondary" onClick={() => setToDelete(null)}>Cancelar</Button>
              <Button
                variant="destructive"
                loading={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate(toDelete.id)}
              >
                Eliminar
              </Button>
            </div>
          </div>
        </div>
      )}

      <PublishModal
        book={toPublish}
        open={Boolean(toPublish)}
        onClose={() => setToPublish(null)}
        isPublishing={publishMutation.isPending}
        onPublish={(payload) => publishMutation.mutate({ bookId: toPublish.id, payload })}
      />
    </div>
  )
}
