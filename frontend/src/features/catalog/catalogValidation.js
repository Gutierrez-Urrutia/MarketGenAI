// Validaciones del formulario de servicio, iguales a las del servidor (RF-VTA-02).
// Devuelven claves de traducción `catalogPage.errors.*`, no textos.

export const CONDITIONS_MAX = 1000;
export const NAME_MAX = 200;
export const UNIT_MAX = 50;
export const CURRENCIES = ["USD", "CLP"];

export function validatePrice(rawPrice, currency) {
  const text = String(rawPrice ?? "").trim();
  if (!text) return "catalogPage.errors.priceRequired";
  if (!/^\d+(\.\d+)?$/.test(text)) return "catalogPage.errors.priceNumber";
  if (Number(text) <= 0) return "catalogPage.errors.priceGreater";
  if (currency === "CLP" && text.includes(".")) return "catalogPage.errors.clpInteger";
  if (currency === "USD" && /\.\d{3,}$/.test(text)) return "catalogPage.errors.usdDecimals";
  return null;
}

/** @returns {Record<string, string>} errores por campo (vacío si el formulario es válido) */
export function validateServiceForm(values) {
  const errors = {};
  const name = String(values.name || "").trim();
  const unit = String(values.unit || "").trim();
  if (!name) errors.name = "catalogPage.errors.required";
  else if (name.length > NAME_MAX) errors.name = "catalogPage.errors.nameMax";
  if (!unit) errors.unit = "catalogPage.errors.required";
  else if (unit.length > UNIT_MAX) errors.unit = "catalogPage.errors.unitMax";
  if (!values.typeId) errors.typeId = "catalogPage.errors.required";
  if (!CURRENCIES.includes(values.currency)) errors.currency = "catalogPage.errors.required";
  const priceError = validatePrice(values.price, values.currency);
  if (priceError) errors.price = priceError;
  if (String(values.conditions || "").length > CONDITIONS_MAX) errors.conditions = "catalogPage.errors.conditionsMax";
  return errors;
}

/**
 * Traduce el error del servidor a errores por campo: 422 trae `detail: [{loc, msg}]`;
 * 409 (duplicado) se muestra en el nombre. Lo que no se pueda ubicar va en `_form`.
 */
export function serverErrorsByField(error) {
  const status = error?.response?.status;
  const detail = error?.response?.data?.detail;
  if (status === 409) return { name: typeof detail === "string" ? detail : "Duplicate", _status: 409 };
  if (status === 422 && Array.isArray(detail)) {
    const fields = {};
    detail.forEach((item) => {
      const field = Array.isArray(item?.loc) ? item.loc[item.loc.length - 1] : null;
      const key = typeof field === "string" ? field : "_form";
      fields[key] = fields[key] ? `${fields[key]} ${item.msg}` : item.msg;
    });
    return { ...fields, _status: 422 };
  }
  if (typeof detail === "string" && detail.trim()) return { _form: detail, _status: status };
  return { _form: null, _status: status };
}
