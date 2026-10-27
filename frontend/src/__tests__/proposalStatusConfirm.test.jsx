// RF-VTA-05: Firmada y Rechazada piden confirmación antes de cambiar el estado.
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/context/LanguageContext", () => ({ useLanguage: () => ({ language: "es" }), LanguageProvider: ({ children }) => children }));

const renderControl = async (props) => {
  const { ProposalStatusControl } = await import("@/features/proposals/ProposalStatusControl");
  const onChange = props.onChange || vi.fn(() => Promise.resolve());
  render(<ProposalStatusControl proposalTitle="Propuesta Acme" {...props} onChange={onChange} />);
  return onChange;
};
const choose = (value) => fireEvent.change(screen.getByRole("combobox"), { target: { value } });
const dialog = () => screen.queryByRole("dialog");

describe("ProposalStatusControl: confirmación", () => {
  it("elegir Firmada muestra el diálogo y no llama al cambio", async () => {
    const onChange = await renderControl({ status: "en_negociacion" });
    choose("firmada");
    expect(dialog()).toBeTruthy();
    expect(screen.getByText("¿Cambiar «Propuesta Acme» a Firmada?")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("elegir Rechazada muestra el diálogo y no llama al cambio", async () => {
    const onChange = await renderControl({ status: "enviada" });
    choose("rechazada");
    expect(screen.getByText("¿Cambiar «Propuesta Acme» a Rechazada?")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("el aviso es distinto para Firmada y para Rechazada", async () => {
    await renderControl({ status: "en_negociacion" });
    choose("firmada");
    expect(screen.getByText("Este cambio es definitivo y no se puede deshacer.")).toBeTruthy();
    expect(screen.queryByText("Solo un administrador podrá reabrir esta propuesta.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    choose("rechazada");
    expect(screen.getByText("Solo un administrador podrá reabrir esta propuesta.")).toBeTruthy();
    expect(screen.queryByText("Este cambio es definitivo y no se puede deshacer.")).toBeNull();
  });

  it("el diálogo es accesible y el foco inicial va en Cancelar", async () => {
    await renderControl({ status: "en_negociacion" });
    choose("firmada");
    const box = screen.getByRole("dialog");
    expect(box.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(box.getAttribute("aria-labelledby")).textContent).toBe("Confirmar cambio de estado");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancelar" }));
  });

  it("Cancelar no llama al cambio y el selector queda en el estado actual", async () => {
    const onChange = await renderControl({ status: "en_negociacion" });
    choose("firmada");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(dialog()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox").value).toBe("en_negociacion");
  });

  it("Escape cancela", async () => {
    const onChange = await renderControl({ status: "enviada" });
    choose("rechazada");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Confirmar llama al cambio una sola vez, aunque se haga doble clic", async () => {
    let resolveSave;
    const onChange = vi.fn(() => new Promise((resolve) => { resolveSave = resolve; }));
    await renderControl({ status: "en_negociacion", onChange });
    choose("firmada");
    const confirm = screen.getByRole("button", { name: "Confirmar" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("firmada");
    await waitFor(() => expect(confirm.disabled).toBe(true));
    resolveSave();
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it("Enviada → Vista cambia sin confirmación", async () => {
    const onChange = await renderControl({ status: "enviada" });
    choose("vista");
    expect(dialog()).toBeNull();
    expect(onChange).toHaveBeenCalledWith("vista");
  });

  it("Vista → En negociación cambia sin confirmación", async () => {
    const onChange = await renderControl({ status: "vista" });
    choose("en_negociacion");
    expect(dialog()).toBeNull();
    expect(onChange).toHaveBeenCalledWith("en_negociacion");
  });
});
