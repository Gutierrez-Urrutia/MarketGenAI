import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";

import api, {
  authTokenStore,
  GENERATION_TIMEOUT_MS,
  leadsApi,
  outreachEmailsApi,
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

  it.each([
    ["POST /outreach-emails", () => outreachEmailsApi.generate("l1", "c1", "es"), "/outreach-emails", GENERATION_TIMEOUT_MS],
    ["PATCH .../regenerate", () => outreachEmailsApi.regenerate("e1", "pt"), "/outreach-emails/e1/regenerate", GENERATION_TIMEOUT_MS],
    ["GET /outreach-emails", () => outreachEmailsApi.list({ lead_id: "l1" }), "/outreach-emails", READ_TIMEOUT_MS],
    ["PATCH .../approve", () => outreachEmailsApi.approve("e1"), "/outreach-emails/e1/approve", READ_TIMEOUT_MS],
    ["PATCH .../reject", () => outreachEmailsApi.reject("e1"), "/outreach-emails/e1/reject", READ_TIMEOUT_MS],
    ["PATCH .../mark-sent", () => outreachEmailsApi.markSent("e1"), "/outreach-emails/e1/mark-sent", READ_TIMEOUT_MS],
  ])("%s keeps its own timeout although the URL contains 'outreach' (RF-VTA-16)", async (_name, call, url, timeout) => {
    await call();
    expect(captured.url).toBe(url);
    expect(captured.timeout).toBe(timeout);
    expect(captured.logBody).toBe(false);
  });

  it("the prospecting generation limit is 2 minutes", () => {
    expect(GENERATION_TIMEOUT_MS).toBe(120_000);
  });

  it("sends language only when given", async () => {
    await outreachEmailsApi.generate("l1", "c1", "pt");
    expect(JSON.parse(captured.data)).toEqual({ lead_id: "l1", contact_id: "c1", language: "pt" });
    await outreachEmailsApi.generate("l1", "c1");
    expect(JSON.parse(captured.data)).toEqual({ lead_id: "l1", contact_id: "c1" });
  });

  it("other URLs with 'outreach' stay without limit, as before", async () => {
    await api.patch("/outreach/review-queue/x/regenerate", {});
    expect(captured.timeout).toBe(0);
    await api.get("/outreach", { timeout: 5_000 });
    expect(captured.timeout).toBe(0);
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
