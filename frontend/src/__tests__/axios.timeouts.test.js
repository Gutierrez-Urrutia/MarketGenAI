import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";

import api, {
  authTokenStore,
  leadsApi,
  pipelineApi,
  refreshAuthSession,
  READ_TIMEOUT_MS,
  SCAN_REQUEST_TIMEOUT_MS,
} from "@/api/axios";

// Capture the config that survives the request interceptors (which force
// timeout 0 for "generative" URLs) instead of hitting the network.
let captured;
const originalAdapter = api.defaults.adapter;
beforeEach(() => {
  captured = null;
  api.defaults.adapter = async (config) => {
    captured = config;
    return { data: {}, status: 200, statusText: "OK", headers: {}, config };
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  api.defaults.adapter = originalAdapter;
  vi.restoreAllMocks();
});

describe("per-route timeouts", () => {
  it("POST /pipeline/runs gets a limit above the 240 s synchronous scan budget", async () => {
    await pipelineApi.runScan();
    expect(captured.url).toBe("/pipeline/runs");
    expect(SCAN_REQUEST_TIMEOUT_MS).toBe(360_000);
    expect(captured.timeout).toBe(SCAN_REQUEST_TIMEOUT_MS);
    expect(captured.timeout).toBeGreaterThan(240_000); // never cuts a legitimate scan
  });

  it.each([
    ["GET /leads", () => leadsApi.list({}), "/leads"],
    ["GET /pipeline/runs/active", () => pipelineApi.getActiveRun(), "/pipeline/runs/active"],
    ["GET /pipeline/runs/:id", () => pipelineApi.getRun("r1"), "/pipeline/runs/r1"],
  ])("%s gets the 30 s read limit", async (_name, call, url) => {
    await call();
    expect(captured.url).toBe(url);
    expect(captured.timeout).toBe(READ_TIMEOUT_MS);
    expect(READ_TIMEOUT_MS).toBe(30_000);
  });

  it("does not change routes it does not own (no default timeout added)", async () => {
    await api.get("/opportunities");
    expect(captured.timeout).toBe(0);
    await api.post("/proposals/generate-draft", {});
    expect(captured.timeout).toBe(0);
  });
});

describe("refreshAuthSession only ends the session on a real rejection", () => {
  const seedSession = () => {
    localStorage.setItem("marketgen_access_token", "old-access");
    localStorage.setItem("marketgen_refresh_token", "real-refresh");
  };

  it("sends a timeout with the refresh request", async () => {
    seedSession();
    const post = vi.spyOn(axios, "post").mockRejectedValue({ code: "ECONNABORTED" });
    await refreshAuthSession();
    expect(post.mock.calls[0][2]).toEqual({ timeout: 30_000 });
  });

  it("keeps the tokens on a timeout / network error (saturated backend)", async () => {
    seedSession();
    vi.spyOn(axios, "post").mockRejectedValue({ code: "ECONNABORTED", message: "timeout" });
    expect(await refreshAuthSession()).toBe(false);
    expect(authTokenStore.getRefreshToken()).toBe("real-refresh");
  });

  it("keeps the tokens on a 5xx", async () => {
    seedSession();
    vi.spyOn(axios, "post").mockRejectedValue({ response: { status: 503 } });
    expect(await refreshAuthSession()).toBe(false);
    expect(authTokenStore.getRefreshToken()).toBe("real-refresh");
  });

  it("clears the session when the refresh token is rejected (401)", async () => {
    seedSession();
    vi.spyOn(axios, "post").mockRejectedValue({ response: { status: 401 } });
    expect(await refreshAuthSession()).toBe(false);
    expect(authTokenStore.getRefreshToken()).toBeNull();
  });
});
