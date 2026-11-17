// RF-VTA-10: reporte de pipeline en la pantalla de informes (cifras, período, vacío, error y exportación).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { reportsApi } = vi.hoisted(() => ({ reportsApi: { pipeline: vi.fn(), export: vi.fn() } }));

vi.mock("@/hooks/useI18n", () => ({ useI18n: () => ({ t: (key) => key, language: "es" }) }));
vi.mock("@/api/axios", () => ({ reportsApi, default: {} }));

import { PipelineReport } from "@/features/reports/PipelineReport";
import { usePipelineReport } from "@/features/reports/usePipelineReport";
import { formatDays, formatMoneyByCurrency, formatPercent } from "@/features/reports/pipelineFormat";
import { useState } from "react";

const REPORT = {
  period: { days: null, label: "todo el historial" },
  totals: { proposals: 8, sent: 7, signed: 3, rejected: 1, drafts: 1 },
  byStatus: [
    { status: "borrador", count: 1, share: 12.5, value: { USD: 500, CLP: 0 } },
    { status: "enviada", count: 1, share: 12.5, value: { USD: 1000, CLP: 0 } },
    { status: "firmada", count: 3, share: 37.5, value: { USD: 14000, CLP: 8000000 } },
    { status: "rechazada", count: 1, share: 12.5, value: { USD: 700, CLP: 0 } },
  ],
  conversionRate: 42.9,
  winRate: 75,
  value: { total: { USD: 21200, CLP: 8000000 }, won: { USD: 14000, CLP: 8000000 }, open: { USD: 6000, CLP: 0 } },
  closeTime: { averageDays: 15, signedWithDate: 3, signedWithoutDate: 0 },
  truncated: false,
  generatedAt: "2026-11-13T12:00:00+00:00",
};

function Harness() {
  const [days, setDays] = useState(null);
  const pipeline = usePipelineReport(days);
  return <PipelineReport days={days} onDaysChange={setDays} pipeline={pipeline} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  reportsApi.pipeline.mockResolvedValue({ data: REPORT });
  reportsApi.export.mockResolvedValue({ data: new Uint8Array([1, 2, 3]) });
  window.URL.createObjectURL = vi.fn(() => "blob:fake");
  window.URL.revokeObjectURL = vi.fn();
});

describe("formato", () => {
  it("porcentaje, días y valor por moneda", () => {
    expect(formatPercent(42.9)).toBe("42.9 %");
    expect(formatPercent(75)).toBe("75 %");
    expect(formatPercent(null)).toBeNull();
    expect(formatDays(15)).toBe("15.0");
    expect(formatDays(undefined)).toBeNull();
    expect(formatMoneyByCurrency({ USD: 0, CLP: 0 })).toBe("0");
    const text = formatMoneyByCurrency({ USD: 21200, CLP: 8000000 });
    expect(text).toContain("USD ");
    expect(text).toContain("CLP ");
    expect(text).toContain(" · ");
  });

  it("no muestra una moneda en cero", () => {
    const text = formatMoneyByCurrency({ USD: 1000, CLP: 0 });
    expect(text).toContain("USD") && expect(text).not.toContain("CLP");
  });
});

describe("cifras", () => {
  it("muestra conversión, win rate, tiempo de cierre y valor por moneda", async () => {
    render(<Harness />);
    const conversion = await screen.findByTestId("metric-conversion");
    expect(within(conversion).getByText("42.9 %")).toBeTruthy();
    expect(within(screen.getByTestId("metric-winrate")).getByText("75 %")).toBeTruthy();
    expect(within(screen.getByTestId("metric-closetime")).getByText("reports.pipeline.days")).toBeTruthy();
    const total = screen.getByTestId("metric-value").textContent;
    expect(total).toContain("USD");
    expect(total).toContain("CLP");
  });

  it("lista las propuestas por estado con su cantidad y porcentaje", async () => {
    render(<Harness />);
    const row = await screen.findByTestId("status-row-firmada");
    expect(within(row).getByText("3")).toBeTruthy();
    expect(within(row).getByText("37.5 %")).toBeTruthy();
    expect(screen.getByTestId("status-row-rechazada")).toBeTruthy();
    expect(screen.queryByTestId("status-row-vista")).toBeNull();
  });

  it("sin datos de cierre dice «sin datos» en lugar de 0 días", async () => {
    reportsApi.pipeline.mockResolvedValue({ data: {
      ...REPORT, conversionRate: null, winRate: null, closeTime: { averageDays: null, signedWithDate: 0, signedWithoutDate: 0 },
    } });
    render(<Harness />);
    expect(within(await screen.findByTestId("metric-closetime")).getByText("reports.pipeline.noData")).toBeTruthy();
    expect(within(screen.getByTestId("metric-conversion")).getByText("reports.pipeline.noData")).toBeTruthy();
  });

  it("avisa cuántas firmadas no cuentan por no tener fecha de cierre", async () => {
    reportsApi.pipeline.mockResolvedValue({ data: { ...REPORT, closeTime: { averageDays: 10, signedWithDate: 2, signedWithoutDate: 1 } } });
    render(<Harness />);
    expect(within(await screen.findByTestId("metric-closetime")).getByText("reports.pipeline.closeTimeMissing")).toBeTruthy();
  });

  it("avisa cuando el reporte quedó truncado", async () => {
    reportsApi.pipeline.mockResolvedValue({ data: { ...REPORT, truncated: true } });
    render(<Harness />);
    expect(await screen.findByText("reports.pipeline.truncated")).toBeTruthy();
  });

  it("sin propuestas muestra el estado vacío", async () => {
    reportsApi.pipeline.mockResolvedValue({ data: { ...REPORT, totals: { proposals: 0, sent: 0, signed: 0, rejected: 0, drafts: 0 }, byStatus: [] } });
    render(<Harness />);
    expect(await screen.findByTestId("pipeline-empty")).toBeTruthy();
    expect(screen.queryByTestId("metric-conversion")).toBeNull();
  });
});

describe("período", () => {
  it("pide todo el historial al abrir y el período elegido al cambiarlo", async () => {
    render(<Harness />);
    await screen.findByTestId("metric-conversion");
    expect(reportsApi.pipeline).toHaveBeenLastCalledWith(undefined);

    fireEvent.click(screen.getByRole("button", { name: "reports.pipeline.period30" }));
    await waitFor(() => expect(reportsApi.pipeline).toHaveBeenLastCalledWith({ days: 30 }));
    expect(screen.getByRole("button", { name: "reports.pipeline.period30" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "reports.pipeline.period90" }));
    await waitFor(() => expect(reportsApi.pipeline).toHaveBeenLastCalledWith({ days: 90 }));
  });
});

describe("error", () => {
  it("si el reporte no carga muestra el error y permite reintentar", async () => {
    reportsApi.pipeline.mockRejectedValueOnce(new Error("boom"));
    render(<Harness />);
    expect(await screen.findByText("reports.pipeline.loadError")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "reports.retry" }));
    expect(await screen.findByTestId("metric-conversion")).toBeTruthy();
    expect(screen.queryByText("reports.pipeline.loadError")).toBeNull();
  });
});

describe("exportación", () => {
  it.each([["xlsx", "reports.pipeline.exportXlsx"], ["csv", "reports.pipeline.exportCsv"], ["pdf", "reports.pipeline.exportPdf"]])(
    "%s pide el reporte de pipeline y descarga el archivo", async (format, label) => {
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      render(<Harness />);
      await screen.findByTestId("metric-conversion");
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(reportsApi.export).toHaveBeenCalledWith({ format, report: "pipeline" }));
      await waitFor(() => expect(click).toHaveBeenCalled());
      click.mockRestore();
    });

  it("exporta con el período elegido", async () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<Harness />);
    await screen.findByTestId("metric-conversion");
    fireEvent.click(screen.getByRole("button", { name: "reports.pipeline.period90" }));
    await waitFor(() => expect(reportsApi.pipeline).toHaveBeenLastCalledWith({ days: 90 }));
    fireEvent.click(screen.getByRole("button", { name: "reports.pipeline.exportCsv" }));
    await waitFor(() => expect(reportsApi.export).toHaveBeenCalledWith({ format: "csv", report: "pipeline", days: 90 }));
  });

  it("si la exportación falla lo dice y no descarga nada", async () => {
    reportsApi.export.mockRejectedValueOnce(new Error("boom"));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<Harness />);
    await screen.findByTestId("metric-conversion");
    fireEvent.click(screen.getByRole("button", { name: "reports.pipeline.exportXlsx" }));
    expect(await screen.findByText("reports.pipeline.exportError")).toBeTruthy();
    expect(click).not.toHaveBeenCalled();
    click.mockRestore();
  });
});
