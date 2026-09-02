/**
 * Reports — KPI dashboard with Recharts visualisations.
 * Shows: total books, content generated, proposals sent, customer count + trend charts.
 */
import { useQuery } from "@tanstack/react-query";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from "recharts";
import { BookOpen, FileText, Users, TrendingUp, Download } from "lucide-react";
import { format, subDays } from "date-fns";
import { es } from "date-fns/locale";
import toast from "react-hot-toast";

import { reportsApi } from "@/api/axios";
import { Spinner } from "@/components/ui/Spinner";
import Button from "@/components/ui/Button";

const COLORS = ["#6366f1", "#0d9488", "#f59e0b", "#ef4444", "#8b5cf6"];

// ── KPI Card ──────────────────────────────────────────────────────────────────
function KpiCard({ icon: Icon, label, value, sub, color = "primary" }) {
  const colorMap = {
    primary: "bg-primary-50 text-primary-600",
    teal:    "bg-teal-50 text-teal-600",
    amber:   "bg-amber-50 text-amber-600",
    violet:  "bg-violet-50 text-violet-600",
  };
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-5 flex items-start gap-4">
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ${colorMap[color]}`}>
        <Icon size={20} />
      </div>
      <div>
        <p className="text-sm text-gray-500">{label}</p>
        <p className="text-2xl font-bold text-gray-900 mt-0.5">{value ?? "—"}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────
const ChartSection = ({ title, children }) => (
  <div className="bg-white rounded-2xl border border-gray-100 shadow-card p-5">
    <h3 className="text-sm font-semibold text-gray-700 mb-4">{title}</h3>
    {children}
  </div>
);

export default function Reports() {
  const { data, isLoading } = useQuery({
    queryKey: ["reports-overview"],
    queryFn: () => reportsApi.overview().then((r) => r.data),
  });

  const exportReport = async () => {
    try {
      const res = await reportsApi.export({ format: "xlsx" });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = `nd-report-${format(new Date(), "yyyy-MM-dd")}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      toast.error("Error al exportar el informe");
    }
  };

  if (isLoading) return <div className="flex justify-center py-20"><Spinner /></div>;

  // Fallback demo data if API doesn't yet return real data
  const kpis = data?.kpis ?? {
    totalBooks: 12,
    chaptersGenerated: 87,
    proposalsSent: 5,
    totalCustomers: 34,
  };

  const activityData = data?.activityByDay ?? Array.from({ length: 14 }, (_, i) => ({
    date: format(subDays(new Date(), 13 - i), "d MMM", { locale: es }),
    libros: Math.floor(Math.random() * 3),
    propuestas: Math.floor(Math.random() * 2),
    capítulos: Math.floor(Math.random() * 8),
  }));

  const booksByStatus = data?.booksByStatus ?? [
    { name: "Borrador",    value: 3 },
    { name: "Generado",    value: 6 },
    { name: "Publicado",   value: 2 },
    { name: "Pendiente",   value: 1 },
  ];

  const contentTypeDist = data?.contentTypeDist ?? [
    { type: "eBook",          count: 5 },
    { type: "White Paper",    count: 3 },
    { type: "Guía práctica",  count: 2 },
    { type: "Caso de estudio",count: 1 },
    { type: "Informe",        count: 1 },
  ];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Informes</h1>
          <p className="text-sm text-gray-500 mt-0.5">Métricas de actividad y rendimiento de contenido</p>
        </div>
        <Button variant="secondary" icon={<Download size={15} />} onClick={exportReport}>
          Exportar Excel
        </Button>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard icon={BookOpen}  label="Libros totales"       value={kpis.totalBooks}          sub="activos en la plataforma" color="primary" />
        <KpiCard icon={TrendingUp} label="Capítulos generados" value={kpis.chaptersGenerated}   sub="con IA" color="teal" />
        <KpiCard icon={FileText}  label="Propuestas enviadas"  value={kpis.proposalsSent}       sub="este mes" color="amber" />
        <KpiCard icon={Users}     label="Clientes registrados" value={kpis.totalCustomers}      sub="en CRM" color="violet" />
      </div>

      {/* Activity chart */}
      <ChartSection title="Actividad de los últimos 14 días">
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={activityData} margin={{ top: 5, right: 10, bottom: 0, left: -20 }}>
            <defs>
              <linearGradient id="gLibros" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gCapitulos" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#0d9488" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#0d9488" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#94a3b8" }} />
            <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} />
            <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} />
            <Area type="monotone" dataKey="libros"    stroke="#6366f1" fill="url(#gLibros)"    strokeWidth={2} name="Libros" />
            <Area type="monotone" dataKey="capítulos" stroke="#0d9488" fill="url(#gCapitulos)" strokeWidth={2} name="Capítulos" />
          </AreaChart>
        </ResponsiveContainer>
      </ChartSection>

      {/* Bottom row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Books by status */}
        <ChartSection title="Libros por estado">
          <div className="flex items-center gap-4">
            <ResponsiveContainer width="50%" height={160}>
              <PieChart>
                <Pie data={booksByStatus} dataKey="value" cx="50%" cy="50%" outerRadius={65} innerRadius={35}>
                  {booksByStatus.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="flex-1 space-y-2">
              {booksByStatus.map((s, i) => (
                <div key={s.name} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                    <span className="text-gray-600">{s.name}</span>
                  </div>
                  <span className="font-semibold text-gray-800">{s.value}</span>
                </div>
              ))}
            </div>
          </div>
        </ChartSection>

        {/* Content type distribution */}
        <ChartSection title="Tipos de contenido creados">
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={contentTypeDist} layout="vertical" margin={{ left: 10, right: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: "#94a3b8" }} />
              <YAxis dataKey="type" type="category" tick={{ fontSize: 11, fill: "#94a3b8" }} width={100} />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} />
              <Bar dataKey="count" fill="#6366f1" radius={[0, 4, 4, 0]} name="Libros" />
            </BarChart>
          </ResponsiveContainer>
        </ChartSection>
      </div>
    </div>
  );
}
