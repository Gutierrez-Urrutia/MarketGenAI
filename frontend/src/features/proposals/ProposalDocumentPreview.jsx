import { BRAND } from "@/config/brand";
import { generatedSectionsToHtml } from "@/utils/proposalSections";
import { getProposalCopy } from "@/features/proposals/proposalCopy";
import { formatUsd, normalizeProposalDocument } from "@/features/proposals/proposalDocument";
import { additionalSectionTitle, proposalAdjustmentRows, proposalClientDetails } from "@/features/proposals/proposalHtml";

function ProposalParagraphs({ text, fallback }) {
  const paragraphs = String(text || fallback || "")
    .split(/\n{2,}|\n(?=[A-Z])/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return paragraphs.map((paragraph, index) => <p key={`${index}-${paragraph}`}>{paragraph}</p>);
}

function splitProposalCardText(value) {
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
}

function ProposalDetailCards({ items }) {
  return (
    <div className="proposal-card-list">
      {items.map((item) => {
        const card = splitProposalCardText(item);
        return (
          <div className="proposal-detail-card" key={item}>
            <strong>{card.title}</strong>
            {card.body && <p>{card.body}</p>}
          </div>
        );
      })}
    </div>
  );
}

export function ProposalDocumentPreview({ proposal, className = "", exportRef = null }) {
  const doc = normalizeProposalDocument(proposal);
  const copy = getProposalCopy(doc.language);
  const problems = Array.isArray(doc.problemsIdentified) ? doc.problemsIdentified.filter(Boolean) : [];
  const technologies = Array.isArray(doc.technologiesUsed) ? doc.technologiesUsed.filter(Boolean) : [];
  const nextSteps = Array.isArray(doc.nextSteps) ? doc.nextSteps.filter(Boolean) : [];
  const clientDetails = proposalClientDetails(doc, copy);
  const adjustmentRows = proposalAdjustmentRows(doc, copy);
  const notes = doc.sectionNotes || {};

  return (
    <article ref={exportRef} className={`proposal-preview-document ${className}`} data-sections={doc.sections ? "generic" : undefined}>
      <div className="proposal-paper">
        <header className="proposal-cover">
          <div className="proposal-logo-band">
            <img
              className="proposal-logo"
              src={BRAND.logoPath}
              alt={BRAND.name}
              onError={(event) => {
                event.currentTarget.style.display = "none";
                event.currentTarget.parentElement?.classList.add("logo-missing");
              }}
            />
            <span className="proposal-logo-name">{BRAND.name}</span>
          </div>
          <p className="proposal-eyebrow">{copy.preparedBy}</p>
          <h1>{doc.title}</h1>
          <p className="proposal-subtitle">{copy.proposalEyebrow} · {copy.preparedFor} {doc.client}</p>
          {clientDetails && <p className="proposal-client-details">{clientDetails}</p>}
          {doc.introduction && (
            <div className="proposal-intro"><ProposalParagraphs text={doc.introduction} /></div>
          )}
          <div className="proposal-meta">
            {doc.industry && <span>{doc.industry}</span>}
            {doc.contact && <span>{doc.contact}</span>}
            {doc.serviceLine && <span>{doc.serviceLine}</span>}
          </div>
          <div className="proposal-cover-info">
            <span><strong>{copy.total}</strong>{doc.formattedTotal}</span>
            <span><strong>{copy.issuedOn}</strong>{doc.issuedOn}</span>
            <span><strong>{copy.validUntil}</strong>{doc.validUntil}</span>
            <span><strong>{copy.preparedByPerson}</strong>{doc.issuedBy || "—"}</span>
          </div>
        </header>

        {doc.sections && <div dangerouslySetInnerHTML={{ __html: generatedSectionsToHtml(doc, copy) }} />}

        {!doc.sections && (<>
        <section>
          <h2>{copy.executiveSummary}</h2>
          <ProposalParagraphs text={doc.executiveSummary} fallback={copy.noExecutiveSummary} />
        </section>

        <section>
          <h2>{copy.problemsIdentified}</h2>
          <ProposalParagraphs text={notes.problemsIdentified} />
          <ProposalDetailCards items={problems.length ? problems : [copy.noProblems]} />
        </section>

        <section>
          <h2>{copy.proposedSolution}</h2>
          <ProposalParagraphs text={doc.proposedSolution} fallback={copy.noSolution} />
        </section>

        <section>
          <h2>{copy.technologiesUsed}</h2>
          <ProposalParagraphs text={notes.technologiesUsed} />
          <ProposalDetailCards items={technologies.length ? technologies : copy.defaultTechnologies} />
        </section>

        <section>
          <h2>{copy.implementationCosts}</h2>
          <div className="proposal-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{copy.serviceUnit}</th>
                  <th>{copy.description}</th>
                  <th>{copy.qty}</th>
                  <th>{copy.unitPrice}</th>
                  <th>{copy.subtotal}</th>
                </tr>
              </thead>
              <tbody>
                {doc.lineItems.length ? doc.lineItems.map((item, index) => (
                  <tr key={`${item.service}-${index}`}>
                    <td>{item.service}</td>
                    <td>{item.description}</td>
                    <td>{item.quantity}</td>
                    <td>{formatUsd(item.unitPrice)}</td>
                    <td>{formatUsd(item.subtotal)}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={5}>{copy.noPricing}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {adjustmentRows.length > 0 && (
            <div className="proposal-adjustments">
              {adjustmentRows.map(([label, value]) => (
                <div key={label}><span>{label}</span><strong>{value}</strong></div>
              ))}
            </div>
          )}
          <ProposalParagraphs text={notes.implementationCosts} />
          <p className="proposal-validity-note">{copy.validUntil}: {doc.validUntil}</p>
        </section>

        <div className="proposal-total-card">
          <span>{copy.totalImplementationCost}</span>
          <strong>{doc.formattedTotal}</strong>
        </div>

        <section className="proposal-highlight-section">
          <h2>{copy.expectedROI}</h2>
          <ProposalParagraphs text={doc.expectedROI} fallback={copy.noROI} />
        </section>

        <section>
          <h2>{copy.nextSteps}</h2>
          <ol className="proposal-next-steps">
            {(nextSteps.length ? nextSteps : copy.noNextSteps).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <ProposalParagraphs text={notes.nextSteps} />
        </section>

        {(doc.additionalSections || []).map((item, index) => (
          <section className="proposal-additional-section" key={`${index}-${item.heading}`}>
            <h2>{additionalSectionTitle(item.heading, copy)}</h2>
            <ProposalParagraphs text={item.body} />
          </section>
        ))}

        <section className="proposal-acceptance">
          <h2>{copy.acceptance}</h2>
          <p>{copy.acceptanceIntro}</p>
          <div className="proposal-signature-grid">
            <div className="proposal-signature-field"><span>{copy.signatureName}</span><div className="proposal-signature-line" /></div>
            <div className="proposal-signature-field"><span>{copy.signatureRole}</span><div className="proposal-signature-line" /></div>
            <div className="proposal-signature-field"><span>{copy.signatureDate}</span><div className="proposal-signature-line" /></div>
            <div className="proposal-signature-field"><span>{copy.signatureLine}</span><div className="proposal-signature-line" /></div>
          </div>
        </section>
        </>)}
      </div>
    </article>
  );
}
