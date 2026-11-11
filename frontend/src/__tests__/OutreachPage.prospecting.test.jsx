/**
 * RF-VTA-16 — prospecting emails in «Alcance» (OutreachPage), next to the
 * AI replies. API mocked; synthetic data only (example.com, invented names).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";

vi.mock("@/api/axios", () => {
  const api = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  return {
    default: api,
    campaignsApi: { update: vi.fn() },
    outreachEmailsApi: {
      list: vi.fn(), approve: vi.fn(), reject: vi.fn(), markSent: vi.fn(), regenerate: vi.fn(),
    },
  };
});
vi.mock("@/utils/dashboardData", () => ({ fetchOptional: vi.fn() }));
vi.mock("@/hooks/useI18n", () => {
  const templates = { "outreachPage.prospecting.bulkScope": "({count} replies)" };
  return { useI18n: () => ({ t: (key) => templates[key] ?? key }) };
});
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("react-hot-toast", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast };
});

import toast from "react-hot-toast";
import api, { outreachEmailsApi } from "@/api/axios";
import { fetchOptional } from "@/utils/dashboardData";
import { OutreachPage } from "@/views/OutreachPage";

const KP = "outreachPage.prospecting";
const flush = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });

const prospecting = (id, overrides = {}) => ({
  id, user_id: "u", lead_id: "lead-1", contact_id: `c-${id}`, status: "pending_review", language: "en",
  job_title: "Support Agent", company_name: "Example Services", contact_name: `Ana ${id}`,
  contact_job_title: "Head of Support", to_email: `ana.${id}@example.com`, contact_review_status: "not_required",
  subject: `Subject ${id}`, body: `Body of ${id}`, history: [], ...overrides,
});
const reply = (id) => ({
  id, name: `Reply ${id}`, company: "Example Org", role: "VP", subject: `Re ${id}`, content: "Hello", status: "pending", score: 60,
});

async function renderPage({ emails = [], replies = [], history = [], props = {} } = {}) {
  outreachEmailsApi.list.mockResolvedValue({ data: { items: emails } });
  fetchOptional.mockResolvedValue({ reviewQueue: replies, history });
  const onOutreachBadgeChange = vi.fn();
  render(<OutreachPage onOutreachBadgeChange={onOutreachBadgeChange} {...props} />);
  await flush();
  return { onOutreachBadgeChange };
}

const detail = () => screen.getByTestId("prospecting-email-detail");
const button = (name) => within(detail()).getByRole("button", { name });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("queue: prospecting emails next to the replies", () => {
  it("lists both kinds with their label and filters them", async () => {
    await renderPage({ emails: [prospecting("p1"), prospecting("p2", { status: "sent" })], replies: [reply("r1")] });
    expect(screen.getAllByTestId("prospecting-item")).toHaveLength(1); // sent is not in the queue
    expect(screen.getAllByTestId("reply-item")).toHaveLength(1);
    expect(screen.getAllByText(`${KP}.kind.prospecting`).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: `${KP}.filters.prospecting` }));
    expect(screen.queryAllByTestId("reply-item")).toHaveLength(0);
    expect(screen.getAllByTestId("prospecting-item")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: `${KP}.filters.replies` }));
    expect(screen.queryAllByTestId("prospecting-item")).toHaveLength(0);
    expect(screen.getAllByTestId("reply-item")).toHaveLength(1);
  });

  it("navigationState.kind preselects the prospecting filter", async () => {
    await renderPage({ emails: [prospecting("p1")], replies: [reply("r1")], props: { navigationState: { kind: "prospecting" } } });
    expect(screen.getByRole("button", { name: `${KP}.filters.prospecting` }).getAttribute("aria-pressed")).toBe("true");
    expect(detail()).toBeTruthy();
  });

  it("the badge counts pending replies plus active prospecting emails", async () => {
    const { onOutreachBadgeChange } = await renderPage({
      emails: [prospecting("p1"), prospecting("p2", { status: "approved" }), prospecting("p3", { status: "rejected" })],
      replies: [reply("r1")],
    });
    expect(onOutreachBadgeChange).toHaveBeenLastCalledWith(3);
  });
});

describe("«Aprobar todo» / «Rechazar todo» only act on the replies", () => {
  it("never call /outreach-emails and say how many replies they cover", async () => {
    await renderPage({ emails: [prospecting("p1")], replies: [reply("r1"), reply("r2")] });
    api.patch.mockResolvedValue({ data: {} });
    const approveAll = screen.getByRole("button", { name: "outreachPage.approveAll (2 replies)" });
    fireEvent.click(approveAll);
    await flush();
    expect(api.patch.mock.calls.map(([url]) => url)).toEqual([
      "/outreach/review-queue/r1/approve", "/outreach/review-queue/r2/approve",
    ]);
    expect(outreachEmailsApi.approve).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("prospecting-item")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /outreachPage\.rejectAll/ }));
    await flush();
    expect(outreachEmailsApi.reject).not.toHaveBeenCalled();
  });

  it("are hidden with the prospecting filter", async () => {
    await renderPage({ emails: [prospecting("p1")], replies: [reply("r1")] });
    fireEvent.click(screen.getByRole("button", { name: `${KP}.filters.prospecting` }));
    expect(screen.queryByRole("button", { name: /outreachPage\.approveAll/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /outreachPage\.rejectAll/ })).toBeNull();
  });
});

describe("detail of a prospecting email", () => {
  it("shows vacancy, recipient and language, and the body as plain text", async () => {
    await renderPage({
      emails: [prospecting("p1", { language: "pt", subject: "<b>Olá</b>", body: "<script>alert(1)</script>\n<b>x</b>" })],
    });
    expect(within(detail()).getByText("Support Agent @ Example Services")).toBeTruthy();
    expect(within(detail()).getByText("ana.p1@example.com")).toBeTruthy();
    expect(screen.getByTestId("email-language").textContent).toBe("Português");
    expect(screen.getByTestId("email-subject").textContent).toBe("<b>Olá</b>");
    expect(screen.getByTestId("email-body").textContent).toBe("<script>alert(1)</script>\n<b>x</b>");
    expect(detail().querySelector("script")).toBeNull();
    expect(detail().querySelector("b")).toBeNull();
  });

  it("warns when the contact needed review when the email was drafted", async () => {
    await renderPage({ emails: [prospecting("p1", { contact_review_status: "pending" })] });
    expect(within(detail()).getByRole("note").textContent).toBe(`${KP}.detail.pendingContact`);
  });

  it("approve, then mark as sent; the email leaves the queue for the history", async () => {
    await renderPage({ emails: [prospecting("p1")] });
    expect(within(detail()).queryByRole("button", { name: `${KP}.actions.markSent` })).toBeNull();
    outreachEmailsApi.approve.mockResolvedValue({ data: prospecting("p1", { status: "approved" }) });
    fireEvent.click(button(`${KP}.actions.approve`));
    await flush();
    expect(outreachEmailsApi.approve).toHaveBeenCalledWith("p1");
    expect(toast.success).toHaveBeenCalledWith(`${KP}.messages.approved`);

    outreachEmailsApi.markSent.mockResolvedValue({
      data: prospecting("p1", { status: "sent", sent_marked_by_name: "Test User", sent_at: "2026-11-11T12:00:00Z" }),
    });
    fireEvent.click(button(`${KP}.actions.markSent`));
    await flush();
    expect(outreachEmailsApi.markSent).toHaveBeenCalledWith("p1");
    expect(screen.queryAllByTestId("prospecting-item")).toHaveLength(0);

    fireEvent.click(screen.getByText("outreachPage.sentHistory"));
    const row = within(screen.getByTestId("prospecting-history")).getByText("Ana p1").closest("tr");
    expect(within(row).getByText(`${KP}.status.sent`)).toBeTruthy();
    expect(within(row).getByText("Test User")).toBeTruthy();
    expect(within(row).getByText("English")).toBeTruthy();
  });

  it("an error is shown translated and a changed status reloads the list", async () => {
    await renderPage({ emails: [prospecting("p1")] });
    outreachEmailsApi.approve.mockRejectedValue({ response: { status: 422, data: { detail: { code: "contact_not_approved" } } } });
    fireEvent.click(button(`${KP}.actions.approve`));
    await flush();
    expect(toast.error).toHaveBeenCalledWith(`${KP}.errors.contact_not_approved`);
    expect(outreachEmailsApi.list).toHaveBeenCalledTimes(1);

    outreachEmailsApi.approve.mockRejectedValue({ response: { status: 422, data: { detail: { code: "invalid_email_transition" } } } });
    fireEvent.click(button(`${KP}.actions.approve`));
    await flush();
    expect(outreachEmailsApi.list).toHaveBeenCalledTimes(2);
  });

  it("regenerate can change the language and is disabled with «Generando…» meanwhile", async () => {
    let finish;
    outreachEmailsApi.regenerate.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await renderPage({ emails: [prospecting("p1", { language: "en" })] });
    const select = within(detail()).getByRole("combobox", { name: `${KP}.actions.regenerateLanguage` });
    expect(select.value).toBe("en");
    fireEvent.change(select, { target: { value: "es" } });
    fireEvent.click(button(`${KP}.actions.regenerate`));
    await flush();
    expect(outreachEmailsApi.regenerate).toHaveBeenCalledWith("p1", "es");
    const busy = button(`${KP}.actions.generating`);
    expect(busy.disabled).toBe(true);
    expect(button(`${KP}.actions.approve`).disabled).toBe(true);

    await act(async () => { finish({ data: prospecting("p1", { language: "es", subject: "Asunto nuevo" }) }); });
    await flush();
    expect(screen.getByTestId("email-subject").textContent).toBe("Asunto nuevo");
    expect(screen.getByTestId("email-language").textContent).toBe("Español");
  });

  it("a rejected email has no actions", async () => {
    await renderPage({ emails: [prospecting("p1")] });
    outreachEmailsApi.reject.mockResolvedValue({ data: prospecting("p1", { status: "rejected", rejected_by_name: "Test User" }) });
    fireEvent.click(button(`${KP}.actions.reject`));
    await flush();
    expect(screen.queryByTestId("prospecting-email-detail")).toBeNull(); // left the queue
    fireEvent.click(screen.getByText("outreachPage.sentHistory"));
    const row = within(screen.getByTestId("prospecting-history")).getByText("Ana p1").closest("tr");
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
  });
});

describe("«Copiar»", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("copies subject and body without calling the API nor changing the email", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await renderPage({ emails: [prospecting("p1", { status: "approved" })] });
    fireEvent.click(button(`${KP}.actions.copy`));
    await flush();
    expect(writeText).toHaveBeenCalledWith("Subject p1\n\nBody of p1");
    expect(toast.success).toHaveBeenCalledWith(`${KP}.messages.copied`);
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(Object.values(outreachEmailsApi).some((fn) => fn !== outreachEmailsApi.list && fn.mock.calls.length)).toBe(false);
    expect(within(detail()).getByText(`${KP}.status.approved`)).toBeTruthy();
  });

  it.each([
    ["refuses", () => ({ clipboard: { writeText: vi.fn(() => Promise.reject(new Error("denied"))) } })],
    ["is missing", () => ({})],
  ])("when the clipboard %s: a translated message, no API call, no change", async (_name, nav) => {
    vi.stubGlobal("navigator", { ...navigator, ...nav(), ...(nav().clipboard ? {} : { clipboard: undefined }) });
    await renderPage({ emails: [prospecting("p1", { status: "approved" })] });
    fireEvent.click(button(`${KP}.actions.copy`));
    await flush();
    expect(toast.error).toHaveBeenCalledWith(`${KP}.messages.copyFailed`);
    expect(toast.success).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(outreachEmailsApi.markSent).not.toHaveBeenCalled();
    expect(within(detail()).getByText(`${KP}.status.approved`)).toBeTruthy();
  });
});
