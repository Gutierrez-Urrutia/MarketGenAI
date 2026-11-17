/**
 * CustomersPage — RF-VTA-03: clientes con perfil (industria y tamaño) e historial de propuestas.
 * Cada usuario ve y gestiona solo sus propios clientes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";

import { customersApi } from "@/api/customersApi";
import { Button, Modal, Spinner } from "@/components/ui";
import { CustomerDetailModal } from "@/features/customers/CustomerDetailModal";
import { CustomerFormModal } from "@/features/customers/CustomerFormModal";
import { CustomerImportModal } from "@/features/customers/CustomerImportModal";
import { useCustomerOptions } from "@/features/customers/useCustomerOptions";
import { useI18n } from "@/hooks/useI18n";

const PAGE_SIZE = 20;
const filterClass = "px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-500";

export function CustomersPage() {
  const { t } = useI18n();
  const tRef = useRef(t); // useI18n devuelve un t nuevo en cada render: no debe disparar la recarga
  tRef.current = t;
  const options = useCustomerOptions();

  const [customers, setCustomers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [industry, setIndustry] = useState("");
  const [size, setSize] = useState("");
  const [offset, setOffset] = useState(0);
  const [formCustomer, setFormCustomer] = useState(undefined); // undefined = cerrado, null = nuevo
  const [detailCustomer, setDetailCustomer] = useState(null);
  const [toDelete, setToDelete] = useState(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => { setDebouncedSearch(search.trim()); setOffset(0); }, 250);
    return () => clearTimeout(handle);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const params = { limit: PAGE_SIZE, offset };
      if (debouncedSearch) params.search = debouncedSearch;
      if (industry) params.industry = industry;
      if (size) params.size = size;
      const { data } = await customersApi.list(params);
      setCustomers(data?.items ?? []);
      setTotal(data?.total ?? 0);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, industry, size, offset]);

  useEffect(() => { load(); }, [load]);

  const confirmDelete = async () => {
    setDeleting(true);
    setDeleteError("");
    try {
      await customersApi.remove(toDelete.id);
      toast.success(tRef.current("customersPage.deleted"));
      setToDelete(null);
      await load();
    } catch (err) {
      const detail = err?.response?.data?.detail;
      if (err?.response?.status === 409 && detail?.proposalCount) {
        setDeleteError(tRef.current("customersPage.deleteBlocked").replace("{count}", String(detail.proposalCount)));
      } else {
        setDeleteError(tRef.current("customersPage.genericError"));
      }
    } finally {
      setDeleting(false);
    }
  };

  const filtered = Boolean(debouncedSearch || industry || size);
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">{t("customersPage.title")}</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">{t("customersPage.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setImportOpen(true)}>{t("customersPage.importCsv")}</Button>
          <Button onClick={() => setFormCustomer(null)}>{t("customersPage.newCustomer")}</Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          aria-label={t("customersPage.search")}
          placeholder={t("customersPage.search")}
          className={`${filterClass} min-w-[220px] flex-1`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select aria-label={t("customersPage.industry")} className={filterClass} value={industry} onChange={(event) => { setIndustry(event.target.value); setOffset(0); }}>
          <option value="">{t("customersPage.allIndustries")}</option>
          {options.industries.map((item) => <option key={item.value} value={item.value}>{options.optionLabel(item)}</option>)}
        </select>
        <select aria-label={t("customersPage.size")} className={filterClass} value={size} onChange={(event) => { setSize(event.target.value); setOffset(0); }}>
          <option value="">{t("customersPage.allSizes")}</option>
          {options.sizes.map((item) => <option key={item.value} value={item.value}>{options.optionLabel(item)}</option>)}
        </select>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">{t("customersPage.name")}</th>
              <th className="px-3 py-2 text-left">{t("customersPage.email")}</th>
              <th className="px-3 py-2 text-left">{t("customersPage.industry")}</th>
              <th className="px-3 py-2 text-left">{t("customersPage.size")}</th>
              <th className="px-3 py-2 text-right">{t("customersPage.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} className="px-3 py-10 text-center text-slate-400">
                <span className="inline-flex items-center gap-2"><Spinner size={16} />{t("customersPage.loading")}</span>
              </td></tr>
            )}
            {!loading && error && (
              <tr><td colSpan={5} className="px-3 py-10 text-center text-red-500" role="alert">
                {t("customersPage.error")}{" "}
                <button type="button" className="underline" onClick={load}>{t("customersPage.retry")}</button>
              </td></tr>
            )}
            {!loading && !error && customers.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-10 text-center text-slate-400">
                {filtered ? t("customersPage.emptyFiltered") : t("customersPage.empty")}
              </td></tr>
            )}
            {!loading && !error && customers.map((customer) => (
              <tr key={customer.id} data-testid={`customer-row-${customer.id}`} className="border-t border-slate-100">
                <td className="px-3 py-2">
                  <p className="font-medium text-slate-900">{customer.name}</p>
                  {customer.company && <p className="text-xs text-slate-500">{customer.company}</p>}
                </td>
                <td className="px-3 py-2 text-slate-600">{customer.email}</td>
                <td className="px-3 py-2">
                  {customer.industry
                    ? <span className="text-slate-700">{options.industryLabel(customer.industry)}</span>
                    : <span className="inline-flex rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">{t("customersPage.undefined")}</span>}
                </td>
                <td className="px-3 py-2">
                  {customer.size
                    ? <span className="text-slate-700">{options.sizeLabel(customer.size)}</span>
                    : <span className="inline-flex rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">{t("customersPage.undefined")}</span>}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setDetailCustomer(customer)}>{t("customersPage.view")}</Button>
                    <Button size="sm" variant="secondary" onClick={() => setFormCustomer(customer)}>{t("customersPage.edit")}</Button>
                    <Button size="sm" variant="secondary" onClick={() => { setToDelete(customer); setDeleteError(""); }}>{t("customersPage.delete")}</Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>{t("customersPage.showing")} {from}–{to} {t("customersPage.of")} {total}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>{t("customersPage.previous")}</Button>
            <Button size="sm" variant="secondary" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>{t("customersPage.next")}</Button>
          </div>
        </div>
      )}

      <CustomerFormModal
        open={formCustomer !== undefined}
        onClose={() => setFormCustomer(undefined)}
        customer={formCustomer}
        options={options}
        onSaved={() => { setFormCustomer(undefined); load(); }}
      />
      <CustomerDetailModal
        open={Boolean(detailCustomer)}
        onClose={() => setDetailCustomer(null)}
        customer={detailCustomer}
        options={options}
      />
      <CustomerImportModal open={importOpen} onClose={() => setImportOpen(false)} onImported={load} />

      <Modal open={Boolean(toDelete)} onClose={() => setToDelete(null)} title={t("customersPage.deleteTitle")} maxWidth="sm">
        <p className="text-sm text-slate-700"><strong>{toDelete?.name}</strong>{toDelete?.company ? ` · ${toDelete.company}` : ""}</p>
        <p className="mt-2 text-sm text-slate-500">{t("customersPage.deleteConfirm")}</p>
        {deleteError && <p className="mt-3 text-sm text-red-500" role="alert">{deleteError}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setToDelete(null)}>{t("customersPage.cancel")}</Button>
          <Button variant="destructive" loading={deleting} onClick={confirmDelete}>{t("customersPage.delete")}</Button>
        </div>
      </Modal>
    </div>
  );
}
