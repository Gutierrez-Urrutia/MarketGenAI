import { proposalDocumentToHtml } from "@/features/proposals/proposalHtml";
import { useI18n } from "@/hooks/useI18n";
import { useState } from "react";
import { ArrowRightIcon, XIcon } from "@/components/dashboard/icons";
import { Btn, Field, Input } from "@/components/dashboard/ui";
import { saveLocalContentProposal } from "@/utils/localStore";

export function QuickProposalModal({ onClose, onCreated }) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    title: "",
    customer: "",
    customerEmail: "",
    objective: "",
    context: "",
  });

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const saveProposal = (status = "draft") => {
    const now = new Date();
    const title = form.title.trim() || t("dashboard.quickActionCards.proposalDefaultTitle");
    const customer = form.customer.trim() || t("dashboard.quickActionCards.proposalDefaultCustomer");
    const proposal = {
      id: `quick-proposal-${Date.now()}`,
      title,
      name: title,
      type: "Proposal",
      status,
      customerName: customer,
      clientName: customer,
      clientEmail: form.customerEmail.trim(),
      objective: form.objective,
      description: form.context,
      date: now.toISOString().slice(0, 10),
      updatedAt: now.toISOString(),
      content: proposalDocumentToHtml({
        title,
        customerName: customer,
        executiveSummary: form.context || form.objective || title,
        sections: [
          {
            title: t("dashboard.quickActionCards.proposalObjective"),
            body: form.objective || form.context || title,
          },
        ],
        pricingRows: [],
        totalAmount: 0,
      }),
      structuredContent: {
        title,
        customerName: customer,
        executiveSummary: form.context || form.objective || title,
        sections: [
          {
            title: t("dashboard.quickActionCards.proposalObjective"),
            body: form.objective || form.context || title,
          },
        ],
      },
      pricingRows: [],
      totalAmount: 0,
    };
    saveLocalContentProposal(proposal);
    onCreated(t("dashboard.quickActionCards.proposalDraftCreated"));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 p-5">
          <div>
            <p className="text-sm font-semibold text-gray-900">{t("dashboard.quickActionCards.proposalModalTitle")}</p>
            <p className="text-xs text-gray-500">{t("dashboard.quickActionCards.proposalModalSubtitle")}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600" aria-label={t("common.close")}>
            <XIcon size={16} />
          </button>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label={t("dashboard.quickActionCards.proposalName")}>
            <Input value={form.title} onChange={(event) => update("title", event.target.value)} placeholder={t("dashboard.quickActionCards.proposalNamePlaceholder")} />
          </Field>
          <Field label={t("dashboard.quickActionCards.proposalCustomer")}>
            <Input value={form.customer} onChange={(event) => update("customer", event.target.value)} placeholder={t("dashboard.quickActionCards.proposalCustomerPlaceholder")} />
          </Field>
          <Field label="Client email">
            <Input type="email" value={form.customerEmail} onChange={(event) => update("customerEmail", event.target.value)} placeholder="client@company.com" />
          </Field>
          <Field label={t("dashboard.quickActionCards.proposalObjective")}>
            <Input value={form.objective} onChange={(event) => update("objective", event.target.value)} placeholder={t("dashboard.quickActionCards.proposalObjectivePlaceholder")} />
          </Field>
          <div />
          <div className="sm:col-span-2">
            <Field label={t("dashboard.quickActionCards.context")}>
              <textarea
                value={form.context}
                onChange={(event) => update("context", event.target.value)}
                rows={4}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder={t("dashboard.quickActionCards.proposalContextPlaceholder")}
              />
            </Field>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-100 bg-gray-50 p-4">
          <Btn variant="ghost" onClick={onClose}>{t("common.cancel")}</Btn>
          <Btn variant="secondary" onClick={() => saveProposal("draft")}>{t("dashboard.quickActionCards.saveDraft")}</Btn>
          <Btn icon={<ArrowRightIcon size={13} />} onClick={() => saveProposal("draft")}>{t("dashboard.quickActionCards.createProposalButton")}</Btn>
        </div>
      </div>
    </div>
  );
}
