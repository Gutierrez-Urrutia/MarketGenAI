import { describe, expect, it } from "vitest";

import { generatedSectionsToHtml, parseGeneratedSections } from "../utils/proposalSections";

const PRICING =
  '<table class="pricing-table"><thead><tr><th>Servicio</th></tr></thead><tbody><tr><td>Gestores</td></tr></tbody></table>';

const RAW = `<h1>Propuesta</h1><p>Sub</p>
<h2>Resumen Ejecutivo</h2><p>Texto <strong>clave</strong>.</p>
<h2>Alcance y Objetivos</h2><ul><li>Cobranza temprana</li></ul>
<h2>Precios y Condiciones Comerciales</h2>${PRICING}<ul><li>Facturación mensual</li></ul>`;

const copy = {
  totalProposal: "Total de la propuesta",
  acceptance: "Aceptación",
  acceptanceIntro: "Firme y devuelva.",
  signatureName: "Nombre",
  signatureRole: "Cargo",
  signatureDate: "Fecha",
  signatureLine: "Firma",
};

describe("parseGeneratedSections", () => {
  it("splits raw LLM html into sections and keeps the pricing table class", () => {
    const parsed = parseGeneratedSections(RAW);
    expect(parsed.title).toBe("Propuesta");
    expect(parsed.sections.map((s) => s.title)).toEqual([
      "Resumen Ejecutivo",
      "Alcance y Objetivos",
      "Precios y Condiciones Comerciales",
    ]);
    expect(parsed.sections[0].html).toContain("<strong>clave</strong>");
    expect(parsed.sections[2].html).toContain('class="pricing-table"');
  });

  it("returns null for legacy content with fewer than 3 sections or no headings", () => {
    expect(parseGeneratedSections("<h2>Uno</h2><p>x</p><h2>Dos</h2><p>y</p>")).toBeNull();
    expect(parseGeneratedSections("solo texto")).toBeNull();
  });

  it("strips scripts, event handlers, styles and unknown tags", () => {
    const parsed = parseGeneratedSections(
      '<h2>A</h2><p onclick="x()" style="color:red">hola<script>alert(1)</script></p><h2>B</h2><div><a href="javascript:x">link</a></div><h2>C</h2><p>c</p>',
    );
    const html = parsed.sections.map((s) => s.html).join("");
    expect(html).not.toMatch(/script|onclick|style=|href|<div|<a /i);
    expect(html).toContain("hola");
    expect(html).toContain("link");
  });
});

describe("generatedSectionsToHtml", () => {
  const doc = () => ({ ...parseGeneratedSections(RAW), formattedTotal: "$18,750 USD" });

  it("adds the total card right after the pricing table and an acceptance block", () => {
    const html = generatedSectionsToHtml(doc(), copy);
    expect(html.indexOf("</table>")).toBeLessThan(html.indexOf("proposal-total-card"));
    expect(html).toContain("$18,750 USD");
    expect(html.match(/proposal-total-card/g)).toHaveLength(1);
    expect(html).toContain("proposal-acceptance");
  });

  it("survives a save/reload round trip without duplicating the total card or acceptance", () => {
    const wrapped = `<article class="proposal-preview-document" data-sections="generic"><div class="proposal-paper">
      <header class="proposal-cover"><h1>Mi Propuesta</h1></header>${generatedSectionsToHtml(doc(), copy)}</div></article>`;
    const reparsed = parseGeneratedSections(wrapped);
    expect(reparsed.title).toBe("Mi Propuesta");
    expect(reparsed.sections).toHaveLength(3);
    const again = generatedSectionsToHtml({ ...reparsed, formattedTotal: "$18,750 USD" }, copy);
    expect(again.match(/proposal-total-card/g)).toHaveLength(1);
    expect(again.match(/proposal-acceptance/g)).toHaveLength(1);
  });

  it("does not parse legacy presentation html (no data-sections marker)", () => {
    const legacy =
      '<article class="proposal-preview-document"><div class="proposal-paper"><section><h2>A</h2></section><section><h2>B</h2></section><section><h2>C</h2></section></div></article>';
    expect(parseGeneratedSections(legacy)).toBeNull();
  });
});
