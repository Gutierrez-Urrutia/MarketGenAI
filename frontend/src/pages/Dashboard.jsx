/**
 * Dashboard page — KPI summary cards + quick navigation.
 */
import { useEffect, useState } from 'react'
import { BookOpen, Briefcase, FileText, TrendingUp } from 'lucide-react'
import { getCustomers } from '@/api/customersApi'
import { Link } from 'react-router-dom'
import { Card } from '@/components/ui/Card'
import { useAuth } from '@/hooks/useAuth'

const KPI_CARDS = [
  { label: 'Book Concepts',  icon: BookOpen,   value: '—', color: 'text-primary-600', bg: 'bg-primary-50', to: '/books' },
  { label: 'Propuestas',     icon: Briefcase,  value: '—', color: 'text-teal-600',    bg: 'bg-teal-50',    to: '/proposals' },
  { label: 'Activos Gen.',   icon: FileText,   value: '—', color: 'text-amber-600',   bg: 'bg-amber-50',   to: '/books' },
  { label: 'Valor Total',    icon: TrendingUp, value: '—', color: 'text-green-600',   bg: 'bg-green-50',   to: '/reports' },
]

const QUICK_ACTIONS = [
  { label: '+ Nuevo Book Concept', to: '/books/new',       color: 'bg-primary-600 hover:bg-primary-700' },
  { label: '+ Nueva Propuesta',    to: '/proposals/new',   color: 'bg-teal-500    hover:bg-teal-600' },
  { label: 'Ver Reportes',         to: '/reports',         color: 'bg-slate-700   hover:bg-slate-800' },
]

export default function Dashboard() {
  const { user } = useAuth()
  const [customers, setCustomers] = useState([])

  useEffect(() => {
  const loadCustomers = async () => {
    try {
      const data = await getCustomers()
      setCustomers(data)
    } catch (error) {
      console.error(error)
    }
  }

  loadCustomers()
  }, [])
  
  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          Bienvenido, {user?.name?.split(' ')[0] || 'usuario'} 👋
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Resumen de tu actividad en NoonDalton AI Marketing Suite
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <Card>
        <h2 className="text-sm font-semibold text-slate-700 mb-2">
        Customers conectados
          </h2>
          <p className="text-3xl font-bold text-primary-600">
          {customers.length}
         </p>
        </Card>
        {KPI_CARDS.map(({ label, icon: Icon, value, color, bg, to }) => (
          <Link key={label} to={to}>
            <Card className="hover:shadow-md transition-shadow cursor-pointer">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">{value}</p>
                </div>
                <div className={`p-3 rounded-xl ${bg}`}>
                  <Icon size={22} className={color} />
                </div>
              </div>
            </Card>
          </Link>
        ))}
      </div>

      {/* Quick Actions */}
      <Card>
        <h2 className="text-sm font-semibold text-slate-700 mb-4">Acciones rápidas</h2>
        <div className="flex flex-wrap gap-3">
          {QUICK_ACTIONS.map(({ label, to, color }) => (
            <Link
              key={to}
              to={to}
              className={`px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors ${color}`}
            >
              {label}
            </Link>
          ))}
        </div>
      </Card>

      {/* Placeholder for recent activity */}
      <Card>
        <h2 className="text-sm font-semibold text-slate-700 mb-4">Actividad reciente</h2>
        <p className="text-slate-400 text-sm text-center py-8">
          Los datos de actividad aparecerán aquí una vez que hayas creado content o propuestas.
        </p>
      </Card>
    </div>
  )
}
