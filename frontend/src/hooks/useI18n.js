/**
 * hooks/useI18n.js
 * Hook for accessing translations
 */
import { useLanguage } from "@/context/LanguageContext";
import { getTranslation } from "@/i18n/translations";

export function useI18n() {
  const { language } = useLanguage();

  const t = (key) => {
    return getTranslation(key, language);
  };

  return { t, language };
}
