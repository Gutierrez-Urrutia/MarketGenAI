// Industrias y tamaños con etiquetas en es/en/pt, tal como las entrega el servidor (RF-VTA-03).
import { useEffect, useState } from "react";

import { customersApi } from "@/api/customersApi";
import { useI18n } from "@/hooks/useI18n";

const EMPTY = { industries: [], sizes: [] };

export function useCustomerOptions() {
  const { language } = useI18n();
  const [options, setOptions] = useState(EMPTY);

  useEffect(() => {
    let cancelled = false;
    customersApi.options()
      .then(({ data }) => { if (!cancelled) setOptions({ industries: data?.industries ?? [], sizes: data?.sizes ?? [] }); })
      .catch(() => { if (!cancelled) setOptions(EMPTY); });
    return () => { cancelled = true; };
  }, []);

  const labelOf = (group, code) => {
    if (!code) return null;
    const found = (options[group] || []).find((item) => item.value === code);
    return found?.labels?.[language] || found?.labels?.es || code;
  };

  return {
    ...options,
    industryLabel: (code) => labelOf("industries", code),
    sizeLabel: (code) => labelOf("sizes", code),
    optionLabel: (item) => item.labels?.[language] || item.labels?.es || item.value,
  };
}
