// RF-VTA-02: vista del catálogo de servicios, formulario, tipos y formato de moneda.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { catalogApi, toast, auth } = vi.hoisted(() => ({
  catalogApi: {
    listServices: vi.fn(), listServiceTypes: vi.fn(), createService: vi.fn(), updateService: vi.fn(),
    createServiceType: vi.fn(), updateServiceType: vi.fn(),
  },
  toast: { error: vi.fn(), success: vi.fn() },
  auth: { user: { roles: ["manager"] } },
}));

vi.mock("react-hot-toast", () => ({ default: toast }));
vi.mock("@/hooks/useI18n", () => ({ useI18n: () => ({ t: (key) => key, language: "es" }) })); // t nuevo en cada render, como el hook real
vi.mock("@/api/catalogApi", () => ({ catalogApi }));
vi.mock("@/api/axios", () => ({ authTokenStore: { getUser: () => auth.user } }));

import { CatalogPage } from "@/views/CatalogPage";
import { formatMoney, normalizeLineItem, calculateProposalTotal } from "@/features/proposals/proposalDocument";
import { canManageCatalog } from "@/utils/permissions";
import { validatePrice } from "@/features/catalog/catalogValidation";

const TYPES = [
  { id: "t1", name: "Soporte técnico", active: true },
  { id: "t2", name: "Cobranza", active: true },
  { id: "t3", name: "Back office", active: false },
];

const service = (over = {}) => ({
  id: "s1", name: "Mesa de ayuda", description: "", unit: "hora", typeId: "t1", typeName: "Soporte técnico",
  price: 25.5, currency: "USD", conditions: "Pago a 30 días", active: true, ...over,
});

const listOf = (items) => ({ data: { items, total: items.length } });

beforeEach(() => {
  vi.clearAllMocks();
  auth.user = { roles: ["manager"] };
  catalogApi.listServiceTypes.mockResolvedValue({ data: { items: TYPES, total: TYPES.length } });
  catalogApi.listServices.mockResolvedValue(listOf([]));
});

const openNewForm = async () => {
  render(<CatalogPage />);
  fireEvent.click(await screen.findByRole("button", { name: "catalogPage.newService" }));
  return screen.findByRole("dialog");
};

describe("canManageCatalog", () => {
  it("solo manager y admin", () => {
    expect(canManageCatalog({ roles: ["manager"] })).toBe(true);
    expect(canManageCatalog({ roles: ["admin"] })).toBe(true);
    expect(canManageCatalog({ roles: ["user"] })).toBe(false);
    expect(canManageCatalog({})).toBe(false);
  });
});

describe("formatMoney", () => {
  it("USD se muestra como antes y CLP sin decimales", () => {
    expect(formatMoney(21950, "USD")).toBe("$21,950 USD");
    expect(formatMoney(21950)).toBe("$21,950 USD");
    expect(formatMoney(1500, "CLP")).toBe("$1.500 CLP");
    expect(formatMoney(1500.4, "CLP")).toBe("$1.500 CLP");
    expect(formatMoney(null, "CLP")).toBe("Not calculated");
  });

  it("exact conserva los centavos del USD (precios de catálogo) y no cambia el CLP", () => {
    expect(formatMoney(25.5, "USD", { exact: true })).toBe("$25.50 USD");
    expect(formatMoney(4200, "USD", { exact: true })).toBe("$4,200 USD");
    expect(formatMoney(0.01, "USD", { exact: true })).toBe("$0.01 USD");
    expect(formatMoney(18000, "CLP", { exact: true })).toBe("$18.000 CLP");
  });

  it("una moneda desconocida cae en USD (propuestas antiguas)", () => {
    expect(formatMoney(100, "EUR")).toBe("$100 USD");
  });

  it("PA-16: total de dos líneas con cantidades 3 y 1, en la moneda de la propuesta", () => {
    const lineItems = [
      { service: "Soporte", quantity: 3, unitPrice: 18000, currency: "CLP" },
      { service: "Cobranza", quantity: 1, unitPrice: 1500, currency: "CLP" },
    ];
    const total = calculateProposalTotal({ lineItems });
    expect(total.totalAmount).toBe(55500);
    expect(total.currency).toBe("CLP");
    expect(total.formattedTotal).toBe("$55.500 CLP");
    expect(calculateProposalTotal({ lineItems: [{ quantity: 3, unitPrice: 1000 }, { quantity: 1, unitPrice: 500 }] }).formattedTotal).toBe("$3,500 USD");
  });

  it("normalizeLineItem conserva la copia del servicio y no inventa campos en filas manuales", () => {
    const copy = normalizeLineItem({ service: "Mesa", quantity: 1, unitPrice: 10, serviceId: "s1", unit: "hora", currency: "clp", conditions: "30 días" });
    expect(copy).toMatchObject({ serviceId: "s1", unit: "hora", currency: "CLP", conditions: "30 días" });
    const manual = normalizeLineItem({ service: "Manual", quantity: 1, unitPrice: 10 });
    expect(manual).not.toHaveProperty("currency");
    expect(manual).not.toHaveProperty("serviceId");
  });
});

describe("validatePrice", () => {
  it.each([
    ["", "USD", "catalogPage.errors.priceRequired"],
    ["abc", "USD", "catalogPage.errors.priceNumber"],
    ["0", "USD", "catalogPage.errors.priceGreater"],
    ["10.555", "USD", "catalogPage.errors.usdDecimals"],
    ["10.5", "CLP", "catalogPage.errors.clpInteger"],
  ])("rechaza %j en %s", (price, currency, expected) => {
    expect(validatePrice(price, currency)).toBe(expected);
  });

  it.each([["0.01", "USD"], ["25.5", "USD"], ["1000000", "USD"], ["1", "CLP"], ["1500", "CLP"], ["1000000", "CLP"]])("acepta %s en %s", (price, currency) => {
    expect(validatePrice(price, currency)).toBeNull();
  });
});

describe("CatalogPage · lista", () => {
  it("muestra los servicios con su precio y atenúa los inactivos", async () => {
    catalogApi.listServices.mockResolvedValue(listOf([
      service(),
      service({ id: "s2", name: "Cobranza preventiva", unit: "gestión", price: 1500, currency: "CLP", typeName: "Cobranza", active: false }),
    ]));
    render(<CatalogPage />);
    expect(await screen.findByText("Mesa de ayuda")).toBeTruthy();
    expect(screen.getByText("$25.50 USD")).toBeTruthy(); // el catálogo conserva los centavos
    expect(screen.getByText("$1.500 CLP")).toBeTruthy();
    expect(screen.getByTestId("service-row-s1").className).not.toMatch(/opacity-50/);
    expect(screen.getByTestId("service-row-s2").className).toMatch(/opacity-50/);
  });

  it("muestra los estados vacío, vacío con filtros y error con reintento", async () => {
    const view = render(<CatalogPage />);
    expect(await screen.findByText("catalogPage.empty")).toBeTruthy();
    view.unmount();

    catalogApi.listServices.mockRejectedValueOnce(new Error("boom"));
    render(<CatalogPage />);
    expect(await screen.findByText(/catalogPage.error/)).toBeTruthy();
    catalogApi.listServices.mockResolvedValue(listOf([service()]));
    fireEvent.click(screen.getByRole("button", { name: "catalogPage.retry" }));
    expect(await screen.findByText("Mesa de ayuda")).toBeTruthy();
  });

  it("PA-06: la búsqueda y los filtros de estado y tipo llegan al servidor", async () => {
    render(<CatalogPage />);
    await screen.findByText("catalogPage.empty");

    fireEvent.change(screen.getByLabelText("catalogPage.search"), { target: { value: "mesa" } });
    await waitFor(() => expect(catalogApi.listServices).toHaveBeenLastCalledWith(expect.objectContaining({ search: "mesa" })));

    fireEvent.change(screen.getByLabelText("catalogPage.status"), { target: { value: "inactive" } });
    await waitFor(() => expect(catalogApi.listServices).toHaveBeenLastCalledWith(expect.objectContaining({ active: false })));

    fireEvent.change(screen.getByLabelText("catalogPage.type"), { target: { value: "t2" } });
    await waitFor(() => expect(catalogApi.listServices).toHaveBeenLastCalledWith(expect.objectContaining({ search: "mesa", active: false, type_id: "t2" })));
    expect(await screen.findByText("catalogPage.emptyFiltered")).toBeTruthy();
  });
});

describe("CatalogPage · permisos", () => {
  it("el rol user ve la lista en modo lectura, sin botones de cambio", async () => {
    auth.user = { roles: ["user"] };
    catalogApi.listServices.mockResolvedValue(listOf([service()]));
    render(<CatalogPage />);
    expect(await screen.findByText("Mesa de ayuda")).toBeTruthy();
    expect(screen.getByText("catalogPage.readOnly")).toBeTruthy();
    for (const label of ["catalogPage.newService", "catalogPage.manageTypes", "catalogPage.edit", "catalogPage.deactivate", "catalogPage.activate"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it.each(["manager", "admin"])("el rol %s ve los botones de cambio", async (role) => {
    auth.user = { roles: [role] };
    catalogApi.listServices.mockResolvedValue(listOf([service(), service({ id: "s2", name: "Otro", active: false })]));
    render(<CatalogPage />);
    await screen.findByText("Mesa de ayuda");
    expect(screen.getByRole("button", { name: "catalogPage.newService" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "catalogPage.manageTypes" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "catalogPage.edit" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "catalogPage.deactivate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "catalogPage.activate" })).toBeTruthy();
  });
});

describe("ServiceFormModal", () => {
  const fill = (dialog, values) => {
    const scope = within(dialog);
    if (values.name !== undefined) fireEvent.change(scope.getByLabelText("catalogPage.name"), { target: { value: values.name } });
    if (values.unit !== undefined) fireEvent.change(scope.getByLabelText("catalogPage.unit"), { target: { value: values.unit } });
    if (values.typeId !== undefined) fireEvent.change(scope.getByLabelText("catalogPage.type"), { target: { value: values.typeId } });
    if (values.currency !== undefined) fireEvent.change(scope.getByLabelText("catalogPage.currency"), { target: { value: values.currency } });
    if (values.price !== undefined) fireEvent.change(scope.getByLabelText("catalogPage.price"), { target: { value: values.price } });
    if (values.conditions !== undefined) fireEvent.change(scope.getByLabelText("catalogPage.conditions"), { target: { value: values.conditions } });
  };
  const submit = (dialog) => fireEvent.click(within(dialog).getByRole("button", { name: "catalogPage.save" }));

  it("solo ofrece tipos activos y valida en el cliente sin llamar al servidor", async () => {
    const dialog = await openNewForm();
    const options = within(within(dialog).getByLabelText("catalogPage.type")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["catalogPage.selectType", "Soporte técnico", "Cobranza"]); // «Back office» está inactivo

    submit(dialog);
    expect(await within(dialog).findAllByText("catalogPage.errors.required")).toHaveLength(3); // nombre, unidad, tipo
    expect(within(dialog).getByText("catalogPage.errors.priceRequired")).toBeTruthy();

    fill(dialog, { name: "X", unit: "hora", typeId: "t1", currency: "CLP", price: "10.5" });
    submit(dialog);
    expect(await within(dialog).findByText("catalogPage.errors.clpInteger")).toBeTruthy();

    fill(dialog, { currency: "USD", price: "10.555" });
    submit(dialog);
    expect(await within(dialog).findByText("catalogPage.errors.usdDecimals")).toBeTruthy();

    fill(dialog, { price: "0" });
    submit(dialog);
    expect(await within(dialog).findByText("catalogPage.errors.priceGreater")).toBeTruthy();
    expect(catalogApi.createService).not.toHaveBeenCalled();
  });

  it("PA-07: contador de condiciones y límite de 1.000 caracteres", async () => {
    const dialog = await openNewForm();
    fill(dialog, { name: "X", unit: "hora", typeId: "t1", price: "10", conditions: "c".repeat(1000) });
    expect(within(dialog).getByTestId("conditions-counter").textContent).toBe("1000/1000");
    fill(dialog, { conditions: "c".repeat(1001) });
    expect(within(dialog).getByTestId("conditions-counter").textContent).toBe("1001/1000");
    submit(dialog);
    expect(await within(dialog).findByText("catalogPage.errors.conditionsMax")).toBeTruthy();
    expect(catalogApi.createService).not.toHaveBeenCalled();
  });

  it("crea el servicio con el precio como número y recarga la lista", async () => {
    catalogApi.createService.mockResolvedValue({ data: service({ id: "new" }) });
    const dialog = await openNewForm();
    fill(dialog, { name: "  Mesa de ayuda ", unit: "hora", typeId: "t1", currency: "USD", price: "25.5", conditions: "Pago a 30 días" });
    submit(dialog);
    await waitFor(() => expect(catalogApi.createService).toHaveBeenCalledTimes(1));
    expect(catalogApi.createService.mock.calls[0][0]).toMatchObject({
      name: "Mesa de ayuda", unit: "hora", typeId: "t1", currency: "USD", price: 25.5, conditions: "Pago a 30 días",
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("catalogPage.saved"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(catalogApi.listServices.mock.calls.length).toBeGreaterThan(1);
  });

  it("muestra el 409 de duplicado en el campo nombre y el 422 en el campo que indica el servidor", async () => {
    catalogApi.createService.mockRejectedValueOnce({ response: { status: 409, data: { detail: "A service with the same name and unit already exists." } } });
    const dialog = await openNewForm();
    fill(dialog, { name: "Mesa de ayuda", unit: "hora", typeId: "t1", price: "25" });
    submit(dialog);
    expect(await within(dialog).findByText("A service with the same name and unit already exists.")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy(); // el formulario sigue abierto

    catalogApi.createService.mockRejectedValueOnce({
      response: { status: 422, data: { detail: [{ loc: ["body", "price"], msg: "USD prices allow at most 2 decimals." }] } },
    });
    fill(dialog, { name: "Otra" });
    submit(dialog);
    expect(await within(dialog).findByText("USD prices allow at most 2 decimals.")).toBeTruthy();
  });

  it("editar precarga el servicio y conserva su tipo aunque esté inactivo", async () => {
    catalogApi.listServices.mockResolvedValue(listOf([service({ typeId: "t3", typeName: "Back office" })]));
    catalogApi.updateService.mockResolvedValue({ data: service({ price: 30 }) });
    render(<CatalogPage />);
    fireEvent.click(await screen.findByRole("button", { name: "catalogPage.edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("catalogPage.name").value).toBe("Mesa de ayuda");
    expect(within(dialog).getByLabelText("catalogPage.type").value).toBe("t3");
    fill(dialog, { price: "30" });
    submit(dialog);
    await waitFor(() => expect(catalogApi.updateService).toHaveBeenCalledWith("s1", expect.objectContaining({ price: 30, typeId: "t3" })));
  });
});

describe("CatalogPage · desactivar y tipos", () => {
  it("desactivar pide confirmación y activar no", async () => {
    catalogApi.listServices.mockResolvedValue(listOf([service(), service({ id: "s2", name: "Otro", active: false })]));
    catalogApi.updateService.mockResolvedValue({ data: service({ active: false }) });
    render(<CatalogPage />);
    fireEvent.click(await screen.findByRole("button", { name: "catalogPage.deactivate" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("catalogPage.deactivateConfirm")).toBeTruthy();
    expect(catalogApi.updateService).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "catalogPage.deactivate" }));
    await waitFor(() => expect(catalogApi.updateService).toHaveBeenCalledWith("s1", { active: false }));

    fireEvent.click(await screen.findByRole("button", { name: "catalogPage.activate" }));
    await waitFor(() => expect(catalogApi.updateService).toHaveBeenCalledWith("s2", { active: true }));
  });

  it("PA-08: crea, renombra y desactiva tipos", async () => {
    catalogApi.createServiceType.mockResolvedValue({ data: { id: "t9", name: "Nuevo", active: true } });
    catalogApi.updateServiceType.mockResolvedValue({ data: {} });
    render(<CatalogPage />);
    fireEvent.click(await screen.findByRole("button", { name: "catalogPage.manageTypes" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText("catalogPage.newType"), { target: { value: " Nuevo " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "catalogPage.add" }));
    await waitFor(() => expect(catalogApi.createServiceType).toHaveBeenCalledWith({ name: "Nuevo" }));

    fireEvent.click(within(dialog).getAllByRole("button", { name: "catalogPage.rename" })[0]);
    fireEvent.change(within(dialog).getByLabelText("catalogPage.typeName"), { target: { value: "Soporte N1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "catalogPage.save" }));
    await waitFor(() => expect(catalogApi.updateServiceType).toHaveBeenCalledWith("t1", { name: "Soporte N1" }));

    fireEvent.click(within(dialog).getAllByRole("button", { name: "catalogPage.deactivate" })[0]);
    await waitFor(() => expect(catalogApi.updateServiceType).toHaveBeenCalledWith("t1", { active: false }));
    expect(within(dialog).getByRole("button", { name: "catalogPage.activate" })).toBeTruthy(); // «Back office» inactivo
  });

  it("muestra el 409 al repetir el nombre de un tipo", async () => {
    catalogApi.createServiceType.mockRejectedValue({ response: { status: 409, data: { detail: "A service type with this name already exists." } } });
    render(<CatalogPage />);
    fireEvent.click(await screen.findByRole("button", { name: "catalogPage.manageTypes" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("catalogPage.newType"), { target: { value: "Cobranza" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "catalogPage.add" }));
    expect(await within(dialog).findByText("A service type with this name already exists.")).toBeTruthy();
  });
});
