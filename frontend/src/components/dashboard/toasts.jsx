import { useEffect, useRef, useState } from "react";
import { AlertIcon, CheckIcon, XIcon } from "@/components/dashboard/icons";

const TOAST_LIMIT = 3;

const TOAST_DURATION = {
  error: 8000,
  default: 5000,
};

function normalizeToast(toast) {
  if (!toast) return null;
  const base = typeof toast === "string" ? { message: toast } : toast;
  const type = base.type || "success";
  return {
    id: base.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    message: base.message || String(base),
    duration: base.duration || (type === "error" ? TOAST_DURATION.error : TOAST_DURATION.default),
  };
}

export function useToastQueue() {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef(new Map());

  const clearTimer = (id) => {
    const timer = timersRef.current.get(id);
    if (timer?.timeoutId) clearTimeout(timer.timeoutId);
    timersRef.current.delete(id);
  };

  const removeToast = (id) => {
    clearTimer(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  };

  const scheduleToast = (toast, duration = toast.duration) => {
    clearTimer(toast.id);
    const startedAt = Date.now();
    const timeoutId = setTimeout(() => removeToast(toast.id), duration);
    timersRef.current.set(toast.id, { timeoutId, startedAt, remaining: duration });
  };

  const setToast = (toast) => {
    if (!toast) {
      timersRef.current.forEach((timer) => {
        if (timer?.timeoutId) clearTimeout(timer.timeoutId);
      });
      timersRef.current.clear();
      setToasts([]);
      return;
    }
    const normalized = normalizeToast(toast);
    if (!normalized) return;
    setToasts((current) => {
      const next = [...current, normalized];
      const overflow = next.slice(0, Math.max(0, next.length - TOAST_LIMIT));
      overflow.forEach((oldToast) => clearTimer(oldToast.id));
      return next.slice(-TOAST_LIMIT);
    });
    scheduleToast(normalized);
  };

  const pauseToast = (id) => {
    const timer = timersRef.current.get(id);
    if (!timer) return;
    clearTimeout(timer.timeoutId);
    timersRef.current.set(id, {
      ...timer,
      timeoutId: null,
      remaining: Math.max(0, timer.remaining - (Date.now() - timer.startedAt)),
    });
  };

  const resumeToast = (id) => {
    const timer = timersRef.current.get(id);
    const toast = toasts.find((item) => item.id === id);
    if (!timer || !toast || timer.timeoutId) return;
    scheduleToast(toast, timer.remaining || toast.duration);
  };

  useEffect(() => () => {
    timersRef.current.forEach((timer) => {
      if (timer?.timeoutId) clearTimeout(timer.timeoutId);
    });
    timersRef.current.clear();
  }, []);

  return { toasts, setToast, removeToast, pauseToast, resumeToast };
}

export function ToastStack({ toasts, onClose, onMouseEnter, onMouseLeave }) {
  if (!toasts.length) return null;
  return (
    <div className="fixed right-6 top-6 z-[80] space-y-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          onMouseEnter={() => onMouseEnter(toast.id)}
          onMouseLeave={() => onMouseLeave(toast.id)}
          className={`rounded-xl border bg-white px-4 py-3 shadow-lg text-xs text-gray-700 flex items-center gap-2 ${
            toast.type === "error" ? "border-red-100" : toast.type === "warning" ? "border-amber-100" : "border-green-100"
          }`}
        >
          {toast.type === "error"
            ? <XIcon size={14} className="text-red-600" />
            : toast.type === "warning"
            ? <AlertIcon size={14} className="text-amber-500" />
            : <CheckIcon size={14} className="text-green-600" />}
          {toast.message}
          <button onClick={() => onClose(toast.id)} className="ml-2 text-gray-400 hover:text-gray-600"><XIcon size={12} /></button>
        </div>
      ))}
    </div>
  );
}
