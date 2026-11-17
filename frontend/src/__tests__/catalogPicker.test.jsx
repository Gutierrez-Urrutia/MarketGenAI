// RF-VTA-02 (C2, C4): selector de servicios del catálogo en el paso 2 de la propuesta.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { catalog, api } = vi.hoisted(() => ({
  catalog: { getServices: vi.fn() },
  api: { createProposal: vi.fn(), generateProposalById: vi.fn(), updateProposal: vi.fn(), generateDraft: vi.fn(), proposalsApi: { exportFile: vi.fn() } },
}));

vi.mock("react-hot-toast", () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock("html2pdf.js", () => ({ default: () => ({}) }));
vi.mock("@/context/LanguageContext", () => ({ useLanguage: () => ({ language: "es" }), LanguageProvider: ({ children }) => children }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }), ThemeProvider: ({ children }) => children }));
vi.mock("@/api/proposalsApi", () => api);
vi.mock("@/api/catalogApi", () => catalog);

import { OpportunityProposalModal } from "@/features/proposals/OpportunityProposalModal";

const opportunity = { id: "opp-1", company: "Financiera Horizonte", job: "Cobranza telefónica", contact: "María", role: "Gerente", kw: ["cobranza"], content: "Cartera morosa" };

const MESA = { id: "s1", name: "Mesa de ayuda", description: "Atención 24/7", unit: "hora", typeName: "Atención al cliente", price: 25.5, currency: "USD", conditions: "Pago a 30 días", active: true };
const SOPORTE = { id: "s2", name: "Soporte técnico nivel 1", description: "", unit: "hora", typeName: "Soporte técnico", price: 18000, currency: "CLP", conditions: "Mínimo 40 horas", active: true };

const byText = (re) => screen.getAllByRole("button").find((b) => re.test(b.textContent));

const openStep2 = () => {
  render(<OpportunityProposalModal opportunity={opportunity} onClose={() => {}} />);
  fireEvent.click(byText(/precios|pricing/i));
};

const pick = async (name) => {
  fireEvent.focus(screen.getByLabelText("Agregar desde el catálogo"));
  const option = await screen.findByRole("button", { name: new RegExp(`^${name}`) });
  fireEvent.click(option);
};

beforeEach(() => {
  vi.clearAllMocks();
  catalog.getServices.mockResolvedValue([MESA, SOPORTE]);
  api.createProposal.mockResolvedValue({ id: "p1" });
  api.generateProposalById.mockResolvedValue({ id: "p1", content: "<p>x</p>", status: "generated" });
});

describe("selector de servicios del paso 2", () => {
  it("PA-14: solo pide al catálogo los servicios activos y los ofrece con su precio", async () => {
    openStep2();
    fireEvent.focus(screen.getByLabelText("Agregar desde el catálogo"));
    expect(await screen.findByRole("button", { name: /Mesa de ayuda/ })).toBeTruthy();
    expect(catalog.getServices).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
    expect(screen.getByText("$25.50 USD")).toBeTruthy();
    expect(screen.getByText("$18.000 CLP")).toBeTruthy();
  });

  it("no consulta el catálogo hasta que el usuario abre el selector", () => {
    openStep2();
    expect(catalog.getServices).not.toHaveBeenCalled();
  });

  it("PA-12/PA-13: precarga servicio, unidad, precio, moneda y condiciones, y todo se puede ajustar en la fila", async () => {
    openStep2();
    await pick("Mesa de ayuda");

    expect(screen.getByLabelText("Servicio / Unidad").value).toBe("Mesa de ayuda");
    expect(screen.getByLabelText("Unidad").value).toBe("hora");
    expect(screen.getByLabelText("Precio unitario").value).toBe("25.5");
    expect(screen.getByLabelText("Condiciones").value).toBe("Pago a 30 días");
    expect(screen.getByText("$26 USD")).toBeTruthy(); // subtotal 1 x 25,5 (formato de propuesta)

    fireEvent.change(screen.getByLabelText("Precio unitario"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Cant."), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Condiciones"), { target: { value: "Pago a 60 días" } });
    expect(screen.getByLabelText("Precio unitario").value).toBe("20");
    expect(screen.getAllByText("$60 USD").length).toBeGreaterThan(0); // subtotal y total
    // El ajuste es local: el catálogo no se vuelve a consultar ni se modifica.
    expect(catalog.getServices).toHaveBeenCalledTimes(1);
    expect(MESA.price).toBe(25.5);
    expect(MESA.conditions).toBe("Pago a 30 días");
  });

  it("mantiene el botón de fila manual y las filas manuales conviven con las del catálogo", async () => {
    openStep2();
    fireEvent.click(byText(/agregar ítem|add line item/i));
    await pick("Mesa de ayuda");
    expect(screen.getAllByLabelText("Servicio / Unidad")).toHaveLength(2);
    expect(screen.getAllByLabelText("Condiciones")).toHaveLength(1); // solo las filas del catálogo muestran condiciones
  });

  it("rechaza un servicio de otra moneda y avisa, sin agregar la fila", async () => {
    openStep2();
    await pick("Mesa de ayuda");
    await pick("Soporte técnico");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/ya usa USD/);
    expect(screen.getAllByLabelText("Servicio / Unidad")).toHaveLength(1);
  });

  it("acepta otros servicios de la misma moneda y muestra el total en la moneda de la propuesta", async () => {
    catalog.getServices.mockResolvedValue([SOPORTE, { ...SOPORTE, id: "s3", name: "Cobranza preventiva", unit: "gestión", price: 1500, conditions: "" }]);
    openStep2();
    await pick("Soporte técnico");
    await pick("Cobranza preventiva");
    expect(screen.getAllByLabelText("Servicio / Unidad")).toHaveLength(2);
    expect(screen.getByText(/\$19\.500 CLP/)).toBeTruthy(); // total 18.000 + 1.500
  });

  it("si el catálogo falla, avisa y deja agregar filas manuales", async () => {
    catalog.getServices.mockRejectedValue(new Error("boom"));
    openStep2();
    fireEvent.focus(screen.getByLabelText("Agregar desde el catálogo"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/No se pudo cargar el catálogo/);
    fireEvent.click(byText(/agregar ítem|add line item/i));
    expect(screen.getAllByLabelText("Servicio / Unidad")).toHaveLength(1);
  });

  it("PA-17: la propuesta envía una copia; si el catálogo cambia después, el precio emitido no cambia", async () => {
    openStep2();
    await pick("Soporte técnico");
    // El catálogo cambia después de agregar la fila.
    catalog.getServices.mockResolvedValue([{ ...SOPORTE, price: 99999, conditions: "Cambiado" }]);

    fireEvent.click(byText(/borrador|draft/i));
    await waitFor(() => expect(api.generateProposalById).toHaveBeenCalled(), { timeout: 8000 });

    const payload = api.generateProposalById.mock.calls[0][1];
    expect(payload.currency).toBe("CLP");
    expect(payload.lineItems).toHaveLength(1);
    expect(payload.lineItems[0]).toMatchObject({
      serviceId: "s2", service: "Soporte técnico nivel 1", unit: "hora", unitPrice: 18000, currency: "CLP", conditions: "Mínimo 40 horas",
    });
    expect(api.createProposal.mock.calls[0][0].currency).toBe("CLP");
    expect(api.createProposal.mock.calls[0][0].lineItems[0].unitPrice).toBe(18000);
  }, 15000);

  it("sin servicios del catálogo la propuesta se envía en USD, como antes", async () => {
    openStep2();
    fireEvent.click(byText(/agregar ítem|add line item/i));
    fireEvent.click(byText(/borrador|draft/i));
    await waitFor(() => expect(api.generateProposalById).toHaveBeenCalled(), { timeout: 8000 });
    const payload = api.generateProposalById.mock.calls[0][1];
    expect(payload.currency).toBe("USD");
    expect(payload.lineItems[0]).not.toHaveProperty("currency");
  }, 15000);
});

describe("paso 2 · mensajes traducidos", () => {
  it("las claves nuevas existen en los tres idiomas", async () => {
    const { translations } = await import("@/i18n/translations");
    const keys = ["addFromCatalog", "catalogSearch", "catalogLoading", "catalogEmpty", "catalogError", "catalogCurrencyMismatch", "unit", "conditions", "currency"];
    for (const lang of ["en", "es", "pt"]) {
      for (const key of keys) expect(translations[lang].opportunitiesPage.proposalModal[key], `${lang}.${key}`).toBeTruthy();
      expect(translations[lang].sidebar.catalog, `${lang}.sidebar.catalog`).toBeTruthy();
      expect(Object.keys(translations[lang].catalogPage).length).toBe(Object.keys(translations.es.catalogPage).length);
    }
    expect(within(document.body).queryByText("catalogPage.title")).toBeNull();
  });
});
