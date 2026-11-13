// RF-VTA-10: formato de las cifras del reporte de pipeline.
// El valor se muestra siempre por moneda: USD y CLP no se suman en un solo número.
export const CURRENCIES = ["USD", "CLP"];

export const formatPercent = (value) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const n = Number(value);
  return `${n.toFixed(n % 1 === 0 ? 0 : 1)} %`;
};

export const formatDays = (value) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return Number(value).toFixed(1);
};

const number = (value) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Number(value) || 0);

/** {USD: 21200, CLP: 8000000} → "USD 21.200 · CLP 8.000.000". Las monedas en cero no se muestran. */
export const formatMoneyByCurrency = (bucket) => {
  const parts = CURRENCIES.filter((code) => Number(bucket?.[code]) > 0).map((code) => `${code} ${number(bucket[code])}`);
  return parts.length ? parts.join(" · ") : "0";
};

/** Monto de una sola moneda, sin el código (para las columnas de la tabla). */
export const formatAmount = (value) => (Number(value) > 0 ? number(value) : "—");

export const downloadBlob = (data, filename, type) => {
  const url = window.URL.createObjectURL(new Blob([data], type ? { type } : undefined));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.URL.revokeObjectURL(url);
};
