import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios from "axios";

import api from "@/api/axios";

const originalAdapter = api.defaults.adapter;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const unauthorized = (config) =>
  new axios.AxiosError("Unauthorized", "ERR_BAD_REQUEST", config, null, {
    status: 401, statusText: "Unauthorized", data: {}, headers: {}, config,
  });

// The backend accepts only the token "new"; anything else is a 401 that
// arrives after `delayMs` (the request was in flight when the token changed).
function backendAcceptingOnlyNew(delayByUrl = {}) {
  const seen = [];
  api.defaults.adapter = async (config) => {
    const bearer = String(config.headers.Authorization || "");
    seen.push({ url: config.url, bearer });
    await wait(delayByUrl[config.url] ?? 1);
    if (bearer === "Bearer new") return { data: { ok: config.url }, status: 200, statusText: "OK", headers: {}, config };
    throw unauthorized(config);
  };
  return seen;
}

function refreshEndpoint(delayMs = 15) {
  return vi.spyOn(axios, "post").mockImplementation(async () => {
    await wait(delayMs);
    return { data: { accessToken: "new", refreshToken: "refresh-2", expiresIn: 3600 } };
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("marketgen_access_token", "old");
  localStorage.setItem("marketgen_refresh_token", "refresh-1");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  api.defaults.adapter = originalAdapter;
  vi.restoreAllMocks();
});

describe("401 handling: in-flight requests wait for the one refresh and retry", () => {
  it("refreshes once and retries a single 401 with the new token", async () => {
    const seen = backendAcceptingOnlyNew();
    const refresh = refreshEndpoint();

    const res = await api.get("/a");

    expect(res.data.ok).toBe("/a");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(seen.map((s) => s.bearer)).toEqual(["Bearer old", "Bearer new"]);
  });

  it("concurrent 401s share one refresh and all succeed", async () => {
    backendAcceptingOnlyNew();
    const refresh = refreshEndpoint();

    const results = await Promise.all([api.get("/a"), api.get("/b"), api.get("/c")]);

    expect(results.map((r) => r.data.ok)).toEqual(["/a", "/b", "/c"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a 401 that arrives AFTER the refresh finished retries with the new token without a second refresh", async () => {
    // /slow left with the old token and its 401 comes back at ~60 ms, after the
    // refresh (started by /fast) completed at ~20 ms. Before the fix this
    // started a second /auth/refresh and rotated the refresh token again.
    backendAcceptingOnlyNew({ "/fast": 1, "/slow": 60 });
    const refresh = refreshEndpoint(15);

    const [fast, slow] = await Promise.all([api.get("/fast"), api.get("/slow")]);

    expect(fast.data.ok).toBe("/fast");
    expect(slow.data.ok).toBe("/slow");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a request that still gets 401 with the new token is rejected, not looped", async () => {
    api.defaults.adapter = async (config) => { throw unauthorized(config); };
    const refresh = refreshEndpoint();

    await expect(api.get("/a")).rejects.toMatchObject({ response: { status: 401 } });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("rejects when the refresh fails (token revoked) instead of retrying", async () => {
    backendAcceptingOnlyNew();
    vi.spyOn(axios, "post").mockRejectedValue({ response: { status: 401 } });

    await expect(api.get("/a")).rejects.toMatchObject({ response: { status: 401 } });
  });
});
