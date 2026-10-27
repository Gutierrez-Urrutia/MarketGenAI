/**
 * Sidebar — persistent navigation.
 * Collapses to an icon bar on small screens.
 */
import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, BookOpen, Briefcase, BarChart2,
  Settings, LogOut, ChevronLeft, ChevronRight, X,
  Users, MessageSquare, Image, FileText,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'

const NAV_ITEMS = [
  { to: '/dashboard',  icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/books',      icon: BookOpen,        label: 'Book Concepts' },
  { to: '/proposals',  icon: Briefcase,       label: 'Propuestas' },
  { to: '/customers',  icon: Users,           label: 'Clientes' },
  { to: '/assets',     icon: Image,           label: 'Assets' },
  { to: '/templates',  icon: FileText,        label: 'Plantillas' },
  { to: '/reports',    icon: BarChart2,       label: 'Reportes' },
  { to: '/chat',       icon: MessageSquare,   label: 'Asistente IA' },
]

const BOTTOM_ITEMS = [
  { to: '/settings', icon: Settings, label: 'Configuración' },
]

export default function Sidebar({ collapsed, onToggle, mobileOpen, onMobileClose }) {
  const { user, logout } = useAuth()

  const linkClass = ({ isActive }) =>
    `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors text-sm font-medium
     ${isActive
       ? 'bg-primary-600 text-white'
       : 'text-slate-300 hover:bg-slate-700 hover:text-white'
     }
     ${collapsed ? 'justify-center' : ''}`

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 lg:hidden"
          onClick={onMobileClose}
        />
      )}

      <aside className={`
        fixed top-0 left-0 h-full z-30 flex flex-col
        bg-sidebar transition-all duration-200
        ${collapsed ? 'w-16' : 'w-64'}
        ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
        {/* Logo */}
        <div className={`flex items-center h-16 px-4 border-b border-slate-700 ${collapsed ? 'justify-center' : 'justify-between'}`}>
          {!collapsed && (
            <span className="text-white font-bold text-sm leading-tight">
              NoonDalton<br />
              <span className="text-teal-400 font-normal text-xs">AI Marketing Suite</span>
            </span>
          )}
          <button
            onClick={onToggle}
            className="hidden lg:flex p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-700"
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
          <button
            onClick={onMobileClose}
            className="lg:hidden p-1 rounded-md text-slate-400 hover:text-white"
          >
            <X size={16} />
          </button>
        </div>

        {/* Main nav */}
        <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} className={linkClass} title={collapsed ? label : undefined}>
              <Icon size={18} className="shrink-0" />
              {!collapsed && <span>{label}</span>}
            </NavLink>
          ))}
        </nav>

        {/* Divider */}
        <div className="mx-3 border-t border-slate-700" />

        {/* Bottom nav */}
        <nav className="px-2 py-3 space-y-1">
          {BOTTOM_ITEMS.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} className={linkClass} title={collapsed ? label : undefined}>
              <Icon size={18} className="shrink-0" />
              {!collapsed && <span>{label}</span>}
            </NavLink>
          ))}

          {/* Logout */}
          <button
            onClick={logout}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium
              text-slate-300 hover:bg-red-700/30 hover:text-red-300 transition-colors
              ${collapsed ? 'justify-center' : ''}`}
            title={collapsed ? 'Cerrar sesión' : undefined}
          >
            <LogOut size={18} className="shrink-0" />
            {!collapsed && <span>Cerrar sesión</span>}
          </button>
        </nav>

        {/* User footer */}
        {!collapsed && user && (
          <div className="px-4 py-3 border-t border-slate-700">
            <p className="text-white text-xs font-medium truncate">{user.name || user.preferred_username}</p>
            <p className="text-slate-400 text-xs truncate">{user.email}</p>
          </div>
        )}
      </aside>
    </>
  )
}
