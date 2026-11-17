/**
 * CatalogPage — RF-VTA-02: catálogo de servicios y precios de la empresa.
 * Todos los roles lo consultan; solo manager y admin crean, editan y desactivan.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";

import { authTokenStore } from "@/api/axios";
import { catalogApi } from "@/api/catalogApi";
import { Badge, Button, Modal, Spinner } from "@/components/ui";
import { ServiceFormModal } from "@/features/catalog/ServiceFormModal";
import { ServiceTypesModal } from "@/features/catalog/ServiceTypesModal";
import { formatMoney } from "@/features/proposals/proposalDocument";
import { useI18n } from "@/hooks/useI18n";
import { canManageCatalog } from "@/utils/permissions";

const PAGE_SIZE = 20;
const filterClass = "px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-500";

export function CatalogPage() {
  const { t } = useI18n();
  const tRef = useRef(t); // useI18n devuelve un t nuevo en cada render: no debe disparar la recarga
  tRef.current = t;
  const canManage = canManageCatalog(authTokenStore.getUser() || {});

  const [services, setServices] = useState([]);
  const [total, setTotal] = useState(0);
  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [typeId, setTypeId] = useState("");
  const [offset, setOffset] = useState(0);
  const [formService, setFormService] = useState(undefined); // undefined = cerrado, null = nuevo
  const [typesOpen, setTypesOpen] = useState(false);
  const [toDeactivate, setToDeactivate] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => { setDebouncedSearch(search.trim()); setOffset(0); }, 250);
    return () => clearTimeout(handle);
  }, [search]);

  const loadTypes = useCallback(async () => {
    try {
      const { data } = await catalogApi.listServiceTypes();
      setTypes(data?.items ?? []);
    } catch {
      setTypes([]);
    }
  }, []);

  const loadServices = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const params = { limit: PAGE_SIZE, offset };
      if (debouncedSearch) params.search = debouncedSearch;
      if (status !== "all") params.active = status === "active";
      if (typeId) params.type_id = typeId;
      const { data } = await catalogApi.listServices(params);
      setServices(data?.items ?? []);
      setTotal(data?.total ?? 0);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, status, typeId, offset]);

  useEffect(() => { loadTypes(); }, [loadTypes]);
  useEffect(() => { loadServices(); }, [loadServices]);

  const setActive = async (service, active) => {
    setBusy(true);
    try {
      await catalogApi.updateService(service.id, { active });
      toast.success(tRef.current(active ? "catalogPage.activatedToast" : "catalogPage.deactivatedToast"));
      setToDeactivate(null);
      await loadServices();
    } catch (err) {
      toast.error(tRef.current(err?.response?.status === 403 ? "catalogPage.forbidden" : "catalogPage.genericError"));
    } finally {
      setBusy(false);
    }
  };

  const filtered = Boolean(debouncedSearch || status !== "all" || typeId);
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">{t("catalogPage.title")}</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">{t("catalogPage.subtitle")}</p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setTypesOpen(true)}>{t("catalogPage.manageTypes")}</Button>
            <Button onClick={() => setFormService(null)}>{t("catalogPage.newService")}</Button>
          </div>
        )}
      </div>

      {!canManage && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600" role="note">{t("catalogPage.readOnly")}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          aria-label={t("catalogPage.search")}
          placeholder={t("catalogPage.search")}
          className={`${filterClass} min-w-[220px] flex-1`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select aria-label={t("catalogPage.status")} className={filterClass} value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }}>
          <option value="all">{t("catalogPage.allStatus")}</option>
          <option value="active">{t("catalogPage.active")}</option>
          <option value="inactive">{t("catalogPage.inactive")}</option>
        </select>
        <select aria-label={t("catalogPage.type")} className={filterClass} value={typeId} onChange={(event) => { setTypeId(event.target.value); setOffset(0); }}>
          <option value="">{t("catalogPage.allTypes")}</option>
          {types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
        </select>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">{t("catalogPage.name")}</th>
              <th className="px-3 py-2 text-left">{t("catalogPage.type")}</th>
              <th className="px-3 py-2 text-left">{t("catalogPage.unit")}</th>
              <th className="px-3 py-2 text-right">{t("catalogPage.price")}</th>
              <th className="px-3 py-2 text-left">{t("catalogPage.status")}</th>
              {canManage && <th className="px-3 py-2 text-right">{t("catalogPage.actions")}</th>}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={canManage ? 6 : 5} className="px-3 py-10 text-center text-slate-400">
                <span className="inline-flex items-center gap-2"><Spinner size={16} />{t("catalogPage.loading")}</span>
              </td></tr>
            )}
            {!loading && error && (
              <tr><td colSpan={canManage ? 6 : 5} className="px-3 py-10 text-center text-red-500" role="alert">
                {t("catalogPage.error")}{" "}
                <button type="button" className="underline" onClick={loadServices}>{t("catalogPage.retry")}</button>
              </td></tr>
            )}
            {!loading && !error && services.length === 0 && (
              <tr><td colSpan={canManage ? 6 : 5} className="px-3 py-10 text-center text-slate-400">
                {filtered ? t("catalogPage.emptyFiltered") : t("catalogPage.empty")}
              </td></tr>
            )}
            {!loading && !error && services.map((service) => (
              <tr key={service.id} data-testid={`service-row-${service.id}`} className={`border-t border-slate-100 ${service.active ? "" : "opacity-50"}`}>
                <td className="px-3 py-2">
                  <p className="font-medium text-slate-900">{service.name}</p>
                  {service.description && <p className="text-xs text-slate-500">{service.description}</p>}
                  {service.conditions && <p className="text-xs text-slate-400">{service.conditions}</p>}
                </td>
                <td className="px-3 py-2 text-slate-600">{service.typeName || "—"}</td>
                <td className="px-3 py-2 text-slate-600">{service.unit}</td>
                <td className="px-3 py-2 text-right font-semibold text-slate-800">{formatMoney(service.price, service.currency, { exact: true })}</td>
                <td className="px-3 py-2">
                  <Badge status={service.active ? "generated" : "draft"} label={service.active ? t("catalogPage.active") : t("catalogPage.inactive")} />
                </td>
                {canManage && (
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setFormService(service)}>{t("catalogPage.edit")}</Button>
                      {service.active ? (
                        <Button size="sm" variant="secondary" onClick={() => setToDeactivate(service)}>{t("catalogPage.deactivate")}</Button>
                      ) : (
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setActive(service, true)}>{t("catalogPage.activate")}</Button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>{t("catalogPage.showing")} {from}–{to} {t("catalogPage.of")} {total}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>{t("catalogPage.previous")}</Button>
            <Button size="sm" variant="secondary" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>{t("catalogPage.next")}</Button>
          </div>
        </div>
      )}

      {canManage && (
        <>
          <ServiceFormModal
            open={formService !== undefined}
            onClose={() => setFormService(undefined)}
            service={formService}
            types={types}
            onSaved={() => { setFormService(undefined); loadServices(); }}
          />
          <ServiceTypesModal
            open={typesOpen}
            onClose={() => setTypesOpen(false)}
            types={types}
            onChanged={() => { loadTypes(); loadServices(); }}
          />
          <Modal open={Boolean(toDeactivate)} onClose={() => setToDeactivate(null)} title={t("catalogPage.deactivateTitle")} maxWidth="sm">
            <p className="text-sm text-slate-700"><strong>{toDeactivate?.name}</strong> · {toDeactivate?.unit}</p>
            <p className="mt-2 text-sm text-slate-500">{t("catalogPage.deactivateConfirm")}</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setToDeactivate(null)}>{t("catalogPage.cancel")}</Button>
              <Button variant="destructive" loading={busy} onClick={() => setActive(toDeactivate, false)}>{t("catalogPage.deactivate")}</Button>
            </div>
          </Modal>
        </>
      )}
    </div>
  );
}
