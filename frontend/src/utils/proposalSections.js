/* ── Propuestas generadas: secciones libres (estructura BPO) ───────────────────
 * El backend devuelve HTML con <h2> por sección (Resumen Ejecutivo, Alcance, SLAs, ...). Se renderiza
 * tal cual en lugar de forzarlo a los campos fijos de la plantilla antigua. */
const GENERATED_ALLOWED_TAGS = new Set(["P", "UL", "OL", "LI", "STRONG", "EM", "B", "I", "BR", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "H3", "SPAN"]);
const GENERATED_DROP_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "FORM", "INPUT", "BUTTON"]);

function sanitizeGeneratedNode(node) {
  Array.from(node.childNodes).forEach((child) => {
    if (child.nodeType !== 1) return;
    if (GENERATED_DROP_TAGS.has(child.tagName)) { child.remove(); return; }
    sanitizeGeneratedNode(child);
    if (!GENERATED_ALLOWED_TAGS.has(child.tagName)) {
      child.replaceWith(...Array.from(child.childNodes));
      return;
    }
    const keepClass = child.tagName === "TABLE" && child.classList.contains("pricing-table");
    Array.from(child.attributes).forEach((attr) => child.removeAttribute(attr.name));
    if (keepClass) child.setAttribute("class", "pricing-table");
  });
}

// Encabezados de la estructura BPO que genera el backend (SECTION_HEADINGS en proposal_tasks.py).
// Solo el contenido que los usa se renderiza como «secciones libres»; el resto (formato antiguo,
// títulos traducidos, secciones adicionales) sigue por splitProposalSections de Dashboard.jsx.
const normalizeHeading = (text) => String(text || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .trim()
  .toLowerCase();

const BPO_HEADINGS = new Set([
  "resumen ejecutivo", "quienes somos", "entendimiento de la necesidad", "alcance y objetivos",
  "modelo operativo y niveles de servicio", "equipo y organizacion del trabajo", "plan de implementacion",
  "precios y condiciones comerciales", "condiciones generales",
  "executive summary", "about noondalton", "understanding of the need", "scope and objectives",
  "operating model and service levels", "team and work organization", "implementation plan",
  "pricing and commercial terms", "general terms",
  "resumo executivo", "quem somos", "entendimento da necessidade", "escopo e objetivos",
  "modelo operacional e niveis de servico", "equipe e organizacao do trabalho", "plano de implementacao",
  "precos e condicoes comerciais", "condicoes gerais",
]);
const MIN_BPO_HEADINGS = 3;

export function parseGeneratedSections(html = "") {
  if (!html || typeof DOMParser === "undefined" || !/<h2[\s>]/i.test(html)) return null;
  const root = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
  const sections = [];
  let title = "";
  const pushSection = (heading, container) => {
    container.querySelectorAll(".proposal-total-card").forEach((node) => node.remove());
    sanitizeGeneratedNode(container);
    sections.push({ title: heading, html: container.innerHTML.trim() });
  };

  const wrapped = root.querySelector('article[data-sections="generic"]');
  if (wrapped) {
    title = wrapped.querySelector(".proposal-cover h1")?.textContent?.trim() || "";
    wrapped.querySelectorAll(".proposal-paper > section:not(.proposal-acceptance)").forEach((section) => {
      const heading = section.querySelector("h2");
      if (!heading) return;
      const container = section.cloneNode(true);
      container.querySelector("h2")?.remove();
      pushSection(heading.textContent.trim(), container);
    });
  } else if (!root.querySelector(".proposal-paper")) {
    let container = null;
    let heading = "";
    const flush = () => { if (container) pushSection(heading, container); };
    Array.from(root.children).forEach((el) => {
      if (el.tagName === "H1") { title = title || el.textContent.trim(); return; }
      if (el.tagName === "H2") {
        flush();
        heading = el.textContent.trim();
        container = document.createElement("div");
        return;
      }
      if (container && !GENERATED_DROP_TAGS.has(el.tagName)) container.appendChild(el.cloneNode(true));
    });
    flush();
  }
  if (wrapped) return sections.length >= 3 ? { title, sections } : null;
  const bpoCount = sections.filter((section) => BPO_HEADINGS.has(normalizeHeading(section.title))).length;
  return sections.length >= 3 && bpoCount >= MIN_BPO_HEADINGS ? { title, sections } : null;
}

export function generatedSectionsToHtml(doc, copy) {
  const escapeText = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const totalCard = `<div class="proposal-total-card"><span>${escapeText(copy.totalProposal)}</span><strong>${escapeText(doc.formattedTotal)}</strong></div>`;
  const body = doc.sections.map((section) => {
    const html = section.html.replace(/(<table[^>]*class="pricing-table"[^>]*>[\s\S]*?<\/table>)/i, (table) => table + totalCard);
    return `<section><h2>${escapeText(section.title)}</h2>${html}</section>`;
  }).join("");
  const acceptance = `
    <section class="proposal-acceptance">
      <h2>${escapeText(copy.acceptance)}</h2>
      <p>${escapeText(copy.acceptanceIntro)}</p>
      <div class="proposal-signature-grid">
        ${[copy.signatureName, copy.signatureRole, copy.signatureDate, copy.signatureLine].map((label) => `<div class="proposal-signature-field"><span>${escapeText(label)}</span><div class="proposal-signature-line"></div></div>`).join("")}
      </div>
    </section>`;
  return body + acceptance;
}
