// RF-VTA-08: página de Sales enablement (generar, editar, eliminar borradores).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { enablementApi, toast } = vi.hoisted(() => ({
  enablementApi: { list: vi.fn(), generate: vi.fn(), update: vi.fn(), remove: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("react-hot-toast", () => ({ default: toast }));
vi.mock("@/hooks/useI18n", () => ({ useI18n: () => ({ t: (key) => key, language: "es" }) })); // t nuevo en cada render, como el hook real
vi.mock("@/api/axios", () => ({
  enablementApi,
  opportunitiesApi: { list: vi.fn(() => Promise.resolve({ data: [{ id: "o1", company: "Financiera Horizonte", job: "Cobranza" }] })) },
}));

import { SalesEnablementPage, countPending } from "@/views/SalesEnablementPage";

const draft = (over = {}) => ({
  id: "d1", type: "case_study", title: "Caso Banco Uno", topic: "cobranza", clientName: "Banco Uno",
  content: "Resultados: [COMPLETAR: métrica]", sources: [{ docId: "a", title: "Propuesta Cobranza" }],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  window.confirm = vi.fn(() => true);
  enablementApi.list.mockResolvedValue({ data: [] });
});

describe("SalesEnablementPage", () => {
  it("cuenta las partes por completar", () => {
    expect(countPending("a [COMPLETAR: x] b [COMPLETAR: y]")).toBe(2);
    expect(countPending("")).toBe(0);
  });

  it("muestra el estado vacío y no permite generar sin tema", async () => {
    render(<SalesEnablementPage />);
    expect(await screen.findByText("enablement.empty")).toBeTruthy();
    expect(screen.getByRole("button", { name: "enablement.gen" }).disabled).toBe(true);
  });

  it("genera un borrador con el tipo y tema elegidos y lo abre para editar", async () => {
    enablementApi.generate.mockResolvedValue({ data: draft({ type: "objection", title: "Es muy caro" }) });
    render(<SalesEnablementPage />);
    await screen.findByText("enablement.empty");

    fireEvent.click(screen.getByRole("radio", { name: "enablement.types.objection" }));
    fireEvent.change(screen.getByPlaceholderText("enablement.ph.objection"), { target: { value: "Es muy caro" } });
    fireEvent.change(screen.getByRole("combobox", { name: /enablement.opp/ }), { target: { value: "o1" } });
    fireEvent.click(screen.getByRole("button", { name: "enablement.gen" }));

    await waitFor(() => expect(enablementApi.generate).toHaveBeenCalledTimes(1));
    expect(enablementApi.generate.mock.calls[0][0]).toMatchObject({ type: "objection", topic: "Es muy caro", opportunityId: "o1", language: "es" });
    expect(await screen.findByLabelText("enablement.edit")).toBeTruthy();
    expect(screen.getByText(/enablement.pending: 1/)).toBeTruthy();
    expect(screen.getByText(/Propuesta Cobranza/)).toBeTruthy();
  });

  it("avisa cuando no hay información cargada que respalde el material", async () => {
    enablementApi.generate.mockRejectedValue({ response: { status: 422, data: { detail: "sin fuentes" } } });
    render(<SalesEnablementPage />);
    await screen.findByText("enablement.empty");
    fireEvent.change(screen.getByPlaceholderText("enablement.ph.case_study"), { target: { value: "cobranza" } });
    fireEvent.click(screen.getByRole("button", { name: "enablement.gen" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("enablement.noSources"));
  });

  it("edita y guarda el contenido del borrador", async () => {
    enablementApi.list.mockResolvedValue({ data: [draft()] });
    enablementApi.update.mockResolvedValue({ data: draft({ content: "Texto final", updatedAt: "2026-01-02T00:00:00Z" }) });
    render(<SalesEnablementPage />);

    fireEvent.click(await screen.findByText("Caso Banco Uno"));
    const box = await screen.findByLabelText("enablement.edit");
    const save = screen.getByRole("button", { name: "enablement.save" });
    expect(save.disabled).toBe(true);

    fireEvent.change(box, { target: { value: "Texto final" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(enablementApi.update).toHaveBeenCalledWith("d1", { content: "Texto final" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("enablement.saved"));
  });

  it("elimina un borrador tras confirmar", async () => {
    enablementApi.list.mockResolvedValue({ data: [draft()] });
    enablementApi.remove.mockResolvedValue({});
    render(<SalesEnablementPage />);

    fireEvent.click(await screen.findByText("Caso Banco Uno"));
    fireEvent.click(await screen.findByRole("button", { name: "enablement.delete" }));

    await waitFor(() => expect(enablementApi.remove).toHaveBeenCalledWith("d1"));
    await waitFor(() => expect(screen.queryByLabelText("enablement.edit")).toBeNull());
  });

  it("filtra la lista por tipo", async () => {
    render(<SalesEnablementPage />);
    await screen.findByText("enablement.empty");
    fireEvent.change(screen.getByLabelText("enablement.filterAll"), { target: { value: "comparison" } });
    await waitFor(() => expect(enablementApi.list).toHaveBeenLastCalledWith("comparison"));
  });
});
