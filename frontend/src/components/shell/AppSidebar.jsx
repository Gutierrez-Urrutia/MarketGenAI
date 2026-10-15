import { LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { BrandLogo } from "@/components/shell/BrandLogo";

const initials = (name = "") =>
  String(name)
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("") || "U";

function NavItem({ item, active, collapsed, onClick }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      title={collapsed ? item.label : undefined}
      aria-current={active ? "page" : undefined}
      className={`group relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all ${
        active
          ? "bg-white/15 text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]"
          : "text-white/70 hover:bg-white/8 hover:text-white"
      } ${collapsed ? "justify-center px-0" : ""}`}
    >
      {active && <span className="absolute -left-2 top-1/2 h-6 w-1 -translate-y-1/2 rounded-full bg-accent-500" aria-hidden="true" />}
      <Icon size={18} className={`shrink-0 transition-transform group-hover:scale-110 ${active ? "text-accent-400" : ""}`} />
      {!collapsed && <span className="flex-1 truncate text-left">{item.label}</span>}
      {!collapsed && item.badge ? (
        <span className="rounded-full bg-accent-500 px-1.5 py-0.5 text-[11px] font-bold leading-none text-white">{item.badge}</span>
      ) : null}
    </button>
  );
}

/** Barra lateral de marca: degradado del primario, navegación principal, ajustes y usuario. */
export function AppSidebar({ mainItems, bottomItems, activeKey, collapsed, onToggle, onNavigate, user, logoutLabel, onLogout }) {
  return (
    <aside
      className={`${collapsed ? "w-[72px]" : "w-64"} flex h-full shrink-0 flex-col text-white transition-[width] duration-200`}
      style={{ background: "linear-gradient(180deg, rgb(var(--shell-from)) 0%, rgb(var(--shell-to)) 100%)" }}
    >
      <div className={`flex h-16 items-center px-4 ${collapsed ? "justify-center" : "justify-between"}`}>
        <BrandLogo mark={collapsed} />
        {!collapsed && (
          <button
            type="button"
            onClick={onToggle}
            aria-label="Colapsar menú"
            className="rounded-lg p-1.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <PanelLeftClose size={18} />
          </button>
        )}
      </div>
      {collapsed && (
        <button
          type="button"
          onClick={onToggle}
          aria-label="Expandir menú"
          className="mx-auto mb-1 rounded-lg p-1.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
        >
          <PanelLeftOpen size={18} />
        </button>
      )}
      {!collapsed && <p className="px-5 pb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/40">AI Marketing Suite</p>}

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2" aria-label="Principal">
        {mainItems.map((item) => (
          <NavItem key={item.key} item={item} active={activeKey === item.key} collapsed={collapsed} onClick={() => onNavigate(item.key)} />
        ))}
      </nav>

      <div className="mx-3 border-t border-white/10" />
      <nav className="space-y-1 px-3 py-3" aria-label="Cuenta">
        {bottomItems.map((item) => (
          <NavItem key={item.key} item={item} active={activeKey === item.key} collapsed={collapsed} onClick={() => onNavigate(item.key)} />
        ))}
        <button
          type="button"
          onClick={onLogout}
          title={collapsed ? logoutLabel : undefined}
          className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-white/70 transition-colors hover:bg-red-500/20 hover:text-red-200 ${
            collapsed ? "justify-center px-0" : ""
          }`}
        >
          <LogOut size={18} className="shrink-0" />
          {!collapsed && logoutLabel}
        </button>
      </nav>

      <div className={`m-3 mt-0 flex items-center gap-3 rounded-xl bg-black/15 p-2.5 ${collapsed ? "justify-center" : ""}`}>
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-500 text-xs font-bold text-white ring-2 ring-white/20"
          aria-hidden="true"
        >
          {initials(user.name)}
        </span>
        {!collapsed && (
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-sm font-semibold text-white">{user.name}</span>
            {user.email && <span className="block truncate text-xs text-white/55">{user.email}</span>}
          </span>
        )}
      </div>
    </aside>
  );
}
