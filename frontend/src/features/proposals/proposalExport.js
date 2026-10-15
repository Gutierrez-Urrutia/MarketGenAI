import { AlignmentType, BorderStyle, Document, Footer, HeadingLevel, ImageRun, Packer, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import { BRAND, docxColor, loadBrandLogo, rgbColor } from "@/config/brand";
import html2pdf from "html2pdf.js";
import { proposalsApi } from "@/api/proposalsApi";
import { PROPOSAL_COPY, getProposalCopy } from "@/features/proposals/proposalCopy";
import { formatUsd, normalizeLineItem, normalizeMoney, normalizeProposalDocument } from "@/features/proposals/proposalDocument";
import { PROPOSAL_PDF_PAGE_BREAK_CSS, additionalSectionTitle, proposalAdjustmentRows, proposalClientDetails, proposalDocumentToHtml } from "@/features/proposals/proposalHtml";

export const sanitizeDownloadName = (title = "proposal") => String(title || "proposal")
  .trim()
  .replace(/[^a-z0-9]+/gi, "_")
  .replace(/^_+|_+$/g, "")
  || "proposal";

export function downloadBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.URL.revokeObjectURL(url);
}

// html2pdf page geometry for the proposal PDF (A4; margins top, left, bottom,
// right in mm), in CSS px the same way html2pdf computes it.
const PROPOSAL_PDF_MARGIN_MM = [14, 8, 18, 8];

const mmToCssPx = (mm) => Math.floor((mm / 25.4) * 96);

const PROPOSAL_PDF_PAGE_PX = {
  width: mmToCssPx(210 - PROPOSAL_PDF_MARGIN_MM[1] - PROPOSAL_PDF_MARGIN_MM[3]),
  height: mmToCssPx(297 - PROPOSAL_PDF_MARGIN_MM[0] - PROPOSAL_PDF_MARGIN_MM[2]),
};

function createProposalExportClone(sourceElement) {
  if (!sourceElement) return null;
  const clone = sourceElement.cloneNode(true);
  if (!clone.querySelector("style[data-proposal-pdf-page-breaks]")) {
    const style = document.createElement("style");
    style.dataset.proposalPdfPageBreaks = "true";
    style.textContent = PROPOSAL_PDF_PAGE_BREAK_CSS;
    clone.prepend(style);
  }
  clone.classList.remove("max-h-[55vh]", "max-h-[65vh]", "overflow-y-auto", "shadow-sm");
  clone.classList.add("proposal-export-pdf");
  // html2pdf re-clones this node into a container as wide as the printable
  // A4 area (~733px). A fixed 794px width overflowed it and clipped the right edge.
  clone.style.width = "100%";
  clone.style.maxHeight = "none";
  clone.style.overflow = "visible";
  clone.style.boxShadow = "none";
  clone.style.background = "#ffffff";

  const wrapper = document.createElement("div");
  wrapper.style.position = "fixed";
  wrapper.style.left = "-10000px";
  wrapper.style.top = "0";
  // Same width as html2pdf's page container, so measurements match the PDF layout.
  wrapper.style.width = `${PROPOSAL_PDF_PAGE_PX.width}px`;
  wrapper.style.background = "#ffffff";
  wrapper.appendChild(clone);
  document.body.appendChild(wrapper);
  return { wrapper, clone };
}

// Removes the blank strip at the bottom of the captured page image. html2pdf
// adds a whole new PDF page for any leftover pixels, so a few px of trailing
// padding produced an almost empty last page.
function trimCanvasBottom(canvas, paddingPx = 24) {
  const context = canvas?.getContext?.("2d");
  if (!context || !canvas.width || !canvas.height) return;
  const { width, height } = canvas;
  const isBlank = (data, index) => data[index] > 245 && data[index + 1] > 245 && data[index + 2] > 245;
  const chunkRows = 64;
  let lastContentRow = -1;
  for (let bottom = height; bottom > 0 && lastContentRow < 0; bottom -= chunkRows) {
    const top = Math.max(0, bottom - chunkRows);
    const { data } = context.getImageData(0, top, width, bottom - top);
    for (let row = bottom - top - 1; row >= 0 && lastContentRow < 0; row -= 1) {
      const rowStart = row * width * 4;
      for (let col = 0; col < width; col += 1) {
        if (!isBlank(data, rowStart + col * 4)) {
          lastContentRow = top + row;
          break;
        }
      }
    }
  }
  if (lastContentRow < 0) return;
  const newHeight = Math.min(height, lastContentRow + 1 + paddingPx);
  if (newHeight >= height) return;
  const copy = document.createElement("canvas");
  copy.width = width;
  copy.height = newHeight;
  copy.getContext("2d").drawImage(canvas, 0, 0);
  canvas.height = newHeight;
  canvas.getContext("2d").drawImage(copy, 0, 0);
}

function createTemporaryProposalPreview(proposal) {
  const wrapper = document.createElement("div");
  wrapper.style.position = "fixed";
  wrapper.style.left = "-10000px";
  wrapper.style.top = "0";
  wrapper.style.width = "794px";
  wrapper.style.background = "#ffffff";
  wrapper.style.padding = "24px";
  wrapper.innerHTML = proposalDocumentToHtml(proposal);
  document.body.appendChild(wrapper);
  return { wrapper, element: wrapper.querySelector(".proposal-preview-document") };
}

// Inlines the logo as a data URL so html2canvas always captures it; if the
// logo can't be loaded, drops the <img> so the PDF is still generated.
// html2canvas draws native list markers small and raised (like superscripts):
// replace them with real text in the export clone.
function materializeListMarkers(root) {
  root.querySelectorAll("ol, ul").forEach((list) => {
    const ordered = list.tagName === "OL";
    let number = ordered ? Number(list.getAttribute("start")) || 1 : 1;
    list.classList.add("proposal-export-list");
    [...list.children].filter((child) => child.tagName === "LI").forEach((item) => {
      if (item.firstElementChild?.classList.contains("proposal-list-marker")) return;
      const marker = document.createElement("span");
      marker.className = "proposal-list-marker";
      marker.textContent = ordered ? `${number}.` : "•";
      number += 1;
      item.prepend(marker);
    });
  });
}

// html2pdf ignores "break-after: avoid", so a section title could end a page
// alone. Group each <h2> with the first block after it in a wrapper that
// html2pdf keeps on one page (it is in the pagebreak "avoid" list). For a long
// list only its first item goes in the group, so the rest can still flow.
function keepHeadingsWithNextBlock(root, pageHeightPx = PROPOSAL_PDF_PAGE_PX.height) {
  root.querySelectorAll("h2").forEach((heading) => {
    if (heading.parentElement?.classList.contains("proposal-keep-with-next")) return;
    const next = heading.nextElementSibling;
    if (!next) return;
    const group = document.createElement("div");
    group.className = "proposal-keep-with-next";
    heading.before(group);
    group.appendChild(heading);
    const items = next.matches("ul, ol, .proposal-card-list") ? [...next.children] : [];
    if (items.length > 1 && next.getBoundingClientRect().height > pageHeightPx / 2) {
      const head = next.cloneNode(false);
      head.classList.add("proposal-split-head");
      next.classList.add("proposal-split-tail");
      head.appendChild(items[0]);
      group.appendChild(head);
    } else {
      group.appendChild(next);
    }
  });
}

async function prepareExportLogo(root) {
  const logo = await loadBrandLogo();
  const images = [...root.querySelectorAll(".proposal-logo")];
  await Promise.all(images.map(async (img) => {
    const dropLogo = () => {
      img.closest(".proposal-logo-band")?.classList.add("logo-missing");
      img.remove();
    };
    if (!logo) {
      dropLogo();
      return;
    }
    img.style.display = "";
    img.closest(".proposal-logo-band")?.classList.remove("logo-missing");
    img.src = logo.dataUrl;
    try {
      await img.decode?.();
    } catch {
      dropLogo();
    }
  }));
}

export async function renderProposalPdf(proposal, sourceElement) {
  const doc = normalizeProposalDocument(proposal);
  const temporary = sourceElement ? null : createTemporaryProposalPreview(proposal);
  const exportNode = createProposalExportClone(sourceElement || temporary?.element);
  if (!exportNode) throw new Error("Proposal preview is not available for PDF export.");

  try {
    await prepareExportLogo(exportNode.clone);
    materializeListMarkers(exportNode.clone);
    keepHeadingsWithNextBlock(exportNode.clone);
    const filename = `${sanitizeDownloadName(doc.title)}.pdf`;
    const buildWorker = () => html2pdf()
      .set({
        filename,
        // A bigger top margin alone can't fix "page 2 starts mid-sentence" —
        // it applies equally to every page, so cranking it up just pushes
        // page 1's cover down too. The actual fix is below: never let a <p>
        // get sliced in half across a page boundary. With that in place this
        // margin only needs to cover the page's breathing room, not also
        // fake a "fresh paragraph" feeling.
        margin: PROPOSAL_PDF_MARGIN_MM,
        image: { type: "png", quality: 1 },
        html2canvas: {
          scale: 3,
          useCORS: true,
          backgroundColor: "#ffffff",
          scrollX: 0,
          scrollY: 0,
          windowWidth: 940,
          // Runs on the captured canvas before html2pdf slices it into pages.
          onrendered: trimCanvasBottom,
        },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait", compress: true },
        pagebreak: {
          mode: ["css", "legacy"],
          avoid: [
            ".proposal-keep-with-next",
            ".proposal-cover",
            ".proposal-highlight-section",
            ".proposal-total-card",
            ".proposal-detail-card",
            ".proposal-card-list",
            ".proposal-table-wrap",
            ".proposal-acceptance",
            "table",
            "thead",
            "tr",
            "h1",
            "h2",
            "p",
            "li",
          ],
        },
      })
      .from(exportNode.clone);

    let worker = buildWorker();
    let pdf = await worker.toPdf().get("pdf").then((generatedPdf) => generatedPdf);

    if (pdf.internal.getNumberOfPages() > 6) {
      exportNode.clone.classList.add("proposal-export-pdf-compact");
      worker = buildWorker();
      pdf = await worker.toPdf().get("pdf").then((generatedPdf) => generatedPdf);
    }

    if (pdf.internal.getNumberOfPages() > 6) {
      exportNode.clone.classList.add("proposal-export-pdf-ultra");
      worker = buildWorker();
      pdf = await worker.toPdf().get("pdf").then((generatedPdf) => generatedPdf);
    }

    const pageCount = pdf.internal.getNumberOfPages();
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    for (let page = 1; page <= pageCount; page += 1) {
      pdf.setPage(page);
      pdf.setFontSize(9);
      pdf.setTextColor(...rgbColor(BRAND.colors.muted));
      pdf.text(`${BRAND.name} - ${page} / ${pageCount}`, pageWidth / 2, pageHeight - 8, { align: "center" });
    }
    return { pdf, filename };
  } finally {
    exportNode.wrapper.remove();
    temporary?.wrapper.remove();
  }
}

async function exportProposalPdf(proposal, sourceElement) {
  const { pdf, filename } = await renderProposalPdf(proposal, sourceElement);
  pdf.save(filename);
}

function extractProposalDocumentFromDom(sourceElement, fallbackProposal = {}) {
  const fallback = normalizeProposalDocument(fallbackProposal);
  if (!sourceElement) return fallback;

  const textOf = (selector) => sourceElement.querySelector(selector)?.textContent?.trim() || "";
  const coverInfoLabelMap = Object.values(PROPOSAL_COPY).reduce((acc, copy) => {
    acc[copy.total.toLowerCase()] = "total";
    return acc;
  }, {});
  const coverInfo = [...sourceElement.querySelectorAll(".proposal-cover-info span")].reduce((acc, item) => {
    const label = item.querySelector("strong")?.textContent?.trim().toLowerCase();
    const value = item.textContent.replace(item.querySelector("strong")?.textContent || "", "").trim();
    if (label) acc[coverInfoLabelMap[label] || label] = value;
    return acc;
  }, {});
  const sections = [...sourceElement.querySelectorAll(".proposal-paper section")].reduce((acc, section) => {
    const heading = section.querySelector("h2")?.textContent?.trim();
    if (!heading) return acc;
    acc[heading] = section;
    return acc;
  }, {});
  const translatedHeadings = (key) => [...new Set(Object.values(PROPOSAL_COPY).map((copy) => copy[key]))];
  const findSection = (key) => translatedHeadings(key).map((heading) => sections[heading]).find(Boolean);
  const sectionParagraphs = (key) => [...(findSection(key)?.querySelectorAll("p") || [])]
    .map((node) => node.textContent.trim())
    .filter(Boolean)
    .join("\n\n");
  // The cover-card sections (problems identified, technologies used) render
  // as .proposal-detail-card divs, not <li> — keep this in sync with
  // proposalDocumentToHtml()/cardsToHtml(), otherwise these always extract
  // empty and the DOCX export throws when it builds a zero-row Table from them.
  // A card is <strong>title</strong><p>body</p>: rejoin as "title: body"
  // (plain textContent glued them together, e.g. "Costoalto.").
  const cardText = (node) => {
    const title = node.querySelector?.("strong")?.textContent.trim() || "";
    const body = [...(node.querySelectorAll?.("p") || [])].map((p) => p.textContent.trim()).filter(Boolean).join(" ");
    return title || body ? [title, body].filter(Boolean).join(": ") : node.textContent.trim();
  };
  const sectionList = (key, selector = ".proposal-detail-card") => [...(findSection(key)?.querySelectorAll(selector) || [])]
    .map(cardText)
    .filter(Boolean);
  const lineItems = [...(findSection("implementationCosts")?.querySelectorAll("tbody tr") || [])]
    .map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent.trim()))
    .filter((cells) => cells.length >= 5)
    .map((cells) => normalizeLineItem({
      service: cells[0],
      description: cells[1],
      quantity: cells[2],
      unitPrice: cells[3],
      subtotal: cells[4],
    }));

  return {
    ...fallback,
    title: textOf(".proposal-paper .proposal-cover h1") || fallback.title,
    totalAmount: normalizeMoney(coverInfo.total) ?? fallback.totalAmount,
    executiveSummary: sectionParagraphs("executiveSummary") || fallback.executiveSummary,
    problemsIdentified: sectionList("problemsIdentified").length ? sectionList("problemsIdentified") : fallback.problemsIdentified,
    proposedSolution: sectionParagraphs("proposedSolution") || fallback.proposedSolution,
    technologiesUsed: sectionList("technologiesUsed").length ? sectionList("technologiesUsed") : fallback.technologiesUsed,
    lineItems: lineItems.length ? lineItems : fallback.lineItems,
    expectedROI: sectionParagraphs("expectedROI") || fallback.expectedROI,
    nextSteps: sectionList("nextSteps", "li").length ? sectionList("nextSteps", "li") : fallback.nextSteps,
    formattedTotal: coverInfo.total || fallback.formattedTotal,
  };
}

const DOCX_COLORS = Object.fromEntries(Object.entries(BRAND.colors).map(([key, value]) => [key, docxColor(value)]));

const docxBorder = { style: BorderStyle.SINGLE, size: 4, color: DOCX_COLORS.border };

const docxCellBorders = { top: docxBorder, bottom: docxBorder, left: docxBorder, right: docxBorder };

function docxText(text, options = {}) {
  return new TextRun({ text: String(text || ""), font: BRAND.docxFont, ...options });
}

function docxParagraph(text, options = {}) {
  return new Paragraph({
    spacing: { after: 260, line: 360 },
    keepLines: true,
    children: [docxText(text, { color: DOCX_COLORS.text, ...(options.textOptions || {}) })],
    ...options,
  });
}

const docxParagraphs = (text, options) => String(text || "")
  .split(/\n{2,}/)
  .map((paragraph) => paragraph.trim())
  .filter(Boolean)
  .map((paragraph) => docxParagraph(paragraph, options));

function docxHeading(text, level = HeadingLevel.HEADING_2, spacing = {}, pageBreakBefore = false) {
  return new Paragraph({
    children: [docxText(text, { bold: true, color: DOCX_COLORS.primary, size: 28 })],
    heading: level,
    keepNext: true,
    pageBreakBefore,
    border: { bottom: { style: BorderStyle.SINGLE, size: 10, color: DOCX_COLORS.accent, space: 4 } },
    spacing: { before: 620, after: 260, ...spacing },
  });
}

function docxCell(children, options = {}) {
  return new TableCell({
    borders: docxCellBorders,
    margins: { top: 120, bottom: 120, left: 140, right: 140 },
    children: Array.isArray(children) ? children : [children],
    ...options,
  });
}

function docxRowsFromLineItems(lineItems = [], copy = PROPOSAL_COPY.en) {
  const header = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: [copy.serviceUnit, copy.description, copy.qty, copy.unitPrice, copy.subtotal].map((label) =>
      docxCell(new Paragraph({ children: [docxText(label, { bold: true, color: DOCX_COLORS.onPrimary })] }), {
        shading: { type: ShadingType.CLEAR, fill: DOCX_COLORS.primary },
      }),
    ),
  });
  const rows = lineItems.map((item, index) => new TableRow({
    cantSplit: true,
    children: [
      item.service,
      item.description,
      item.quantity,
      formatUsd(item.unitPrice),
      formatUsd(item.subtotal),
    ].map((value) => docxCell(new Paragraph({ children: [docxText(value, { color: DOCX_COLORS.text })] }), {
      shading: { type: ShadingType.CLEAR, fill: index % 2 === 0 ? DOCX_COLORS.white : DOCX_COLORS.surface },
    })),
  }));
  return [header, ...rows];
}

function docxTechnologyRows(technologies = []) {
  // docx's Table constructor does Array(Math.max(...rows.map(...))) internally,
  // and Math.max() over an empty list is -Infinity — a zero-row table throws
  // RangeError: Invalid array length. Never let that array be empty.
  const list = technologies.length ? technologies : ["—"];
  const chunks = [];
  for (let index = 0; index < list.length; index += 3) {
    chunks.push(list.slice(index, index + 3));
  }
  return chunks.map((chunk) => new TableRow({
    cantSplit: true,
    children: chunk.map((technology) => docxCell(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [docxText(technology, { bold: true, color: DOCX_COLORS.primary })],
      }),
      {
        shading: { type: ShadingType.CLEAR, fill: DOCX_COLORS.surface },
        margins: { top: 120, bottom: 120, left: 160, right: 160 },
      },
    )).concat(Array.from({ length: Math.max(0, 3 - chunk.length) }, () => docxCell(new Paragraph({ children: [] }), {
      borders: {
        top: { style: BorderStyle.SINGLE, size: 0, color: DOCX_COLORS.white },
        bottom: { style: BorderStyle.SINGLE, size: 0, color: DOCX_COLORS.white },
        left: { style: BorderStyle.SINGLE, size: 0, color: DOCX_COLORS.white },
        right: { style: BorderStyle.SINGLE, size: 0, color: DOCX_COLORS.white },
      },
    }))),
  }));
}

function docxSignatureCell(label) {
  return docxCell([
    new Paragraph({ children: [docxText(label, { color: DOCX_COLORS.muted, bold: true, size: 18 })], spacing: { after: 360 } }),
    new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: DOCX_COLORS.border } },
      spacing: { after: 40 },
      children: [docxText(" ")],
    }),
  ], {
    borders: {
      top: { style: BorderStyle.SINGLE, size: 0, color: DOCX_COLORS.white },
      bottom: { style: BorderStyle.SINGLE, size: 0, color: DOCX_COLORS.white },
      left: { style: BorderStyle.SINGLE, size: 0, color: DOCX_COLORS.white },
      right: { style: BorderStyle.SINGLE, size: 0, color: DOCX_COLORS.white },
    },
  });
}

// Primary-color band at the top of the DOCX cover with the (white) logo inside;
// shows the brand name in white when the logo isn't available.
function docxLogoBand(logo) {
  let content;
  if (logo) {
    const scale = Math.min(180 / logo.width, 56 / logo.height, 1);
    content = new ImageRun({
      type: logo.type,
      data: logo.bytes,
      transformation: { width: Math.round(logo.width * scale), height: Math.round(logo.height * scale) },
      altText: { name: BRAND.name, title: BRAND.name, description: `${BRAND.name} logo` },
    });
  } else {
    content = docxText(BRAND.name, { bold: true, color: DOCX_COLORS.onPrimary, size: 36 });
  }
  const none = { style: BorderStyle.NONE, size: 0, color: DOCX_COLORS.white };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
    rows: [new TableRow({
      cantSplit: true,
      children: [new TableCell({
        shading: { type: ShadingType.CLEAR, fill: DOCX_COLORS.primary },
        borders: { top: none, left: none, right: none, bottom: { style: BorderStyle.SINGLE, size: 24, color: DOCX_COLORS.accent } },
        margins: { top: 200, bottom: 200, left: 280, right: 280 },
        children: [new Paragraph({ children: [content] })],
      })],
    })],
  });
}

export async function buildProposalDocx(proposal, sourceElement) {
  const temporary = sourceElement ? null : createTemporaryProposalPreview(proposal);
  try {
    const doc = extractProposalDocumentFromDom(sourceElement || temporary?.element, proposal);
    const copy = getProposalCopy(doc.language);
    const logoBand = docxLogoBand(await loadBrandLogo());
    // Mirror the PDF/preview fallbacks: a Table built from a zero-length rows
    // array throws (docx tries to Array(Math.max(...[])) internally), so an
    // empty list must never reach docxTechnologyRows/docxRowsFromLineItems.
    const technologiesForDocx = doc.technologiesUsed.length ? doc.technologiesUsed : copy.defaultTechnologies;
    const problemsForDocx = doc.problemsIdentified.length ? doc.problemsIdentified : [copy.noProblems];
    const coverInfoTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            [copy.total, doc.formattedTotal],
            [copy.issuedOn, doc.issuedOn],
            [copy.validUntil, doc.validUntil],
            [copy.preparedByPerson, doc.issuedBy || "—"],
          ].map(([label, value]) => docxCell([
            new Paragraph({ children: [docxText(label, { color: DOCX_COLORS.muted, bold: true })] }),
            new Paragraph({ children: [docxText(value, { color: DOCX_COLORS.primary, bold: true })] }),
          ], { shading: { type: ShadingType.CLEAR, fill: DOCX_COLORS.surface } })),
        }),
      ],
    });
    const costTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: docxRowsFromLineItems(doc.lineItems, copy),
    });
    const signatureTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ cantSplit: true, children: [docxSignatureCell(copy.signatureName), docxSignatureCell(copy.signatureRole)] }),
        new TableRow({ cantSplit: true, children: [docxSignatureCell(copy.signatureDate), docxSignatureCell(copy.signatureLine)] }),
      ],
    });
    const borderlessCell = (children) => docxCell(children, {
      borders: {
        top: { style: BorderStyle.SINGLE, size: 0, color: DOCX_COLORS.white },
        bottom: { style: BorderStyle.SINGLE, size: 0, color: DOCX_COLORS.white },
        left: { style: BorderStyle.SINGLE, size: 0, color: DOCX_COLORS.white },
        right: { style: BorderStyle.SINGLE, size: 0, color: DOCX_COLORS.white },
      },
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    const notes = doc.sectionNotes || {};
    const clientDetails = proposalClientDetails(doc, copy);
    const adjustmentParagraphs = proposalAdjustmentRows(doc, copy).map(([label, value]) => new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 60, after: 60 },
      children: [
        docxText(`${label}: `, { color: DOCX_COLORS.muted }),
        docxText(value, { bold: true, color: DOCX_COLORS.primary }),
      ],
    }));
    const costSectionTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [new TableRow({
        cantSplit: true,
        children: [borderlessCell([
          docxHeading(copy.implementationCosts),
          costTable,
          ...adjustmentParagraphs,
          new Paragraph({
            children: [docxText(`${copy.totalImplementationCost}: ${doc.formattedTotal}`, { bold: true, color: DOCX_COLORS.onPrimary, size: 28 })],
            shading: { type: ShadingType.CLEAR, fill: DOCX_COLORS.primary },
            border: { left: { style: BorderStyle.SINGLE, size: 18, color: DOCX_COLORS.accent } },
            spacing: { before: 240, after: 260 },
            alignment: AlignmentType.CENTER,
          }),
        ])],
      })],
    });
    const acceptanceSectionTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [new TableRow({
        cantSplit: true,
        children: [borderlessCell([
          docxHeading(copy.acceptance),
          docxParagraph(copy.acceptanceIntro),
          signatureTable,
        ])],
      })],
    });
    const proposalDoc = new Document({
      styles: {
        default: {
          document: { run: { font: BRAND.docxFont } },
        },
      },
      sections: [{
        properties: {},
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  docxText(`${BRAND.name} · `, { color: DOCX_COLORS.muted, size: 18 }),
                  new TextRun({ children: [PageNumber.CURRENT], font: BRAND.docxFont, size: 18, color: DOCX_COLORS.muted }),
                  docxText(" / ", { color: DOCX_COLORS.muted, size: 18 }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], font: BRAND.docxFont, size: 18, color: DOCX_COLORS.muted }),
                ],
              }),
            ],
          }),
        },
        children: [
          logoBand,
          new Paragraph({
            children: [docxText(copy.preparedBy.toUpperCase(), { bold: true, color: DOCX_COLORS.primary, size: 22 })],
            spacing: { before: 360, after: 220 },
          }),
          new Paragraph({ children: [docxText(doc.title, { bold: true, color: DOCX_COLORS.primaryDeep, size: 42 })], spacing: { after: 260, line: 360 } }),
          docxParagraph(`${copy.proposalEyebrow} - ${copy.preparedFor} ${doc.client}`, { spacing: { after: clientDetails || doc.introduction ? 160 : 360, line: 360 }, textOptions: { color: DOCX_COLORS.muted, size: 24 } }),
          ...(clientDetails ? [docxParagraph(clientDetails, { spacing: { after: 240, line: 320 }, textOptions: { color: DOCX_COLORS.primary, bold: true } })] : []),
          ...docxParagraphs(doc.introduction, { spacing: { after: 200, line: 320 }, textOptions: { color: DOCX_COLORS.muted } }),
          docxParagraph([doc.industry, doc.contact, doc.serviceLine].filter(Boolean).join("   "), { spacing: { after: 420, line: 320 }, textOptions: { color: DOCX_COLORS.text, bold: true } }),
          coverInfoTable,
          new Paragraph({ children: [docxText(" ")], spacing: { after: 420 } }),
          docxHeading(copy.executiveSummary, HeadingLevel.HEADING_2),
          ...String(doc.executiveSummary || "").split(/\n{2,}/).filter(Boolean).map((text) => docxParagraph(text)),
          docxHeading(copy.problemsIdentified),
          ...docxParagraphs(notes.problemsIdentified),
          ...problemsForDocx.map((item) => new Paragraph({ text: item, bullet: { level: 0 }, keepLines: true, spacing: { after: 140 } })),
          docxHeading(copy.proposedSolution),
          ...String(doc.proposedSolution || "").split(/\n{2,}/).filter(Boolean).map((text) => docxParagraph(text)),
          docxHeading(copy.technologiesUsed),
          ...docxParagraphs(notes.technologiesUsed),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: docxTechnologyRows(technologiesForDocx),
          }),
          costSectionTable,
          ...docxParagraphs(notes.implementationCosts),
          docxHeading(copy.expectedROI),
          ...String(doc.expectedROI || "").split(/\n{2,}/).filter(Boolean).map((text) => docxParagraph(text)),
          docxHeading(copy.nextSteps),
          ...doc.nextSteps.map((item) => new Paragraph({ text: item, numbering: { reference: "next-steps", level: 0 }, keepLines: true, spacing: { after: 140 } })),
          ...docxParagraphs(notes.nextSteps),
          ...(doc.additionalSections || []).flatMap((item) => [
            docxHeading(additionalSectionTitle(item.heading, copy)),
            ...docxParagraphs(item.body),
          ]),
          acceptanceSectionTable,
        ],
      }],
      numbering: {
        config: [{
          reference: "next-steps",
          levels: [{
            level: 0,
            format: "decimal",
            text: "%1.",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 360, hanging: 260 } } },
          }],
        }],
      },
    });

    return { proposalDoc, filename: `${sanitizeDownloadName(doc.title)}.docx` };
  } finally {
    temporary?.wrapper.remove();
  }
}

async function exportProposalViaBackend(proposal, format) {
  const doc = normalizeProposalDocument(proposal);
  const response = await proposalsApi.exportFile(proposal.id, {
    format,
    content: proposal.content || undefined,
    issuedBy: doc.issuedBy || undefined,
  });
  downloadBlob(response.data, `${sanitizeDownloadName(doc.title)}.${format}`);
}

async function exportProposalDocx(proposal, sourceElement) {
  const { proposalDoc, filename } = await buildProposalDocx(proposal, sourceElement);
  const blob = await Packer.toBlob(proposalDoc);
  downloadBlob(blob, filename);
}

export async function exportProposalDocument(proposal, format, sourceElement) {
  // PDF/DOCX reales generados en el backend (texto seleccionable). Si la propuesta aún no está
  // guardada o el servidor falla, se usa la captura de pantalla de siempre.
  const savedId = proposal?.id && !String(proposal.id).startsWith("copy-");
  if (savedId) {
    try {
      await exportProposalViaBackend(proposal, format === "docx" ? "docx" : "pdf");
      return;
    } catch (error) {
      console.warn("Backend export failed, falling back to client-side export", error);
    }
  }
  if (format === "docx") {
    await exportProposalDocx(proposal, sourceElement);
    return;
  }
  await exportProposalPdf(proposal, sourceElement);
}
