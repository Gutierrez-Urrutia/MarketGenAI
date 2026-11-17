/**
 * CustomerFormModal — alta y edición de un cliente con su perfil (RF-VTA-03).
 * Industria y tamaño son opcionales; el servidor valida y su error se muestra por campo.
 */
import { useEffect, useState } from "react";
import toast from "react-hot-toast";

import { customersApi } from "@/api/customersApi";
import { Button, Input, Modal, Textarea } from "@/components/ui";
import { NAME_MAX, serverErrorsByField, validateCustomerForm } from "@/features/customers/customerValidation";
import { useI18n } from "@/hooks/useI18n";

const selectClass = "w-full px-3 py-2 text-sm border rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-500";
const emptyForm = { name: "", email: "", company: "", phone: "", industry: "", size: "", notes: "" };

const fromCustomer = (customer) => ({
  name: customer.name || "",
  email: customer.email || "",
  company: customer.company || "",
  phone: customer.phone || "",
  industry: customer.industry || "",
  size: customer.size || "",
  notes: customer.notes || "",
});

export function CustomerFormModal({ open, onClose, customer, options, onSaved }) {
  const { t } = useI18n();
  const [values, setValues] = useState(emptyForm);
  const [clientErrors, setClientErrors] = useState({});
  const [serverErrors, setServerErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const editing = Boolean(customer?.id);

  useEffect(() => {
    if (!open) return;
    setValues(editing ? fromCustomer(customer) : emptyForm);
    setClientErrors({});
    setServerErrors({});
  }, [open, customer?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const setField = (field) => (event) => {
    const value = event.target.value;
    setValues((prev) => ({ ...prev, [field]: value }));
    setClientErrors((prev) => ({ ...prev, [field]: undefined }));
    setServerErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const fieldError = (field) => (clientErrors[field] ? t(clientErrors[field]) : serverErrors[field]);

  const submit = async (event) => {
    event.preventDefault();
    const errors = validateCustomerForm(values);
    setClientErrors(errors);
    if (Object.keys(errors).length) return;

    // "" en industria/tamaño = sin dato; al editar sirve para vaciar un valor ya guardado.
    const payload = {
      name: values.name.trim(),
      email: values.email.trim(),
      company: values.company.trim() || undefined,
      phone: values.phone.trim() || undefined,
      notes: values.notes.trim() || undefined,
      industry: values.industry,
      size: values.size,
    };
    setSaving(true);
    try {
      const { data } = editing
        ? await customersApi.update(customer.id, payload)
        : await customersApi.create(payload);
      toast.success(t("customersPage.saved"));
      onSaved(data);
    } catch (error) {
      const mapped = serverErrorsByField(error);
      setServerErrors(mapped);
      if (mapped._form || !mapped._status || mapped._status >= 500) toast.error(mapped._form || t("customersPage.genericError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? t("customersPage.editCustomer") : t("customersPage.newCustomer")} maxWidth="2xl">
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label={t("customersPage.name")} value={values.name} onChange={setField("name")} maxLength={NAME_MAX + 50} error={fieldError("name")} />
          <Input label={t("customersPage.email")} type="email" value={values.email} onChange={setField("email")} error={fieldError("email")} />
          <Input label={t("customersPage.company")} value={values.company} onChange={setField("company")} error={fieldError("company")} />
          <Input label={t("customersPage.phone")} value={values.phone} onChange={setField("phone")} error={fieldError("phone")} />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor="customer-industry" className="block text-sm font-medium text-slate-700">{t("customersPage.industry")}</label>
            <select id="customer-industry" className={`${selectClass} ${fieldError("industry") ? "border-red-400" : "border-slate-300"}`} value={values.industry} onChange={setField("industry")}>
              <option value="">{t("customersPage.undefined")}</option>
              {options.industries.map((item) => <option key={item.value} value={item.value}>{options.optionLabel(item)}</option>)}
            </select>
            {fieldError("industry") && <p className="text-xs text-red-500">{fieldError("industry")}</p>}
          </div>
          <div className="space-y-1">
            <label htmlFor="customer-size" className="block text-sm font-medium text-slate-700">{t("customersPage.size")}</label>
            <select id="customer-size" className={`${selectClass} ${fieldError("size") ? "border-red-400" : "border-slate-300"}`} value={values.size} onChange={setField("size")}>
              <option value="">{t("customersPage.undefined")}</option>
              {options.sizes.map((item) => (
                <option key={item.value} value={item.value}>{options.optionLabel(item)} ({item.employees})</option>
              ))}
            </select>
            {fieldError("size") && <p className="text-xs text-red-500">{fieldError("size")}</p>}
          </div>
        </div>
        <p className="text-xs text-slate-500">{t("customersPage.profileHint")}</p>

        <Textarea label={t("customersPage.notes")} value={values.notes} onChange={setField("notes")} error={fieldError("notes")} />

        {serverErrors._form && <p className="text-sm text-red-500" role="alert">{serverErrors._form}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>{t("customersPage.cancel")}</Button>
          <Button type="submit" loading={saving}>{t("customersPage.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}
