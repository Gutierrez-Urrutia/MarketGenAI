import { BRAND } from "@/config/brand";
import { generatedSectionsToHtml } from "@/utils/proposalSections";
import { getProposalCopy } from "@/features/proposals/proposalCopy";
import { formatUsd, normalizeProposalDocument } from "@/features/proposals/proposalDocument";
import { escapeHtml } from "@/utils/htmlText";

export const PROPOSAL_PDF_PAGE_BREAK_CSS = `
h1, h2, h3 {
  page-break-after: avoid;
  break-after: avoid;
}

h2 + p, h2 + ul, h2 + div {
  page-break-before: avoid;
  break-before: avoid;
}

p {
  orphans: 3;
  widows: 3;
}

.proposal-detail-card {
  page-break-inside: avoid;
  break-inside: avoid;
}
`.trim();

// Shared by the on-screen preview, the PDF (HTML) and the DOCX so all three show the same data.
export function proposalClientDetails(doc, copy) {
  return [
    doc.clientCompany ? `${copy.company}: ${doc.clientCompany}` : "",
    doc.clientEmail ? `${copy.email}: ${doc.clientEmail}` : "",
  ].filter(Boolean).join(" · ");
}

export function proposalAdjustmentRows(doc, copy) {
  const adjustments = doc.pricingAdjustments;
  if (!adjustments?.show) return [];
  return [
    [copy.subtotal, formatUsd(adjustments.subtotal)],
    adjustments.discountAmount > 0 ? [copy.discount, `- ${formatUsd(adjustments.discountAmount)}`] : null,
    adjustments.taxAmount > 0 ? [copy.taxes, formatUsd(adjustments.taxAmount)] : null,
  ].filter(Boolean);
}

export const additionalSectionTitle = (heading, copy) => (heading ? `${copy.additionalSection}: ${heading}` : copy.additionalSection);

export function proposalDocumentToHtml(proposal = {}) {
  const doc = normalizeProposalDocument(proposal);
  const copy = getProposalCopy(doc.language);
  const splitCardText = (value) => {
    const text = String(value || "").trim();
    const parts = text.split(/:\s+| - | – | — /);
    if (parts.length > 1 && parts[0].length <= 90) {
      return {
        title: parts[0].trim(),
        body: text.slice(parts[0].length).replace(/^(:|\s+-\s+|\s+–\s+|\s+—\s+)/, "").trim(),
      };
    }
    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
    return {
      title: sentences[0]?.trim() || text,
      body: sentences.slice(1).join(" ").trim(),
    };
  };
  const paragraphsToHtml = (value) => String(value || "")
    .split(/\n{2,}|\n(?=[A-Z])/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("");
  const cardsToHtml = (items) => items.map((item) => {
    const card = splitCardText(item);
    return `<div class="proposal-detail-card"><strong>${escapeHtml(card.title)}</strong>${card.body ? `<p>${escapeHtml(card.body)}</p>` : ""}</div>`;
  }).join("");
  const rows = doc.lineItems.map((item) => `
    <tr>
      <td>${escapeHtml(item.service)}</td>
      <td>${escapeHtml(item.description)}</td>
      <td>${escapeHtml(item.quantity)}</td>
      <td>${escapeHtml(formatUsd(item.unitPrice))}</td>
      <td>${escapeHtml(formatUsd(item.subtotal))}</td>
    </tr>
  `).join("");
  const clientDetails = proposalClientDetails(doc, copy);
  const adjustmentsHtml = proposalAdjustmentRows(doc, copy)
    .map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");
  const notes = doc.sectionNotes || {};
  const additionalHtml = (doc.additionalSections || [])
    .map((item) => `<section class="proposal-additional-section"><h2>${escapeHtml(additionalSectionTitle(item.heading, copy))}</h2>${paragraphsToHtml(item.body)}</section>`)
    .join("");
  return `
    <style data-proposal-pdf-page-breaks>${PROPOSAL_PDF_PAGE_BREAK_CSS}</style>
    <article class="proposal-preview-document"${doc.sections ? ' data-sections="generic"' : ""}>
      <div class="proposal-paper">
        <header class="proposal-cover">
          <div class="proposal-logo-band">
            <img class="proposal-logo" src="${escapeHtml(BRAND.logoPath)}" alt="${escapeHtml(BRAND.name)}" onerror="this.parentNode.classList.add('logo-missing');this.remove()" />
            <span class="proposal-logo-name">${escapeHtml(BRAND.name)}</span>
          </div>
          <p class="proposal-eyebrow">${escapeHtml(copy.preparedBy)}</p>
          <h1>${escapeHtml(doc.title)}</h1>
          <p class="proposal-subtitle">${escapeHtml(copy.proposalEyebrow)} · ${escapeHtml(copy.preparedFor)} ${escapeHtml(doc.client)}</p>
          ${clientDetails ? `<p class="proposal-client-details">${escapeHtml(clientDetails)}</p>` : ""}
          ${doc.introduction ? `<div class="proposal-intro">${paragraphsToHtml(doc.introduction)}</div>` : ""}
          <div class="proposal-meta">
            ${doc.industry ? `<span>${escapeHtml(doc.industry)}</span>` : ""}
            ${doc.contact ? `<span>${escapeHtml(doc.contact)}</span>` : ""}
            ${doc.serviceLine ? `<span>${escapeHtml(doc.serviceLine)}</span>` : ""}
          </div>
          <div class="proposal-cover-info">
            <span><strong>${escapeHtml(copy.total)}</strong>${escapeHtml(doc.formattedTotal)}</span>
            <span><strong>${escapeHtml(copy.issuedOn)}</strong>${escapeHtml(doc.issuedOn)}</span>
            <span><strong>${escapeHtml(copy.validUntil)}</strong>${escapeHtml(doc.validUntil)}</span>
            <span><strong>${escapeHtml(copy.preparedByPerson)}</strong>${escapeHtml(doc.issuedBy || "—")}</span>
          </div>
        </header>
        ${doc.sections ? generatedSectionsToHtml(doc, copy) : `
        <section><h2>${escapeHtml(copy.executiveSummary)}</h2>${paragraphsToHtml(doc.executiveSummary || copy.noExecutiveSummary)}</section>
        <section><h2>${escapeHtml(copy.problemsIdentified)}</h2>${paragraphsToHtml(notes.problemsIdentified)}<div class="proposal-card-list">${cardsToHtml(doc.problemsIdentified.length ? doc.problemsIdentified : [copy.noProblems])}</div></section>
        <section><h2>${escapeHtml(copy.proposedSolution)}</h2>${paragraphsToHtml(doc.proposedSolution || copy.noSolution)}</section>
        <section><h2>${escapeHtml(copy.technologiesUsed)}</h2>${paragraphsToHtml(notes.technologiesUsed)}<div class="proposal-card-list">${cardsToHtml(doc.technologiesUsed.length ? doc.technologiesUsed : copy.defaultTechnologies)}</div></section>
        <section><h2>${escapeHtml(copy.implementationCosts)}</h2><table><thead><tr><th>${escapeHtml(copy.serviceUnit)}</th><th>${escapeHtml(copy.description)}</th><th>${escapeHtml(copy.qty)}</th><th>${escapeHtml(copy.unitPrice)}</th><th>${escapeHtml(copy.subtotal)}</th></tr></thead><tbody>${rows || `<tr><td colspan="5">${escapeHtml(copy.noPricing)}</td></tr>`}</tbody></table>${adjustmentsHtml ? `<div class="proposal-adjustments">${adjustmentsHtml}</div>` : ""}${paragraphsToHtml(notes.implementationCosts)}<p class="proposal-validity-note">${escapeHtml(copy.validUntil)}: ${escapeHtml(doc.validUntil)}</p></section>
        <div class="proposal-total-card"><span>${escapeHtml(copy.totalImplementationCost)}</span><strong>${escapeHtml(doc.formattedTotal)}</strong></div>
        <section><h2>${escapeHtml(copy.expectedROI)}</h2>${paragraphsToHtml(doc.expectedROI || copy.noROI)}</section>
        <section><h2>${escapeHtml(copy.nextSteps)}</h2><ol>${(doc.nextSteps.length ? doc.nextSteps : copy.noNextSteps).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>${paragraphsToHtml(notes.nextSteps)}</section>
        ${additionalHtml}
        <section class="proposal-acceptance">
          <h2>${escapeHtml(copy.acceptance)}</h2>
          <p>${escapeHtml(copy.acceptanceIntro)}</p>
          <div class="proposal-signature-grid">
            <div class="proposal-signature-field"><span>${escapeHtml(copy.signatureName)}</span><div class="proposal-signature-line"></div></div>
            <div class="proposal-signature-field"><span>${escapeHtml(copy.signatureRole)}</span><div class="proposal-signature-line"></div></div>
            <div class="proposal-signature-field"><span>${escapeHtml(copy.signatureDate)}</span><div class="proposal-signature-line"></div></div>
            <div class="proposal-signature-field"><span>${escapeHtml(copy.signatureLine)}</span><div class="proposal-signature-line"></div></div>
          </div>
        </section>`}
      </div>
    </article>
  `;
}
