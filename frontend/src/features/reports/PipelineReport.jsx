/**
 * PipelineReport — reporte de pipeline de Ventas (RF-VTA-10): propuestas por estado, tasa de
 * conversión, win rate, valor por moneda y tiempo promedio de cierre, con exportación a
 * Excel, CSV y PDF. Las cifras las calcula el servidor; aquí solo se muestran.
 */
import { useState } from "react";

import { reportsApi } from "@/api/axios";
import { Badge, Btn, Card } from "@/components/dashboard/ui";
import { DownloadIcon, RefreshIcon } from "@/components/dashboard/icons";
import { CURRENCIES, downloadBlob, formatAmount, formatDays, formatMoneyByCurrency, formatPercent } from "@/features/reports/pipelineFormat";
import { proposalStatusChartColor, proposalStatusLabelKey } from "@/features/proposals/proposalStatus";
import { useI18n } from "@/hooks/useI18n";

export const PERIODS = [
  { key: "30d", days: 30, label: "reports.pipeline.period30" },
  { key: "90d", days: 90, label: "reports.pipeline.period90" },
  { key: "all", days: null, label: "reports.pipeline.periodAll" },
];

const FORMATS = [
  { format: "xlsx", label: "reports.pipeline.exportXlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  { format: "csv", label: "reports.pipeline.exportCsv", type: "text/csv" },
  { format: "pdf", label: "reports.pipeline.exportPdf", type: "application/pdf" },
];

function Metric({ label, value, hint, testId }) {
  return (
    <div className="rounded-xl border border-gray-100 p-3" data-testid={testId}>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-0.5 text-lg font-bold text-gray-900">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-gray-400">{hint}</p>}
    </div>
  );
}

export function PipelineReport({ days, onDaysChange, pipeline }) {
  const { t } = useI18n();
  const { report, loading, error, reload } = pipeline;
  const [exporting, setExporting] = useState("");
  const [exportError, setExportError] = useState(false);

  const exportAs = async ({ format, type }) => {
    setExporting(format);
    setExportError(false);
    try {
      const response = await reportsApi.export({ format, report: "pipeline", ...(days ? { days } : {}) });
      downloadBlob(response.data, `pipeline-ventas.${format}`, type);
    } catch {
      setExportError(true);
    } finally {
      setExporting("");
    }
  };

  const none = t("reports.pipeline.noData");
  const close = report?.closeTime;
  const average = formatDays(close?.averageDays);

  return (
    <Card className="p-3" data-testid="pipeline-report">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-1">
            <p className="text-sm font-semibold text-gray-800">{t("reports.pipeline.title")}</p>
            <Badge label={t("reports.live")} color="bg-green-100 text-green-700" />
          </div>
          <p className="mt-1 text-xs text-gray-400">{t("reports.pipeline.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-gray-100 p-1" role="group" aria-label={t("reports.pipeline.period")}>
            {PERIODS.map((period) => (
              <button
                key={period.key}
                type="button"
                aria-pressed={(days ?? null) === period.days}
                onClick={() => onDaysChange(period.days)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${(days ?? null) === period.days ? "bg-white text-indigo-700 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
              >
                {t(period.label)}
              </button>
            ))}
          </div>
          <Btn variant="secondary" icon={<RefreshIcon size={13} className={loading ? "animate-spin" : ""} />} onClick={reload} disabled={loading}>
            {t("reports.refresh")}
          </Btn>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-red-50 p-3" role="alert">
          <p className="text-sm text-red-600">{t("reports.pipeline.loadError")}</p>
          <Btn variant="secondary" onClick={reload}>{t("reports.retry")}</Btn>
        </div>
      )}

      {!error && !report && loading && <p className="p-4 text-center text-sm text-gray-500">{t("reports.loading")}</p>}

      {!error && report && report.totals.proposals === 0 && (
        <p className="p-4 text-center text-sm text-gray-500" data-testid="pipeline-empty">{t("reports.pipeline.empty")}</p>
      )}

      {!error && report && report.totals.proposals > 0 && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              testId="metric-conversion"
              label={t("reports.pipeline.conversion")}
              value={formatPercent(report.conversionRate) ?? none}
              hint={t("reports.pipeline.conversionHint").replace("{signed}", String(report.totals.signed)).replace("{sent}", String(report.totals.sent))}
            />
            <Metric
              testId="metric-winrate"
              label={t("reports.pipeline.winRate")}
              value={formatPercent(report.winRate) ?? none}
              hint={t("reports.pipeline.winRateHint").replace("{signed}", String(report.totals.signed)).replace("{rejected}", String(report.totals.rejected))}
            />
            <Metric
              testId="metric-closetime"
              label={t("reports.pipeline.closeTime")}
              value={average ? t("reports.pipeline.days").replace("{days}", average) : none}
              hint={close.signedWithoutDate > 0
                ? t("reports.pipeline.closeTimeMissing").replace("{count}", String(close.signedWithoutDate))
                : t("reports.pipeline.closeTimeHint")}
            />
            <Metric testId="metric-value" label={t("reports.pipeline.valueTotal")} value={formatMoneyByCurrency(report.value.total)} hint={t("reports.pipeline.valueByCurrency")} />
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Metric testId="metric-won" label={t("reports.pipeline.valueWon")} value={formatMoneyByCurrency(report.value.won)} />
            <Metric testId="metric-open" label={t("reports.pipeline.valueOpen")} value={formatMoneyByCurrency(report.value.open)} />
          </div>

          <div className="overflow-x-auto rounded-lg border border-gray-100">
            <table className="min-w-full text-sm" data-testid="pipeline-status-table">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">{t("reports.pipeline.colStatus")}</th>
                  <th className="px-3 py-2 text-right">{t("reports.pipeline.colCount")}</th>
                  <th className="px-3 py-2 text-right">{t("reports.pipeline.colShare")}</th>
                  {CURRENCIES.map((code) => <th key={code} className="px-3 py-2 text-right">{code}</th>)}
                </tr>
              </thead>
              <tbody>
                {report.byStatus.map((row) => (
                  <tr key={row.status} data-testid={`status-row-${row.status}`} className="border-t border-gray-100">
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-2 text-gray-800">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: proposalStatusChartColor(row.status) }} />
                        {t(proposalStatusLabelKey(row.status))}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-gray-900">{row.count}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{formatPercent(row.share) ?? "—"}</td>
                    {CURRENCIES.map((code) => (
                      <td key={code} className="px-3 py-2 text-right text-gray-600">{formatAmount(row.value?.[code])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {report.truncated && <p className="text-xs text-amber-600" role="status">{t("reports.pipeline.truncated")}</p>}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
        <span className="text-xs text-gray-500">{t("reports.pipeline.exportLabel")}</span>
        {FORMATS.map((item) => (
          <Btn key={item.format} variant="secondary" icon={<DownloadIcon size={14} />} onClick={() => exportAs(item)} disabled={Boolean(exporting)}>
            {exporting === item.format ? t("reports.exporting") : t(item.label)}
          </Btn>
        ))}
        {exportError && <span className="text-xs text-red-600" role="alert">{t("reports.pipeline.exportError")}</span>}
      </div>
    </Card>
  );
}
