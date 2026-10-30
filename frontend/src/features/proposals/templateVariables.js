// RF-VTA-07: variables {nombre} de las plantillas de propuesta. Mismo patrón que
// backend/app/services/template_service.py: también reconoce {{nombre}}, que es lo
// que guardaba el editor de Settings antes.
const PLACEHOLDER = /\{\{\s*([A-Za-z_]\w*)\s*\}\}|\{([A-Za-z_]\w*)\}/g;

/** Nombres de variable en el orden en que aparecen, sin repetir. */
export function extractVariables(...texts) {
  const names = [];
  for (const text of texts) {
    for (const match of String(text || "").matchAll(PLACEHOLDER)) {
      const name = match[1] || match[2];
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** Inserta `{name}` en la posición del cursor (o reemplaza la selección). */
export function insertVariable(text, name, selectionStart, selectionEnd = selectionStart) {
  const value = String(text || "");
  const start = Number.isInteger(selectionStart) ? selectionStart : value.length;
  const end = Number.isInteger(selectionEnd) ? selectionEnd : start;
  const token = `{${name}}`;
  return { text: value.slice(0, start) + token + value.slice(end), cursor: start + token.length };
}

/** Etiqueta de una opción del catálogo ({ value, labels: { es, en, pt } }) en el idioma activo. */
export function catalogLabel(option, language) {
  if (!option) return "";
  return option.labels?.[language] || option.labels?.es || option.value;
}
