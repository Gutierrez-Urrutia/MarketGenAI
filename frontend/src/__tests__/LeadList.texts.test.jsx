import { describe, it, expect } from "vitest";

import { translations } from "@/i18n/translations";

// RF14-D-009: the Leads screen talks about "the scan", not "Agente 1".
describe("LeadList texts", () => {
  it.each([
    ["es", "Escanear vacantes", "Vacantes encontradas en el escaneo, evaluadas por relevancia para NoonDalton."],
    ["en", "Scan jobs", "Job postings found in the scan, scored for relevance to NoonDalton."],
    ["pt", "Escanear vagas", "Vagas encontradas na varredura, avaliadas por relevância para a NoonDalton."],
  ])("button and subtitle in %s", (lang, runScan, subtitle) => {
    const leads = translations[lang].leads;
    expect(leads.runScan).toBe(runScan);
    expect(leads.subtitle).toBe(subtitle);
    expect(`${leads.runScan} ${leads.subtitle}`).not.toMatch(/Agente 1|Agent 1/);
  });
});
