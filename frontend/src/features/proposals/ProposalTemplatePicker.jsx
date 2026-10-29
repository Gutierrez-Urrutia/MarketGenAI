/**
 * RF-VTA-07: elegir una plantilla de propuesta al generar. Lo usan el modal de propuesta
 * desde oportunidad y el formulario de propuestas de la Biblioteca de contenido.
 *
 * useProposalTemplatePicker guarda la elección (plantilla, servicio, industria y valores de
 * las variables propias) y carga plantillas y catálogo cuando `active` pasa a true.
 * ProposalTemplateFields dibuja los campos como celdas de una grilla de 2 columnas.
 */
import { useEffect, useState } from "react";

import { templatesApi } from "@/api/axios";
import { Field, Input, Select } from "@/components/dashboard/ui";
import { catalogLabel, extractVariables } from "@/features/proposals/templateVariables";
import { useI18n } from "@/hooks/useI18n";

export const STANDARD_TEMPLATE_NAME = "NoonDalton Standard Proposal";

const EMPTY = { templateId: "", serviceType: "", industry: "", templateValues: {} };
const QUIET = { suppressPermissionToast: true };

/** Elección guardada en una propuesta (para regenerarla con la misma plantilla). */
export const pickerStateFromProposal = (proposal = {}) => ({
  templateId: proposal.templateId || "",
  serviceType: proposal.serviceType || "",
  industry: proposal.industry || "",
  templateValues: proposal.templateVariables && typeof proposal.templateVariables === "object" ? proposal.templateVariables : {},
});

export function useProposalTemplatePicker({ active = true } = {}) {
  const { language } = useI18n();
  const [selection, setSelection] = useState(EMPTY);
  const [templates, setTemplates] = useState([]);
  const [catalog, setCatalog] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    // Las plantillas son opcionales: si no cargan, se genera con la estructura estándar.
    Promise.allSettled([templatesApi.catalog(QUIET), templatesApi.list({ type: "proposal", limit: 100 }, QUIET)])
      .then(([catalogResult, listResult]) => {
        if (cancelled) return;
        if (catalogResult.status === "fulfilled") setCatalog(catalogResult.value.data);
        setTemplates(listResult.status === "fulfilled" ? listResult.value.data?.items || [] : []);
        setLoaded(listResult.status === "fulfilled");
      });
    return () => { cancelled = true; };
  }, [active]);

  // Una propuesta puede apuntar a una plantilla que ya se eliminó: se vuelve a "sin plantilla".
  useEffect(() => {
    if (loaded && selection.templateId && !templates.some((template) => template.id === selection.templateId)) {
      setSelection((current) => ({ ...current, templateId: "", templateValues: {} }));
    }
  }, [loaded, templates, selection.templateId]);

  const selectedTemplate = templates.find((template) => template.id === selection.templateId) || null;
  const standardNames = new Set(Object.values(catalog?.standardVariables || {}).flat());
  const customVariables = selectedTemplate
    ? extractVariables(selectedTemplate.content, selectedTemplate.commercialTerms).filter((name) => !standardNames.has(name))
    : [];
  const labelFor = (group, value) => catalogLabel((catalog?.[group] || []).find((option) => option.value === value), language);

  const chooseTemplate = (templateId) => {
    const template = templates.find((item) => item.id === templateId);
    setSelection((current) => ({
      ...current,
      templateId,
      templateValues: {},
      // La plantilla trae su clasificación; el usuario puede cambiarla después.
      ...(template ? { serviceType: template.serviceType || "", industry: template.industry || "" } : {}),
    }));
  };

  return {
    ...selection,
    templates,
    catalog,
    selectedTemplate,
    customVariables,
    templateName: selectedTemplate?.name || STANDARD_TEMPLATE_NAME,
    serviceTypeLabel: labelFor("serviceTypes", selection.serviceType),
    industryLabel: labelFor("industries", selection.industry),
    labelFor,
    chooseTemplate,
    setServiceType: (serviceType) => setSelection((current) => ({ ...current, serviceType })),
    setIndustry: (industry) => setSelection((current) => ({ ...current, industry })),
    setTemplateValue: (name, value) => setSelection((current) => ({ ...current, templateValues: { ...current.templateValues, [name]: value } })),
    reset: (next = EMPTY) => setSelection({ ...EMPTY, ...next }),
    /** Campos para crear/actualizar la propuesta (se guardan en el documento). */
    persistenceFields: () => ({
      serviceType: selection.serviceType || undefined,
      industry: selection.industry || undefined,
      templateId: selectedTemplate ? selectedTemplate.id : undefined,
    }),
    /** Campos para POST /proposals/{id}/generate: el backend aplica la plantilla. */
    generationFields: () => ({
      serviceType: selection.serviceType || undefined,
      industry: selection.industry || undefined,
      templateId: selectedTemplate ? selectedTemplate.id : undefined,
      templateVariables: selectedTemplate ? selection.templateValues : undefined,
    }),
  };
}

export function ProposalTemplateFields({ picker }) {
  const { t, language } = useI18n();
  const label = (key) => t(`proposalTemplatePicker.${key}`);

  return (
    <>
      <Field label={label("template")} hint={label("templateHint")}>
        <Select aria-label={label("template")} value={picker.templateId} onChange={(event) => picker.chooseTemplate(event.target.value)}>
          <option value="">{label("templateNone")}</option>
          {picker.templates.map((template) => (
            <option key={template.id} value={template.id}>
              {[template.name, picker.labelFor("serviceTypes", template.serviceType), picker.labelFor("industries", template.industry)].filter(Boolean).join(" · ")}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={label("serviceType")}>
        <Select aria-label={label("serviceType")} value={picker.serviceType} onChange={(event) => picker.setServiceType(event.target.value)}>
          <option value="">{label("notSpecified")}</option>
          {(picker.catalog?.serviceTypes || []).map((option) => <option key={option.value} value={option.value}>{catalogLabel(option, language)}</option>)}
        </Select>
      </Field>
      <Field label={label("industry")}>
        <Select aria-label={label("industry")} value={picker.industry} onChange={(event) => picker.setIndustry(event.target.value)}>
          <option value="">{label("notSpecified")}</option>
          {(picker.catalog?.industries || []).map((option) => <option key={option.value} value={option.value}>{catalogLabel(option, language)}</option>)}
        </Select>
      </Field>
      {picker.customVariables.length > 0 && (
        <div className="col-span-2">
          <Field label={label("templateVariables")} hint={label("templateVariablesHint")}>
            <div className="grid grid-cols-2 gap-2">
              {picker.customVariables.map((name) => (
                <label key={name} className="text-xs">
                  <span className="block font-mono text-gray-500 mb-1">{`{${name}}`}</span>
                  <Input aria-label={`{${name}}`} value={picker.templateValues[name] || ""} onChange={(event) => picker.setTemplateValue(name, event.target.value)} />
                </label>
              ))}
            </div>
          </Field>
        </div>
      )}
    </>
  );
}
