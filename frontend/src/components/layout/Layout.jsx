/**
 * Main app shell — sidebar + topbar + page content.
 */
import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { Menu, Bell } from 'lucide-react'
import Sidebar from './Sidebar'
import { useAuth } from '@/hooks/useAuth'

export default function Layout() {
  const [collapsed,   setCollapsed]   = useState(false)
  const [mobileOpen,  setMobileOpen]  = useState(false)
  const { user } = useAuth()

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Sidebar */}
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      {/* Main content area */}
      <div className={`flex-1 flex flex-col min-h-screen transition-all duration-200
        ${collapsed ? 'lg:ml-16' : 'lg:ml-64'}`}>

        {/* Top bar */}
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 lg:px-6 sticky top-0 z-10">
          {/* Mobile menu button */}
          <button
            onClick={() => setMobileOpen(true)}
            className="lg:hidden p-2 rounded-md text-slate-500 hover:bg-slate-100"
          >
            <Menu size={20} />
          </button>

          <div className="flex-1" />

          {/* Right actions */}
          <div className="flex items-center gap-3">
            <button className="p-2 rounded-md text-slate-500 hover:bg-slate-100 relative">
              <Bell size={18} />
            </button>
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-600 flex items-center justify-center text-white text-xs font-bold">
                {(user?.name || user?.preferred_username || '?')[0].toUpperCase()}
              </div>
              <span className="hidden md:block text-sm font-medium text-slate-700">
                {user?.name || user?.preferred_username}
              </span>
            </div>
          </div>
        </header>

        {/* Page */}
        <main className="flex-1 p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
