// Dashboard: los KPI de una fila deben alinear el número aunque la etiqueta ocupe una o dos líneas.
// jsdom no calcula layout, así que se fija el contrato de clases: etiqueta con alto reservado de 2 líneas y tarjeta de alto completo.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }) }));

import { KpiCard, QuickActionCard } from "@/components/dashboard/ui";

const Icon = () => <svg />;
const cards = [
  { label: "Detectados", value: 24, sub: "esta semana" },
  { label: "Pendientes de Revisión", value: 5, sub: "requieren atención" },
  { label: "Respondidos", value: 2 },
];

describe("KpiCard", () => {
  it("todas las etiquetas reservan el mismo alto (2 líneas) y se recortan, sin importar cuánto texto tengan", () => {
    render(<>{cards.map((c) => <KpiCard key={c.label} icon={Icon} color="bg-blue-50 text-blue-600" {...c} />)}</>);
    const labels = screen.getAllByTestId("kpi-label");
    expect(labels).toHaveLength(3);
    for (const label of labels) {
      expect(label.className).toContain("min-h-8");
      expect(label.className).toContain("line-clamp-2");
      expect(label.className).toContain("leading-4");
    }
  });

  it("el texto completo queda en el tooltip por si se recorta", () => {
    render(<KpiCard icon={Icon} color="bg-blue-50 text-blue-600" label="Pendientes de Revisión" value={5} />);
    expect(screen.getByTestId("kpi-label").getAttribute("title")).toBe("Pendientes de Revisión");
  });

  it("la tarjeta ocupa todo el alto de la fila, con o sin clic", () => {
    const { container, rerender } = render(<KpiCard icon={Icon} color="bg-blue-50 text-blue-600" label="A" value={1} />);
    expect(container.firstChild.className).toContain("h-full");
    rerender(<KpiCard icon={Icon} color="bg-blue-50 text-blue-600" label="A" value={1} onClick={() => {}} />);
    expect(container.firstChild.className).toContain("h-full");
  });
});

describe("QuickActionCard: métricas", () => {
  it("las etiquetas de las métricas reservan 2 líneas para que los números queden alineados", () => {
    render(
      <QuickActionCard
        icon={Icon}
        title="Crear una Propuesta"
        description="Descripción"
        badges={[]}
        buttonLabel="Crear"
        metrics={[
          { label: "Propuestas creadas", value: 12 },
          { label: "Ventas ganadas", value: 0 },
        ]}
      />,
    );
    const labels = screen.getAllByTestId("metric-label");
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label.className).toContain("min-h-8");
      expect(label.className).toContain("leading-4"); // la altura mínima es 2 x la interlínea
      expect(label.className).toContain("line-clamp-2");
    }
  });
});
