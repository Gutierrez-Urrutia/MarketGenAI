import { clsx } from 'clsx'

const VARIANTS = {
  draft:     'bg-slate-100  text-slate-600',
  outlined:  'bg-blue-100   text-blue-700',
  generated: 'bg-teal-100   text-teal-700',
  published: 'bg-green-100  text-green-700',
  pending:   'bg-yellow-100 text-yellow-700',
  edited:    'bg-purple-100 text-purple-700',
  error:     'bg-red-100    text-red-700',
  default:   'bg-slate-100  text-slate-600',
}

export function Badge({ status, label, className }) {
  return (
    <span className={clsx(
      'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize',
      VARIANTS[status] || VARIANTS.default,
      className,
    )}>
      {label || status}
    </span>
  )
  
}

export default Badge;