import { Badge, Btn, Card, Field, Input } from "@/components/dashboard/ui";
import { RefreshIcon, SearchIcon } from "@/components/dashboard/icons";
import api, { authTokenStore } from "@/api/axios";
import { canViewAuditLogs } from "@/utils/permissions";
import { useEffect, useState } from "react";

export function AuditLogsPage() {
  const [logs, setLogs] = useState([]);
  const [userId, setUserId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const currentUser = authTokenStore.getUser() || {};

  const fetchLogs = async (filterUserId = userId) => {
    setLoading(true);
    setError("");
    try {
      const params = { limit: 50 };
      if (filterUserId.trim()) params.userId = filterUserId.trim();
      const { data } = await api.get("/admin/audit-logs", { params });
      setLogs(Array.isArray(data?.logs) ? data.logs : []);
    } catch (err) {
      setError(err.response?.data?.detail || "Unable to load audit logs.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (canViewAuditLogs(currentUser)) fetchLogs("");
  }, []);

  if (!canViewAuditLogs(currentUser)) {
    return null;
  }

  const formatTimestamp = (value) => {
    if (!value) return "-";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  };
  const methodColor = (method) => ({
    POST: "bg-indigo-100 text-indigo-700",
    GET: "bg-green-100 text-green-700",
    PUT: "bg-orange-100 text-orange-700",
    PATCH: "bg-orange-100 text-orange-700",
    DELETE: "bg-red-100 text-red-700",
  }[String(method || "").toUpperCase()] || "bg-gray-100 text-gray-600");
  const statusColor = (status) => Number(status || 0) >= 400
    ? "bg-red-100 text-red-700"
    : "bg-green-100 text-green-700";

  return (
    <div className="space-y-2.5">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Audit Logs</h1>
          <p className="text-xs text-gray-500">Security and activity trail from backend requests.</p>
        </div>
        <Btn variant="secondary" icon={<RefreshIcon size={14} />} onClick={() => fetchLogs()} disabled={loading}>
          Refresh
        </Btn>
      </div>

      <Card className="p-2">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end">
          <Field label="Filter by userId">
            <Input value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="anonymous or user id" />
          </Field>
          <Btn className="mb-[18px]" icon={<SearchIcon size={14} />} onClick={() => fetchLogs(userId)} disabled={loading}>
            Buscar
          </Btn>
        </div>
        {error && <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-4 text-xs text-red-700">{error}</div>}
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-100 text-left text-xs">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-4 font-semibold">Timestamp</th>
                <th className="px-4 py-4 font-semibold">Usuario</th>
                <th className="px-4 py-4 font-semibold">Acción</th>
                <th className="px-4 py-4 font-semibold">Método</th>
                <th className="px-4 py-4 font-semibold">Path</th>
                <th className="px-4 py-4 font-semibold">Status</th>
                <th className="px-4 py-4 font-semibold">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {loading && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-gray-400">Loading audit logs...</td>
                </tr>
              )}
              {!loading && logs.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-gray-400">No audit logs found.</td>
                </tr>
              )}
              {!loading && logs.map((log) => (
                <tr key={log.id} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-4 text-gray-700">{formatTimestamp(log.timestamp)}</td>
                  <td className="whitespace-nowrap px-4 py-4 font-medium text-gray-900">{log.userId || "-"}</td>
                  <td className="px-4 py-4 text-gray-700">{log.action || "-"}</td>
                  <td className="whitespace-nowrap px-4 py-4">
                    <Badge label={log.method || "-"} color={methodColor(log.method)} />
                  </td>
                  <td className="max-w-[260px] truncate px-4 py-4 font-mono text-[11px] text-gray-600" title={log.path || ""}>{log.path || "-"}</td>
                  <td className="whitespace-nowrap px-4 py-4">
                    <Badge label={String(log.statusCode ?? "-")} color={statusColor(log.statusCode)} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 text-gray-600">{log.ip || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
