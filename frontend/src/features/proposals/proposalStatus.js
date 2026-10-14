export const PROPOSAL_STATUSES = [
  { value: "Generada", labelKey: "generated" },
  { value: "Entregada", labelKey: "delivered" },
  { value: "En Negociación", labelKey: "inNegotiation" },
  { value: "Cerrada", labelKey: "closed" },
  { value: "En Contrato", labelKey: "underContract" },
  { value: "Perdida", labelKey: "lost" },
];

export const PROPOSAL_STATUS_COLOR_CLASSES = {
  Generada: "bg-slate-100 text-slate-500",
  Entregada: "bg-blue-50 text-blue-500",
  "En Negociación": "bg-amber-50 text-amber-800",
  Cerrada: "bg-green-50 text-green-600",
  "En Contrato": "bg-emerald-50 text-emerald-700",
  Perdida: "bg-rose-50 text-rose-700",
};
