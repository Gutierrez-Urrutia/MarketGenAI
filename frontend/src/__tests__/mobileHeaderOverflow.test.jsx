// CP-183: a 390 px se cortaban la barra superior (selector de tema) y los botones del encabezado del Panel y de Informes.
// jsdom no calcula layout: se fija el contrato de clases que evita el corte (la fila puede saltar de línea y la barra se encoge).
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light", changeTheme: () => {} }) }));
vi.mock("@/context/LanguageContext", () => ({ useLanguage: () => ({ language: "es" }), LanguageProvider: ({ children }) => children }));
vi.mock("@/features/dashboard/dashboardSnapshot", async (importOriginal) => ({
  ...(await importOriginal()),
  buildDashboardMetricsFromSources: vi.fn(() => new Promise(() => {})),
}));

import { AppTopbar } from "@/components/shell/AppTopbar";
import { DashboardPage } from "@/views/DashboardPage";

describe("Barra superior en pantallas angostas", () => {
  it("reduce el margen, recorta el título largo y no deja que el selector de tema se achique ni se salga", () => {
    const { container } = render(<AppTopbar title="Sales enablement con un título largo" />);
    const header = container.querySelector("header");
    expect(header.className).toContain("px-3");
    expect(header.className).toContain("sm:px-6");
    expect(screen.getByText("Sales enablement con un título largo").className).toContain("truncate");
    expect(screen.getByLabelText("Ubicación").className).toContain("min-w-0");
    expect(screen.getByRole("radiogroup").parentElement.className).toContain("shrink-0");
  });
});

describe("Encabezado del Panel principal en pantallas angostas", () => {
  it("la fila y el grupo de botones saltan de línea en vez de salirse del ancho", () => {
    render(<DashboardPage onNavigate={() => {}} />);
    const button = screen.getAllByRole("button").find((b) => /ejecutar pipeline/i.test(b.textContent));
    const group = button.parentElement;
    expect(group.className).toContain("flex-wrap");
    expect(group.parentElement.className).toContain("flex-wrap");
  });
});
