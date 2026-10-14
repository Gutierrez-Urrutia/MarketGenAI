import { CheckIcon, RefreshIcon } from "@/components/dashboard/icons";
import { Btn } from "@/components/dashboard/ui";

export function ProgressModal({ title, subtitle = "Estimated time: 10 - 15 seconds", completeLabel = "complete", retryLabel = "Retry", cancelLabel = "Cancel", steps, state, onCancel, onRetry }) {
  if (!state) return null;
  const progress = Math.max(0, Math.min(100, Number(state.progress || 0)));
  const failed = Boolean(state.error);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-slate-900/55 backdrop-blur-sm" />
      <div className="relative w-full max-w-md mx-4 rounded-2xl bg-white shadow-2xl border border-gray-100 overflow-hidden">
        <div className="p-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          <p className="text-xs text-gray-400 mt-1">{subtitle}</p>
        </div>
        <div className="p-5 space-y-3">
          {steps.map((step, index) => {
            const done = state.completedSteps?.includes(index);
            const active = state.activeStep === index && !done && !failed;
            return (
              <div key={step} className="flex items-center gap-3">
                <span className={`flex h-5 w-5 items-center justify-center rounded-full border text-xs ${
                  done
                    ? "border-green-200 bg-green-50 text-green-600"
                    : active
                    ? "border-indigo-200 bg-indigo-50 text-indigo-600"
                    : failed && state.activeStep === index
                    ? "border-red-200 bg-red-50 text-red-600"
                    : "border-gray-200 text-gray-400"
                }`}>
                  {done ? <CheckIcon size={11} /> : active ? <RefreshIcon size={11} className="animate-spin" /> : index + 1}
                </span>
                <span className={`text-xs flex-1 ${done ? "text-gray-700" : active ? "text-indigo-700 font-medium" : "text-gray-400"}`}>
                  {step}
                </span>
                {done && <CheckIcon size={13} className="text-green-500" />}
              </div>
            );
          })}
          <div className="pt-2">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>{progress}% {completeLabel}</span>
              {failed && <span className="text-red-600">{state.error}</span>}
            </div>
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${failed ? "bg-red-500" : "bg-indigo-600"}`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 p-4 bg-gray-50 border-t border-gray-100">
          {failed && <Btn variant="secondary" small onClick={onRetry}>{retryLabel}</Btn>}
          <Btn variant="ghost" small onClick={onCancel}>{cancelLabel}</Btn>
        </div>
      </div>
    </div>
  );
}
