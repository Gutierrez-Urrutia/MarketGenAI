// RF-VTA-07: plantillas de propuesta en Settings (clasificación, condiciones comerciales, variables).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { templatesApi, toast } = vi.hoisted(() => ({
  templatesApi: { list: vi.fn(), catalog: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), extract: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("react-hot-toast", () => ({ default: toast }));
vi.mock("@/hooks/useI18n", () => ({ useI18n: () => ({ t: (key) => key, language: "es" }) })); // t nuevo en cada render, como el hook real
vi.mock("@/api/axios", () => ({ templatesApi }));

import ProposalTemplatesTab from "@/pages/settings/ProposalTemplatesTab";
import { catalogLabel, extractVariables, insertVariable } from "@/features/proposals/templateVariables";

const CATALOG = {
  serviceTypes: [
    { value: "back_office", labels: { es: "Back office", en: "Back office", pt: "Back office" } },
    { value: "collections", labels: { es: "Cobranza", en: "Collections", pt: "Cobrança" } },
    { value: "other", labels: { es: "Otro", en: "Other", pt: "Outro" } },
  ],
  industries: [
    { value: "general", labels: { es: "General", en: "General", pt: "Geral" } },
    { value: "healthcare", labels: { es: "Salud", en: "Healthcare", pt: "Saúde" } },
  ],
  standardVariables: { customer: ["cliente_nombre", "cliente_empresa"], proposal: ["monto_total", "valida_hasta"] },
  defaultCommercialTerms: { es: "Válida hasta {valida_hasta}. Total {monto_total}.", en: "Valid until {valida_hasta}.", pt: "Válida até {valida_hasta}." },
};

const template = (over = {}) => ({
  id: "t1", name: "BPO salud", type: "proposal", serviceType: "back_office", industry: "healthcare",
  description: "Para clínicas", content: "Hola {cliente_nombre}", commercialTerms: "Pago a 30 días",
  variables: ["cliente_nombre"], isPublic: false, userId: "u1", usageCount: 3, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  templatesApi.catalog.mockResolvedValue({ data: CATALOG });
  templatesApi.list.mockResolvedValue({ data: { items: [template()], total: 1 } });
});

describe("templateVariables", () => {
  it("extrae variables {x} y {{x}} sin repetir, en orden", () => {
    expect(extractVariables("Hola {cliente_nombre} de {{ cliente_empresa }}", "Total {monto_total} {cliente_nombre}"))
      .toEqual(["cliente_nombre", "cliente_empresa", "monto_total"]);
    expect(extractVariables("", null, "sin variables")).toEqual([]);
  });

  it("inserta la variable en el cursor o reemplaza la selección", () => {
    expect(insertVariable("Hola !", "cliente_nombre", 5)).toEqual({ text: "Hola {cliente_nombre}!", cursor: 21 });
    expect(insertVariable("Hola XX", "x", 5, 7)).toEqual({ text: "Hola {x}", cursor: 8 });
    expect(insertVariable("Fin", "x", undefined).text).toBe("Fin{x}");
  });

  it("usa la etiqueta del idioma activo con respaldo en español", () => {
    expect(catalogLabel(CATALOG.serviceTypes[1], "pt")).toBe("Cobrança");
    expect(catalogLabel({ value: "x", labels: { es: "Equis" } }, "en")).toBe("Equis");
  });
});

describe("ProposalTemplatesTab", () => {
  it("lista plantillas de propuesta con su servicio e industria", async () => {
    render(<ProposalTemplatesTab />);
    const card = (await screen.findByText("BPO salud")).closest("li");
    expect(within(card).getByText("Back office")).toBeTruthy();
    expect(within(card).getByText("Salud")).toBeTruthy();
    expect(templatesApi.list.mock.calls[0][0]).toMatchObject({ type: "proposal" });
  });

  it("filtra por servicio e industria en el backend", async () => {
    render(<ProposalTemplatesTab />);
    await screen.findByText("BPO salud");
    fireEvent.change(screen.getByRole("combobox", { name: "settings.templateFilterService" }), { target: { value: "collections" } });
    await waitFor(() => expect(templatesApi.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ serviceType: "collections", industry: undefined }), expect.anything(),
    ));
    fireEvent.change(screen.getByRole("combobox", { name: "settings.templateFilterIndustry" }), { target: { value: "healthcare" } });
    await waitFor(() => expect(templatesApi.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ serviceType: "collections", industry: "healthcare" }), expect.anything(),
    ));
  });

  it("precarga las condiciones comerciales base y crea con clasificación y variables", async () => {
    templatesApi.create.mockImplementation(async (payload) => ({ data: { ...template(), ...payload, id: "t2" } }));
    render(<ProposalTemplatesTab />);
    const terms = screen.getByRole("textbox", { name: /settings.templateCommercialTerms/ });
    await waitFor(() => expect(terms.value).toBe(CATALOG.defaultCommercialTerms.es));

    fireEvent.change(screen.getByRole("textbox", { name: "settings.templateName" }), { target: { value: "Cobranza retail" } });
    fireEvent.change(screen.getByRole("combobox", { name: "settings.templateService" }), { target: { value: "collections" } });
    fireEvent.change(screen.getByRole("textbox", { name: "settings.templateContent" }), { target: { value: "Hola {cliente_nombre}, plazo {plazo}" } });
    fireEvent.click(screen.getByRole("button", { name: "settings.templateSave" }));

    await waitFor(() => expect(templatesApi.create).toHaveBeenCalledTimes(1));
    expect(templatesApi.create.mock.calls[0][0]).toMatchObject({
      name: "Cobranza retail", type: "proposal", serviceType: "collections", industry: "general",
      commercialTerms: CATALOG.defaultCommercialTerms.es,
      variables: ["cliente_nombre", "plazo", "valida_hasta", "monto_total"],
    });
  });

  it("no guarda sin condiciones comerciales", async () => {
    render(<ProposalTemplatesTab />);
    await screen.findByText("BPO salud");
    fireEvent.change(screen.getByRole("textbox", { name: "settings.templateName" }), { target: { value: "Sin condiciones" } });
    fireEvent.change(screen.getByRole("textbox", { name: /settings.templateCommercialTerms/ }), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "settings.templateSave" }));
    expect(toast.error).toHaveBeenCalledWith("settings.templateTermsRequired");
    expect(templatesApi.create).not.toHaveBeenCalled();
  });

  it("marca las variables propias que no se completan solas", async () => {
    render(<ProposalTemplatesTab />);
    await screen.findByText("BPO salud");
    fireEvent.change(screen.getByRole("textbox", { name: "settings.templateContent" }), { target: { value: "Hola {cliente_nombre}, plazo {plazo_meses}" } });
    expect(screen.getByText("settings.templateCustomVars")).toBeTruthy();
    expect(screen.getByText("{plazo_meses}")).toBeTruthy();
  });

  it("inserta una variable estándar al hacer clic", async () => {
    render(<ProposalTemplatesTab />);
    await screen.findByText("BPO salud");
    const content = screen.getByRole("textbox", { name: "settings.templateContent" });
    fireEvent.change(content, { target: { value: "Hola " } });
    content.setSelectionRange(5, 5);
    fireEvent.click(screen.getByRole("button", { name: "{cliente_empresa}" }));
    expect(content.value).toBe("Hola {cliente_empresa}");
  });

  it("edita una plantilla existente", async () => {
    templatesApi.update.mockImplementation(async (id, payload) => ({ data: { ...template(), ...payload } }));
    render(<ProposalTemplatesTab />);
    fireEvent.click(await screen.findByRole("button", { name: "settings.templateEdit BPO salud" }));
    expect(screen.getByRole("textbox", { name: /settings.templateCommercialTerms/ }).value).toBe("Pago a 30 días");
    fireEvent.change(screen.getByRole("textbox", { name: "settings.templateName" }), { target: { value: "BPO clínicas" } });
    fireEvent.click(screen.getByRole("button", { name: "settings.templateUpdate" }));
    await waitFor(() => expect(templatesApi.update).toHaveBeenCalledTimes(1));
    expect(templatesApi.update.mock.calls[0][0]).toBe("t1");
    expect(await screen.findByText("BPO clínicas")).toBeTruthy();
  });

  it("elimina con confirmación", async () => {
    templatesApi.delete.mockResolvedValue({});
    render(<ProposalTemplatesTab />);
    fireEvent.click(await screen.findByRole("button", { name: "settings.templateDelete BPO salud" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "settings.templateDelete" }));
    await waitFor(() => expect(templatesApi.delete).toHaveBeenCalledWith("t1", expect.anything()));
    await waitFor(() => expect(screen.queryByText("BPO salud")).toBeNull());
  });
});
