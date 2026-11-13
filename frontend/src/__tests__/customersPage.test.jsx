// RF-VTA-03: vista de clientes (perfil, filtros, formulario, ficha con historial, eliminar e importar CSV).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { customersApi, toast, i18n } = vi.hoisted(() => ({
  customersApi: {
    options: vi.fn(), list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), proposals: vi.fn(), importCsv: vi.fn(),
  },
  toast: { error: vi.fn(), success: vi.fn() },
  i18n: { language: "es" },
}));

vi.mock("react-hot-toast", () => ({ default: toast }));
vi.mock("@/hooks/useI18n", () => ({ useI18n: () => ({ t: (key) => key, language: i18n.language }) })); // t nuevo en cada render, como el hook real
vi.mock("@/api/customersApi", () => ({ customersApi }));

import { CustomersPage } from "@/views/CustomersPage";
import { validateCustomerForm, serverErrorsByField } from "@/features/customers/customerValidation";

const OPTIONS = {
  industries: [
    { value: "financial_services", labels: { es: "Servicios financieros", en: "Financial services", pt: "Serviços financeiros" } },
    { value: "healthcare", labels: { es: "Salud", en: "Healthcare", pt: "Saúde" } },
    { value: "retail_ecommerce", labels: { es: "Retail y e-commerce", en: "Retail and e-commerce", pt: "Varejo e e-commerce" } },
  ],
  sizes: [
    { value: "micro", employees: "1-9", labels: { es: "Micro", en: "Micro", pt: "Micro" } },
    { value: "small", employees: "10-49", labels: { es: "Pequeña", en: "Small", pt: "Pequena" } },
    { value: "medium", employees: "50-199", labels: { es: "Mediana", en: "Medium", pt: "Média" } },
    { value: "large", employees: "200+", labels: { es: "Grande", en: "Large", pt: "Grande" } },
  ],
};

const customer = (over = {}) => ({
  id: "c1", name: "Marcela Rojas", email: "marcela@banco-demo.com", company: "Banco Horizonte", phone: "", notes: "",
  industry: "financial_services", size: "large", ...over,
});
const listOf = (items) => ({ data: { items, total: items.length } });

beforeEach(() => {
  vi.clearAllMocks();
  i18n.language = "es";
  customersApi.options.mockResolvedValue({ data: OPTIONS });
  customersApi.list.mockResolvedValue(listOf([]));
  customersApi.proposals.mockResolvedValue({ data: { items: [], total: 0 } });
});

const openNewForm = async () => {
  render(<CustomersPage />);
  fireEvent.click(await screen.findByRole("button", { name: "customersPage.newCustomer" }));
  return screen.findByRole("dialog");
};
const fill = (dialog, values) => {
  const scope = within(dialog);
  for (const [label, value] of Object.entries(values)) fireEvent.change(scope.getByLabelText(label), { target: { value } });
};
const submit = (dialog) => fireEvent.click(within(dialog).getByRole("button", { name: "customersPage.save" }));

describe("validación del formulario", () => {
  it("nombre y correo obligatorios, correo con formato", () => {
    expect(validateCustomerForm({ name: "", email: "" })).toEqual({ name: "customersPage.errors.required", email: "customersPage.errors.required" });
    expect(validateCustomerForm({ name: "Ana", email: "ana" })).toEqual({ email: "customersPage.errors.emailInvalid" });
    expect(validateCustomerForm({ name: "Ana", email: "ana@x.com" })).toEqual({});
    expect(validateCustomerForm({ name: "x".repeat(201), email: "ana@x.com" })).toEqual({ name: "customersPage.errors.nameMax" });
  });

  it("el error 422 del servidor se asigna al campo", () => {
    const err = { response: { status: 422, data: { detail: [{ loc: ["body", "size"], msg: "size must be one of: micro" }] } } };
    expect(serverErrorsByField(err)).toMatchObject({ size: "size must be one of: micro", _status: 422 });
  });
});

describe("CustomersPage · lista", () => {
  it("PA-06: muestra industria y tamaño con su etiqueta, y «Sin definir» si faltan", async () => {
    customersApi.list.mockResolvedValue(listOf([
      customer(),
      customer({ id: "c2", name: "Cliente Antiguo", email: "antiguo@x-demo.com", company: "Antigua SpA", industry: null, size: null }),
    ]));
    render(<CustomersPage />);
    const row1 = await screen.findByTestId("customer-row-c1");
    await waitFor(() => expect(within(row1).getByText("Servicios financieros")).toBeTruthy());
    expect(within(row1).getByText("Grande")).toBeTruthy();
    const row2 = screen.getByTestId("customer-row-c2");
    expect(within(row2).getAllByText("customersPage.undefined")).toHaveLength(2);
  });

  it("PA-06: las etiquetas siguen el idioma de la interfaz", async () => {
    i18n.language = "en";
    customersApi.list.mockResolvedValue(listOf([customer()]));
    render(<CustomersPage />);
    const row = await screen.findByTestId("customer-row-c1");
    await waitFor(() => expect(within(row).getByText("Financial services")).toBeTruthy());
    expect(within(row).getByText("Large")).toBeTruthy();
  });

  it("muestra los estados vacío, vacío con filtros y error con reintento", async () => {
    const view = render(<CustomersPage />);
    expect(await screen.findByText("customersPage.empty")).toBeTruthy();
    view.unmount();

    customersApi.list.mockRejectedValueOnce(new Error("boom"));
    render(<CustomersPage />);
    expect(await screen.findByText(/customersPage.error/)).toBeTruthy();
    customersApi.list.mockResolvedValue(listOf([customer()]));
    fireEvent.click(screen.getByRole("button", { name: "customersPage.retry" }));
    expect(await screen.findByText("Marcela Rojas")).toBeTruthy();
  });

  it("PA-06: la búsqueda y los filtros de industria y tamaño llegan al servidor", async () => {
    render(<CustomersPage />);
    await screen.findByText("customersPage.empty");
    await waitFor(() => expect(screen.getByRole("option", { name: "Salud" })).toBeTruthy());

    fireEvent.change(screen.getByLabelText("customersPage.search"), { target: { value: "banco" } });
    await waitFor(() => expect(customersApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: "banco" })));
    fireEvent.change(screen.getByLabelText("customersPage.industry"), { target: { value: "healthcare" } });
    await waitFor(() => expect(customersApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: "banco", industry: "healthcare" })));
    fireEvent.change(screen.getByLabelText("customersPage.size"), { target: { value: "micro" } });
    await waitFor(() => expect(customersApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ industry: "healthcare", size: "micro" })));
    expect(await screen.findByText("customersPage.emptyFiltered")).toBeTruthy();
  });
});

describe("CustomerFormModal", () => {
  it("PA-01: crea el cliente con industria y tamaño", async () => {
    customersApi.create.mockResolvedValue({ data: customer() });
    const dialog = await openNewForm();
    await waitFor(() => expect(within(dialog).getByRole("option", { name: "Servicios financieros" })).toBeTruthy());
    fill(dialog, { "customersPage.name": "  Marcela Rojas ", "customersPage.email": "marcela@banco-demo.com", "customersPage.company": "Banco Horizonte", "customersPage.industry": "financial_services", "customersPage.size": "medium" });
    submit(dialog);
    await waitFor(() => expect(customersApi.create).toHaveBeenCalledTimes(1));
    expect(customersApi.create.mock.calls[0][0]).toMatchObject({
      name: "Marcela Rojas", email: "marcela@banco-demo.com", company: "Banco Horizonte", industry: "financial_services", size: "medium",
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("customersPage.saved"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("industria y tamaño son opcionales: sin elegir se envían vacíos", async () => {
    customersApi.create.mockResolvedValue({ data: customer({ industry: null, size: null }) });
    const dialog = await openNewForm();
    fill(dialog, { "customersPage.name": "Ana", "customersPage.email": "ana@x-demo.com" });
    submit(dialog);
    await waitFor(() => expect(customersApi.create).toHaveBeenCalled());
    expect(customersApi.create.mock.calls[0][0]).toMatchObject({ industry: "", size: "" });
  });

  it("valida en el cliente nombre y correo sin llamar al servidor", async () => {
    const dialog = await openNewForm();
    submit(dialog);
    expect(await within(dialog).findAllByText("customersPage.errors.required")).toHaveLength(2);
    fill(dialog, { "customersPage.name": "Ana", "customersPage.email": "ana" });
    submit(dialog);
    expect(await within(dialog).findByText("customersPage.errors.emailInvalid")).toBeTruthy();
    expect(customersApi.create).not.toHaveBeenCalled();
  });

  it("PA-02/03: muestra el 422 del servidor en el campo tamaño y en el de industria", async () => {
    customersApi.create.mockRejectedValueOnce({ response: { status: 422, data: { detail: [{ loc: ["body", "size"], msg: "size must be one of: micro, small, medium, large." }] } } });
    const dialog = await openNewForm();
    fill(dialog, { "customersPage.name": "Ana", "customersPage.email": "ana@x-demo.com" });
    submit(dialog);
    expect(await within(dialog).findByText("size must be one of: micro, small, medium, large.")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy(); // sigue abierto

    customersApi.create.mockRejectedValueOnce({ response: { status: 422, data: { detail: [{ loc: ["body", "industry"], msg: "industry must be one of: general." }] } } });
    submit(dialog);
    expect(await within(dialog).findByText("industry must be one of: general.")).toBeTruthy();
  });

  it("editar precarga el perfil y permite vaciar la industria", async () => {
    customersApi.list.mockResolvedValue(listOf([customer()]));
    customersApi.update.mockResolvedValue({ data: customer({ industry: null }) });
    render(<CustomersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "customersPage.edit" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByLabelText("customersPage.industry").value).toBe("financial_services"));
    expect(within(dialog).getByLabelText("customersPage.size").value).toBe("large");
    fill(dialog, { "customersPage.industry": "" });
    submit(dialog);
    await waitFor(() => expect(customersApi.update).toHaveBeenCalledWith("c1", expect.objectContaining({ industry: "", size: "large" })));
  });
});

describe("CustomerDetailModal · ficha e historial", () => {
  it("PA-07/08: muestra el perfil y el historial en el orden que entrega el servidor, con el estado traducido", async () => {
    customersApi.list.mockResolvedValue(listOf([customer()]));
    customersApi.proposals.mockResolvedValue({ data: { total: 2, items: [
      { id: "p4", title: "Propuesta reciente", proposal_status: "enviada", createdAt: "2026-11-09T10:00:00Z" },
      { id: "p1", title: "Propuesta antigua", proposal_status: "rechazada", createdAt: "2026-10-01T10:00:00Z" },
    ] } });
    render(<CustomersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "customersPage.view" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByTestId("detail-industry").textContent).toBe("Servicios financieros"));
    expect(within(dialog).getByTestId("detail-size").textContent).toBe("Grande");

    const rows = await within(dialog).findAllByTestId(/history-row-/);
    expect(rows.map((r) => r.dataset.testid)).toEqual(["history-row-p4", "history-row-p1"]);
    expect(within(rows[0]).getByText("proposalStatus.labels.enviada")).toBeTruthy();
    expect(within(rows[1]).getByText("proposalStatus.labels.rechazada")).toBeTruthy();
    expect(customersApi.proposals).toHaveBeenCalledWith("c1", { limit: 10, offset: 0 });
  });

  it("sin propuestas muestra el estado vacío y un cliente sin perfil muestra «Sin definir»", async () => {
    customersApi.list.mockResolvedValue(listOf([customer({ industry: null, size: null })]));
    render(<CustomersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "customersPage.view" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("customersPage.historyEmpty")).toBeTruthy();
    expect(within(dialog).getByTestId("detail-industry").textContent).toBe("customersPage.undefined");
    expect(within(dialog).getByTestId("detail-size").textContent).toBe("customersPage.undefined");
  });

  it("pagina el historial", async () => {
    customersApi.list.mockResolvedValue(listOf([customer()]));
    customersApi.proposals.mockResolvedValue({ data: { total: 25, items: [{ id: "p1", title: "Una", proposal_status: "borrador", createdAt: "2026-11-01T00:00:00Z" }] } });
    render(<CustomersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "customersPage.view" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "customersPage.next" }));
    await waitFor(() => expect(customersApi.proposals).toHaveBeenLastCalledWith("c1", { limit: 10, offset: 10 }));
  });
});

describe("eliminar", () => {
  it("pide confirmación y elimina un cliente sin propuestas", async () => {
    customersApi.list.mockResolvedValue(listOf([customer()]));
    customersApi.remove.mockResolvedValue({});
    render(<CustomersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "customersPage.delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(customersApi.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "customersPage.delete" }));
    await waitFor(() => expect(customersApi.remove).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("customersPage.deleted"));
  });

  it("PA-09: un cliente con propuestas no se elimina y se informa cuántas tiene", async () => {
    customersApi.list.mockResolvedValue(listOf([customer()]));
    customersApi.remove.mockRejectedValue({ response: { status: 409, data: { detail: { code: "CUSTOMER_HAS_PROPOSALS", proposalCount: 3 } } } });
    render(<CustomersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "customersPage.delete" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "customersPage.delete" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(within(dialog).getByRole("alert").textContent).toBe("customersPage.deleteBlocked".replace("{count}", "3"));
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("importar CSV", () => {
  it("PA-04: sube el archivo y muestra las importadas y las filas con error", async () => {
    customersApi.importCsv.mockResolvedValue({ data: { imported: 2, errors: ["Row 4: size must be one of: micro, small, medium, large."] } });
    render(<CustomersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "customersPage.importCsv" }));
    const dialog = await screen.findByRole("dialog");
    const importButton = within(dialog).getByRole("button", { name: "customersPage.importAction" });
    expect(importButton.disabled).toBe(true);

    const file = new File(["name,email\nA,a@x.com"], "clientes.csv", { type: "text/csv" });
    fireEvent.change(within(dialog).getByLabelText("customersPage.importChoose"), { target: { files: [file] } });
    fireEvent.click(within(dialog).getByRole("button", { name: "customersPage.importAction" }));
    await waitFor(() => expect(customersApi.importCsv).toHaveBeenCalledWith(file));

    const result = await within(dialog).findByTestId("import-result");
    expect(result.textContent).toContain("customersPage.importedCount".replace("{count}", "2"));
    expect(result.textContent).toContain("Row 4: size must be one of");
    await waitFor(() => expect(customersApi.list.mock.calls.length).toBeGreaterThan(1)); // recargó la lista
  });

  it("si el servidor rechaza el archivo muestra el motivo", async () => {
    customersApi.importCsv.mockRejectedValue({ response: { status: 422, data: { detail: "CSV is missing required columns: ['email']" } } });
    render(<CustomersPage />);
    fireEvent.click(await screen.findByRole("button", { name: "customersPage.importCsv" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("customersPage.importChoose"), { target: { files: [new File(["x"], "m.csv", { type: "text/csv" })] } });
    fireEvent.click(within(dialog).getByRole("button", { name: "customersPage.importAction" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("missing required columns");
  });
});

describe("traducciones", () => {
  it("las claves nuevas existen en los tres idiomas", async () => {
    const { translations } = await import("@/i18n/translations");
    const keys = Object.keys(translations.es.customersPage);
    expect(keys.length).toBeGreaterThan(40);
    for (const lang of ["en", "pt"]) {
      expect(Object.keys(translations[lang].customersPage).sort()).toEqual([...keys].sort());
      expect(Object.keys(translations[lang].customersPage.errors).sort()).toEqual(Object.keys(translations.es.customersPage.errors).sort());
    }
    const modalKeys = ["customerPick", "customerSearch", "customerNone", "customerLoading", "customerEmpty", "customerError", "customerClear", "customerProfileHint", "customerNoProfile"];
    for (const lang of ["en", "es", "pt"]) {
      for (const key of modalKeys) expect(translations[lang].opportunitiesPage.proposalModal[key], `${lang}.${key}`).toBeTruthy();
      expect(translations[lang].sidebar.customers, `${lang}.sidebar.customers`).toBeTruthy();
    }
  });
});
