// CP-181: el botón «Ejecutar Pipeline» del Panel no tenía acción. La corrida cuesta cuota (JSearch + IA), así que no se lanza
// a ciegas desde el Panel: lleva a Leads, donde está «Escanear vacantes».
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("@/context/LanguageContext", () => ({ useLanguage: () => ({ language: "es" }), LanguageProvider: ({ children }) => children }));
vi.mock("@/features/dashboard/dashboardSnapshot", async (importOriginal) => ({
  ...(await importOriginal()),
  buildDashboardMetricsFromSources: vi.fn(() => new Promise(() => {})),
}));

import { DashboardPage } from "@/views/DashboardPage";

describe("Panel principal · Ejecutar Pipeline", () => {
  it("lleva a la pantalla de Leads", () => {
    const onNavigate = vi.fn();
    render(<DashboardPage onNavigate={onNavigate} />);
    const button = screen.getAllByRole("button").find((b) => /ejecutar pipeline/i.test(b.textContent));
    expect(button).toBeTruthy();
    fireEvent.click(button);
    expect(onNavigate).toHaveBeenCalledWith("leads", {});
  });
});
