/**
 * ServiceFormModal — alta y edición de un servicio del catálogo (RF-VTA-02).
 * Valida en el cliente igual que el servidor y muestra además el error que devuelve el servidor por campo.
 */
import { useEffect, useState } from "react";
import toast from "react-hot-toast";

import { catalogApi } from "@/api/catalogApi";
import { Button, Input, Modal, Textarea } from "@/components/ui";
import {
  CONDITIONS_MAX,
  CURRENCIES,
  NAME_MAX,
  UNIT_MAX,
  serverErrorsByField,
  validateServiceForm,
} from "@/features/catalog/catalogValidation";
import { useI18n } from "@/hooks/useI18n";

const selectClass = "w-full px-3 py-2 text-sm border rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-500";

const emptyForm = { name: "", description: "", unit: "", typeId: "", currency: "USD", price: "", conditions: "" };

const fromService = (service) => ({
  name: service.name || "",
  description: service.description || "",
  unit: service.unit || "",
  typeId: service.typeId || "",
  currency: service.currency || "USD",
  price: service.price === undefined || service.price === null ? "" : String(service.price),
  conditions: service.conditions || "",
});

export function ServiceFormModal({ open, onClose, service, types, onSaved }) {
  const { t } = useI18n();
  const [values, setValues] = useState(emptyForm);
  const [clientErrors, setClientErrors] = useState({});
  const [serverErrors, setServerErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const editing = Boolean(service?.id);

  useEffect(() => {
    if (!open) return;
    setValues(editing ? fromService(service) : emptyForm);
    setClientErrors({});
    setServerErrors({});
  }, [open, service?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Un tipo inactivo no se ofrece para servicios nuevos, pero el servicio que ya lo tiene lo conserva.
  const typeOptions = types.filter((type) => type.active || type.id === service?.typeId);

  const setField = (field) => (event) => {
    const value = event.target.value;
    setValues((prev) => ({ ...prev, [field]: value }));
    setClientErrors((prev) => ({ ...prev, [field]: undefined }));
    setServerErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const fieldError = (field) => (clientErrors[field] ? t(clientErrors[field]) : serverErrors[field]);

  const submit = async (event) => {
    event.preventDefault();
    const errors = validateServiceForm(values);
    setClientErrors(errors);
    if (Object.keys(errors).length) return;

    const payload = {
      name: values.name.trim(),
      description: values.description.trim(),
      unit: values.unit.trim(),
      typeId: values.typeId,
      currency: values.currency,
      price: Number(values.price),
      conditions: values.conditions,
    };
    setSaving(true);
    try {
      const { data } = editing
        ? await catalogApi.updateService(service.id, payload)
        : await catalogApi.createService(payload);
      toast.success(t("catalogPage.saved"));
      onSaved(data);
    } catch (error) {
      const mapped = serverErrorsByField(error);
      setServerErrors(mapped);
      if (mapped._status === 403) toast.error(t("catalogPage.forbidden"));
      else if (mapped._form || (!mapped._status || mapped._status >= 500)) toast.error(mapped._form || t("catalogPage.genericError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? t("catalogPage.editService") : t("catalogPage.newServiceTitle")} maxWidth="2xl">
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label={t("catalogPage.name")} value={values.name} onChange={setField("name")} maxLength={NAME_MAX + 50} error={fieldError("name")} />
          <Input label={t("catalogPage.unit")} value={values.unit} onChange={setField("unit")} maxLength={UNIT_MAX + 20} error={fieldError("unit")} />
        </div>

        <Textarea label={t("catalogPage.description")} value={values.description} onChange={setField("description")} error={fieldError("description")} />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <label htmlFor="service-type" className="block text-sm font-medium text-slate-700">{t("catalogPage.type")}</label>
            <select id="service-type" className={`${selectClass} ${fieldError("typeId") ? "border-red-400" : "border-slate-300"}`} value={values.typeId} onChange={setField("typeId")}>
              <option value="">{t("catalogPage.selectType")}</option>
              {typeOptions.map((type) => (
                <option key={type.id} value={type.id}>{type.name}</option>
              ))}
            </select>
            {fieldError("typeId") && <p className="text-xs text-red-500">{fieldError("typeId")}</p>}
          </div>
          <div className="space-y-1">
            <label htmlFor="service-currency" className="block text-sm font-medium text-slate-700">{t("catalogPage.currency")}</label>
            <select id="service-currency" className={`${selectClass} border-slate-300`} value={values.currency} onChange={setField("currency")}>
              {CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
            {fieldError("currency") && <p className="text-xs text-red-500">{fieldError("currency")}</p>}
          </div>
          <Input label={t("catalogPage.price")} inputMode="decimal" value={values.price} onChange={setField("price")} error={fieldError("price")} />
        </div>

        <div>
          <Textarea label={t("catalogPage.conditions")} value={values.conditions} onChange={setField("conditions")} error={fieldError("conditions")} />
          <p className={`mt-1 text-right text-xs ${values.conditions.length > CONDITIONS_MAX ? "text-red-500" : "text-slate-400"}`} data-testid="conditions-counter">
            {values.conditions.length}/{CONDITIONS_MAX}
          </p>
        </div>

        {serverErrors._form && <p className="text-sm text-red-500" role="alert">{serverErrors._form}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>{t("catalogPage.cancel")}</Button>
          <Button type="submit" loading={saving}>{t("catalogPage.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}
