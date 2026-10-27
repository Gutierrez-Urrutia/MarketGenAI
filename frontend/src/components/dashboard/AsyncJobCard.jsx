import { Card } from "@/components/dashboard/ui";

export function AsyncJobCard({ title, job, statusLabel = "Estado" }) {
  const progress = Math.max(0, Math.min(100, Number(job?.progress || 0)));
  const status = job?.status || "idle";
  const failed = status === "failed" || status === "error";
  const completed = status === "completed";

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="text-sm font-semibold text-gray-900">{title}</p>
          <p className={`text-xs ${failed ? "text-red-600" : completed ? "text-green-600" : "text-gray-500"}`}>
            {statusLabel}: {status}
          </p>
        </div>
        <span className="text-xs font-semibold text-gray-600">{progress}%</span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${failed ? "bg-red-500" : completed ? "bg-green-500" : "bg-indigo-600"}`}
          style={{ width: `${progress}%` }}
        />
      </div>
      {job?.error && <p className="mt-2 text-xs text-red-600">{job.error}</p>}
    </Card>
  );
}
