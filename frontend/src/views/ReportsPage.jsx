import { Badge, Btn, Card, KpiCard } from "@/components/dashboard/ui";
import { BookIcon, BriefIcon, DownloadIcon, RefreshIcon, TargetIcon, TrendIcon } from "@/components/dashboard/icons";
import api, { reportsApi } from "@/api/axios";
import { getDashboardData } from "@/api/dashboardApi";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useLanguage } from "@/context/LanguageContext";

/* ═══════════════════════════════════════════════════════════════ */
/*  PAGE: REPORTS                                                  */
/* ═══════════════════════════════════════════════════════════════ */
export function ReportsPage({ onNavigate = () => {}, campaignFlow = null, setCampaignFlow = () => {} }) {
  const { t } = useI18n();
  const { language } = useLanguage();
  const [proposalStatusPeriod, setProposalStatusPeriod] = useState("30d");
  const [winRateData, setWinRateData] = useState({ rate: null, detail: "" });
  const [reportsState, setReportsState] = useState({
    overview: null,
    dashboard: null,
    proposals: null,
    loading: true,
    error: "",
    exporting: false,
  });

  const loadReports = async () => {
    setReportsState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const [overviewResponse, dashboardData, proposalsResponse] = await Promise.all([
        reportsApi.overview(),
        getDashboardData(),
        reportsApi.proposals(),
      ]);
      setReportsState({
        overview: overviewResponse.data || null,
        dashboard: dashboardData || null,
        proposals: proposalsResponse.data || null,
        loading: false,
        error: "",
        exporting: false,
      });
      setWinRateData({
        rate: overviewResponse.data?.win_rate,
        detail: overviewResponse.data?.win_rate_detail,
      });
    } catch {
      setReportsState((current) => ({
        ...current,
        loading: false,
        error: t("reports.loadError"),
      }));
    }
  };

  useEffect(() => {
    loadReports();
  }, []);

  const fetchWinRate = async (period) => {
    const days = period === "30d" ? 30 : period === "90d" ? 90 : null;
    const params = days ? `?days=${days}` : "";
    const res = await api.get(`/reports/overview${params}`).then((r) => r.data);
    setWinRateData({
      rate: res.win_rate,
      detail: res.win_rate_detail,
    });
  };

  const handlePeriodChange = (period) => {
    setProposalStatusPeriod(period);
    fetchWinRate(period);
  };

  useEffect(() => {
    const handleRefresh = () => loadReports();

    window.addEventListener("marketgen:proposal-updated", handleRefresh);
    window.addEventListener("marketgen:campaign-updated", handleRefresh);
    window.addEventListener("marketgen:opportunity-updated", handleRefresh);
    window.addEventListener("marketgen:content-library-updated", handleRefresh);

    return () => {
      window.removeEventListener("marketgen:proposal-updated", handleRefresh);
      window.removeEventListener("marketgen:campaign-updated", handleRefresh);
      window.removeEventListener("marketgen:opportunity-updated", handleRefresh);
      window.removeEventListener("marketgen:content-library-updated", handleRefresh);
    };
  }, []);

  const exportBooksPdf = async () => {
    setReportsState((current) => ({ ...current, exporting: true, error: "" }));
    try {
      const response = await reportsApi.export({ format: "pdf" });
      const url = window.URL.createObjectURL(new Blob([response.data], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "marketgen-books-report.pdf";
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      setReportsState((current) => ({ ...current, error: t("reports.exportError") }));
    } finally {
      setReportsState((current) => ({ ...current, exporting: false }));
    }
  };

  const reportsData = reportsState.overview || {};
  const overviewKpis = reportsData.kpis || {};
  const dashboard = reportsState.dashboard || {};
  const translateProposalStatus = (status, lang) => {
    const translations = {
      Generada: { en: "Generated", pt: "Gerada" },
      Entregada: { en: "Delivered", pt: "Entregue" },
      "En Negociación": { en: "In Negotiation", pt: "Em Negociação" },
      Cerrada: { en: "Closed", pt: "Fechada" },
      "En Contrato": { en: "Under Contract", pt: "Em Contrato" },
      Perdida: { en: "Lost", pt: "Perdida" },
    };
    if (lang === "es") return status;
    return translations[status]?.[lang] || status;
  };
  const statusColors = {
    Generada: "rgb(var(--brand-600))",
    Entregada: "#3B82F6",
    "En Negociación": "#F59E0B",
    Cerrada: "#16A34A",
    "En Contrato": "#047857",
    Perdida: "#F43F5E",
  };
  const proposalStatusOrder = ["Generada", "Entregada", "En Negociación", "Cerrada", "En Contrato", "Perdida"];
  const rawProposalRows = Array.isArray(reportsState.proposals?.data) ? reportsState.proposals.data : [];
  const rawProposalRowsByStatus = rawProposalRows.reduce((map, row) => {
    const status = row.name || row.label || "Generada";
    map[status] = row;
    return map;
  }, {});
  const proposalRows = proposalStatusOrder.map((status) => {
    const row = rawProposalRowsByStatus[status] || {};
    const value = Number(row.value ?? row.count) || 0;
    const totalValue = Number(row.totalValue) || 0;
    return {
      ...row,
      status,
      name: translateProposalStatus(status, language),
      value,
      totalValue,
      fill: statusColors[status] || "rgb(var(--brand-600))",
    };
  }).filter((row) => row.value > 0 || rawProposalRows.length === 0);
  const totalProposalValue = rawProposalRows.reduce((sum, row) => sum + (Number(row.totalValue) || 0), 0);
  const totalProposalCount = proposalRows.reduce((sum, row) => sum + row.value, 0);
  const winRateValue = Number(winRateData.rate ?? overviewKpis.winRate ?? dashboard?.totals?.winRate);
  const winRate = Number.isFinite(winRateValue) ? winRateValue : 0;
  let donutStart = -90;
  const donutStops = proposalRows.length && totalProposalCount > 0
    ? proposalRows.map((row) => {
        const deg = (row.value / totalProposalCount) * 360;
        const stop = `${row.fill} ${donutStart}deg ${donutStart + deg}deg`;
        donutStart += deg;
        return stop;
      }).join(", ")
    : "#1E2740 0deg 360deg";
  const donutStyle = { background: `conic-gradient(${donutStops})` };
  const proposalDisplayRows = proposalRows.map((row) => {
    const percent = Math.round((row.value / Math.max(totalProposalCount, 1)) * 100);
    return {
      ...row,
      percent,
    };
  });
  const funnelRows = [
    { label: t("reports.detected"), value: Number(dashboard.detected) || 0, color: "bg-blue-500", stageFilter: "Detected" },
    { label: t("reports.contacted"), value: Number(dashboard.contacted) || 0, color: "bg-indigo-500", stageFilter: "Contacted" },
    { label: t("reports.replied"), value: Number(dashboard.replied) || 0, color: "bg-purple-500", stageFilter: "Replied" },
    { label: t("reports.won"), value: Number(dashboard.won) || 0, color: "bg-green-500", stageFilter: "Won" },
  ];
  const maxFunnelValue = Math.max(0, ...funnelRows.map((row) => row.value));
  const formatCurrency = (value) => new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
  const formatPercent = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "0%";
    return `${numeric.toFixed(numeric % 1 === 0 ? 0 : 1)}%`;
  };
  const formatCompactCurrency = (amount) => {
    if (!amount || amount === 0) return '$0';
    if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`;
    if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}K`;
    return `$${amount}`;
  };
  return (
    <div className="space-y-2">
      {campaignFlow?.currentStep === 7 && (
        <div style={{
          background: 'linear-gradient(135deg, #F0FDF4, #ECFDF5)',
          border: '1px solid #BBF7D0',
          borderLeft: '4px solid #16A34A',
          borderRadius: 10, padding: 24, marginBottom: 24
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h2 style={{ color: '#166534', fontSize: '1.2em', fontWeight: 700, marginBottom: 4 }}>
                🎉 Campaign activated: {campaignFlow.campaignName}
              </h2>
              <p style={{ color: '#16A34A', fontSize: '0.9em' }}>
                Tracking results in real time below
              </p>
            </div>
            <button
              onClick={() => setCampaignFlow(null)}
              style={{ background: '#16A34A', color: 'white', border: 'none', padding: '8px 16px', borderRadius: 6, cursor: 'pointer' }}
            >
              Finish
            </button>
          </div>

          {/* Resumen de la campaña */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 20 }}>
            <div style={{ background: 'white', borderRadius: 8, padding: 16, textAlign: 'center', border: '1px solid #D1FAE5' }}>
              <div style={{ fontSize: '1.8em', fontWeight: 700, color: 'rgb(var(--brand-600))' }}>
                {campaignFlow.selectedOpportunities?.length || 0}
              </div>
              <div style={{ fontSize: '0.8em', color: '#64748B', marginTop: 4 }}>Prospects targeted</div>
            </div>
            <div style={{ background: 'white', borderRadius: 8, padding: 16, textAlign: 'center', border: '1px solid #D1FAE5' }}>
              <div style={{ fontSize: '1.8em', fontWeight: 700, color: 'rgb(var(--brand-600))' }}>
                {campaignFlow.selectedAssets?.length || 0}
              </div>
              <div style={{ fontSize: '0.8em', color: '#64748B', marginTop: 4 }}>Assets attached</div>
            </div>
            <div style={{ background: 'white', borderRadius: 8, padding: 16, textAlign: 'center', border: '1px solid #D1FAE5' }}>
              <div style={{ fontSize: '1.8em', fontWeight: 700, color: '#10B981' }}>
                {campaignFlow.brief?.channels?.length || 0}
              </div>
              <div style={{ fontSize: '0.8em', color: '#64748B', marginTop: 4 }}>Channels active</div>
            </div>
            <div style={{ background: 'white', borderRadius: 8, padding: 16, textAlign: 'center', border: '1px solid #D1FAE5' }}>
              <div style={{ fontSize: '1.2em', fontWeight: 700, color: '#F59E0B' }}>Tracking...</div>
              <div style={{ fontSize: '0.8em', color: '#64748B', marginTop: 4 }}>Response rate</div>
            </div>
          </div>

          {/* KPIs del brief */}
          {campaignFlow.brief?.kpis && (
            <div style={{ marginTop: 16, padding: 12, background: 'white', borderRadius: 8, border: '1px solid #D1FAE5' }}>
              <span style={{ fontSize: '0.85em', fontWeight: 600, color: '#166534' }}>📊 Expected KPIs: </span>
              <span style={{ fontSize: '0.85em', color: '#374151' }}>{campaignFlow.brief.kpis}</span>
            </div>
          )}
        </div>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("reports.title")}</h1>
          <p className="text-xs text-gray-500">{t("reports.subtitle")}</p>
        </div>
        <div className="flex gap-1">
          <Btn
            variant="secondary"
            icon={<RefreshIcon size={13} className={reportsState.loading ? "animate-spin" : ""} />}
            onClick={loadReports}
            disabled={reportsState.loading}
          >
            {t("reports.refresh")}
          </Btn>
          <Btn
            variant="secondary"
            icon={<DownloadIcon size={14} />}
            onClick={exportBooksPdf}
            disabled={reportsState.exporting}
            title={t("reports.exportBooksCsvHint")}
          >
            {reportsState.exporting ? t("reports.exporting") : t("reports.exportBooksCsv")}
          </Btn>
        </div>
      </div>

      {reportsState.loading && (
        <Card className="p-6 text-center">
          <p className="text-sm font-medium text-gray-700">{t("reports.loading")}</p>
        </Card>
      )}

      {!reportsState.loading && reportsState.error && (
        <Card className="p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-red-600">{reportsState.error}</p>
            <Btn variant="secondary" icon={<RefreshIcon size={13} />} onClick={loadReports}>{t("reports.retry")}</Btn>
          </div>
        </Card>
      )}

      {!reportsState.loading && !reportsState.error && (
        <>
          <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2 xl:grid-cols-4">
            <KpiCard icon={BriefIcon} label={t("reports.totalProposalsGenerated")} value={Number(overviewKpis.proposalsSent) || 0} sub={t("reports.backendData")} color="bg-indigo-50 text-indigo-600" onClick={() => onNavigate("content", { typeFilter: "Proposals" })} />
            <KpiCard icon={TrendIcon} label={t("reports.totalProposalValue")} value={formatCompactCurrency(totalProposalValue)} sub={t("reports.fromProposals")} color="bg-green-50 text-green-600" onClick={() => onNavigate("content", { typeFilter: "Proposals" })} />
            <KpiCard icon={BookIcon} label={t("reports.bookConceptsCreated")} value={Number(overviewKpis.totalBooks) || 0} sub={t("reports.fromBooks")} color="bg-purple-50 text-purple-600" onClick={() => onNavigate("books")} />
            <KpiCard
              icon={TargetIcon}
              label={t("reports.winRate")}
              value={formatPercent(winRate)}
              sub={t("reports.fromPipeline")}
              detail={winRateData.detail || reportsData.win_rate_detail || 'No qualified opportunities yet'}
              color="bg-green-50 text-green-600"
              onClick={() => onNavigate("opportunities", { stageFilter: "Won" })}
            />
          </div>

          {proposalRows.length > 0 ? (
            <Card className="p-2">
                <div className="mb-4 flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex items-center gap-1">
                      <p className="text-xs font-semibold text-gray-700">{t("reports.proposalsByStatus")}</p>
                      <Badge label={t("reports.live")} color="bg-green-100 text-green-700" />
                    </div>
                    <p className="mt-1 text-xs text-gray-400">{t("reports.distributionPipelineValue")}</p>
                  </div>
                  <div className="flex rounded-lg bg-gray-100 p-1">
                    {["30d", "90d", "all"].map((period) => (
                      <button
                        key={period}
                        onClick={() => handlePeriodChange(period)}
                        className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${proposalStatusPeriod === period ? "bg-white text-indigo-700 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
                      >
                        {period === "all" ? t("reports.all") : period}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 items-center gap-2.5 md:grid-cols-[170px_1fr]">
                  <div className="relative mx-auto h-36 w-36">
                    <div className="h-full w-full rounded-full" style={donutStyle} />
                    <div className="absolute inset-5 flex flex-col items-center justify-center rounded-full bg-white">
                      <p className="text-3xl font-bold leading-none text-gray-900">{totalProposalCount}</p>
                      <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">{t("reports.proposals")}</p>
                      <p className="mt-2 text-xs font-bold text-indigo-600">{formatCompactCurrency(totalProposalValue)}</p>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    {proposalDisplayRows.map((row) => (
                      <div
                        key={row.status}
                        onClick={() => onNavigate("content", { statusFilter: row.status })}
                        className="cursor-pointer rounded-md hover:bg-[#F8FAFC]"
                      >
                        <div className="mb-1 flex items-center gap-1">
                          <span className="h-2.5 w-2.5 flex-none rounded-[3px]" style={{ background: row.fill }} />
                          <span className="min-w-0 flex-1 text-xs font-semibold text-gray-700">{row.name}</span>
                          <span className="text-xs font-bold text-gray-900">{row.value}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                            <div className="h-full rounded-full" style={{ width: `${row.percent}%`, background: row.fill }} />
                          </div>
                          <span className="w-8 text-right text-[11px] font-medium text-gray-400">{row.percent}%</span>
                          <span className="w-12 text-right text-[11px] font-medium text-gray-500">{formatCompactCurrency(row.totalValue)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

            </Card>
          ) : (
            <Card className="p-6 text-center">
              <p className="text-xs font-medium text-gray-400">{t("reports.noProposalStatusData")}</p>
            </Card>
          )}

          <Card className="p-2">
            <p className="text-xs font-semibold text-gray-700 mb-1.5">{t("reports.funnel")}</p>
            <div className="space-y-1.5">
              {funnelRows.map((row) => {
                const width = maxFunnelValue > 0 ? Math.max(4, Math.round((row.value / maxFunnelValue) * 100)) : 0;
                return (
                  <div
                    key={row.label}
                    onClick={() => onNavigate("opportunities", { stageFilter: row.stageFilter })}
                    className="group cursor-pointer"
                  >
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="font-medium text-gray-600 group-hover:underline">{row.label}</span>
                      <span className="font-bold text-gray-900">{row.value}</span>
                    </div>
                    <div className="h-2 rounded-full bg-gray-100">
                      <div className={`h-full rounded-full ${row.color}`} style={{ width: `${width}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
