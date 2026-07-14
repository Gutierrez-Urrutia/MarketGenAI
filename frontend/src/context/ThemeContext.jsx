/**
 * context/ThemeContext.jsx
 * Manages theme preference globally (light, dark, system)
 */
import React, { createContext, useState, useEffect, useCallback } from "react";
import { settingsApi } from "@/api/axios";

export const ThemeContext = createContext();

const STORAGE_KEY = "marketgen_theme";
const SUPPORTED_THEMES = ["light", "dark", "system"];
const DEFAULT_THEME = "system";

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(DEFAULT_THEME);
  const [isLoading, setIsLoading] = useState(true);

  // Detect if system prefers dark mode
  const getSystemTheme = useCallback(() => {
    if (typeof window === "undefined") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }, []);

  // Apply theme to HTML element
  const applyTheme = useCallback(
    (currentTheme) => {
      if (typeof document === "undefined") return;

      const html = document.documentElement;
      const effectiveTheme =
        currentTheme === "system" ? getSystemTheme() : currentTheme;

      if (effectiveTheme === "dark") {
        html.classList.add("dark");
      } else {
        html.classList.remove("dark");
      }
    },
    [getSystemTheme]
  );

  // Initialize theme from localStorage or backend
  useEffect(() => {
    const initializeTheme = async () => {
      try {
        // Try to get from localStorage first (faster)
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored && SUPPORTED_THEMES.includes(stored)) {
          setThemeState(stored);
          applyTheme(stored);
          setIsLoading(false);
          return;
        }

        // Try to fetch from backend
        const settings = await settingsApi.get();
        const backendTheme = settings.data?.theme;
        if (backendTheme && SUPPORTED_THEMES.includes(backendTheme)) {
          setThemeState(backendTheme);
          applyTheme(backendTheme);
          localStorage.setItem(STORAGE_KEY, backendTheme);
        } else {
          // Use default
          setThemeState(DEFAULT_THEME);
          applyTheme(DEFAULT_THEME);
          localStorage.setItem(STORAGE_KEY, DEFAULT_THEME);
        }
      } catch (error) {
        // Silent fail - use localStorage or default
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored && SUPPORTED_THEMES.includes(stored)) {
          setThemeState(stored);
          applyTheme(stored);
        } else {
          setThemeState(DEFAULT_THEME);
          applyTheme(DEFAULT_THEME);
          localStorage.setItem(STORAGE_KEY, DEFAULT_THEME);
        }
      } finally {
        setIsLoading(false);
      }
    };

    initializeTheme();
  }, [applyTheme]);

  // Watch for system theme changes when in "system" mode
  useEffect(() => {
    if (theme !== "system") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const handleChange = () => {
      applyTheme("system");
    };

    // Modern browsers
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    // Legacy browsers
    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, [theme, applyTheme]);

  // Change theme with immediate UI update and background sync
  const changeTheme = useCallback(
    (newTheme) => {
      if (!SUPPORTED_THEMES.includes(newTheme)) {
        console.warn(`Invalid theme: ${newTheme}`);
        return;
      }

      // Immediate: update state, apply to DOM, and save to localStorage
      setThemeState(newTheme);
      applyTheme(newTheme);
      localStorage.setItem(STORAGE_KEY, newTheme);

      // Background: sync with backend (don't block UI)
      settingsApi
        .put({ theme: newTheme })
        .catch((error) => {
          console.warn("Failed to sync theme to backend:", error);
          // Changes already saved in localStorage, so no need to revert
        });
    },
    [applyTheme]
  );

  return (
    <ThemeContext.Provider value={{ theme, changeTheme, isLoading }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = React.useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
