import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Packer } from 'docx'
import JSZip from 'jszip'

// html2pdf needs a real canvas; these tests cover the DOCX and the HTML the PDF is captured from.
vi.mock('html2pdf.js', () => ({ default: () => ({}) }))

import { buildProposalDocx, normalizeProposalDocument, proposalDocumentToHtml } from '@/Dashboard'
import { BRAND, docxColor, loadBrandLogo } from '@/config/brand'

const logoBytes = readFileSync(path.resolve(__dirname, '../../public', `.${BRAND.logoPath}`))
const PRIMARY = docxColor(BRAND.colors.primary)
const ACCENT = docxColor(BRAND.colors.accent)

// The cover band: first table in the body, filled with the primary color.
const coverBand = (xml) => xml.slice(xml.indexOf('<w:body>'), xml.indexOf('</w:tbl>'))

const content = `
<h1>Automatización de Back Office</h1>
<p>Propuesta para reducir tiempos operativos</p>
<h2>Resumen Ejecutivo</h2>
<p>ACME procesa 5.000 documentos al mes.</p>
<ul><li>Punto clave A</li><li>Punto clave B</li></ul>
<p>Cierre del resumen.</p>
<h2>Problems Identified</h2>
<ul><li>Errores de digitación: retrasan la facturación.</li></ul>
<h2>Implementation Costs</h2>
<table><thead><tr><th>Service / Unit</th><th>Description</th><th>Qty</th><th>Unit Price</th><th>Subtotal</th></tr></thead>
<tbody><tr><td>Discovery</td><td>Levantamiento</td><td>1</td><td>1200</td><td>1200</td></tr></tbody></table>
<p>Pago: 50% al inicio y 50% contra entrega.</p>
<h2>Riesgos y Supuestos</h2>
<p>El cliente entrega acceso al ERP en la semana 1.</p>
<h2>Next Steps</h2>
<ol><li>Reunión de alcance</li></ol>
`

const proposal = {
  title: 'Automatización de Back Office',
  clientName: 'Juan Pérez',
  clientEmail: 'juan.perez@acme.cl',
  clientCompany: 'ACME SpA',
  language: 'es',
  content,
  lineItems: [
    { service: 'Discovery', description: 'Levantamiento', quantity: 1, unitPrice: 1200 },
    { service: 'Bot RPA', description: 'Implementación', quantity: 2, unitPrice: 4000 },
  ],
}

async function docxParts(input) {
  const { proposalDoc } = await buildProposalDocx(input, null)
  const zip = await JSZip.loadAsync(await Packer.toBuffer(proposalDoc))
  const xml = await zip.file('word/document.xml').async('string')
  const media = Object.values(zip.files)
    .filter((entry) => !entry.dir && entry.name.startsWith('word/media/'))
    .map((entry) => entry.name)
  return { xml, media }
}

function mockLogoFetch(ok = true) {
  vi.stubGlobal('fetch', vi.fn(async () => (ok
    ? { ok: true, arrayBuffer: async () => logoBytes.buffer.slice(logoBytes.byteOffset, logoBytes.byteOffset + logoBytes.byteLength) }
    : Promise.reject(new Error('network down')))))
}

beforeEach(async () => {
  mockLogoFetch(true)
  await loadBrandLogo({ force: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('proposal DOCX export', () => {
  it('includes client, email, company, every service and the total', async () => {
    const { xml } = await docxParts(proposal)

    expect(xml).toContain('Juan Pérez')
    expect(xml).toContain('juan.perez@acme.cl')
    expect(xml).toContain('ACME SpA')
    expect(xml).toContain('Discovery')
    expect(xml).toContain('Bot RPA')
    expect(xml).toContain('$9,200 USD')
    expect(xml).toContain('Errores de digitación: retrasan la facturación.')
  })

  it('uses the DOCX font (Calibri), not the web font of the preview/PDF', async () => {
    const { xml } = await docxParts(proposal)

    expect(xml).toContain(`w:ascii="${BRAND.docxFont}"`)
    expect(xml).not.toContain(`w:ascii="${BRAND.font}"`)
  })

  it('embeds the brand logo inside the primary-color band with the accent border', async () => {
    const { xml, media } = await docxParts(proposal)
    const band = coverBand(xml)

    expect(media).toHaveLength(1)
    expect(media[0]).toMatch(/\.png$/)
    expect(band).toContain(`w:fill="${PRIMARY}"`)
    expect(band).toContain(`w:color="${ACCENT}"`)
    expect(band).toContain('<w:drawing>')
  })

  it('still builds the document without a logo when it cannot be loaded', async () => {
    mockLogoFetch(false)
    await loadBrandLogo({ force: true })

    const { xml, media } = await docxParts(proposal)

    expect(media).toHaveLength(0)
    expect(xml).toContain('Juan Pérez')
    // The band stays, with the brand name in white instead of the logo.
    const band = coverBand(xml)
    expect(band).toContain(`w:fill="${PRIMARY}"`)
    expect(band).toContain(BRAND.name)
    expect(band).toContain(`w:color w:val="${docxColor(BRAND.colors.onPrimary)}"`)
  })

  it('keeps a section outside the 7 fixed ones as an additional section', async () => {
    const { xml } = await docxParts(proposal)

    expect(xml).toContain('Sección adicional: Riesgos y Supuestos')
    expect(xml).toContain('El cliente entrega acceso al ERP en la semana 1.')
  })
})

describe('proposal HTML used for the PDF', () => {
  it('shows company and email on the cover and the logo', () => {
    const html = proposalDocumentToHtml(proposal)

    expect(html).toContain('Empresa: ACME SpA · Correo: juan.perez@acme.cl')
    expect(html).toMatch(/<div class="proposal-logo-band">\s*<img class="proposal-logo"/)
  })

  it('keeps lists inside a section that also has paragraphs', () => {
    const doc = normalizeProposalDocument(proposal)

    expect(doc.executiveSummary).toContain('ACME procesa 5.000 documentos al mes.')
    expect(doc.executiveSummary).toContain('• Punto clave A')
    expect(doc.executiveSummary).toContain('Cierre del resumen.')
  })

  it('keeps unknown sections and text outside the pricing table', () => {
    const html = proposalDocumentToHtml(proposal)

    expect(html).toContain('Sección adicional: Riesgos y Supuestos')
    expect(html).toContain('Pago: 50% al inicio y 50% contra entrega.')
  })

  it('shows discount and taxes only when the proposal has them', () => {
    expect(proposalDocumentToHtml(proposal)).not.toContain('proposal-adjustments')

    const html = proposalDocumentToHtml({ ...proposal, discount: 200, tax: 500 })

    expect(html).toContain('Descuento')
    expect(html).toContain('- $200 USD')
    expect(html).toContain('Impuestos')
    expect(html).toContain('$500 USD')
  })

  it('does not duplicate the additional-section prefix when re-exporting the preview HTML', () => {
    const embedded = proposalDocumentToHtml(proposal)
    const doc = normalizeProposalDocument({ ...proposal, content: embedded })

    expect(doc.additionalSections.map((item) => item.heading)).toEqual(['Riesgos y Supuestos'])
    expect(doc.problemsIdentified).toEqual(['Errores de digitación: retrasan la facturación.'])
  })
})
