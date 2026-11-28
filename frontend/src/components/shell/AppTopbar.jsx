import { ThemeSwitcher } from "@/components/shell/ThemeSwitcher";

/** Barra superior: ubicación actual (migas) y selector de tema. */
export function AppTopbar({ title }) {
  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-slate-200/70 bg-page/80 px-3 backdrop-blur-md sm:gap-4 sm:px-6 dark:border-white/10">
      <nav aria-label="Ubicación" className="flex min-w-0 items-center gap-2 text-sm">
        <span className="hidden text-slate-400 sm:inline">NoonDalton</span>
        <span className="hidden text-slate-300 sm:inline" aria-hidden="true">/</span>
        <span className="truncate font-semibold text-slate-800 dark:text-slate-100">{title}</span>
      </nav>
      <div className="ml-auto flex shrink-0 items-center gap-3">
        <ThemeSwitcher />
      </div>
    </header>
  );
}
