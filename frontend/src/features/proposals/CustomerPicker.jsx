/**
 * CustomerPicker — elegir un cliente propio (opcional) en el paso 1 de la propuesta (RF-VTA-03).
 * Al elegirlo, la propuesta queda vinculada a él y su industria y tamaño orientan el contenido generado.
 * «Sin cliente» deja el flujo como estaba. El catálogo se consulta solo al abrir el buscador.
 */
import { useEffect, useRef, useState } from "react";

import { customersApi } from "@/api/customersApi";
import { useCustomerOptions } from "@/features/customers/useCustomerOptions";
import { useI18n } from "@/hooks/useI18n";

const PREFIX = "opportunitiesPage.proposalModal";

export function CustomerPicker({ selected, onSelect }) {
  const { t } = useI18n();
  const options = useCustomerOptions();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | loading | ready | error
  const requestRef = useRef(0);

  useEffect(() => {
    if (!open) return undefined;
    const request = ++requestRef.current;
    setStatus("loading");
    const handle = setTimeout(async () => {
      try {
        const { data } = await customersApi.list({ limit: 20, ...(query.trim() && { search: query.trim() }) });
        if (request !== requestRef.current) return;
        setCustomers(data?.items ?? []);
        setStatus("ready");
      } catch {
        if (request !== requestRef.current) return;
        setStatus("error");
      }
    }, query ? 250 : 0);
    return () => clearTimeout(handle);
  }, [open, query]);

  const choose = (customer) => {
    setOpen(false);
    setQuery("");
    onSelect(customer);
  };

  const industry = selected ? options.industryLabel(selected.industry) : null;
  const size = selected ? options.sizeLabel(selected.size) : null;

  if (selected) {
    return (
      <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700" data-testid="selected-customer">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-semibold text-gray-900">{selected.name}{selected.company ? ` · ${selected.company}` : ""}</p>
            <p className="mt-0.5 text-gray-600">
              {t("customersPage.industry")}: {industry || t("customersPage.undefined")} · {t("customersPage.size")}: {size || t("customersPage.undefined")}
            </p>
            <p className="mt-0.5 text-gray-500">
              {industry || size ? t(`${PREFIX}.customerProfileHint`) : t(`${PREFIX}.customerNoProfile`)}
            </p>
          </div>
          <button type="button" className="whitespace-nowrap text-indigo-600 underline" onClick={() => onSelect(null)}>{t(`${PREFIX}.customerClear`)}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        type="search"
        aria-label={t(`${PREFIX}.customerPick`)}
        placeholder={`${t(`${PREFIX}.customerPick`)} — ${t(`${PREFIX}.customerSearch`)}`}
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-400"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
      />
      {open && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          <button type="button" className="block w-full px-3 py-2 text-left text-xs text-gray-500 hover:bg-gray-50" onClick={() => choose(null)}>
            {t(`${PREFIX}.customerNone`)}
          </button>
          {status === "loading" && <p className="px-3 py-2 text-xs text-gray-400">{t(`${PREFIX}.customerLoading`)}</p>}
          {status === "error" && <p className="px-3 py-2 text-xs text-red-500" role="alert">{t(`${PREFIX}.customerError`)}</p>}
          {status === "ready" && customers.length === 0 && <p className="px-3 py-2 text-xs text-gray-400">{t(`${PREFIX}.customerEmpty`)}</p>}
          {status === "ready" && (
            <ul role="listbox" aria-label={t(`${PREFIX}.customerPick`)}>
              {customers.map((customer) => (
                <li key={customer.id} role="option" aria-selected="false">
                  <button type="button" onClick={() => choose(customer)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-indigo-50">
                    <span>
                      <span className="font-medium text-gray-900">{customer.name}</span>
                      {customer.company && <span className="text-gray-500"> · {customer.company}</span>}
                    </span>
                    <span className="whitespace-nowrap text-gray-400">
                      {[options.industryLabel(customer.industry), options.sizeLabel(customer.size)].filter(Boolean).join(" · ") || t("customersPage.undefined")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
