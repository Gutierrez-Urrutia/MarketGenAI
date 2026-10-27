import { ThemeSwitcher } from "@/components/shell/ThemeSwitcher";

/** Barra superior: ubicación actual (migas) y selector de tema. */
export function AppTopbar({ title }) {
  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-4 border-b border-slate-200/70 bg-page/80 px-6 backdrop-blur-md dark:border-white/10">
      <nav aria-label="Ubicación" className="flex items-center gap-2 text-sm">
        <span className="text-slate-400">NoonDalton</span>
        <span className="text-slate-300" aria-hidden="true">/</span>
        <span className="font-semibold text-slate-800 dark:text-slate-100">{title}</span>
      </nav>
      <div className="ml-auto flex items-center gap-3">
        <ThemeSwitcher />
      </div>
    </header>
  );
}
