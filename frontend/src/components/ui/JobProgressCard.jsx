import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react'

const STATUS_LABELS = {
  pending: 'En cola',
  processing: 'Procesando',
  completed: 'Completado',
  failed: 'Fallido',
}

export default function JobProgressCard({
  title = 'Procesando trabajo',
  job,
  progress,
  className = '',
}) {
  const status = String(job?.status || 'pending').toLowerCase()
  const pct = Math.max(0, Math.min(100, Number(progress ?? job?.progress ?? 0)))
  const isDone = status === 'completed'
  const isError = status === 'failed' || status === 'error'

  return (
    <div className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}>
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg ${
          isError ? 'bg-red-50 text-red-600' : isDone ? 'bg-emerald-50 text-emerald-600' : 'bg-primary-50 text-primary-600'
        }`}>
          {isError ? <CircleAlert size={18} /> : isDone ? <CheckCircle2 size={18} /> : <Loader2 size={18} className="animate-spin" />}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-slate-900">{title}</p>
            <span className="text-xs font-medium text-slate-500">{pct}%</span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Estado: {STATUS_LABELS[status] || status}
          </p>

          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                isError ? 'bg-red-500' : isDone ? 'bg-emerald-500' : 'bg-primary-600'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>

          {job?.error && (
            <p className="mt-2 text-xs text-red-600">{job.error}</p>
          )}
        </div>
      </div>
    </div>
  )
}
