import { ArrowRightIcon, XIcon } from "@/components/dashboard/icons";
import { Btn, Field, Input, Select } from "@/components/dashboard/ui";
import { campaignsApi } from "@/api/axios";
import { saveLocalCampaign } from "@/utils/localStore";
import { useI18n } from "@/hooks/useI18n";
import { useState } from "react";

export function CampaignModal({ onClose, onCreated }) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    name: "",
    audience: "",
    channel: "linkedin",
    objective: "lead_generation",
    context: "",
  });
  const [saving, setSaving] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [generationStep, setGenerationStep] = useState("");

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const saveCampaign = async (status = "draft") => {
    const now = new Date();
    const name = form.name.trim() || t("dashboard.quickActionCards.campaignDefaultName");
    const payload = {
      name,
      audience: form.audience,
      channels: [form.channel],
      objective: form.objective,
      context: form.context,
      status,
    };

    setSaving(true);
    setGenerationProgress(status === "active" ? 8 : 0);
    setGenerationStep(status === "active" ? t("dashboard.quickActionCards.aiStepSaving") : "");
    let createdCampaign = null;
    let progressTimer = null;
    try {
      const { data } = await campaignsApi.create(payload);
      if (!data || typeof data !== "object" || Array.isArray(data) || !data.id) {
        throw new Error("Invalid campaign response");
      }
      createdCampaign = data;
      saveLocalCampaign({ ...data, channel: data.channels?.[0] || form.channel });

      if (status === "draft") {
        onCreated(t("dashboard.quickActionCards.campaignSaved"));
        return;
      }

      setGenerationProgress(20);
      setGenerationStep(t("dashboard.quickActionCards.aiStepAnalyzing"));
      progressTimer = window.setInterval(() => {
        setGenerationProgress((current) => {
          const next = Math.min(current + 7, 88);
          if (next >= 62) setGenerationStep(t("dashboard.quickActionCards.aiStepPublishing"));
          else if (next >= 36) setGenerationStep(t("dashboard.quickActionCards.aiStepWriting"));
          return next;
        });
      }, 700);

      await campaignsApi.generate(data.id);
      window.clearInterval(progressTimer);
      progressTimer = null;
      setGenerationProgress(100);
      setGenerationStep(t("dashboard.quickActionCards.aiStepComplete"));
      window.dispatchEvent(new CustomEvent("marketgen:content-library-updated"));
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      onCreated({ type: "success", message: t("dashboard.quickActionCards.campaignCreatedWithContent") });
    } catch (error) {
      if (createdCampaign) {
        setGenerationStep(t("dashboard.quickActionCards.aiStepFailed"));
        onCreated({ type: "error", message: t("dashboard.quickActionCards.campaignCreatedAiError") });
        return;
      }
      saveLocalCampaign({
        ...payload,
        id: `campaign-${Date.now()}`,
        channel: form.channel,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      onCreated(t("dashboard.quickActionCards.campaignSavedLocally"));
    } finally {
      if (progressTimer) window.clearInterval(progressTimer);
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 p-5">
          <div>
            <p className="text-sm font-semibold text-gray-900">{t("dashboard.quickActionCards.campaignModalTitle")}</p>
            <p className="text-xs text-gray-500">{t("dashboard.quickActionCards.campaignModalSubtitle")}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600" aria-label={t("common.close")}>
            <XIcon size={16} />
          </button>
        </div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label={t("dashboard.quickActionCards.campaignName")}>
            <Input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder={t("dashboard.quickActionCards.campaignNamePlaceholder")} />
          </Field>
          <Field label={t("dashboard.quickActionCards.targetAudience")}>
            <Input value={form.audience} onChange={(event) => update("audience", event.target.value)} placeholder={t("dashboard.quickActionCards.targetAudiencePlaceholder")} />
          </Field>
          <Field label={t("dashboard.quickActionCards.primaryChannel")}>
            <Select value={form.channel} onChange={(event) => update("channel", event.target.value)}>
              <option value="linkedin">LinkedIn</option>
              <option value="substack">Substack</option>
              <option value="email_outreach">Email Outreach</option>
            </Select>
          </Field>
          <Field label={t("dashboard.quickActionCards.objective")}>
            <Select value={form.objective} onChange={(event) => update("objective", event.target.value)}>
              <option value="lead_generation">{t("dashboard.quickActionCards.objectiveLeadGeneration")}</option>
              <option value="awareness">{t("dashboard.quickActionCards.objectiveAwareness")}</option>
              <option value="follow_up">{t("dashboard.quickActionCards.objectiveFollowUp")}</option>
              <option value="conversion">{t("dashboard.quickActionCards.objectiveConversion")}</option>
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field label={t("dashboard.quickActionCards.context")}>
              <textarea
                value={form.context}
                onChange={(event) => update("context", event.target.value)}
                rows={4}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-teal-500"
                placeholder={t("dashboard.quickActionCards.campaignContextPlaceholder")}
              />
            </Field>
          </div>
        </div>
        {saving && generationStep && (
          <div className="mx-5 mb-5 rounded-xl border border-teal-100 bg-teal-50 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold text-teal-800">{generationStep}</p>
              <span className="text-xs font-semibold text-teal-700">{generationProgress}%</span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white">
              <div
                className="h-full rounded-full bg-teal-500 transition-all duration-500"
                style={{ width: `${generationProgress}%` }}
              />
            </div>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 border-t border-gray-100 bg-gray-50 p-4">
          <p className="text-xs font-medium text-teal-600">
            {saving && generationStep ? t("dashboard.quickActionCards.generatingAiContent") : ""}
          </p>
          <div className="flex gap-2">
            <Btn variant="ghost" onClick={onClose} disabled={saving}>{t("common.cancel")}</Btn>
            <Btn variant="secondary" onClick={() => saveCampaign("draft")} disabled={saving}>{t("dashboard.quickActionCards.saveDraft")}</Btn>
            <Btn variant="teal" icon={<ArrowRightIcon size={13} />} onClick={() => saveCampaign("active")} disabled={saving}>{t("dashboard.quickActionCards.continue")}</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
