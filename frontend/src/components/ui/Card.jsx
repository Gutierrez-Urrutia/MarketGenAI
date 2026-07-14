import { clsx } from 'clsx'

export function Card({ children, className, ...props }) {
  return (
    <div
      className={clsx('bg-white rounded-xl shadow-card border border-slate-100 p-6', className)}
      {...props}
    >
      {children}
    </div>
  )
}

export function CardHeader({ title, subtitle, actions }) {
  return (
    <div className="flex items-start justify-between mb-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
