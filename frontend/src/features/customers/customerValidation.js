// Validaciones del formulario de cliente (RF-VTA-03). Devuelven claves de traducción
// `customersPage.errors.*`; los errores del servidor se muestran tal cual, por campo.

export const NAME_MAX = 200;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** @returns {Record<string, string>} errores por campo (vacío si el formulario es válido) */
export function validateCustomerForm(values) {
  const errors = {};
  const name = String(values.name || "").trim();
  const email = String(values.email || "").trim();
  if (!name) errors.name = "customersPage.errors.required";
  else if (name.length > NAME_MAX) errors.name = "customersPage.errors.nameMax";
  if (!email) errors.email = "customersPage.errors.required";
  else if (!EMAIL.test(email)) errors.email = "customersPage.errors.emailInvalid";
  return errors;
}

/** 422 trae `detail: [{loc, msg}]`; lo que no se pueda ubicar va en `_form`. */
export function serverErrorsByField(error) {
  const status = error?.response?.status;
  const detail = error?.response?.data?.detail;
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
