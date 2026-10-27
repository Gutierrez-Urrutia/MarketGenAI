import { Btn, Card, Field, Input, Select } from "@/components/dashboard/ui";
import { campaignsApi } from "@/api/axios";
import { completeCampaignFlowSteps } from "@/utils/campaignContent";
import { saveLocalCampaign } from "@/utils/localStore";
import { useState } from "react";

export function CampaignBriefPage({ onNavigate = () => {}, campaignFlow = null, setCampaignFlow = () => {} }) {
  const [form, setForm] = useState({
    name: campaignFlow?.brief?.name || "",
    objective: campaignFlow?.brief?.objective || "lead_generation",
    channels: campaignFlow?.brief?.channels || [],
    startDate: campaignFlow?.brief?.startDate || "",
    budget: campaignFlow?.brief?.budget || "",
    kpis: campaignFlow?.brief?.kpis || "",
    context: campaignFlow?.brief?.context || "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const toggleChannel = (channel) => {
    setForm((current) => {
      const channels = current.channels || [];
      return {
        ...current,
        channels: channels.includes(channel)
          ? channels.filter((item) => item !== channel)
          : [...channels, channel],
      };
    });
  };
  const handleSubmit = async () => {
    if (!form.name.trim() || !form.channels.length) return;
    setSaving(true);
    setError("");
    try {
      const response = await campaignsApi.create({
        name: form.name.trim(),
        audience: (campaignFlow?.selectedOpportunities || []).map((item) => item.company || item.name).filter(Boolean).join(", "),
        objective: form.objective,
        channels: form.channels,
        context: form.context,
        briefData: {
          startDate: form.startDate,
          budget: form.budget,
          kpis: form.kpis,
          selectedOpportunityIds: (campaignFlow?.selectedOpportunities || []).map((item) => item.id).filter(Boolean),
        },
        status: "draft",
      });
      const data = response.data;
      saveLocalCampaign({ ...data, channel: data.channels?.[0] || form.channels[0] });
      window.dispatchEvent(new CustomEvent("marketgen:campaigns-updated"));
      setCampaignFlow((prev) => ({
        ...completeCampaignFlowSteps(prev, [2], 3),
        campaignId: data.id,
        campaignName: form.name.trim(),
        brief: form,
      }));
      onNavigate("assistant");
    } catch (err) {
      console.error(err);
      setError("Could not create the campaign brief. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {campaignFlow && (
        <div className="flow-step-banner">
          <span>🎯 Step 2: Define your campaign brief</span>
        </div>
      )}
      <div>
        <h1 className="text-xl font-bold text-gray-900">Campaign Brief</h1>
        <p className="text-xs text-gray-500">Define the campaign before moving to AI content.</p>
      </div>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      <Card className="p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Campaign name">
            <Input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Q3 outbound campaign" />
          </Field>
          <Field label="Objective">
            <Select value={form.objective} onChange={(event) => update("objective", event.target.value)}>
              <option value="lead_generation">Lead generation</option>
              <option value="awareness">Awareness</option>
              <option value="follow_up">Follow-up</option>
              <option value="conversion">Conversion</option>
            </Select>
          </Field>
          <Field label="Start date">
            <Input type="date" value={form.startDate} onChange={(event) => update("startDate", event.target.value)} />
          </Field>
          <Field label="Budget">
            <Input type="number" min="0" value={form.budget} onChange={(event) => update("budget", event.target.value)} placeholder="Optional" />
          </Field>
          <div className="md:col-span-2">
            <Field label="Channels">
              <div className="flex flex-wrap gap-2">
                {[
                  ["linkedin", "LinkedIn"],
                  ["substack", "Substack"],
                  ["email_outreach", "Email Outreach"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => toggleChannel(value)}
                    className={`rounded-lg border px-3 py-2 text-xs font-medium transition ${form.channels.includes(value) ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-600 hover:border-indigo-200"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Field>
          </div>
          <div className="md:col-span-2">
            <Field label="KPIs">
              <Input value={form.kpis} onChange={(event) => update("kpis", event.target.value)} placeholder="Open rate, response rate, booked meetings..." />
            </Field>
          </div>
          <div className="md:col-span-2">
            <Field label="Context">
              <textarea
                value={form.context}
                onChange={(event) => update("context", event.target.value)}
                rows={5}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="Additional context for the campaign..."
              />
            </Field>
          </div>
        </div>
      </Card>
      <div className="flex justify-between">
        <Btn variant="secondary" onClick={() => onNavigate("opportunities")}>Back</Btn>
        <Btn onClick={handleSubmit} disabled={saving || !form.name.trim() || !form.channels.length}>
          {saving ? "Saving..." : "Continue to AI Content →"}
        </Btn>
      </div>
    </div>
  );
}
