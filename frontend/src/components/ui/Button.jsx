import { clsx } from 'clsx'
import { Loader2 } from 'lucide-react'

const VARIANTS = {
  primary:     'bg-primary-600 text-white hover:bg-primary-700 focus:ring-primary-500',
  secondary:   'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 focus:ring-slate-400',
  teal:        'bg-teal-500 text-white hover:bg-teal-600 focus:ring-teal-400',
  destructive: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500',
  ghost:       'text-slate-600 hover:bg-slate-100 focus:ring-slate-300',
}

const SIZES = {
  sm: 'px-3 py-1.5 text-xs rounded-md',
  md: 'px-4 py-2   text-sm rounded-lg',
  lg: 'px-6 py-2.5 text-sm rounded-lg',
}

export function Button({
  variant  = 'primary',
  size     = 'md',
  loading  = false,
  disabled = false,
  icon,
  children,
  className,
  ...props
}) {
  return (
    <button
      className={clsx(
        'inline-flex items-center justify-center gap-2 font-medium',
        'transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  )

  
}

export default Button;