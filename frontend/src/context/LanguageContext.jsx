/**
 * context/LanguageContext.jsx
 * Manages language preference globally
 */
import React, { createContext, useState, useEffect, useCallback } from "react";
import { settingsApi } from "@/api/axios";

export const LanguageContext = createContext();

const STORAGE_KEY = "marketgen_language";
const SUPPORTED_LANGUAGES = ["en", "es", "pt"];
const DEFAULT_LANGUAGE = "en";

export function LanguageProvider({ children }) {
  const [language, setLanguageState] = useState(DEFAULT_LANGUAGE);
  const [isLoading, setIsLoading] = useState(true);

  // Initialize language from localStorage or backend
  useEffect(() => {
    const initializeLanguage = async () => {
      try {
        // Try to get from localStorage first (faster)
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored && SUPPORTED_LANGUAGES.includes(stored)) {
          setLanguageState(stored);
          setIsLoading(false);
          return;
        }

        // Try to fetch from backend
        const settings = await settingsApi.get();
        const backendLanguage = settings.data?.language;
        if (backendLanguage && SUPPORTED_LANGUAGES.includes(backendLanguage)) {
          setLanguageState(backendLanguage);
          localStorage.setItem(STORAGE_KEY, backendLanguage);
        } else {
          // Use default
          setLanguageState(DEFAULT_LANGUAGE);
          localStorage.setItem(STORAGE_KEY, DEFAULT_LANGUAGE);
        }
      } catch (error) {
        // Silent fail - use localStorage or default
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored && SUPPORTED_LANGUAGES.includes(stored)) {
          setLanguageState(stored);
        } else {
          setLanguageState(DEFAULT_LANGUAGE);
          localStorage.setItem(STORAGE_KEY, DEFAULT_LANGUAGE);
        }
      } finally {
        setIsLoading(false);
      }
    };

    initializeLanguage();
  }, []);

  // Change language with immediate UI update and background sync
  const changeLanguage = useCallback(
    (newLanguage) => {
      if (!SUPPORTED_LANGUAGES.includes(newLanguage)) {
        console.warn(`Invalid language: ${newLanguage}`);
        return;
      }

      // Immediate: update state and localStorage
      setLanguageState(newLanguage);
      localStorage.setItem(STORAGE_KEY, newLanguage);

      // Background: sync with backend (don't block UI)
      settingsApi
        .put({ language: newLanguage })
        .catch((error) => {
          console.warn("Failed to sync language to backend:", error);
          // Changes already saved in localStorage, so no need to revert
        });
    },
    []
  );

  return (
    <LanguageContext.Provider value={{ language, changeLanguage, isLoading }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = React.useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within LanguageProvider");
  }
  return context;
}
