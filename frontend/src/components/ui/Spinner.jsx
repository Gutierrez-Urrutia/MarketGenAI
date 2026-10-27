import { Loader2 } from 'lucide-react'
import { clsx } from 'clsx'

export function Spinner({ size = 20, className }) {
  return <Loader2 size={size} className={clsx('animate-spin text-primary-600', className)} />
}

export function FullPageSpinner() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-white/80 z-50">
      <Spinner size={32} />
    </div>
  )
}
