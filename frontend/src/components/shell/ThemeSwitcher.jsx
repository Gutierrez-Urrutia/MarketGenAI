import { Monitor, Moon, Sun, Sunrise } from "lucide-react";

import { useTheme } from "@/context/ThemeContext";
import { useI18n } from "@/hooks/useI18n";

// Orden y tema de cada opción. "noon" es el tema claro cálido de la marca; "system" sigue al sistema operativo.
export const THEME_OPTIONS = [
  { key: "light", icon: Sun },
  { key: "dark", icon: Moon },
  { key: "noon", icon: Sunrise },
  { key: "system", icon: Monitor },
];

/** Selector rápido de tema (grupo de opciones excluyentes, accesible con teclado y lectores). */
export function ThemeSwitcher({ onChange, className = "" }) {
  const { theme, changeTheme } = useTheme();
  const { t } = useI18n();

  const select = (key) => {
    changeTheme(key);
    onChange?.(key);
    window.dispatchEvent(new CustomEvent("marketgen:prefs"));
  };

  return (
    <div
      role="radiogroup"
      aria-label={t("settings.theme")}
      className={`inline-flex items-center gap-0.5 rounded-full border border-slate-200 bg-white/70 p-0.5 shadow-sm dark:border-white/10 dark:bg-white/5 ${className}`}
    >
      {THEME_OPTIONS.map(({ key, icon: Icon }) => {
        const active = theme === key;
        const label = t(`settings.${key}Mode`);
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => select(key)}
            className={`flex h-7 w-7 items-center justify-center rounded-full transition-all ${
              active
                ? "bg-brand-600 text-white shadow-sm"
                : "text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white"
            }`}
          >
            <Icon size={14} strokeWidth={2.2} />
          </button>
        );
      })}
    </div>
  );
}
