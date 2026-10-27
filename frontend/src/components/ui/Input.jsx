import { clsx } from 'clsx'
import { forwardRef } from 'react'

export const Input = forwardRef(function Input({ label, error, className, ...props }, ref) {
  return (
    <div className="space-y-1">
      {label && <label className="block text-sm font-medium text-slate-700">{label}</label>}
      <input
        ref={ref}
        className={clsx(
          'w-full px-3 py-2 text-sm border rounded-lg bg-white',
          'placeholder:text-slate-400 text-slate-900',
          'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent',
          'disabled:bg-slate-50 disabled:text-slate-400',
          error ? 'border-red-400' : 'border-slate-300',
          className,
        )}
        {...props}
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
})

export const Textarea = forwardRef(function Textarea({ label, error, className, ...props }, ref) {
  return (
    <div className="space-y-1">
      {label && <label className="block text-sm font-medium text-slate-700">{label}</label>}
      <textarea
        ref={ref}
        className={clsx(
          'w-full px-3 py-2 text-sm border rounded-lg bg-white resize-y min-h-[80px]',
          'placeholder:text-slate-400 text-slate-900',
          'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent',
          'disabled:bg-slate-50 disabled:text-slate-400',
          error ? 'border-red-400' : 'border-slate-300',
          className,
        )}
        {...props}
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
})
