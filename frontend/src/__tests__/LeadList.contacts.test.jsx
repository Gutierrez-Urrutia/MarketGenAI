/**
 * RF15 — contact search of a lead from LeadList (LeadContactsPanel).
 * API mocked; synthetic data only (example.com / example.org, invented names).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";

vi.mock("@/api/axios", () => ({
  leadsApi: {
    list: vi.fn(), get: vi.fn(), searchContacts: vi.fn(), listContacts: vi.fn(), reviewContact: vi.fn(),
  },
  pipelineApi: { runScan: vi.fn(), getRun: vi.fn(), getActiveRun: vi.fn() },
}));
// Keys come back as-is, except the two templates whose placeholders the tests read.
vi.mock("@/hooks/useI18n", () => {
  const templates = {
    "leads.contacts.lastSearch": "leads.contacts.lastSearch {date} · {result}",
    "leads.contacts.lastSearchNoDate": "leads.contacts.lastSearchNoDate {result}",
  };
  return { useI18n: () => ({ t: (key) => templates[key] ?? key }) };
});
vi.mock("react-hot-toast", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast };
});

import toast from "react-hot-toast";
import { leadsApi, pipelineApi } from "@/api/axios";
import LeadList from "@/pages/pipeline/LeadList";

const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const makeLead = (id, overrides = {}) => ({
  id,
  job_title: `Customer Support Agent ${id}`,
  company_name: "Example Services",
  job_url: "https://jobs.example.com/1",
  relevance_score: 0.9,
  status: "new",
  created_at: "2026-10-01T12:00:00Z",
  ...overrides,
});

const makeContact = (id, overrides = {}) => ({
  id,
  lead_id: "lead-1",
  full_name: "Ana Ficticia",
  job_title: "Head of Customer Service",
  company: "Example Services",
  email: "ana.ficticia@example.com",
  role: "department_head",
  confidence_score: 0.9,
  email_verification_status: "valid",
  email_verified_at: "2026-09-30T10:00:00Z",
  review_status: "not_required",
  rank: 1,
  reused_from_lead_id: null,
  ...overrides,
});

const apiError = (status, detail) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { detail } } });

const searchResponse = (overrides = {}) => ({
  data: {
    lead_id: "lead-1", search_id: "s-1", state: "contacts_found", reason: null, lead_status: "contacts_found",
    contacts: [makeContact("c-1"), makeContact("c-2", { full_name: "Bruno Inventado", email: "bruno.inventado@example.com", rank: 2 })],
    credits_used: 1, credits_remaining: 39, reused: false, reused_from_lead_id: null,
    searched_at: "2026-10-01T12:00:05Z", next_search_allowed_at: "2026-10-02T12:00:05Z",
    ...overrides,
  },
});

async function renderList(leads = [makeLead("lead-1")], props = {}) {
  leadsApi.list.mockResolvedValue({ data: { items: leads } });
  const utils = render(<LeadList {...props} />);
  await flush();
  return utils;
}

async function expand(index = 0) {
  fireEvent.click(screen.getAllByRole("button", { name: "leads.contacts.show" })[index]);
  await flush();
}

const searchButton = () => screen.getByRole("button", { name: /^leads\.contacts\.(search|searching)$/ });

beforeEach(() => {
  vi.clearAllMocks();
  pipelineApi.getActiveRun.mockResolvedValue({ data: { run: null } });
  leadsApi.listContacts.mockResolvedValue({ data: { items: [], total: 0 } });
  leadsApi.get.mockImplementation((id) => Promise.reject(new Error(`no ${id}`)));
});

describe("panel and button", () => {
  it("expands a row into the contacts panel, collapsed by default", async () => {
    await renderList();
    expect(screen.queryByRole("region", { name: "leads.contacts.panelTitle" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "leads.contacts.show" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await expand();
    expect(screen.getByRole("button", { name: "leads.contacts.hide" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("region", { name: "leads.contacts.panelTitle" })).toBeTruthy();
    expect(leadsApi.listContacts).toHaveBeenCalledWith("lead-1", { includeRejected: false });
  });

  it.each(["composing", "ready_for_review", "approved", "auto_approved", "sent", "replied", "rejected"])(
    "is disabled with a visible reason at the %s stage", async (status) => {
      await renderList([makeLead("lead-1", { status })]);
      await expand();
      const button = searchButton();
      expect(button.getAttribute("aria-disabled")).toBe("true");
      const reasonEl = document.getElementById(button.getAttribute("aria-describedby"));
      expect(reasonEl.textContent).toBe("leads.contacts.notSearchable");
      fireEvent.click(button);
      await flush();
      expect(leadsApi.searchContacts).not.toHaveBeenCalled();
    },
  );

  it.each(["new", "researching", "contacts_found", "error"])("is enabled at the %s stage", async (status) => {
    await renderList([makeLead("lead-1", { status })]);
    await expand();
    expect(searchButton().getAttribute("aria-disabled")).toBeNull();
  });
});

describe("search", () => {
  it("shows the result, the credits and the contacts, and refreshes the row", async () => {
    leadsApi.searchContacts.mockResolvedValue(searchResponse());
    leadsApi.get.mockResolvedValue({ data: makeLead("lead-1", { status: "contacts_found" }) });
    await renderList();
    await expand();
    fireEvent.click(searchButton());
    await flush();

    expect(leadsApi.searchContacts).toHaveBeenCalledWith("lead-1", { force: false });
    expect(screen.getByText("leads.contacts.result.contactsFound")).toBeTruthy();
    expect(screen.getByText(/leads\.contacts\.result\.creditsUsed/)).toBeTruthy();
    expect(screen.getByText(/leads\.contacts\.result\.creditsRemaining/)).toBeTruthy();
    expect(screen.getByText("Ana Ficticia")).toBeTruthy();
    expect(screen.getByText("Bruno Inventado")).toBeTruthy();
    expect(leadsApi.get).toHaveBeenCalledWith("lead-1");
    expect(screen.getByRole("cell", { name: "leads.status.contacts_found" })).toBeTruthy();
  });

  it("shows progress and blocks the button while searching", async () => {
    const pending = deferred();
    leadsApi.searchContacts.mockReturnValue(pending.promise);
    await renderList();
    await expand();
    fireEvent.click(searchButton());
    await flush();
    const button = searchButton();
    expect(button.textContent).toContain("leads.contacts.searching");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("leads.contacts.searchingHint")).toBeTruthy();
    fireEvent.click(button);
    expect(leadsApi.searchContacts).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(searchResponse()); });
    await flush();
    expect(searchButton().getAttribute("aria-disabled")).toBeNull();
  });

  it("two clicks in the same tick start a single search", async () => {
    const pending = deferred();
    leadsApi.searchContacts.mockReturnValue(pending.promise);
    await renderList();
    await expand();
    const button = searchButton();
    act(() => { button.click(); button.click(); });
    expect(leadsApi.searchContacts).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(searchResponse()); });
  });

  it("one search at a time on the whole screen: another lead's button is blocked with a reason", async () => {
    const pending = deferred();
    leadsApi.searchContacts.mockReturnValue(pending.promise);
    await renderList([makeLead("lead-1"), makeLead("lead-2")]);
    await expand(0);
    fireEvent.click(searchButton());
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "leads.contacts.hide" })); // collapse lead-1
    await expand(1);
    const other = searchButton();
    expect(other.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(other.getAttribute("aria-describedby")).textContent).toBe("leads.contacts.blockedByOther");
    fireEvent.click(other);
    expect(leadsApi.searchContacts).toHaveBeenCalledTimes(1);

    await act(async () => { pending.resolve(searchResponse()); });
    await flush();
    expect(searchButton().getAttribute("aria-disabled")).toBeNull();
  });

  it("reused contacts say they were copied, with no credits", async () => {
    leadsApi.searchContacts.mockResolvedValue(searchResponse({
      reused: true, reused_from_lead_id: "lead-0", credits_used: 0, credits_remaining: null,
      contacts: [makeContact("c-1", { reused_from_lead_id: "lead-0" })],
    }));
    await renderList();
    await expand();
    fireEvent.click(searchButton());
    await flush();
    expect(screen.getByText("leads.contacts.result.reused")).toBeTruthy();
    expect(screen.getByText("leads.contacts.list.copied")).toBeTruthy();
    expect(screen.queryByText(/creditsRemaining/)).toBeNull();
  });

  it.each([
    [{ state: "no_domain", reason: "no_domain_or_company_name" }, "leads.contacts.result.noDomain", "info"],
    [{ state: "no_contacts", reason: "no_results" }, "leads.contacts.reason.no_results", "info"],
    [{ state: "no_contacts", reason: "no_deliverable_contacts" }, "leads.contacts.reason.no_deliverable_contacts", "info"],
    [{ state: "no_contacts", reason: "company_name_unmatched" }, "leads.contacts.reason.company_name_unmatched", "info"],
    [{ state: "no_contacts", reason: "not_a_company" }, "leads.contacts.reason.not_a_company", "info"],
    [{ state: "no_contacts", reason: "reused_contacts_unusable" }, "leads.contacts.reason.reused_contacts_unusable", "info"],
    [{ state: "error", reason: "rate_limited" }, "leads.contacts.reason.rate_limited", "error"],
    [{ state: "error", reason: "no_credits" }, "leads.contacts.reason.no_credits", "error"],
    [{ state: "error", reason: "timeout" }, "leads.contacts.reason.timeout", "error"],
    [{ state: "error", reason: "provider_error" }, "leads.contacts.reason.provider_error", "error"],
    [{ state: "error", reason: "internal_error" }, "leads.contacts.reason.internal_error", "error"],
    [{ state: "error", reason: "something_new" }, "leads.contacts.reason.internal_error", "error"],
  ])("state %o shows %s", async (outcome, key, tone) => {
    leadsApi.searchContacts.mockResolvedValue(searchResponse({ ...outcome, contacts: [], lead_status: "new" }));
    await renderList();
    await expand();
    fireEvent.click(searchButton());
    await flush();
    const text = screen.getByText(key);
    expect(text.closest("[data-tone]").getAttribute("data-tone")).toBe(tone);
    expect(Boolean(text.closest("[role=alert]"))).toBe(tone === "error");
  });

  it("an error offers a retry without force (errors are not cooled down)", async () => {
    leadsApi.searchContacts.mockResolvedValueOnce(searchResponse({ state: "error", reason: "timeout", contacts: [] }));
    leadsApi.searchContacts.mockResolvedValueOnce(searchResponse());
    await renderList();
    await expand();
    fireEvent.click(searchButton());
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "leads.contacts.action.retry" }));
    await flush();
    expect(leadsApi.searchContacts).toHaveBeenNthCalledWith(2, "lead-1", { force: false });
  });

  it("an invalid key points to Settings", async () => {
    const onNavigate = vi.fn();
    leadsApi.searchContacts.mockResolvedValue(searchResponse({ state: "error", reason: "invalid_api_key", contacts: [] }));
    await renderList(undefined, { onNavigate });
    await expand();
    fireEvent.click(searchButton());
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "leads.contacts.action.goToSettings" }));
    expect(onNavigate).toHaveBeenCalledWith("settings", { tab: "pipeline" });
  });
});

describe("refusals", () => {
  it("cooldown shows the date and 'search anyway' sends force only then", async () => {
    leadsApi.searchContacts.mockRejectedValueOnce(apiError(409, {
      code: "cooldown", message: "…", next_search_allowed_at: "2026-10-02T12:00:05+00:00",
    }));
    leadsApi.searchContacts.mockResolvedValueOnce(searchResponse());
    await renderList([makeLead("lead-1", { status: "contacts_found" })]);
    await expand();
    fireEvent.click(searchButton());
    await flush();

    expect(leadsApi.searchContacts).toHaveBeenNthCalledWith(1, "lead-1", { force: false });
    expect(screen.getByText("leads.contacts.error.cooldown")).toBeTruthy();
    expect(screen.getByText("leads.contacts.action.forceCooldownHint")).toBeTruthy();
    const force = screen.getByRole("button", { name: "leads.contacts.action.forceCooldown" });
    expect(document.getElementById(force.getAttribute("aria-describedby")).textContent)
      .toBe("leads.contacts.action.forceCooldownHint");
    fireEvent.click(force);
    await flush();
    expect(leadsApi.searchContacts).toHaveBeenNthCalledWith(2, "lead-1", { force: true });
    expect(leadsApi.searchContacts).toHaveBeenCalledTimes(2);
  });

  it("a search of another area can be forced", async () => {
    leadsApi.searchContacts.mockRejectedValueOnce(apiError(409, { code: "reuse_area_mismatch", reused_from_lead_id: "lead-0" }));
    leadsApi.searchContacts.mockResolvedValueOnce(searchResponse());
    await renderList();
    await expand();
    fireEvent.click(searchButton());
    await flush();
    expect(screen.getByText("leads.contacts.error.reuseAreaMismatch")).toBeTruthy();
    expect(screen.getByText("leads.contacts.action.forceAreaHint")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "leads.contacts.action.forceArea" }));
    await flush();
    expect(leadsApi.searchContacts).toHaveBeenNthCalledWith(2, "lead-1", { force: true });
  });

  it("a search in progress is a notice, not a red error", async () => {
    leadsApi.searchContacts.mockRejectedValue(apiError(409, { code: "search_in_progress" }));
    await renderList([makeLead("lead-1", { status: "researching" })]);
    await expand();
    fireEvent.click(searchButton());
    await flush();
    const text = screen.getByText("leads.contacts.error.inProgress");
    expect(text.closest("[role=alert]")).toBeNull();
    expect(text.closest("[data-tone]").getAttribute("data-tone")).toBe("info");
    expect(screen.getByRole("button", { name: "leads.contacts.action.refresh" })).toBeTruthy();
  });

  it("a missing Hunter key never disables the button: only the 422 shows the notice", async () => {
    const onNavigate = vi.fn();
    leadsApi.searchContacts.mockRejectedValue(apiError(422, { code: "hunter_not_configured" }));
    await renderList(undefined, { onNavigate });
    await expand();
    expect(searchButton().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(searchButton());
    await flush();

    expect(screen.getByText("leads.contacts.error.notConfigured")).toBeTruthy();
    expect(searchButton().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "leads.contacts.action.goToSettings" }));
    expect(onNavigate).toHaveBeenCalledWith("settings", { tab: "pipeline" });
    fireEvent.click(searchButton());
    await flush();
    expect(leadsApi.searchContacts).toHaveBeenCalledTimes(2);
  });

  it.each([
    [apiError(422, { code: "lead_not_searchable" }), "leads.contacts.error.notSearchable"],
    [apiError(409, { code: "search_superseded" }), "leads.contacts.error.superseded"],
    [apiError(403, "Access denied."), "leads.contacts.error.forbidden"],
    [apiError(404, "Lead 'x' not found."), "leads.contacts.error.notFound"],
    [apiError(429, "Rate limit exceeded"), "leads.contacts.error.rateLimited"],
    [apiError(500, "boom"), "leads.contacts.error.serverError"],
    [Object.assign(new Error("timeout of 90000ms exceeded"), { code: "ECONNABORTED" }), "leads.contacts.error.clientTimeout"],
  ])("refusal %#: %s", async (error, key) => {
    leadsApi.searchContacts.mockRejectedValue(error);
    await renderList();
    await expand();
    fireEvent.click(searchButton());
    await flush();
    expect(screen.getByText(key)).toBeTruthy();
    expect(screen.queryByText(/Access denied|not found|boom|Rate limit/)).toBeNull();
  });
});

describe("last search comes from contacts_search, never from lead.status", () => {
  it("shows the search error of a lead whose status is new", async () => {
    await renderList([makeLead("lead-1", {
      status: "new",
      contacts_search: { state: "error", reason: "no_credits", searched_at: "2026-10-01T12:00:05Z" },
    })]);
    await expand();
    const line = screen.getByText(/leads\.contacts\.lastSearch/);
    expect(line.textContent).toContain("leads.contacts.stateLabel.error");
    expect(line.textContent).toContain("leads.contacts.reason.no_credits");
  });

  it("does not show an error for a lead whose status is error but whose last search found contacts", async () => {
    await renderList([makeLead("lead-1", {
      status: "error",
      contacts_search: { state: "contacts_found", searched_at: { _seconds: 1790000000, _nanoseconds: 0 } },
    })]);
    await expand();
    const line = screen.getByText(/leads\.contacts\.lastSearch/);
    expect(line.textContent).toContain("leads.contacts.stateLabel.contacts_found");
    expect(line.textContent).not.toContain("stateLabel.error");
  });

  it("shows nothing for a lead that was never searched", async () => {
    await renderList([makeLead("lead-1", { status: "error" })]);
    await expand();
    expect(screen.queryByText(/leads\.contacts\.lastSearch/)).toBeNull();
  });
});

describe("contact cards and review", () => {
  const cardOf = (name) => screen.getByText(name).closest("li");

  it("shows role, verification and confidence as text, and the copied note", async () => {
    leadsApi.listContacts.mockResolvedValue({ data: { items: [
      makeContact("c-1"),
      makeContact("c-2", { full_name: "Carla Sintetica", role: "procurement", email_verification_status: "accept_all",
        confidence_score: 0.55, review_status: "not_required", reused_from_lead_id: "lead-0" }),
      makeContact("c-3", { full_name: "Diego Prueba", role: "mystery", email_verification_status: null,
        confidence_score: 0.4, review_status: "pending" }),
    ] } });
    await renderList();
    await expand();

    const ana = within(cardOf("Ana Ficticia"));
    expect(ana.getByText("leads.contacts.role.department_head")).toBeTruthy();
    expect(ana.getByText("leads.contacts.verification.verifiedOn")).toBeTruthy();
    expect(ana.getByText("leads.contacts.confidence.high")).toBeTruthy();

    const carla = within(cardOf("Carla Sintetica"));
    expect(carla.getByText("leads.contacts.role.procurement")).toBeTruthy();
    expect(carla.getByText("leads.contacts.verification.risky")).toBeTruthy();
    expect(carla.getByText("leads.contacts.confidence.medium")).toBeTruthy();
    expect(carla.getByText("leads.contacts.list.copied")).toBeTruthy();

    const diego = within(cardOf("Diego Prueba"));
    expect(diego.getByText("leads.contacts.role.unknown")).toBeTruthy();
    expect(diego.getByText("leads.contacts.verification.unverified")).toBeTruthy();
    expect(diego.getByText("leads.contacts.confidence.low")).toBeTruthy();
    expect(diego.getByText("leads.contacts.review.pending")).toBeTruthy();
    expect(diego.getByRole("button", { name: "leads.contacts.review.approve: Diego Prueba" })).toBeTruthy();
    expect(ana.queryByRole("button", { name: /review\.approve/ })).toBeNull();
    expect(ana.getByRole("button", { name: "leads.contacts.review.reject: Ana Ficticia" })).toBeTruthy();
  });

  it("an approved contact out of the top (rank null) is shown", async () => {
    leadsApi.listContacts.mockResolvedValue({ data: { items: [
      makeContact("c-1"), makeContact("c-9", { full_name: "Gina Aprobada", rank: null, review_status: "approved" }),
    ] } });
    await renderList();
    await expand();
    const gina = within(cardOf("Gina Aprobada"));
    expect(gina.getByText("leads.contacts.review.approved")).toBeTruthy();
    expect(gina.getByRole("button", { name: "leads.contacts.review.reject: Gina Aprobada" })).toBeTruthy();
  });

  it("approves a pending contact", async () => {
    const pending = makeContact("c-3", { full_name: "Diego Prueba", review_status: "pending", confidence_score: 0.4 });
    leadsApi.listContacts.mockResolvedValue({ data: { items: [pending] } });
    leadsApi.reviewContact.mockResolvedValue({ data: { ...pending, review_status: "approved", reviewed_at: "2026-10-01T13:00:00Z" } });
    await renderList();
    await expand();
    fireEvent.click(screen.getByRole("button", { name: "leads.contacts.review.approve: Diego Prueba" }));
    await flush();
    expect(leadsApi.reviewContact).toHaveBeenCalledWith("lead-1", "c-3", "approved");
    expect(within(cardOf("Diego Prueba")).getByText("leads.contacts.review.approved")).toBeTruthy();
  });

  it("a rejected contact disappears; 'show rejected' brings it back with Restore", async () => {
    const ana = makeContact("c-1");
    leadsApi.listContacts.mockResolvedValueOnce({ data: { items: [ana] } });
    leadsApi.reviewContact.mockResolvedValueOnce({ data: { ...ana, review_status: "rejected" } });
    await renderList();
    await expand();
    fireEvent.click(screen.getByRole("button", { name: "leads.contacts.review.reject: Ana Ficticia" }));
    await flush();
    expect(leadsApi.reviewContact).toHaveBeenCalledWith("lead-1", "c-1", "rejected");
    expect(screen.queryByText("Ana Ficticia")).toBeNull();

    leadsApi.listContacts.mockResolvedValueOnce({ data: { items: [{ ...ana, review_status: "rejected" }] } });
    fireEvent.click(screen.getByRole("checkbox", { name: "leads.contacts.list.showRejected" }));
    await flush();
    expect(leadsApi.listContacts).toHaveBeenLastCalledWith("lead-1", { includeRejected: true });
    expect(within(cardOf("Ana Ficticia")).getByText("leads.contacts.review.rejected")).toBeTruthy();

    leadsApi.reviewContact.mockResolvedValueOnce({ data: { ...ana, review_status: "approved" } });
    fireEvent.click(screen.getByRole("button", { name: "leads.contacts.review.restore: Ana Ficticia" }));
    await flush();
    expect(leadsApi.reviewContact).toHaveBeenLastCalledWith("lead-1", "c-1", "approved");
    expect(within(cardOf("Ana Ficticia")).getByText("leads.contacts.review.approved")).toBeTruthy();
  });

  it("a review refused with 422 reloads the list", async () => {
    leadsApi.listContacts.mockResolvedValue({ data: { items: [makeContact("c-1")] } });
    leadsApi.reviewContact.mockRejectedValue(apiError(422, { code: "invalid_review_transition" }));
    await renderList();
    await expand();
    const before = leadsApi.listContacts.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "leads.contacts.review.reject: Ana Ficticia" }));
    await flush();
    expect(toast.error).toHaveBeenCalledWith("leads.contacts.review.invalidTransition");
    expect(leadsApi.listContacts.mock.calls.length).toBe(before + 1);
  });

  it("a double click on Approve sends one review", async () => {
    const pending = deferred();
    leadsApi.listContacts.mockResolvedValue({ data: { items: [makeContact("c-3", { full_name: "Diego Prueba", review_status: "pending" })] } });
    leadsApi.reviewContact.mockReturnValue(pending.promise);
    await renderList();
    await expand();
    const approve = screen.getByRole("button", { name: "leads.contacts.review.approve: Diego Prueba" });
    act(() => { approve.click(); approve.click(); });
    expect(leadsApi.reviewContact).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({ data: makeContact("c-3", { full_name: "Diego Prueba", review_status: "approved" }) }); });
  });
});

describe("no personal data in the console", () => {
  it("a search, a list and a review log nothing about the contacts", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    leadsApi.listContacts.mockResolvedValue({ data: { items: [makeContact("c-1", { review_status: "pending" })] } });
    leadsApi.searchContacts.mockResolvedValueOnce(searchResponse());
    leadsApi.searchContacts.mockRejectedValueOnce(apiError(500, { contacts: [makeContact("c-1")] }));
    leadsApi.reviewContact.mockRejectedValue(apiError(500, "Ana Ficticia"));
    await renderList();
    await expand();
    fireEvent.click(searchButton());
    await flush();
    fireEvent.click(searchButton());
    await flush();
    fireEvent.click(screen.getAllByRole("button", { name: /review\.reject: Ana Ficticia/ })[0]);
    await flush();

    const logged = JSON.stringify([...log.mock.calls, ...err.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toMatch(/Ficticia|Inventado|@example\.com/);
    log.mockRestore(); err.mockRestore(); warn.mockRestore();
  });
});

describe("the lead row follows a review (lead_status)", () => {
  const twelveLeads = () => Array.from({ length: 12 }, (_, i) => makeLead(`lead-${i + 1}`, {
    status: i === 10 ? "contacts_found" : "new",
    created_at: `2026-10-${String(20 - i).padStart(2, "0")}T12:00:00Z`,
  }));

  async function openOnPageTwo() {
    await renderList(twelveLeads());
    fireEvent.click(screen.getByRole("button", { name: "common.next" }));
    await flush();
    expect(screen.queryByText("Customer Support Agent lead-1")).toBeNull();
    expect(screen.getByText("Customer Support Agent lead-11")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "leads.contacts.show" })[0]); // lead-11
    await flush();
  }

  const rowOf = (title) => screen.getByText(title).closest("tr");

  it("rejecting the last contact refreshes the row to new, without going back to page 1", async () => {
    const ana = makeContact("c-1", { lead_id: "lead-11" });
    leadsApi.listContacts.mockResolvedValue({ data: { items: [ana] } });
    leadsApi.reviewContact.mockResolvedValue({ data: { ...ana, review_status: "rejected", lead_status: "new" } });
    leadsApi.get.mockResolvedValue({ data: makeLead("lead-11", { status: "new" }) });
    await openOnPageTwo();
    expect(within(rowOf("Customer Support Agent lead-11")).getByText("leads.status.contacts_found")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "leads.contacts.review.reject: Ana Ficticia" }));
    await flush();

    expect(leadsApi.get).toHaveBeenCalledWith("lead-11");
    expect(within(rowOf("Customer Support Agent lead-11")).getByText("leads.status.new")).toBeTruthy();
    expect(screen.queryByText("Customer Support Agent lead-1")).toBeNull(); // still on page 2
    expect(leadsApi.list).toHaveBeenCalledTimes(1);                         // the table was not reloaded
  });

  it("restoring a contact refreshes the row to contacts_found", async () => {
    const ana = makeContact("c-1", { lead_id: "lead-11", review_status: "rejected" });
    leadsApi.listContacts.mockResolvedValue({ data: { items: [] } });
    await openOnPageTwo();
    leadsApi.listContacts.mockResolvedValue({ data: { items: [ana] } });
    fireEvent.click(screen.getByRole("checkbox", { name: "leads.contacts.list.showRejected" }));
    await flush();

    leadsApi.reviewContact.mockResolvedValue({ data: { ...ana, review_status: "approved", lead_status: "contacts_found" } });
    leadsApi.get.mockResolvedValue({ data: makeLead("lead-11", { status: "contacts_found" }) });
    fireEvent.click(screen.getByRole("button", { name: "leads.contacts.review.restore: Ana Ficticia" }));
    await flush();

    expect(leadsApi.get).toHaveBeenCalledWith("lead-11");
    expect(within(rowOf("Customer Support Agent lead-11")).getByText("leads.status.contacts_found")).toBeTruthy();
    expect(within(screen.getByText("Ana Ficticia").closest("li")).getByText("leads.contacts.review.approved")).toBeTruthy();
    expect(screen.getByText("Ana Ficticia").closest("li").textContent).not.toContain("lead_status");
  });

  it("the row keeps its status when the backend left it unchanged", async () => {
    const ana = makeContact("c-1", { lead_id: "lead-11" });
    leadsApi.listContacts.mockResolvedValue({ data: { items: [ana, makeContact("c-2", { lead_id: "lead-11", full_name: "Bruno Inventado" })] } });
    leadsApi.reviewContact.mockResolvedValue({ data: { ...ana, review_status: "rejected", lead_status: "contacts_found" } });
    leadsApi.get.mockResolvedValue({ data: makeLead("lead-11", { status: "contacts_found" }) });
    await openOnPageTwo();
    fireEvent.click(screen.getByRole("button", { name: "leads.contacts.review.reject: Ana Ficticia" }));
    await flush();
    expect(within(rowOf("Customer Support Agent lead-11")).getByText("leads.status.contacts_found")).toBeTruthy();
  });
});
