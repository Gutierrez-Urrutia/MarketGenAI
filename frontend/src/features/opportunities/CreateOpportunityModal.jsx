import { Btn, Field, Input, Select, stageTranslationKey } from "@/components/dashboard/ui";
import Modal from "@/components/ui/Modal";
import { OPPORTUNITY_STAGES, normalizeOpportunityKeywords } from "@/features/opportunities/opportunityHelpers";
import { opportunitiesApi } from "@/api/axios";
import { useI18n } from "@/hooks/useI18n";
import { useState } from "react";

/* ═══════════════════════════════════════════════════════════════ */
/*  PAGE: OPPORTUNITIES (merged Leads + Customers)                 */
/* ═══════════════════════════════════════════════════════════════ */
export function CreateOpportunityModal({ open, onClose, onCreated }) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    company: "",
    job: "",
    contact: "",
    role: "",
    contactEmail: "",
    stage: "Detected",
    source: "",
    kw: "",
    content: "",
    date: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [validation, setValidation] = useState({});

  const update = (field) => (event) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
    setValidation((current) => ({ ...current, [field]: "" }));
    setError("");
  };

  const reset = () => {
    setForm({
      company: "",
      job: "",
      contact: "",
      role: "",
      contactEmail: "",
      stage: "Detected",
      source: "",
      kw: "",
      content: "",
      date: "",
    });
    setError("");
    setValidation({});
  };

  const close = () => {
    if (saving) return;
    reset();
    onClose();
  };

  const submit = async () => {
    const nextValidation = {};
    if (!form.company.trim()) nextValidation.company = t("opportunitiesPage.createModal.required");
    if (!form.job.trim()) nextValidation.job = t("opportunitiesPage.createModal.required");
    setValidation(nextValidation);
    if (Object.keys(nextValidation).length > 0) return;

    const payload = {
      company: form.company.trim(),
      job: form.job.trim(),
      contact: form.contact.trim(),
      role: form.role.trim(),
      contactEmail: form.contactEmail.trim(),
      stage: form.stage,
      source: form.source.trim(),
      kw: normalizeOpportunityKeywords(form.kw),
      content: form.content.trim(),
      date: form.date.trim(),
    };

    setSaving(true);
    setError("");
    try {
      await opportunitiesApi.create(payload);
      reset();
      onClose();
      onCreated();
    } catch (err) {
      console.error(err);
      setError(t("opportunitiesPage.createModal.createError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title={t("opportunitiesPage.createModal.title")} maxWidth="2xl">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t("opportunitiesPage.createModal.company")}>
          <Input value={form.company} onChange={update("company")} placeholder={t("opportunitiesPage.createModal.companyPlaceholder")} />
          {validation.company && <p className="mt-1 text-xs text-red-600">{validation.company}</p>}
        </Field>
        <Field label={t("opportunitiesPage.createModal.job")}>
          <Input value={form.job} onChange={update("job")} placeholder={t("opportunitiesPage.createModal.jobPlaceholder")} />
          {validation.job && <p className="mt-1 text-xs text-red-600">{validation.job}</p>}
        </Field>
        <Field label={t("opportunitiesPage.createModal.contact")}>
          <Input value={form.contact} onChange={update("contact")} />
        </Field>
        <Field label={t("opportunitiesPage.createModal.role")}>
          <Input value={form.role} onChange={update("role")} />
        </Field>
        <Field label={t("opportunitiesPage.createModal.contactEmail")}>
          <Input type="email" value={form.contactEmail} onChange={update("contactEmail")} />
        </Field>
        <Field label={t("opportunitiesPage.createModal.stage")}>
          <Select value={form.stage} onChange={update("stage")}>
            {OPPORTUNITY_STAGES.filter((stage) => stage !== "All").map((stage) => (
              <option key={stage} value={stage}>{t(`opportunitiesPage.stages.${stageTranslationKey(stage)}`)}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("opportunitiesPage.createModal.source")}>
          <Input value={form.source} onChange={update("source")} />
        </Field>
        <Field label={t("opportunitiesPage.createModal.date")}>
          <Input value={form.date} onChange={update("date")} placeholder={t("opportunitiesPage.createModal.datePlaceholder")} />
        </Field>
        <div className="sm:col-span-2">
          <Field label={t("opportunitiesPage.createModal.keywords")} hint={t("opportunitiesPage.createModal.keywordsHint")}>
            <Input value={form.kw} onChange={update("kw")} placeholder={t("opportunitiesPage.createModal.keywordsPlaceholder")} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label={t("opportunitiesPage.createModal.content")}>
            <Input value={form.content} onChange={update("content")} />
          </Field>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Btn variant="secondary" onClick={close} disabled={saving}>{t("common.cancel")}</Btn>
        <Btn onClick={submit} disabled={saving}>{saving ? t("opportunitiesPage.createModal.saving") : t("opportunitiesPage.createModal.save")}</Btn>
      </div>
    </Modal>
  );
}
