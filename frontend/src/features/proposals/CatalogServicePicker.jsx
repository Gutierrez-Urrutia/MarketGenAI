/**
 * CatalogServicePicker — buscador de servicios ACTIVOS del catálogo para el paso 2 de la propuesta (RF-VTA-02).
 * Al elegir uno, el padre agrega una fila con una COPIA del servicio: la propuesta no queda ligada al catálogo.
 * Una propuesta usa una sola moneda: los servicios de otra moneda se muestran deshabilitados con un aviso.
 */
import { useEffect, useRef, useState } from "react";

import { getServices } from "@/api/catalogApi";
import { formatMoney } from "@/features/proposals/proposalDocument";
import { useI18n } from "@/hooks/useI18n";

const PREFIX = "opportunitiesPage.proposalModal";

export function CatalogServicePicker({ currency, onPick }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [services, setServices] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | loading | ready | error
  const [blocked, setBlocked] = useState(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!open) return undefined;
    const request = ++requestRef.current;
    setStatus("loading");
    const handle = setTimeout(async () => {
      try {
        const items = await getServices({ active: true, limit: 100, ...(query.trim() && { search: query.trim() }) });
        if (request !== requestRef.current) return;
        setServices(items);
        setStatus("ready");
      } catch {
        if (request !== requestRef.current) return;
        setStatus("error");
      }
    }, query ? 250 : 0);
    return () => clearTimeout(handle);
  }, [open, query]);

  const choose = (service) => {
    if (currency && service.currency !== currency) {
      setBlocked(t(`${PREFIX}.catalogCurrencyMismatch`).replace("{currency}", currency));
      return;
    }
    setBlocked(null);
    setOpen(false);
    setQuery("");
    onPick(service);
  };

  return (
    <div className="relative">
      <input
        type="search"
        aria-label={t(`${PREFIX}.addFromCatalog`)}
        placeholder={`${t(`${PREFIX}.addFromCatalog`)} — ${t(`${PREFIX}.catalogSearch`)}`}
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-400"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
      />
      {blocked && <p className="mt-1 text-xs text-amber-700" role="alert">{blocked}</p>}
      {open && (
        <div className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          {status === "loading" && <p className="px-3 py-2 text-xs text-gray-400">{t(`${PREFIX}.catalogLoading`)}</p>}
          {status === "error" && <p className="px-3 py-2 text-xs text-red-500" role="alert">{t(`${PREFIX}.catalogError`)}</p>}
          {status === "ready" && services.length === 0 && <p className="px-3 py-2 text-xs text-gray-400">{t(`${PREFIX}.catalogEmpty`)}</p>}
          {status === "ready" && (
            <ul role="listbox" aria-label={t(`${PREFIX}.addFromCatalog`)}>
              {services.map((service) => {
                const mismatch = Boolean(currency) && service.currency !== currency;
                return (
                  <li key={service.id} role="option" aria-selected="false" aria-disabled={mismatch}>
                    <button
                      type="button"
                      onClick={() => choose(service)}
                      className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-indigo-50 ${mismatch ? "cursor-not-allowed opacity-50" : ""}`}
                    >
                      <span>
                        <span className="font-medium text-gray-900">{service.name}</span>
                        <span className="text-gray-500"> · {service.unit}</span>
                        {service.typeName && <span className="block text-gray-400">{service.typeName}</span>}
                      </span>
                      <span className="whitespace-nowrap font-semibold text-gray-700">{formatMoney(service.price, service.currency, { exact: true })}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
