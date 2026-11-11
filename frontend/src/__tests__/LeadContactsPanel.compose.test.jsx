/**
 * RF-VTA-16 — «Redactar correo» on a lead's contact (LeadContactsPanel).
 * API mocked; synthetic data only (example.com, invented names).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";

vi.mock("@/api/axios", () => ({
  leadsApi: { listContacts: vi.fn(), searchContacts: vi.fn(), reviewContact: vi.fn() },
  outreachEmailsApi: { list: vi.fn(), generate: vi.fn() },
}));
vi.mock("@/hooks/useI18n", () => ({ useI18n: () => ({ t: (key) => key }) }));
vi.mock("react-hot-toast", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast };
});

import { leadsApi, outreachEmailsApi } from "@/api/axios";
import LeadContactsPanel from "@/pages/pipeline/LeadContactsPanel";

const KC = "leads.contacts.compose";
const flush = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const LEAD = { id: "lead-1", status: "contacts_found", company_name: "Example Services", job_title: "Support Agent" };
const contact = (id, overrides = {}) => ({
  id, lead_id: "lead-1", full_name: `Ana ${id}`, job_title: "Head of Support", company: "Example Services",
  email: `ana.${id}@example.com`, role: "department_head", confidence_score: 0.9,
  email_verification_status: "valid", review_status: "not_required", ...overrides,
});
const emailOf = (contactId, overrides = {}) => ({
  id: `e-${contactId}`, lead_id: "lead-1", contact_id: contactId, status: "pending_review", language: "en", ...overrides,
});
const apiError = (status, code) => Object.assign(new Error(code), { response: { status, data: { detail: { code } } } });

const searchLock = { activeLeadId: null, tryAcquire: () => true, release: () => {} };

async function renderPanel(contacts, emails = [], props = {}) {
  leadsApi.listContacts.mockResolvedValue({ data: { items: contacts } });
  outreachEmailsApi.list.mockResolvedValue({ data: { items: emails } });
  const handlers = { onLeadChanged: vi.fn(), onNavigate: vi.fn() };
  render(<LeadContactsPanel lead={LEAD} searchLock={searchLock} {...handlers} {...props} />);
  await flush();
  return handlers;
}

const card = (id) => screen.getByTestId(`compose-${id}`);
const draftButton = (id) => within(card(id)).getByRole("button", { name: new RegExp(`^${KC}\\.(draft|generating): Ana ${id}$`) });
const languageSelect = (id) => within(card(id)).getByRole("combobox", { name: `${KC}.language: Ana ${id}` });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("«Redactar correo»", () => {
  it("loads the lead's emails and is offered only to non-rejected contacts with an address", async () => {
    await renderPanel([contact("c1"), contact("c2", { email: null }), contact("c3", { review_status: "rejected" })]);
    expect(outreachEmailsApi.list).toHaveBeenCalledWith({ lead_id: "lead-1" });
    expect(draftButton("c1")).toBeTruthy();
    expect(screen.queryByTestId("compose-c2")).toBeNull();
    expect(screen.queryByTestId("compose-c3")).toBeNull();
  });

  it("offers English, Español and Português, English by default, and sends the one picked", async () => {
    outreachEmailsApi.generate.mockResolvedValue({ data: { ...emailOf("c1"), warnings: [], lead_status: "ready_for_review" } });
    await renderPanel([contact("c1"), contact("c2")]);
    const options = within(languageSelect("c1")).getAllByRole("option");
    expect(options.map((o) => [o.value, o.textContent])).toEqual([["en", "English"], ["es", "Español"], ["pt", "Português"]]);
    expect(languageSelect("c1").value).toBe("en");

    fireEvent.click(draftButton("c1"));
    await flush();
    expect(outreachEmailsApi.generate).toHaveBeenLastCalledWith("lead-1", "c1", "en");

    fireEvent.change(languageSelect("c2"), { target: { value: "pt" } });
    fireEvent.click(draftButton("c2"));
    await flush();
    expect(outreachEmailsApi.generate).toHaveBeenLastCalledWith("lead-1", "c2", "pt");
  });

  it("is disabled with «Generando…» while drafting, and no second draft starts", async () => {
    const pending = deferred();
    outreachEmailsApi.generate.mockReturnValue(pending.promise);
    await renderPanel([contact("c1"), contact("c2")]);
    fireEvent.click(draftButton("c1"));
    await flush();
    const busy = draftButton("c1");
    expect(busy.textContent).toBe(`${KC}.generating`);
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(languageSelect("c1").disabled).toBe(true);
    expect(draftButton("c2").disabled).toBe(true);
    fireEvent.click(draftButton("c2"));
    expect(outreachEmailsApi.generate).toHaveBeenCalledTimes(1);

    await act(async () => { pending.resolve({ data: { ...emailOf("c1"), warnings: [], lead_status: "ready_for_review" } }); });
    await flush();
    expect(draftButton("c2").disabled).toBe(false);
  });

  it("after drafting shows the email's status and «Ver en Alcance» instead of the button", async () => {
    outreachEmailsApi.generate.mockResolvedValue({ data: { ...emailOf("c1"), warnings: [], lead_status: "ready_for_review" } });
    const { onLeadChanged, onNavigate } = await renderPanel([contact("c1")]);
    fireEvent.click(draftButton("c1"));
    await flush();
    expect(within(card("c1")).queryByRole("button", { name: new RegExp(`${KC}.draft`) })).toBeNull();
    expect(within(card("c1")).getByText(`${KC}.active.pending_review`)).toBeTruthy();
    expect(within(card("c1")).getByRole("status").textContent).toBe(`${KC}.created`);
    expect(onLeadChanged).toHaveBeenCalledWith("lead-1", { status: "ready_for_review" });
    fireEvent.click(within(card("c1")).getByRole("button", { name: `${KC}.viewInOutreach` }));
    expect(onNavigate).toHaveBeenCalledWith("outreach", { tab: "review", kind: "prospecting" });
  });

  it("a contact that already has an active email never gets the button", async () => {
    await renderPanel([contact("c1"), contact("c2")], [
      emailOf("c1", { status: "approved" }),
      emailOf("c2", { id: "old", status: "rejected" }),
    ]);
    expect(within(card("c1")).getByText(`${KC}.active.approved`)).toBeTruthy();
    expect(within(card("c1")).queryByRole("combobox")).toBeNull();
    expect(draftButton("c2")).toBeTruthy(); // a rejected email is not active
  });

  it("warns when the contact still needs review, before and after drafting", async () => {
    outreachEmailsApi.generate.mockResolvedValue({
      data: { ...emailOf("c1"), warnings: ["contact_pending_review"], lead_status: "ready_for_review" },
    });
    await renderPanel([contact("c1", { review_status: "pending" })]);
    expect(within(card("c1")).getByText(`${KC}.pendingHint`)).toBeTruthy();
    fireEvent.click(draftButton("c1"));
    await flush();
    expect(within(card("c1")).getByRole("status").textContent).toBe(`${KC}.createdPending`);
  });

  it("a timeout shows the clear message and reloads the lead's emails (the email may exist)", async () => {
    outreachEmailsApi.generate.mockRejectedValue(Object.assign(new Error("timeout of 120000ms exceeded"), { code: "ECONNABORTED" }));
    const { onLeadChanged } = await renderPanel([contact("c1")]);
    outreachEmailsApi.list.mockResolvedValue({ data: { items: [emailOf("c1")] } });
    fireEvent.click(draftButton("c1"));
    await flush();
    expect(within(card("c1")).getByRole("alert").textContent).toBe("outreachPage.prospecting.errors.timeout");
    expect(outreachEmailsApi.list).toHaveBeenCalledTimes(2);
    expect(within(card("c1")).getByText(`${KC}.active.pending_review`)).toBeTruthy();
    expect(within(card("c1")).queryByRole("button", { name: new RegExp(`${KC}.draft`) })).toBeNull();
    expect(onLeadChanged).toHaveBeenCalledWith("lead-1", null);
  });

  it("a 409 email_already_active is shown as translated text and reloads the emails", async () => {
    outreachEmailsApi.generate.mockRejectedValue(apiError(409, "email_already_active"));
    await renderPanel([contact("c1")]);
    fireEvent.click(draftButton("c1"));
    await flush();
    expect(within(card("c1")).getByRole("alert").textContent).toBe("outreachPage.prospecting.errors.email_already_active");
    expect(outreachEmailsApi.list).toHaveBeenCalledTimes(2);
  });

  it("a 422 is shown as translated text without reloading", async () => {
    outreachEmailsApi.generate.mockRejectedValue(apiError(422, "lead_not_composable"));
    await renderPanel([contact("c1")]);
    fireEvent.click(draftButton("c1"));
    await flush();
    expect(within(card("c1")).getByRole("alert").textContent).toBe("outreachPage.prospecting.errors.lead_not_composable");
    expect(outreachEmailsApi.list).toHaveBeenCalledTimes(1);
    expect(draftButton("c1").disabled).toBe(false);
  });

  it("is disabled while this lead's contact search runs", async () => {
    await renderPanel([contact("c1")], [], { searchLock: { ...searchLock, activeLeadId: "lead-1" } });
    expect(draftButton("c1").disabled).toBe(true);
  });
});
