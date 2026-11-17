// RF-VTA-07: selector de plantilla compartido (modal de oportunidad y Biblioteca de contenido).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const { templatesApi } = vi.hoisted(() => ({ templatesApi: { list: vi.fn(), catalog: vi.fn() } }));

vi.mock("@/hooks/useI18n", () => ({ useI18n: () => ({ t: (key) => key, language: "es" }) }));
vi.mock("@/api/axios", () => ({ templatesApi }));

import { STANDARD_TEMPLATE_NAME, pickerStateFromProposal, useProposalTemplatePicker } from "@/features/proposals/ProposalTemplatePicker";

const CATALOG = {
  serviceTypes: [{ value: "collections", labels: { es: "Cobranza" } }],
  industries: [{ value: "healthcare", labels: { es: "Salud" } }],
  standardVariables: { customer: ["cliente_empresa"], proposal: [] },
};
const TEMPLATE = {
  id: "t1", name: "Cobranza salud", serviceType: "collections", industry: "healthcare",
  content: "Para {cliente_empresa}: {tramo}", commercialTerms: "Plazo {plazo}",
};

beforeEach(() => {
  vi.clearAllMocks();
  templatesApi.catalog.mockResolvedValue({ data: CATALOG });
  templatesApi.list.mockResolvedValue({ data: { items: [TEMPLATE] } });
});

describe("useProposalTemplatePicker", () => {
  it("no carga nada mientras no está activo", async () => {
    const { result, rerender } = renderHook(({ active }) => useProposalTemplatePicker({ active }), { initialProps: { active: false } });
    expect(templatesApi.list).not.toHaveBeenCalled();
    rerender({ active: true });
    await waitFor(() => expect(result.current.templates).toHaveLength(1));
    expect(templatesApi.list).toHaveBeenCalledWith({ type: "proposal", limit: 100 }, expect.anything());
  });

  it("al elegir una plantilla toma su clasificación y pide solo las variables propias", async () => {
    const { result } = renderHook(() => useProposalTemplatePicker());
    await waitFor(() => expect(result.current.templates).toHaveLength(1));
    expect(result.current.templateName).toBe(STANDARD_TEMPLATE_NAME);
    expect(result.current.generationFields()).toEqual({
      serviceType: undefined, industry: undefined, templateId: undefined, templateVariables: undefined,
    });

    act(() => result.current.chooseTemplate("t1"));
    act(() => result.current.setTemplateValue("tramo", "30-60"));
    expect(result.current.customVariables).toEqual(["tramo", "plazo"]);
    expect(result.current.templateName).toBe("Cobranza salud");
    expect([result.current.serviceTypeLabel, result.current.industryLabel]).toEqual(["Cobranza", "Salud"]);
    expect(result.current.generationFields()).toEqual({
      serviceType: "collections", industry: "healthcare", templateId: "t1", templateVariables: { tramo: "30-60" },
    });
    expect(result.current.persistenceFields()).toEqual({ serviceType: "collections", industry: "healthcare", templateId: "t1" });
  });

  it("precarga la elección guardada en una propuesta para regenerarla", async () => {
    const { result } = renderHook(() => useProposalTemplatePicker());
    act(() => result.current.reset(pickerStateFromProposal({ templateId: "t1", serviceType: "collections", industry: "healthcare", templateVariables: { tramo: "90+" } })));
    await waitFor(() => expect(result.current.selectedTemplate?.id).toBe("t1"));
    expect(result.current.templateValues).toEqual({ tramo: "90+" });
  });

  it("si la plantilla guardada ya no existe, vuelve a sin plantilla y conserva la clasificación", async () => {
    const { result } = renderHook(() => useProposalTemplatePicker());
    act(() => result.current.reset(pickerStateFromProposal({ templateId: "borrada", serviceType: "collections" })));
    await waitFor(() => expect(result.current.templates).toHaveLength(1));
    await waitFor(() => expect(result.current.templateId).toBe(""));
    expect(result.current.serviceType).toBe("collections");
    expect(result.current.generationFields().templateId).toBeUndefined();
  });

  it("si la API falla, queda sin plantillas y se puede generar igual", async () => {
    templatesApi.list.mockRejectedValue(new Error("offline"));
    templatesApi.catalog.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useProposalTemplatePicker());
    await waitFor(() => expect(templatesApi.list).toHaveBeenCalled());
    expect(result.current.templates).toEqual([]);
    expect(result.current.generationFields().templateId).toBeUndefined();
  });
});
