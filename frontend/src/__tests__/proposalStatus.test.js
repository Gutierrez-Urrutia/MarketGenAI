// RF-VTA-05: reglas de estado de propuesta del frontend (features/proposals/proposalStatus.js).
import { describe, it, expect } from "vitest";
import {
  PROPOSAL_STATUS_CODES,
  PROPOSAL_STATUS_COLOR_CLASSES,
  PROPOSAL_STATUS_CHART_COLORS,
  PROPOSAL_STATUS_DISPLAY_ORDER,
  UNKNOWN_PROPOSAL_STATUS,
  getAllowedTransitions,
  isAdminOnlyTransition,
  proposalStatusErrorMessage,
  proposalStatusLabelKey,
  toDisplayProposalStatus,
} from "@/features/proposals/proposalStatus";
import { translations } from "@/i18n/translations";

const STATES = ["borrador", "enviada", "vista", "en_negociacion", "firmada", "rechazada"];

// Tabla escrita a mano desde el requerimiento (no se reutiliza la del código).
const ALLOWED = new Set([
  "borrador>enviada",
  "enviada>vista", "enviada>en_negociacion", "enviada>rechazada",
  "vista>en_negociacion", "vista>rechazada",
  "en_negociacion>firmada", "en_negociacion>rechazada",
]);
const REOPEN = "rechazada>en_negociacion";

describe("códigos", () => {
  it("son los 6 del backend, en orden, y 'desconocido' va al final al mostrar", () => {
    expect([...PROPOSAL_STATUS_CODES]).toEqual(STATES);
    expect([...PROPOSAL_STATUS_DISPLAY_ORDER]).toEqual([...STATES, "desconocido"]);
  });
});

describe("getAllowedTransitions: las 36 combinaciones", () => {
  for (const isAdmin of [false, true]) {
    for (const from of STATES) {
      for (const to of STATES) {
        const pair = `${from}>${to}`;
        const expected = ALLOWED.has(pair) || (pair === REOPEN && isAdmin);
        it(`${pair} ${isAdmin ? "admin" : "no admin"} → ${expected ? "permitido" : "no permitido"}`, () => {
          expect(getAllowedTransitions(from, { isAdmin }).includes(to)).toBe(expected);
        });
      }
    }
  }

  it("misma→misma nunca está permitida", () => {
    for (const state of STATES) {
      expect(getAllowedTransitions(state, { isAdmin: true })).not.toContain(state);
    }
  });

  it("firmada es final, también para admin", () => {
    expect(getAllowedTransitions("firmada", { isAdmin: true })).toEqual([]);
  });

  it("rechazada: sin admin no hay destinos; con admin solo en_negociacion", () => {
    expect(getAllowedTransitions("rechazada")).toEqual([]);
    expect(getAllowedTransitions("rechazada", { isAdmin: true })).toEqual(["en_negociacion"]);
  });

  it("un estado desconocido no tiene destinos", () => {
    for (const value of ["desconocido", "Ganada", "Generada", undefined, null, ""]) {
      expect(getAllowedTransitions(value, { isAdmin: true })).toEqual([]);
    }
  });

  it("solo la reapertura es exclusiva de admin", () => {
    for (const from of STATES) {
      for (const to of STATES) {
        expect(isAdminOnlyTransition(from, to)).toBe(`${from}>${to}` === REOPEN);
      }
    }
  });
});

describe("toDisplayProposalStatus", () => {
  it("deja igual los 6 códigos", () => {
    for (const state of STATES) expect(toDisplayProposalStatus(state)).toBe(state);
  });

  it("ausente → borrador, como en el backend", () => {
    expect(toDisplayProposalStatus(undefined)).toBe("borrador");
    expect(toDisplayProposalStatus(null)).toBe("borrador");
  });

  it("cualquier otro valor → desconocido (solo para mostrar)", () => {
    for (const value of ["Generada", "En Negociación", "Ganada", "BORRADOR", "", 3]) {
      expect(toDisplayProposalStatus(value)).toBe(UNKNOWN_PROPOSAL_STATUS);
    }
  });
});

describe("etiquetas y colores", () => {
  it("hay etiqueta es/en/pt y colores para los 6 códigos y desconocido", () => {
    for (const value of PROPOSAL_STATUS_DISPLAY_ORDER) {
      for (const lang of ["es", "en", "pt"]) {
        expect(translations[lang].proposalStatus.labels[value], `${lang}.${value}`).toBeTruthy();
      }
      expect(PROPOSAL_STATUS_COLOR_CLASSES[value]).toBeTruthy();
      expect(PROPOSAL_STATUS_CHART_COLORS[value]).toBeTruthy();
    }
  });

  it("la clave de etiqueta usa el valor a mostrar", () => {
    expect(proposalStatusLabelKey("vista")).toBe("proposalStatus.labels.vista");
    expect(proposalStatusLabelKey("Cerrada")).toBe("proposalStatus.labels.desconocido");
  });
});

describe("proposalStatusErrorMessage", () => {
  const t = (key) => `t:${key}`;
  const err = (status, detail) => ({ response: { status, data: { detail } } });

  it("422 → estado inválido", () => {
    expect(proposalStatusErrorMessage(err(422, "x"), { from: "borrador", to: "zzz" }, t)).toBe("t:proposalStatus.errors.invalidStatus");
  });

  it("409 → transición no permitida, o pedir migrar si el actual es desconocido", () => {
    expect(proposalStatusErrorMessage(err(409, "x"), { from: "firmada", to: "rechazada" }, t)).toBe("t:proposalStatus.errors.invalidTransition");
    expect(proposalStatusErrorMessage(err(409, "x"), { from: "Ganada", to: "enviada" }, t)).toBe("t:proposalStatus.errors.unknownStatus");
  });

  it("403 → reabrir solo admin, o sin permiso", () => {
    expect(proposalStatusErrorMessage(err(403, "x"), { from: "rechazada", to: "en_negociacion" }, t)).toBe("t:proposalStatus.errors.reopenAdminOnly");
    expect(proposalStatusErrorMessage(err(403, "x"), { from: "enviada", to: "vista" }, t)).toBe("t:proposalStatus.errors.forbidden");
  });

  it("otros códigos: el detail del servidor como respaldo, o un genérico", () => {
    expect(proposalStatusErrorMessage(err(500, "Fallo interno"), {}, t)).toBe("Fallo interno");
    expect(proposalStatusErrorMessage(err(500), {}, t)).toBe("t:proposalStatus.errors.generic");
    expect(proposalStatusErrorMessage(new Error("network"), {}, t)).toBe("t:proposalStatus.errors.generic");
  });
});
