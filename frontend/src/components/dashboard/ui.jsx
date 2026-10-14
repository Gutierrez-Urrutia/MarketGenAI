import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/context/ThemeContext";
import { PlusIcon, XIcon } from "@/components/dashboard/icons";

/* ═══════════════════════════════════════════════════════════════ */
/*  SHARED UI                                                      */
/* ═══════════════════════════════════════════════════════════════ */
export const Badge = ({ label, color = "bg-gray-100 text-gray-600" }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${color}`}>{label}</span>
);

export const stageTranslationKey = (stage) => ({
  All: "all",
  Detected: "detected",
  Researching: "researching",
  Contacted: "contacted",
  Replied: "replied",
  "In Conversation": "inConversation",
  Won: "won",
  Customer: "customer",
  Lost: "lost",
}[stage] || String(stage || "").toLowerCase());

export const StageBadge = ({ stage }) => {
  const { t } = useI18n();
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const lightMap = {
    "Detected":       "bg-blue-100 text-blue-700",
    "Researching":    "bg-cyan-100 text-cyan-700",
    "Contacted":      "bg-indigo-100 text-indigo-700",
    "Replied":        "bg-amber-100 text-amber-700",
    "In Conversation":"bg-purple-100 text-purple-700",
    "Won":            "bg-green-100 text-green-700",
    "Lost":           "bg-red-100 text-red-700",
    "Customer":       "bg-emerald-100 text-emerald-700",
  };
  const darkMap = {
    "Detected":       "bg-blue-500/10 text-blue-200 border border-blue-400/20",
    "Researching":    "bg-cyan-500/10 text-cyan-200 border border-cyan-400/20",
    "Contacted":      "bg-indigo-500/10 text-indigo-200 border border-indigo-400/20",
    "Replied":        "bg-amber-500/10 text-amber-200 border border-amber-400/20",
    "In Conversation":"bg-purple-500/10 text-purple-200 border border-purple-400/20",
    "Won":            "bg-green-500/10 text-green-200 border border-green-400/20",
    "Lost":           "bg-red-500/10 text-red-200 border border-red-400/20",
    "Customer":       "bg-emerald-500/10 text-emerald-200 border border-emerald-400/20",
  };
  const map = isDark ? darkMap : lightMap;
  return <Badge label={t(`opportunitiesPage.stages.${stageTranslationKey(stage)}`)} color={map[stage] || (isDark ? "bg-slate-900 text-slate-300 border border-white/10" : "bg-gray-100 text-gray-600")} />;
};

export const Btn = ({ variant = "primary", children, icon, className = "", small, ...p }) => {
  const v = {
    primary: "bg-indigo-600 text-white hover:bg-indigo-700",
    secondary: "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50",
    teal: "bg-teal-500 text-white hover:bg-teal-600",
    ghost: "text-gray-500 hover:bg-gray-100",
    destructive: "bg-red-600 text-white hover:bg-red-700",
  };
  return (
    <button className={`inline-flex items-center gap-1.5 font-medium rounded-lg transition-colors text-xs ${small ? "px-2.5 py-1.5" : "px-3.5 py-2"} ${v[variant] || v.primary} ${className}`} {...p}>
      {icon}{children}
    </button>
  );
};

export const Card = ({ children, className = "" }) => (
  <div className={`bg-white rounded-2xl border border-gray-100 shadow-sm ${className}`}>{children}</div>
);

const Section = ({ title, IconComp, desc, badge, children }) => (
  <Card className="p-5">
    <div className="flex items-center justify-between mb-4 pb-3 border-b border-gray-100">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center"><IconComp size={14} className="text-indigo-600" /></div>
        <div>
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          {desc && <p className="text-xs text-gray-400">{desc}</p>}
        </div>
      </div>
      {badge}
    </div>
    {children}
  </Card>
);

const Tag = ({ label }) => (
  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-medium">
    {label}<button className="hover:text-indigo-900"><XIcon size={9} /></button>
  </span>
);

export const TagInput = ({ tags, placeholder }) => (
  <div className="flex flex-wrap gap-1.5 p-2 border border-gray-300 rounded-lg bg-white min-h-[32px]">
    {tags.map(t => <Tag key={t} label={t} />)}
    <input type="text" placeholder={tags.length === 0 ? placeholder : ""} className="flex-1 min-w-[80px] outline-none text-xs bg-transparent placeholder-gray-400" />
  </div>
);

export const KpiCard = ({ icon: Ic, label, value, sub, color, onClick, ariaLabel, title, detail, actions }) => {
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const iconClass = isDark
    ? `${color.replace(/\bbg-\S+/g, "bg-slate-900")} border border-white/10`
    : color;
  const content = (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${iconClass}`}><Ic size={18} /></div>
          <div>
            <p className="text-xs text-gray-500">{label}</p>
            <p className="text-lg font-bold text-gray-900">{value}</p>
            {sub && <p className="text-xs text-gray-400">{sub}</p>}
            {detail && (
              <div style={{ fontSize: '0.8em', color: '#94A3B8', marginTop: 4 }}>
                {detail}
              </div>
            )}
          </div>
        </div>
        {actions}
      </div>
    </div>
  );

  if (onClick) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") onClick(event);
        }}
        aria-label={ariaLabel || `Open ${label}`}
        title={title || `Open ${label}`}
        className="w-full text-left bg-white rounded-2xl border border-gray-100 shadow-sm p-4 cursor-pointer transition-all hover:bg-[#F8FAFC] hover:border-indigo-200 hover:shadow-md active:scale-[0.99] focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
      >
        {content}
      </div>
    );
  }

  return <Card className="p-4">{content}</Card>;
};

const QuickMetric = ({ label, value }) => (
  <div className="rounded-lg bg-gray-50 px-3 py-2">
    <p className="text-[11px] font-medium text-gray-500 leading-tight">{label}</p>
    <p className="mt-1 text-base font-bold text-gray-900">{value}</p>
  </div>
);

export const QuickActionCard = ({ icon: Ic, title, description, badges, metrics, buttonLabel, onClick, ariaLabel, accent = "indigo" }) => {
  const { theme } = useTheme();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const accentClasses = accent === "teal"
    ? {
      icon: isDark ? "bg-slate-900 text-teal-200 border border-white/10" : "bg-teal-50 text-teal-600",
      button: "bg-teal-500 text-white hover:bg-teal-600",
      ring: "hover:border-teal-200 focus:ring-teal-500/25",
    }
    : {
      icon: isDark ? "bg-slate-900 text-indigo-200 border border-white/10" : "bg-indigo-50 text-indigo-600",
      button: "bg-indigo-600 text-white hover:bg-indigo-700",
      ring: "hover:border-indigo-200 focus:ring-indigo-500/25",
    };
  const badgeColor = isDark
    ? "bg-slate-900 text-slate-300 border border-white/10"
    : "bg-gray-100 text-gray-600";

  const handleKeyDown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      aria-label={ariaLabel || title}
      title={title}
      className={`group bg-white rounded-2xl border border-gray-100 shadow-sm p-5 cursor-pointer transition-all hover:shadow-md active:scale-[0.995] focus:outline-none focus:ring-2 ${accentClasses.ring}`}
    >
      <div className="flex items-start gap-4">
        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 ${accentClasses.icon}`}>
          <Ic size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-gray-900">{title}</h2>
              <p className="mt-1 text-xs leading-5 text-gray-500">{description}</p>
            </div>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onClick();
              }}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${accentClasses.button}`}
            >
              <PlusIcon size={13} />
              {buttonLabel}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {badges.map((badge) => (
              <Badge key={badge} label={badge} color={badgeColor} />
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {metrics.map((metric) => (
              <QuickMetric key={metric.label} label={metric.label} value={metric.value} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export const Input = ({ className = "", ...p }) => (
  <input className={`w-full border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 ${className}`} {...p} />
);

export const Select = ({ children, ...p }) => <select className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500" {...p}>{children}</select>;

export const Field = ({ label, hint, children }) => (
  <div className="mb-[18px]">
    <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
    {hint && <p className="text-xs text-gray-400 mb-1">{hint}</p>}
    {children}
  </div>
);
