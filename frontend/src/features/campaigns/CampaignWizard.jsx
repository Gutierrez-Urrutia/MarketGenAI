import { Badge, Btn, Card, Field, Input, Select } from "@/components/dashboard/ui";
import { I, XIcon } from "@/components/dashboard/icons";
import { WIZARD_STEPS, createInitialCampaignWizardData, normalizeCampaignContent } from "@/utils/campaignContent";
import { campaignsApi, opportunitiesApi } from "@/api/axios";
import { fetchOptional } from "@/utils/dashboardData";
import { saveLocalCampaign } from "@/utils/localStore";
import { useEffect, useState } from "react";

export function CampaignWizard({ wizardData, setWizardData, onClose, onCreated, onNavigate }) {
  const [opportunities, setOpportunities] = useState([]);
  const [assets, setAssets] = useState([]);
  const [loadingOpportunities, setLoadingOpportunities] = useState(false);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [savingBrief, setSavingBrief] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [activating, setActivating] = useState(false);
  const [wizardError, setWizardError] = useState("");
  const step = wizardData.currentStep || 1;
  const brief = wizardData.brief || {};
  const generatedPosts = Array.isArray(wizardData.generatedContent) ? wizardData.generatedContent : [];

  useEffect(() => {
    setLoadingOpportunities(true);
    opportunitiesApi.list()
      .then(({ data }) => setOpportunities(Array.isArray(data) ? data : []))
      .catch(() => setOpportunities([]))
      .finally(() => setLoadingOpportunities(false));
  }, []);

  useEffect(() => {
    if (step !== 4 || assets.length) return;
    setLoadingAssets(true);
    fetchOptional("/content-library", [])
      .then((data) => setAssets(Array.isArray(data) ? data : []))
      .finally(() => setLoadingAssets(false));
  }, [assets.length, step]);

  const updateWizard = (patch) => setWizardData((current) => ({ ...current, ...patch }));
  const updateBrief = (field, value) => {
    setWizardData((current) => ({
      ...current,
      brief: { ...(current.brief || {}), [field]: value },
    }));
  };
  const toggleChannel = (channel) => {
    const channels = brief.channels || [];
    const next = channels.includes(channel)
      ? channels.filter((item) => item !== channel)
      : [...channels, channel];
    updateBrief("channels", next);
  };
  const toggleOpportunity = (opportunity) => {
    setWizardData((current) => {
      const selected = current.selectedOpportunities || [];
      const exists = selected.some((item) => item.id === opportunity.id);
      return {
        ...current,
        selectedOpportunities: exists
          ? selected.filter((item) => item.id !== opportunity.id)
          : [...selected, opportunity],
      };
    });
  };
  const toggleAsset = (asset) => {
    setWizardData((current) => {
      const selected = current.selectedAssets || [];
      const exists = selected.some((item) => item.id === asset.id);
      return {
        ...current,
        selectedAssets: exists
          ? selected.filter((item) => item.id !== asset.id)
          : [...selected, asset],
      };
    });
  };

  const opportunityName = (item = {}) => item.company || item.companyName || item.name || item.title || "Untitled company";
  const opportunityContact = (item = {}) => item.contact || item.contactName || item.person || item.email || "No contact";
  const assetTitle = (item = {}) => item.title || item.name || item.assetName || "Untitled asset";
  const assetType = (item = {}) => item.type || item.assetType || item.category || "Asset";

  const saveBrief = async () => {
    if (wizardData.campaignId) return wizardData.campaignId;
    setSavingBrief(true);
    setWizardError("");
    try {
      const payload = {
        name: brief.name?.trim() || "Untitled Campaign",
        audience: (wizardData.selectedOpportunities || []).map(opportunityName).join(", "),
        objective: brief.objective || "lead_generation",
        channels: brief.channels?.length ? brief.channels : ["linkedin"],
        context: brief.context || "",
        status: "draft",
        briefData: {
          startDate: brief.startDate || "",
          budget: brief.budget || "",
          kpis: brief.kpis || "",
          selectedOpportunityIds: (wizardData.selectedOpportunities || []).map((item) => item.id).filter(Boolean),
        },
      };
      const { data } = await campaignsApi.create(payload);
      saveLocalCampaign({ ...data, channel: data.channels?.[0] || payload.channels[0] });
      updateWizard({ campaignId: data.id, brief: { ...brief, name: payload.name } });
      window.dispatchEvent(new CustomEvent("marketgen:campaigns-updated"));
      return data.id;
    } catch {
      setWizardError("Could not save the campaign brief. Please try again.");
      return null;
    } finally {
      setSavingBrief(false);
    }
  };

  const generateContent = async () => {
    if (!wizardData.campaignId || generating) return;
    setGenerating(true);
    setWizardError("");
    try {
      const { data } = await campaignsApi.generate(wizardData.campaignId);
      const posts = normalizeCampaignContent(
        data?.asset?.content || data?.content || data,
        brief.channels?.[0] || "linkedin",
        brief.name || "Campaign content",
      );
      updateWizard({ generatedContent: posts });
      window.dispatchEvent(new CustomEvent("marketgen:content-library-updated"));
    } catch {
      setWizardError("AI content generation failed. You can try again.");
    } finally {
      setGenerating(false);
    }
  };

  useEffect(() => {
    if (step === 3 && wizardData.campaignId && !wizardData.generatedContent && !generating) {
      generateContent();
    }
  }, [step, wizardData.campaignId, wizardData.generatedContent]);

  useEffect(() => {
    if (step !== 6 || !wizardData.campaignId || wizardData.activated || activating) return;
    setActivating(true);
    setWizardError("");
    campaignsApi.update(wizardData.campaignId, { status: "active" })
      .then(() => {
        updateWizard({ activated: true });
        window.dispatchEvent(new CustomEvent("marketgen:campaigns-updated"));
      })
      .catch(() => setWizardError("Could not activate this campaign. Please try again."))
      .finally(() => setActivating(false));
  }, [activating, step, wizardData.activated, wizardData.campaignId]);

  const updatePost = (index, field, value) => {
    setWizardData((current) => ({
      ...current,
      generatedContent: (current.generatedContent || []).map((post, postIndex) => (
        postIndex === index ? { ...post, [field]: value } : post
      )),
    }));
  };

  const goToStep = (nextStep) => updateWizard({ currentStep: Math.min(7, Math.max(1, nextStep)) });
  const isStepComplete = (stepId) => {
    if (stepId === 1) return (wizardData.selectedOpportunities || []).length > 0;
    if (stepId === 2) return Boolean(brief.name?.trim()) && Boolean(brief.objective) && Boolean(brief.channels?.length);
    if (stepId === 3) return generatedPosts.length > 0;
    if (stepId === 4) return true;
    if (stepId === 5) return Boolean(wizardData.approved);
    if (stepId === 6) return Boolean(wizardData.activated);
    return true;
  };
  const handleNext = async () => {
    if (step === 2) {
      const campaignId = await saveBrief();
      if (!campaignId) return;
    }
    if (step === 7) return;
    goToStep(step + 1);
  };
  const resetWizard = () => setWizardData(createInitialCampaignWizardData());

  return (
    <div className="campaign-wizard-overlay">
      <div className="campaign-wizard-header">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Campaign Wizard</h2>
          <p className="text-xs text-slate-500">Build, approve, activate, and track a connected campaign.</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close campaign wizard">
          <XIcon size={18} />
        </button>
      </div>
      <div className="campaign-wizard-steps">
        {WIZARD_STEPS.map((wizardStep) => {
          const completed = wizardStep.id < step || isStepComplete(wizardStep.id);
          return (
            <button
              key={wizardStep.id}
              type="button"
              onClick={() => goToStep(wizardStep.id)}
              className={`campaign-wizard-step ${wizardStep.id === step ? "active" : ""} ${wizardStep.id < step && completed ? "completed" : ""}`}
            >
              <span>{wizardStep.id < step && completed ? "✓" : wizardStep.id}</span>
              <span>{wizardStep.icon}</span>
              <span>{wizardStep.label}</span>
            </button>
          );
        })}
      </div>
      <div className="campaign-wizard-content">
        {wizardError && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{wizardError}</div>}

        {step === 1 && (
          <div className="space-y-5">
            <div>
              <h3 className="text-xl font-semibold text-slate-900">Select Audience</h3>
              <p className="mt-1 text-sm text-slate-500">Choose one or more opportunities to target with this campaign.</p>
            </div>
            {loadingOpportunities ? (
              <div className="rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500">Loading opportunities...</div>
            ) : opportunities.length ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {opportunities.map((opportunity) => {
                  const selected = (wizardData.selectedOpportunities || []).some((item) => item.id === opportunity.id);
                  return (
                    <button
                      key={opportunity.id || opportunityName(opportunity)}
                      type="button"
                      onClick={() => toggleOpportunity(opportunity)}
                      className={`rounded-xl border bg-white p-4 text-left transition ${selected ? "border-indigo-500 ring-2 ring-indigo-100" : "border-slate-200 hover:border-indigo-200"}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-slate-900">{opportunityName(opportunity)}</p>
                          <p className="mt-1 text-xs text-slate-500">{opportunityContact(opportunity)}</p>
                        </div>
                        <Badge label={`${opportunity.score || 0}%`} color="bg-indigo-100 text-indigo-700" />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
                        <span className="rounded-full bg-slate-100 px-2 py-1">{opportunity.stage || opportunity.status || "Detected"}</span>
                        <span className="rounded-full bg-slate-100 px-2 py-1">{opportunity.industry || "General"}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center">
                <p className="text-sm font-medium text-slate-700">No opportunities found yet.</p>
                <Btn className="mt-4" onClick={() => onNavigate("opportunities")}>Add Opportunity</Btn>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="mx-auto max-w-4xl space-y-5">
            <div>
              <h3 className="text-xl font-semibold text-slate-900">Campaign Brief</h3>
              <p className="mt-1 text-sm text-slate-500">Define the campaign contract that the existing Campaigns API will save.</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Campaign name">
                <Input value={brief.name || ""} onChange={(event) => updateBrief("name", event.target.value)} placeholder="Q3 AI marketing outreach" />
              </Field>
              <Field label="Objective">
                <Select value={brief.objective || "lead_generation"} onChange={(event) => updateBrief("objective", event.target.value)}>
                  <option value="lead_generation">Lead generation</option>
                  <option value="awareness">Awareness</option>
                  <option value="follow_up">Follow-up</option>
                  <option value="conversion">Conversion</option>
                </Select>
              </Field>
              <Field label="Start date">
                <Input type="date" value={brief.startDate || ""} onChange={(event) => updateBrief("startDate", event.target.value)} />
              </Field>
              <Field label="Budget">
                <Input type="number" min="0" value={brief.budget || ""} onChange={(event) => updateBrief("budget", event.target.value)} placeholder="Optional" />
              </Field>
            </div>
            <Field label="Channels">
              <div className="flex flex-wrap gap-2">
                {[
                  ["linkedin", "LinkedIn"],
                  ["facebook", "Facebook"],
                  ["twitter_x", "Twitter / X"],
                  ["substack", "Substack"],
                  ["email_outreach", "Email Outreach"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => toggleChannel(value)}
                    className={`rounded-lg border px-3 py-2 text-xs font-medium transition ${brief.channels?.includes(value) ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-600 hover:border-indigo-200"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Expected KPIs">
              <Input value={brief.kpis || ""} onChange={(event) => updateBrief("kpis", event.target.value)} placeholder="Open rate, response rate, meetings booked..." />
            </Field>
            <Field label="Context">
              <textarea value={brief.context || ""} onChange={(event) => updateBrief("context", event.target.value)} rows={5} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500" placeholder="Additional context for the AI..." />
            </Field>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-semibold text-slate-900">AI Content Generation</h3>
                <p className="mt-1 text-sm text-slate-500">Review and edit generated copy per channel.</p>
              </div>
              <Btn variant="secondary" onClick={generateContent} disabled={generating || !wizardData.campaignId}>Regenerate</Btn>
            </div>
            {generating && (
              <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-8 text-center">
                <span className="mx-auto block h-6 w-6 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
                <p className="mt-3 text-sm font-medium text-indigo-700">Generating campaign content with AI...</p>
              </div>
            )}
            <div className="grid gap-4 lg:grid-cols-2">
              {generatedPosts.map((post, index) => (
                <Card key={`${post.channel}-${index}`} className="p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <Badge label={post.channel} color="bg-indigo-100 text-indigo-700" />
                  </div>
                  <Field label="Headline">
                    <Input value={post.headline || ""} onChange={(event) => updatePost(index, "headline", event.target.value)} />
                  </Field>
                  <Field label="Content">
                    <textarea value={post.content || ""} onChange={(event) => updatePost(index, "content", event.target.value)} rows={8} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  </Field>
                </Card>
              ))}
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-5">
            <div>
              <h3 className="text-xl font-semibold text-slate-900">Attach Assets</h3>
              <p className="mt-1 text-sm text-slate-500">Select supporting content from the Content Library.</p>
            </div>
            {loadingAssets ? (
              <div className="rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500">Loading content library...</div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {assets.map((asset) => {
                  const selected = (wizardData.selectedAssets || []).some((item) => item.id === asset.id);
                  return (
                    <button
                      key={asset.id || assetTitle(asset)}
                      type="button"
                      onClick={() => toggleAsset(asset)}
                      className={`rounded-xl border bg-white p-4 text-left transition ${selected ? "border-indigo-500 ring-2 ring-indigo-100" : "border-slate-200 hover:border-indigo-200"}`}
                    >
                      <Badge label={assetType(asset)} color="bg-slate-100 text-slate-700" />
                      <p className="mt-3 font-semibold text-slate-900">{assetTitle(asset)}</p>
                      <p className="mt-1 line-clamp-2 text-xs text-slate-500">{asset.description || asset.content || "Ready to attach"}</p>
                    </button>
                  );
                })}
                {!assets.length && <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 md:col-span-2 xl:col-span-3">No content assets found.</div>}
              </div>
            )}
          </div>
        )}

        {step === 5 && (
          <div className="mx-auto max-w-5xl space-y-4">
            <h3 className="text-xl font-semibold text-slate-900">Review & Approval</h3>
            {[
              ["Audience", 1, `${(wizardData.selectedOpportunities || []).length} opportunities selected`],
              ["Brief", 2, `${brief.name || "Untitled"} · ${brief.objective || "lead_generation"} · ${(brief.channels || []).join(", ")}`],
              ["AI Content", 3, `${generatedPosts.length} generated channel drafts`],
              ["Assets", 4, `${(wizardData.selectedAssets || []).length} assets attached`],
            ].map(([title, targetStep, detail]) => (
              <Card key={title} className="p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="font-semibold text-slate-900">{title}</p>
                    <p className="mt-1 text-sm text-slate-500">{detail}</p>
                  </div>
                  <Btn variant="secondary" small onClick={() => goToStep(targetStep)}>Edit</Btn>
                </div>
              </Card>
            ))}
            <Card className="p-4">
              <label className="flex items-start gap-3 text-sm text-slate-700">
                <input type="checkbox" className="mt-1 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" checked={Boolean(wizardData.approved)} onChange={(event) => updateWizard({ approved: event.target.checked })} />
                <span>I confirm this campaign is ready to activate</span>
              </label>
            </Card>
          </div>
        )}

        {step === 6 && (
          <div className="flex min-h-[420px] items-center justify-center">
            <div className="text-center">
              <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-green-100 text-4xl text-green-600">{activating ? "..." : "✓"}</div>
              <h3 className="mt-5 text-2xl font-bold text-slate-900">{wizardData.activated ? "Campaign activated successfully!" : "Activating campaign..."}</h3>
              <p className="mt-2 text-sm text-slate-500">{brief.name || "Campaign"} · {(brief.channels || []).join(", ")} · {(wizardData.selectedOpportunities || []).length} audience targets</p>
              <Btn className="mt-6" onClick={() => onNavigate("outreach")}>View in Outreach</Btn>
            </div>
          </div>
        )}

        {step === 7 && (
          <div className="mx-auto max-w-5xl space-y-5">
            <div>
              <h3 className="text-xl font-semibold text-slate-900">Results Preview</h3>
              <p className="mt-1 text-sm text-slate-500">Live metrics will begin tracking after launch.</p>
            </div>
            <Card className="p-5">
              <p className="text-sm font-semibold text-slate-900">Defined KPIs</p>
              <p className="mt-2 text-sm text-slate-600">{brief.kpis || "No KPIs defined."}</p>
            </Card>
            <div className="grid gap-3 md:grid-cols-3">
              {["Open Rate", "Response Rate", "Conversions"].map((metric) => (
                <Card key={metric} className="p-4">
                  <p className="text-xs text-slate-500">{metric}</p>
                  <p className="mt-2 text-2xl font-bold text-slate-900">--</p>
                  <Badge label="Tracking..." color="bg-amber-100 text-amber-700" />
                </Card>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Btn onClick={() => onNavigate("reports")}>Go to Reports</Btn>
              <Btn variant="secondary" onClick={resetWizard}>Create Another Campaign</Btn>
            </div>
          </div>
        )}
      </div>
      <div className="campaign-wizard-footer">
        <Btn variant="secondary" onClick={() => goToStep(step - 1)} disabled={step === 1 || savingBrief || generating || activating}>Back</Btn>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">Step {step} of {WIZARD_STEPS.length}</span>
          {step < 7 ? (
            <Btn onClick={handleNext} disabled={!isStepComplete(step) || savingBrief || generating || activating}>
              {savingBrief ? "Saving..." : step === 6 ? "View Results" : "Next"}
            </Btn>
          ) : (
            <Btn onClick={() => {
              onCreated({ type: "success", message: "Campaign wizard complete" });
              onClose();
            }}>Done</Btn>
          )}
        </div>
      </div>
    </div>
  );
}
