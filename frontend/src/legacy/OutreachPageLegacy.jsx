import { Badge, Btn, Card } from "@/components/dashboard/ui";
import { CheckIcon, ClockIcon, InboxIcon, LinkIcon, PenIcon, RefreshIcon, XIcon } from "@/components/dashboard/icons";
import { DEMO_OUTREACH_HISTORY, DEMO_REVIEW_EMAILS } from "@/utils/demoData";
import { normalizeStageName } from "@/features/opportunities/opportunityHelpers";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/context/ThemeContext";

/* ═══════════════════════════════════════════════════════════════ */
/*  PAGE: OUTREACH (merged Review Queue + Outreach History)        */
/* ═══════════════════════════════════════════════════════════════ */
function OutreachPageLegacy({ navigationState = {} }) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const [tab, setTab] = useState(navigationState.tab || "review");
  const [historyFilter, setHistoryFilter] = useState(navigationState.statusFilter || "all");
  const [selected, setSelected] = useState(0);

  const reviewEmails = DEMO_REVIEW_EMAILS;
  const history = DEMO_OUTREACH_HISTORY;

  useEffect(() => {
    if (navigationState.tab) setTab(navigationState.tab);
    if (navigationState.statusFilter) setHistoryFilter(navigationState.statusFilter);
  }, [navigationState.tab, navigationState.statusFilter]);

  const filteredHistory = historyFilter === "all"
    ? history
    : history.filter((item) => normalizeStageName(item.st) === normalizeStageName(historyFilter));

  const historyStatusLabel = (status) => ({
    Sent: t("outreachPage.filters.sent"),
    Opened: t("outreachPage.filters.opened"),
    Replied: t("outreachPage.filters.replied"),
    Bounced: t("outreachPage.filters.bounced"),
  }[status] || status);

  const e = reviewEmails[selected];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("outreachPage.title")}</h1>
          <p className="text-xs text-gray-500">{t("outreachPage.subtitle")}</p>
        </div>
        {tab === "review" && (
          <div className="flex gap-2">
            <Btn variant="destructive" small icon={<XIcon size={12} />}>{t("outreachPage.rejectAll")}</Btn>
            <Btn variant="teal" small icon={<CheckIcon size={12} />}>{t("outreachPage.approveAll")}</Btn>
          </div>
        )}
      </div>

      {/* Tab switcher */}
      <div className={`flex gap-1 p-1 rounded-xl w-fit ${isDark ? "bg-slate-800 border border-white/10" : "bg-gray-100"}`}>
        <button onClick={() => setTab("review")} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${tab === "review" ? isDark ? "bg-slate-700 text-white" : "bg-white text-gray-900 shadow-sm" : isDark ? "text-slate-300 hover:text-white" : "text-gray-500"}`}>
          <InboxIcon size={13} />{t("outreachPage.reviewQueue")}
          <span className="bg-amber-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">{reviewEmails.length}</span>
        </button>
        <button onClick={() => setTab("history")} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${tab === "history" ? isDark ? "bg-slate-700 text-white" : "bg-white text-gray-900 shadow-sm" : isDark ? "text-slate-300 hover:text-white" : "text-gray-500"}`}>
          <ClockIcon size={13} />{t("outreachPage.sentHistory")}
        </button>
      </div>

      {tab === "review" && (
        <div className="grid gap-4" style={{gridTemplateColumns:"2fr 3fr"}}>
          {/* Email list */}
          <div className="space-y-2">
            {reviewEmails.map((em, i) => (
              <div key={i} onClick={() => setSelected(i)}
                className={`p-3 rounded-xl border cursor-pointer transition-colors ${selected === i ? isDark ? "border-indigo-500/40 bg-slate-900" : "border-indigo-300 bg-indigo-50" : isDark ? "border-white/10 bg-slate-800 hover:border-white/20" : "border-gray-100 bg-white hover:border-gray-200"}`}>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs font-semibold text-gray-900">{em.to}</p>
                  <span className={`text-xs font-bold ${em.score >= 80 ? "text-green-600" : "text-amber-600"}`}>{t("outreachPage.confidenceShort")}: {em.score}%</span>
                </div>
                <p className="text-xs text-gray-500">{em.role} · {em.company}</p>
                <p className="text-xs text-gray-400 mt-1 truncate">{em.subject}</p>
                <div className="flex items-center gap-2 mt-1.5">
                  {em.score >= 80 && <Badge label={t("outreachPage.highScore")} color={isDark ? "bg-green-500/10 text-green-200 border border-green-400/20" : "bg-green-100 text-green-700"} />}
                  <span className="text-xs text-indigo-500 flex items-center gap-0.5"><LinkIcon size={9} />{em.contentRef}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Email preview */}
          <Card className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-semibold text-gray-900">{e.to}</p>
                <p className="text-xs text-gray-500">{e.role} @ {e.company}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-sm font-bold ${e.score >= 80 ? "text-green-600" : "text-amber-600"}`}>{t("outreachPage.confidenceShort")}: {e.score}%</span>
                <Badge label={e.score >= 80 ? t("outreachPage.highConfidence") : t("outreachPage.reviewSuggested")} color={isDark ? e.score >= 80 ? "bg-green-500/10 text-green-200 border border-green-400/20" : "bg-amber-500/10 text-amber-200 border border-amber-400/20" : e.score >= 80 ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"} />
              </div>
            </div>
            <div className="flex gap-3 mb-3">
              <div className={`flex-1 p-2 rounded-lg ${isDark ? "bg-[#0F172A] border border-white/10" : "bg-gray-50"}`}>
                <p className="text-xs text-gray-500">{t("outreachPage.opportunity")}</p>
                <p className="text-xs font-medium text-gray-800">{e.vacancy} @ {e.company}</p>
              </div>
              <div className={`flex-1 p-2 rounded-lg ${isDark ? "bg-[#0F172A] border border-white/10" : "bg-indigo-50"}`}>
                <p className="text-xs text-indigo-400">{t("outreachPage.contentReferenced")}</p>
                <p className="text-xs font-medium text-indigo-700 flex items-center gap-1"><LinkIcon size={10} />{e.contentRef}</p>
              </div>
            </div>
            <div className="mb-[18px]">
              <p className="text-xs text-gray-500 mb-1">{t("outreachPage.subject")}</p>
              <p className="text-xs font-semibold text-gray-900">{e.subject}</p>
            </div>
            <div className={`mb-4 p-3 rounded-lg ${isDark ? "bg-[#0F172A] border border-white/10" : "bg-white border border-gray-200"}`}>
              <pre className={`text-xs whitespace-pre-wrap font-sans leading-relaxed ${isDark ? "text-slate-200" : "text-gray-700"}`}>{e.preview}</pre>
            </div>
            <div className="flex gap-2 justify-end">
              <Btn variant="ghost" small icon={<RefreshIcon size={12} />}>{t("outreachPage.regenerate")}</Btn>
              <Btn variant="secondary" small icon={<PenIcon size={12} />}>{t("outreachPage.edit")}</Btn>
              <Btn variant="destructive" small icon={<XIcon size={12} />}>{t("outreachPage.reject")}</Btn>
              <Btn variant="teal" icon={<CheckIcon size={13} />}>{t("outreachPage.approveSend")}</Btn>
            </div>
          </Card>
        </div>
      )}

      {tab === "history" && (
        <>
          <div className="flex gap-2">{["all","sent","opened","replied","bounced"].map((filterKey,i)=>(
            <button
              key={filterKey}
              onClick={() => setHistoryFilter(filterKey)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium ${historyFilter === filterKey ? "bg-indigo-600 text-white" : isDark ? "bg-slate-800 text-slate-300 border border-white/10 hover:bg-slate-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              {t(`outreachPage.filters.${filterKey}`)}
            </button>
          ))}</div>
          <Card>
            <table className="w-full text-xs">
              <thead><tr className="bg-slate-50 text-slate-600 uppercase">
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.contact")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.company")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.subject")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.contentUsed")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.status")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.sent")}</th>
                <th className="px-4 py-2.5 text-left font-medium">{t("outreachPage.columns.score")}</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {filteredHistory.map((o) => (
                  <tr key={o.name} className="hover:bg-slate-50 cursor-pointer">
                    <td className="px-4 py-3 font-medium text-gray-900">{o.name}</td>
                    <td className="px-4 py-3 text-gray-600">{o.co}</td>
                    <td className="px-4 py-3 text-gray-500 truncate max-w-[180px]">{o.subj}</td>
                    <td className="px-4 py-3"><span className="text-xs text-indigo-600 flex items-center gap-1"><LinkIcon size={10} />{o.content}</span></td>
                    <td className="px-4 py-3"><Badge label={historyStatusLabel(o.st)} color={o.stc} /></td>
                    <td className="px-4 py-3 text-gray-500">{o.date}</td>
                    <td className="px-4 py-3 font-semibold text-indigo-600">{o.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
