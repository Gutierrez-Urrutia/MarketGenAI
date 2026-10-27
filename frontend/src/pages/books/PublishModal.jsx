import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CalendarClock,
  Check,
  Download,
  FileText,
  Globe2,
  Linkedin,
  Radio,
  Send,
} from 'lucide-react'

import { publishingApi } from '@/api/axios'
import Button from '@/components/ui/Button'
import Modal from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'

const CHANNELS = [
  { id: 'linkedin', label: 'LinkedIn', type: 'Social', icon: Linkedin },
  { id: 'medium', label: 'Medium', type: 'CMS', icon: FileText },
  { id: 'wordpress', label: 'WordPress', type: 'CMS', icon: Globe2 },
  { id: 'ghost', label: 'Ghost', type: 'CMS', icon: Radio },
  { id: 'pdf_export', label: 'PDF', type: 'Export', icon: Download },
  { id: 'epub_export', label: 'ePub', type: 'Export', icon: FileText },
]

const defaultDateTime = () => {
  const value = new Date(Date.now() + 60 * 60 * 1000)
  value.setMinutes(Math.ceil(value.getMinutes() / 15) * 15, 0, 0)
  return value.toISOString().slice(0, 16)
}

function StatusPill({ status }) {
  const styles = {
    success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    draft_saved: 'bg-amber-50 text-amber-700 border-amber-200',
    scheduled: 'bg-sky-50 text-sky-700 border-sky-200',
    pending: 'bg-slate-50 text-slate-600 border-slate-200',
    error: 'bg-red-50 text-red-700 border-red-200',
  }

  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${styles[status] ?? styles.pending}`}>
      {status ?? 'pending'}
    </span>
  )
}

export default function PublishModal({ book, open, onClose, onPublish, isPublishing }) {
  const [selectedChannels, setSelectedChannels] = useState(['linkedin'])
  const [publishMode, setPublishMode] = useState('now')
  const [scheduledAt, setScheduledAt] = useState(defaultDateTime)
  const [includeCovers, setIncludeCovers] = useState(true)
  const [watermark, setWatermark] = useState('')

  const { data: status, isLoading: loadingStatus } = useQuery({
    queryKey: ['publish-status', book?.id],
    queryFn: () => publishingApi.status(book.id).then((r) => r.data),
    enabled: open && Boolean(book?.id),
  })

  const selectedLabels = useMemo(
    () => CHANNELS.filter((channel) => selectedChannels.includes(channel.id)).map((channel) => channel.label),
    [selectedChannels],
  )

  const toggleChannel = (id) => {
    setSelectedChannels((current) =>
      current.includes(id) ? current.filter((channel) => channel !== id) : [...current, id],
    )
  }

  const handleSubmit = () => {
    if (selectedChannels.length === 0) return

    onPublish({
      channels: selectedChannels,
      publishMode,
      scheduledAt: publishMode === 'scheduled' ? new Date(scheduledAt).toISOString() : null,
      includeCovers,
      watermark: watermark.trim() || null,
    })
  }

  const canPublish = selectedChannels.length > 0 && (publishMode === 'now' || Boolean(scheduledAt))

  return (
    <Modal open={open} onClose={onClose} title="Publicacion multicanal" maxWidth="2xl">
      <div className="space-y-5">
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
          <p className="text-xs font-semibold uppercase text-slate-500">Book Concept</p>
          <h3 className="mt-1 text-sm font-semibold text-slate-900">{book?.title}</h3>
          <p className="mt-1 text-xs text-slate-500">
            Selecciona canales, programa redes sociales y envia el contenido generado al worker.
          </p>
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase text-slate-500">Canales</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {CHANNELS.map((channel) => {
              const Icon = channel.icon
              const selected = selectedChannels.includes(channel.id)
              return (
                <button
                  key={channel.id}
                  type="button"
                  onClick={() => toggleChannel(channel.id)}
                  className={`flex min-h-16 items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                    selected
                      ? 'border-primary-300 bg-primary-50 text-primary-800'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <span className={`flex h-9 w-9 items-center justify-center rounded-md ${selected ? 'bg-white text-primary-600' : 'bg-slate-100 text-slate-500'}`}>
                    <Icon size={17} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{channel.label}</span>
                    <span className="block text-xs text-slate-500">{channel.type}</span>
                  </span>
                  {selected && <Check size={16} className="text-primary-600" />}
                </button>
              )
            })}
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase text-slate-500">Momento de publicacion</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setPublishMode('now')}
              className={`flex items-center gap-3 rounded-lg border px-3 py-3 text-left ${
                publishMode === 'now' ? 'border-primary-300 bg-primary-50' : 'border-slate-200 bg-white hover:bg-slate-50'
              }`}
            >
              <Send size={17} className={publishMode === 'now' ? 'text-primary-600' : 'text-slate-500'} />
              <span>
                <span className="block text-sm font-medium text-slate-900">Publicar ahora</span>
                <span className="block text-xs text-slate-500">Exporta o guarda drafts de inmediato.</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setPublishMode('scheduled')}
              className={`flex items-center gap-3 rounded-lg border px-3 py-3 text-left ${
                publishMode === 'scheduled' ? 'border-primary-300 bg-primary-50' : 'border-slate-200 bg-white hover:bg-slate-50'
              }`}
            >
              <CalendarClock size={17} className={publishMode === 'scheduled' ? 'text-primary-600' : 'text-slate-500'} />
              <span>
                <span className="block text-sm font-medium text-slate-900">Programar</span>
                <span className="block text-xs text-slate-500">Define fecha y hora para redes sociales.</span>
              </span>
            </button>
          </div>

          {publishMode === 'scheduled' && (
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(event) => setScheduledAt(event.target.value)}
              className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={includeCovers}
              onChange={(event) => setIncludeCovers(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
            />
            Incluir portada en exports
          </label>
          <input
            value={watermark}
            onChange={(event) => setWatermark(event.target.value)}
            placeholder="Marca de agua opcional"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>

        <div className="rounded-lg border border-slate-200">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <p className="text-xs font-semibold uppercase text-slate-500">Historial</p>
            {loadingStatus && <Spinner size="sm" />}
          </div>
          <div className="max-h-40 overflow-y-auto">
            {status?.channels?.length ? (
              status.channels.slice().reverse().map((entry, index) => (
                <div key={`${entry.channel}-${index}`} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                  <span className="font-medium text-slate-700">{entry.channel}</span>
                  <StatusPill status={entry.status} />
                </div>
              ))
            ) : (
              <p className="px-4 py-4 text-sm text-slate-400">Todavia no hay publicaciones para este book.</p>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-500">
            {selectedLabels.length ? `Seleccionado: ${selectedLabels.join(', ')}` : 'Selecciona al menos un canal.'}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancelar</Button>
            <Button
              icon={<Send size={15} />}
              loading={isPublishing}
              disabled={!canPublish}
              onClick={handleSubmit}
            >
              {publishMode === 'scheduled' ? 'Programar' : 'Publicar'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
