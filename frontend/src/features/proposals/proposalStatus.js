// Estado comercial de la propuesta (campo `proposal_status`, RF-VTA-05).
// Única fuente en el frontend: códigos, transiciones, etiquetas (vía i18n) y colores.
// Debe coincidir con backend/app/schemas/proposal.py. No confundir con `status`,
// que es el ciclo de generación con IA.

export const PROPOSAL_STATUS = Object.freeze({
  BORRADOR: "borrador",
  ENVIADA: "enviada",
  VISTA: "vista",
  EN_NEGOCIACION: "en_negociacion",
  FIRMADA: "firmada",
  RECHAZADA: "rechazada",
});

// Solo para mostrar: un valor que el backend no reconoce llega tal cual.
export const UNKNOWN_PROPOSAL_STATUS = "desconocido";

export const PROPOSAL_STATUS_CODES = Object.freeze([
  PROPOSAL_STATUS.BORRADOR,
  PROPOSAL_STATUS.ENVIADA,
  PROPOSAL_STATUS.VISTA,
  PROPOSAL_STATUS.EN_NEGOCIACION,
  PROPOSAL_STATUS.FIRMADA,
  PROPOSAL_STATUS.RECHAZADA,
]);

// Orden para reportes y leyendas: los 6 códigos y "desconocido" al final.
export const PROPOSAL_STATUS_DISPLAY_ORDER = Object.freeze([...PROPOSAL_STATUS_CODES, UNKNOWN_PROPOSAL_STATUS]);

// Todo lo que no está aquí es inválido, incluido misma→misma. Firmada es final.
export const PROPOSAL_STATUS_TRANSITIONS = Object.freeze({
  [PROPOSAL_STATUS.BORRADOR]: Object.freeze([PROPOSAL_STATUS.ENVIADA]),
  [PROPOSAL_STATUS.ENVIADA]: Object.freeze([PROPOSAL_STATUS.VISTA, PROPOSAL_STATUS.EN_NEGOCIACION, PROPOSAL_STATUS.RECHAZADA]),
  [PROPOSAL_STATUS.VISTA]: Object.freeze([PROPOSAL_STATUS.EN_NEGOCIACION, PROPOSAL_STATUS.RECHAZADA]),
  [PROPOSAL_STATUS.EN_NEGOCIACION]: Object.freeze([PROPOSAL_STATUS.FIRMADA, PROPOSAL_STATUS.RECHAZADA]),
  [PROPOSAL_STATUS.FIRMADA]: Object.freeze([]),
  [PROPOSAL_STATUS.RECHAZADA]: Object.freeze([PROPOSAL_STATUS.EN_NEGOCIACION]),
});

export const isProposalStatusCode = (value) => PROPOSAL_STATUS_CODES.includes(value);

// Reapertura: rechazada → en_negociacion, solo admin.
export const isAdminOnlyTransition = (from, to) =>
  from === PROPOSAL_STATUS.RECHAZADA && to === PROPOSAL_STATUS.EN_NEGOCIACION;

// Destinos que el usuario puede elegir desde `current`. Estado desconocido → ninguno.
export const getAllowedTransitions = (current, { isAdmin = false } = {}) =>
  (PROPOSAL_STATUS_TRANSITIONS[current] || []).filter((to) => isAdmin || !isAdminOnlyTransition(current, to));

// Destinos que piden confirmación antes de enviarse: firmada es final y rechazada
// solo la reabre un admin.
export const PROPOSAL_STATUSES_REQUIRING_CONFIRMATION = Object.freeze([PROPOSAL_STATUS.FIRMADA, PROPOSAL_STATUS.RECHAZADA]);

export const requiresStatusConfirmation = (to) => PROPOSAL_STATUSES_REQUIRING_CONFIRMATION.includes(to);

// Valor a mostrar: ausente → borrador (igual que el backend); no reconocido → "desconocido".
export const toDisplayProposalStatus = (value) => {
  if (value === undefined || value === null) return PROPOSAL_STATUS.BORRADOR;
  return isProposalStatusCode(value) ? value : UNKNOWN_PROPOSAL_STATUS;
};

export const proposalStatusLabelKey = (value) => `proposalStatus.labels.${toDisplayProposalStatus(value)}`;

export const PROPOSAL_STATUS_COLOR_CLASSES = Object.freeze({
  [PROPOSAL_STATUS.BORRADOR]: "bg-slate-100 text-slate-500",
  [PROPOSAL_STATUS.ENVIADA]: "bg-blue-50 text-blue-500",
  [PROPOSAL_STATUS.VISTA]: "bg-indigo-50 text-indigo-600",
  [PROPOSAL_STATUS.EN_NEGOCIACION]: "bg-amber-50 text-amber-800",
  [PROPOSAL_STATUS.FIRMADA]: "bg-green-50 text-green-600",
  [PROPOSAL_STATUS.RECHAZADA]: "bg-rose-50 text-rose-700",
  [UNKNOWN_PROPOSAL_STATUS]: "bg-gray-100 text-gray-600",
});

export const PROPOSAL_STATUS_CHART_COLORS = Object.freeze({
  [PROPOSAL_STATUS.BORRADOR]: "rgb(var(--brand-600))",
  [PROPOSAL_STATUS.ENVIADA]: "#3B82F6",
  [PROPOSAL_STATUS.VISTA]: "#6366F1",
  [PROPOSAL_STATUS.EN_NEGOCIACION]: "#F59E0B",
  [PROPOSAL_STATUS.FIRMADA]: "#16A34A",
  [PROPOSAL_STATUS.RECHAZADA]: "#F43F5E",
  [UNKNOWN_PROPOSAL_STATUS]: "#9CA3AF",
});

export const proposalStatusColorClass = (value) => PROPOSAL_STATUS_COLOR_CLASSES[toDisplayProposalStatus(value)];
export const proposalStatusChartColor = (value) => PROPOSAL_STATUS_CHART_COLORS[toDisplayProposalStatus(value)];

// Mensaje i18n para un error del PATCH /proposals/{id}/status. El `detail` del
// servidor solo se usa como respaldo (códigos no previstos).
export const proposalStatusErrorMessage = (error, { from, to } = {}, t) => {
  const code = error?.response?.status;
  if (code === 422) return t("proposalStatus.errors.invalidStatus");
  if (code === 409) {
    return toDisplayProposalStatus(from) === UNKNOWN_PROPOSAL_STATUS
      ? t("proposalStatus.errors.unknownStatus")
      : t("proposalStatus.errors.invalidTransition");
  }
  if (code === 403) {
    return isAdminOnlyTransition(from, to)
      ? t("proposalStatus.errors.reopenAdminOnly")
      : t("proposalStatus.errors.forbidden");
  }
  const detail = error?.response?.data?.detail;
  return typeof detail === "string" && detail ? detail : t("proposalStatus.errors.generic");
};
