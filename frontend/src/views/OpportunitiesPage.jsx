import { Btn, Card, Select, StageBadge, stageTranslationKey } from "@/components/dashboard/ui";
import { DownloadIcon, LinkIcon, PlusIcon, SparkIcon } from "@/components/dashboard/icons";
import { OPPORTUNITY_STAGES, exportOpportunitiesWorkbook, getOpportunityStageCounts, normalizeOpportunity, stageMatches, validContentRef } from "@/features/opportunities/opportunityHelpers";
import { OpportunityProposalModal } from "@/features/proposals/OpportunityProposalModal";
import { asArray } from "@/utils/dashboardData";
import { opportunitiesApi } from "@/api/axios";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/context/ThemeContext";
import { CreateOpportunityModal } from "@/features/opportunities/CreateOpportunityModal";

export function OpportunitiesPage({ navigationState = {}, onNavigate = () => {}, campaignFlow = null, setCampaignFlow = () => {} }) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const [stageFilter, setStageFilter] = useState(navigationState.stageFilter || "All");
  const [proposalOpportunity, setProposalOpportunity] = useState(null);
  const [opportunities, setOpportunities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedOpportunities, setSelectedOpportunities] = useState(campaignFlow?.selectedOpportunities || []);
  const stages = OPPORTUNITY_STAGES;
  const stageCounts = getOpportunityStageCounts(opportunities);

  const loadOpportunities = async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await opportunitiesApi.list();
      setOpportunities(asArray(data).map(normalizeOpportunity));
    } catch (err) {
      console.error(err);
      setError(t("opportunitiesPage.loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOpportunities();
  }, []);

  useEffect(() => {
    setStageFilter(navigationState.stageFilter || "All");
  }, [navigationState.stageFilter]);

  useEffect(() => {
    if (campaignFlow?.currentStep === 1) {
      setSelectedOpportunities(campaignFlow.selectedOpportunities || []);
    }
  }, [campaignFlow?.currentStep]);

  const toggleFlowOpportunity = (opportunity) => {
    if (!campaignFlow) return;
    setSelectedOpportunities((current) => {
      const exists = current.some((item) => item.id === opportunity.id);
      return exists
        ? current.filter((item) => item.id !== opportunity.id)
        : [...current, opportunity];
    });
  };

  const filtered = opportunities.filter((o) => {
    if (stageFilter !== "All" && !stageMatches(o, stageFilter)) return false;
    if (navigationState.minScore && Number(o.score || 0) < navigationState.minScore) return false;
    if (navigationState.hasContact && !o.contact) return false;
    return true;
  });
  const exportOpportunities = () => {
    if (opportunities.length === 0) return;
    exportOpportunitiesWorkbook(opportunities);
  };
  const campaignAudienceStep = campaignFlow?.currentStep === 1;

  return (
    <div className="space-y-2">
      {campaignFlow?.currentStep === 1 && (
        <div className="flow-step-banner">
          <span>👥 Step 1: Select the opportunities to target with this campaign</span>
          <button
            type="button"
            disabled={selectedOpportunities.length === 0}
            onClick={() => {
              setCampaignFlow((prev) => ({
                ...prev,
                currentStep: 2,
                completedSteps: Array.from(new Set([...(prev.completedSteps || []), 1])),
                selectedOpportunities,
              }));
              onNavigate("campaign_brief");
            }}
          >
            Continue to Brief →
          </button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("opportunitiesPage.title")}</h1>
          <p className="text-xs text-gray-500">{t("opportunitiesPage.subtitle")}</p>
        </div>
        <div className="flex gap-1">
          <Btn variant="secondary" icon={<DownloadIcon size={13} />} onClick={exportOpportunities} disabled={opportunities.length === 0}>
            {t("opportunitiesPage.exportExcel")}
          </Btn>
          <Btn icon={<PlusIcon size={14} />} onClick={() => setShowCreateModal(true)}>{t("opportunitiesPage.addManually")}</Btn>
        </div>
      </div>

      {/* Stage pipeline visualization */}
      <Card className="p-2">
        <div className="flex gap-1">
          {stages.map(s => {
            const count = stageCounts[s] || 0;
            const active = stageFilter === s;
            return (
              <button key={s} onClick={() => setStageFilter(s)}
                className={`flex-1 py-4 px-2 rounded-lg text-xs font-medium transition-colors text-center ${
                  active
                    ? "bg-indigo-600 text-white"
                    : isDark
                      ? "bg-slate-800 text-slate-300 border border-white/10 hover:bg-slate-700"
                      : "bg-gray-50 text-gray-600 hover:bg-gray-100"
                }`}>
                <span className="block">{t(`opportunitiesPage.stages.${stageTranslationKey(s)}`)}</span>
                <span className={`text-lg font-bold ${active ? "text-white" : isDark ? "text-slate-100" : "text-gray-900"}`}>{count}</span>
              </button>
            );
          })}
        </div>
      </Card>

      {/* Opportunities table */}
      <Card>
        {loading ? (
          <div className="px-4 py-10 text-center text-sm text-gray-500">{t("opportunitiesPage.loading")}</div>
        ) : error ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium text-red-600">{error}</p>
            <Btn className="mt-3" variant="secondary" small onClick={loadOpportunities}>{t("opportunitiesPage.retry")}</Btn>
          </div>
        ) : opportunities.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium text-gray-700">{t("opportunitiesPage.emptyTitle")}</p>
            <p className="mt-1 text-xs text-gray-500">{t("opportunitiesPage.emptyDescription")}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium text-gray-700">{t("opportunitiesPage.emptyFiltered")}</p>
          </div>
        ) : (
          <div className="overflow-x-auto"><table className="w-full text-xs">
            <thead><tr className="bg-slate-50 text-slate-600 uppercase">
              {campaignAudienceStep && <th className="w-10 px-4 py-2.5 text-left font-medium" />}
              <th className="px-4 py-2.5 text-left font-medium">{t("opportunitiesPage.columns.company")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("opportunitiesPage.columns.opportunity")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("opportunitiesPage.columns.contact")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("opportunitiesPage.columns.stage")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("opportunitiesPage.columns.score")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("opportunitiesPage.columns.contentUsed")}</th>
              <th className="px-4 py-2.5 text-left font-medium">{t("opportunitiesPage.columns.lastActivity")}</th>
              {!campaignAudienceStep && <th className="px-4 py-2.5 text-right font-medium">{t("opportunitiesPage.columns.actions")}</th>}
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((o) => {
                const selectedForFlow = campaignAudienceStep && selectedOpportunities.some((item) => item.id === o.id);
                return (
                <tr
                  key={o.id || `${o.company}-${o.job}`}
                  onClick={() => campaignAudienceStep && toggleFlowOpportunity(o)}
                  className={`hover:bg-slate-50 ${campaignAudienceStep ? "cursor-pointer border-l-4" : ""} ${selectedForFlow ? "border-l-indigo-500 bg-indigo-50/60" : campaignAudienceStep ? "border-l-transparent" : ""}`}
                >
                  {campaignAudienceStep && (
                    <td className="px-4 py-4">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        checked={selectedForFlow}
                        onChange={() => toggleFlowOpportunity(o)}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`Select ${o.company}`}
                      />
                    </td>
                  )}
                  <td className="px-4 py-4">
                    <p className="font-medium text-gray-900">{o.company}</p>
                    <div className="flex gap-1 mt-0.5">{o.kw.map(k => <span key={k} className={`px-1.5 py-0.5 rounded text-xs ${isDark ? "bg-[#0F172A] text-slate-300 border border-white/10" : "bg-indigo-50 text-indigo-600"}`}>{k}</span>)}</div>
                  </td>
                  <td className="px-4 py-4 text-indigo-600 font-medium">{o.job}</td>
                  <td className="px-4 py-4">
                    <p className="text-gray-800">{o.contact}</p>
                    <p className="text-gray-400">{o.role}</p>
                  </td>
                  <td className="px-4 py-4"><StageBadge stage={o.stage} /></td>
                  <td className="px-4 py-4"><span className={`text-xs font-bold ${o.score >= 80 ? "text-green-600" : o.score >= 70 ? "text-amber-600" : "text-gray-500"}`}>{o.score}%</span></td>
                  <td className="px-4 py-4">
                    {validContentRef(o.content) ? (
                      <span className="inline-flex items-center gap-1 text-xs text-indigo-600"><LinkIcon size={10} />{o.content}</span>
                    ) : <span className="text-gray-300">-</span>}
                  </td>
                  <td className="px-4 py-4 text-gray-500">{o.date}</td>
                  {!campaignAudienceStep && (
                    <td className="px-4 py-4 text-right">
                      <Btn small icon={<SparkIcon size={12} />} onClick={(event) => {
                        event.stopPropagation();
                        setProposalOpportunity(o);
                      }}>
                        {t("opportunitiesPage.generateProposal")}
                      </Btn>
                    </td>
                  )}
                </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </Card>
      <CreateOpportunityModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={loadOpportunities}
      />
      {proposalOpportunity && (
        <OpportunityProposalModal
          opportunity={proposalOpportunity}
          onClose={() => setProposalOpportunity(null)}
        />
      )}
    </div>
  );
}
