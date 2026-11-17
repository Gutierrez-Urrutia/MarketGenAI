// RF-VTA-10: carga el reporte de pipeline del período elegido y lo recarga cuando cambia una propuesta.
import { useCallback, useEffect, useState } from "react";

import { reportsApi } from "@/api/axios";

export function usePipelineReport(days) {
  const [state, setState] = useState({ report: null, loading: true, error: false });

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: false }));
    try {
      const { data } = await reportsApi.pipeline(days ? { days } : undefined);
      setState({ report: data, loading: false, error: false });
    } catch {
      setState((current) => ({ ...current, loading: false, error: true }));
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    window.addEventListener("marketgen:proposal-updated", load);
    return () => window.removeEventListener("marketgen:proposal-updated", load);
  }, [load]);

  return { ...state, reload: load };
}
