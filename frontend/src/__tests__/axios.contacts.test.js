/**
 * RF15 — contact routes and the `logBody: false` mark of the axios
 * interceptors. No network: a fake adapter answers every request.
 * Synthetic values only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AxiosError } from "axios";

import api, {
  leadsApi,
  pipelineApi,
  READ_TIMEOUT_MS,
  CONTACT_SEARCH_TIMEOUT_MS,
} from "@/api/axios";

const CONTACT = { id: "c-1", full_name: "Ana Ficticia", email: "ana.ficticia@example.com" };
const SECRETS = { smtp_password: "pw-sintetica", hunter_api_key: "hk-sintetica" };

let captured;
let respond;
let log;
let err;
const originalAdapter = api.defaults.adapter;

beforeEach(() => {
  captured = [];
  respond = (config) => ({ data: { items: [CONTACT], contacts: [CONTACT] }, status: 200, statusText: "OK", headers: {}, config });
  api.defaults.adapter = async (config) => {
    captured.push(config);
    return respond(config);
  };
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  err = vi.spyOn(console, "error").mockImplementation(() => {});
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  api.defaults.adapter = originalAdapter;
  vi.restoreAllMocks();
});

const lastConfig = () => captured.at(-1);
const logged = () => JSON.stringify([...log.mock.calls, ...err.mock.calls]);

describe("contact routes", () => {
  it("searchContacts uses the long timeout and sends no body unless forced", async () => {
    await leadsApi.searchContacts("lead-1");
    expect(lastConfig().url).toBe("/leads/lead-1/contacts/search");
    expect(lastConfig().method).toBe("post");
    expect(lastConfig().timeout).toBe(CONTACT_SEARCH_TIMEOUT_MS);
    expect(CONTACT_SEARCH_TIMEOUT_MS).toBe(90_000);
    expect(lastConfig().data).toBeUndefined();

    await leadsApi.searchContacts("lead-1", { force: false });
    expect(lastConfig().data).toBeUndefined();

    await leadsApi.searchContacts("lead-1", { force: true });
    expect(JSON.parse(lastConfig().data)).toEqual({ force: true });
  });

  it("listContacts and reviewContact keep the read timeout", async () => {
    await leadsApi.listContacts("lead-1");
    expect(lastConfig().url).toBe("/leads/lead-1/contacts");
    expect(lastConfig().timeout).toBe(READ_TIMEOUT_MS);
    expect(lastConfig().params).toBeUndefined();

    await leadsApi.listContacts("lead-1", { includeRejected: true });
    expect(lastConfig().params).toEqual({ include_rejected: true });

    await leadsApi.reviewContact("lead-1", "c-1", "rejected");
    expect(lastConfig().url).toBe("/leads/lead-1/contacts/c-1/review");
    expect(lastConfig().method).toBe("patch");
    expect(JSON.parse(lastConfig().data)).toEqual({ decision: "rejected" });
    expect(lastConfig().timeout).toBe(READ_TIMEOUT_MS);
  });

  it("the other lead calls keep their timeouts", async () => {
    await leadsApi.list({ limit: 5 });
    expect(lastConfig().timeout).toBe(READ_TIMEOUT_MS);
    await leadsApi.get("lead-1");
    expect(lastConfig().timeout).toBe(READ_TIMEOUT_MS);
  });
});

describe("logBody: false", () => {
  it("contact calls log neither the request nor the response body", async () => {
    await leadsApi.searchContacts("lead-1", { force: true });
    await leadsApi.listContacts("lead-1");
    await leadsApi.reviewContact("lead-1", "c-1", "approved");
    expect(log).toHaveBeenCalled(); // method, URL and status are still logged
    expect(logged()).toContain("/leads/lead-1/contacts/search");
    expect(logged()).not.toMatch(/Ficticia|@example\.com|"force"|"decision"/);
  });

  it("a failed contact call logs no body either", async () => {
    respond = (config) => {
      throw new AxiosError("Request failed", "ERR_BAD_REQUEST", config, null, {
        status: 409, statusText: "Conflict", headers: {}, config, data: { detail: { code: "cooldown" }, contacts: [CONTACT] },
      });
    };
    await expect(leadsApi.searchContacts("lead-1")).rejects.toBeTruthy();
    expect(err).toHaveBeenCalled();
    expect(logged()).toContain("409");
    expect(logged()).not.toMatch(/Ficticia|@example\.com|cooldown/);
  });

  it("updateConfig never logs smtp_password nor hunter_api_key (also on failure)", async () => {
    respond = (config) => ({ data: { ...JSON.parse(config.data), smtp_password_configured: true }, status: 200, statusText: "OK", headers: {}, config });
    await pipelineApi.updateConfig({ smtp_user: "ventas@example.com", ...SECRETS });
    expect(logged()).toContain("/pipeline/config");
    expect(logged()).not.toContain(SECRETS.smtp_password);
    expect(logged()).not.toContain(SECRETS.hunter_api_key);

    respond = (config) => {
      throw new AxiosError("Request failed", "ERR_BAD_REQUEST", config, null, {
        status: 400, statusText: "Bad Request", headers: {}, config, data: { detail: "bad", echo: SECRETS },
      });
    };
    await expect(pipelineApi.updateConfig({ ...SECRETS })).rejects.toBeTruthy();
    expect(logged()).not.toContain(SECRETS.smtp_password);
    expect(logged()).not.toContain(SECRETS.hunter_api_key);
  });

  it("every other request is still logged with its body, as before", async () => {
    respond = (config) => ({ data: { items: [{ id: "lead-1", company_name: "Example Services" }] }, status: 200, statusText: "OK", headers: {}, config });
    await leadsApi.list({ limit: 5 });
    expect(logged()).toContain("Example Services");

    await pipelineApi.updateKeywords({ keywords: ["BPO-sintetico"] });
    expect(logged()).toContain("BPO-sintetico");
  });
});
