"""
Reporte de pipeline de Ventas (RF-VTA-10).

Todo lo que calcula el reporte vive aquí como funciones puras sobre la lista de propuestas
del usuario: el router solo lee de Firestore y entrega el resultado. Así los números se
prueban sin base de datos y la pantalla y los archivos exportados salen de la misma cuenta.

Definiciones (las mismas que se muestran en pantalla y en los archivos):
  - Propuestas enviadas  = las que ya salieron de «borrador» (enviada, vista, en negociación,
                           firmada o rechazada).
  - Tasa de conversión   = firmadas ÷ enviadas.
  - Win rate             = firmadas ÷ (firmadas + rechazadas), es decir, de lo que ya tiene resultado.
  - Tiempo de cierre     = días entre la creación de la propuesta y su paso a «firmada».
  - Valor                = suma por moneda (USD y CLP nunca se mezclan en un solo número).
"""
from __future__ import annotations

import io
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional

from app.schemas.proposal import PROPOSAL_STATUS_VALUES, ProposalStatus, normalize_proposal_status

UNKNOWN_STATUS = "desconocido"
CURRENCIES = ("USD", "CLP")
SENT_STATUSES = frozenset(PROPOSAL_STATUS_VALUES - {ProposalStatus.borrador.value})
# Propuestas que todavía pueden cerrarse: el valor que sigue «en juego».
OPEN_STATUSES = frozenset({
    ProposalStatus.enviada.value, ProposalStatus.vista.value, ProposalStatus.en_negociacion.value,
})
STATUS_ORDER = [s.value for s in ProposalStatus] + [UNKNOWN_STATUS]
# Tope de lectura desde Firestore; si se alcanza, el reporte avisa que está truncado.
MAX_PROPOSALS = 2000


# ── lectura tolerante de los campos de una propuesta ─────────────────────────────

def status_code(proposal: Dict[str, Any]) -> str:
    code = normalize_proposal_status(proposal.get("proposal_status"))
    return code if code in PROPOSAL_STATUS_VALUES else UNKNOWN_STATUS


def amount(proposal: Dict[str, Any]) -> float:
    structured = proposal.get("structured_content") or proposal.get("structuredContent") or {}
    value = (
        proposal.get("totalAmount")
        or proposal.get("total")
        or proposal.get("total_amount")
        or structured.get("totalAmount")
        or 0
    )
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def currency(proposal: Dict[str, Any]) -> str:
    """Las propuestas anteriores a RF-VTA-02 no guardan moneda: eran siempre USD."""
    structured = proposal.get("structured_content") or proposal.get("structuredContent") or {}
    code = str(proposal.get("currency") or structured.get("currency") or "USD").upper()
    return code if code in CURRENCIES else "USD"


def to_datetime(value: Any) -> Optional[datetime]:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def closed_at(proposal: Dict[str, Any]) -> Optional[datetime]:
    return to_datetime((proposal.get("statusDates") or {}).get(ProposalStatus.firmada.value))


def close_days(proposal: Dict[str, Any]) -> Optional[float]:
    """Días de creación a firma. None si falta alguna fecha o si salen incoherentes (negativas)."""
    created, closed = to_datetime(proposal.get("createdAt")), closed_at(proposal)
    if not created or not closed:
        return None
    days = (closed - created).total_seconds() / 86400
    return days if days >= 0 else None


def _money_bucket() -> Dict[str, float]:
    return {code: 0.0 for code in CURRENCIES}


def _pct(part: int, whole: int) -> Optional[float]:
    return round(part / whole * 100, 1) if whole else None


# ── el reporte ───────────────────────────────────────────────────────────────────

def filter_period(proposals: Iterable[Dict[str, Any]], days: Optional[int], now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """Propuestas creadas en los últimos `days` días. Sin `days`, todas. Sin fecha de creación no entra a un período."""
    items = list(proposals)
    if not days:
        return items
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=days)
    return [p for p in items if (created := to_datetime(p.get("createdAt"))) and created >= cutoff]


def build_pipeline_report(proposals: Iterable[Dict[str, Any]], *, days: Optional[int] = None,
                          now: Optional[datetime] = None, truncated: bool = False) -> Dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    items = filter_period(proposals, days, now)

    by_status: Dict[str, Dict[str, Any]] = {}
    total_value, won_value, open_value = _money_bucket(), _money_bucket(), _money_bucket()
    durations: List[float] = []
    signed_without_date = 0

    for proposal in items:
        code, money, cur = status_code(proposal), amount(proposal), currency(proposal)
        row = by_status.setdefault(code, {"status": code, "count": 0, "value": _money_bucket()})
        row["count"] += 1
        row["value"][cur] += money
        total_value[cur] += money
        if code == ProposalStatus.firmada.value:
            won_value[cur] += money
            elapsed = close_days(proposal)
            if elapsed is None:
                signed_without_date += 1
            else:
                durations.append(elapsed)
        elif code in OPEN_STATUSES:
            open_value[cur] += money

    total = len(items)
    counts = {code: by_status[code]["count"] for code in by_status}
    signed = counts.get(ProposalStatus.firmada.value, 0)
    rejected = counts.get(ProposalStatus.rechazada.value, 0)
    sent = sum(n for code, n in counts.items() if code in SENT_STATUSES)

    rows = []
    for code in STATUS_ORDER:
        if code not in by_status:
            continue
        row = by_status[code]
        rows.append({**row, "share": _pct(row["count"], total), "value": {k: round(v, 2) for k, v in row["value"].items()}})

    return {
        "period": {"days": days, "label": f"últimos {days} días" if days else "todo el historial"},
        "totals": {"proposals": total, "sent": sent, "signed": signed, "rejected": rejected,
                   "drafts": counts.get(ProposalStatus.borrador.value, 0)},
        "byStatus": rows,
        "conversionRate": _pct(signed, sent),
        "winRate": _pct(signed, signed + rejected),
        "value": {
            "total": {k: round(v, 2) for k, v in total_value.items()},
            "won": {k: round(v, 2) for k, v in won_value.items()},
            "open": {k: round(v, 2) for k, v in open_value.items()},
        },
        "closeTime": {
            "averageDays": round(sum(durations) / len(durations), 1) if durations else None,
            "signedWithDate": len(durations),
            "signedWithoutDate": signed_without_date,
        },
        "truncated": truncated,
        "generatedAt": now.isoformat(),
    }


# ── filas para exportar ──────────────────────────────────────────────────────────

STATUS_LABELS = {
    "borrador": "Borrador", "enviada": "Enviada", "vista": "Vista", "en_negociacion": "En negociación",
    "firmada": "Firmada", "rechazada": "Rechazada", UNKNOWN_STATUS: "Desconocido",
}

DETAIL_HEADERS = ["Título", "Cliente", "Estado", "Monto", "Moneda", "Creada", "Cerrada", "Días a cierre"]


def _date_text(value: Optional[datetime]) -> str:
    return value.date().isoformat() if value else ""


def detail_rows(proposals: Iterable[Dict[str, Any]], *, days: Optional[int] = None,
                now: Optional[datetime] = None) -> List[List[Any]]:
    """Una fila por propuesta del período, de la más reciente a la más antigua."""
    items = filter_period(proposals, days, now)
    items.sort(key=lambda p: to_datetime(p.get("createdAt")) or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    rows = []
    for p in items:
        elapsed = close_days(p)
        rows.append([
            str(p.get("title") or ""), str(p.get("clientName") or ""), STATUS_LABELS[status_code(p)],
            amount(p), currency(p), _date_text(to_datetime(p.get("createdAt"))), _date_text(closed_at(p)),
            round(elapsed, 1) if elapsed is not None else "",
        ])
    return rows


def _fmt_rate(value: Optional[float]) -> str:
    return f"{value:.1f} %" if value is not None else "Sin datos"


def _fmt_money(bucket: Dict[str, float]) -> str:
    return " · ".join(f"{code} {bucket[code]:,.0f}" for code in CURRENCIES if bucket.get(code)) or "0"


def summary_rows(report: Dict[str, Any]) -> List[List[str]]:
    totals, close = report["totals"], report["closeTime"]
    average = close["averageDays"]
    close_text = f"{average:.1f} días" if average is not None else "Sin datos"
    if close["signedWithoutDate"]:
        close_text += f" ({close['signedWithoutDate']} firmadas sin fecha de cierre no cuentan)"
    return [
        ["Período", report["period"]["label"]],
        ["Propuestas", str(totals["proposals"])],
        ["Enviadas", str(totals["sent"])],
        ["Firmadas", str(totals["signed"])],
        ["Rechazadas", str(totals["rejected"])],
        ["Tasa de conversión (firmadas ÷ enviadas)", _fmt_rate(report["conversionRate"])],
        ["Win rate (firmadas ÷ cerradas)", _fmt_rate(report["winRate"])],
        ["Valor total", _fmt_money(report["value"]["total"])],
        ["Valor ganado", _fmt_money(report["value"]["won"])],
        ["Valor en juego", _fmt_money(report["value"]["open"])],
        ["Tiempo promedio de cierre", close_text],
    ]


def status_rows(report: Dict[str, Any]) -> List[List[Any]]:
    return [[STATUS_LABELS[r["status"]], r["count"], r["share"] if r["share"] is not None else 0,
             r["value"]["USD"], r["value"]["CLP"]] for r in report["byStatus"]]


STATUS_HEADERS = ["Estado", "Propuestas", "% del total", "Valor USD", "Valor CLP"]


# ── archivos ─────────────────────────────────────────────────────────────────────

def render_csv(proposals: List[Dict[str, Any]], *, days: Optional[int] = None) -> bytes:
    """Una fila por propuesta. Lleva BOM para que Excel respete las tildes."""
    import csv
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(DETAIL_HEADERS)
    writer.writerows(detail_rows(proposals, days=days))
    return buf.getvalue().encode("utf-8-sig")


def render_xlsx(report: Dict[str, Any], proposals: List[Dict[str, Any]], *, days: Optional[int] = None) -> bytes:
    import openpyxl
    from openpyxl.styles import Alignment, Font, PatternFill

    wb = openpyxl.Workbook()
    header_fill = PatternFill("solid", fgColor="6366F1")

    def sheet(title: str, headers: List[str], rows: List[List[Any]], widths: List[int], first: bool = False):
        ws = wb.active if first else wb.create_sheet()
        ws.title = title
        for col, header in enumerate(headers, 1):
            cell = ws.cell(row=1, column=col, value=header)
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = header_fill
            cell.alignment = Alignment(horizontal="center")
            ws.column_dimensions[cell.column_letter].width = widths[col - 1]
        for r, row in enumerate(rows, 2):
            for c, value in enumerate(row, 1):
                ws.cell(row=r, column=c, value=value)
        return ws

    sheet("Resumen", ["Indicador", "Valor"], summary_rows(report), [46, 60], first=True)
    sheet("Por estado", STATUS_HEADERS, status_rows(report), [20, 14, 14, 16, 18])
    detail = sheet("Propuestas", DETAIL_HEADERS, detail_rows(proposals, days=days), [38, 28, 18, 14, 10, 14, 14, 14])
    for row in detail.iter_rows(min_row=2, min_col=4, max_col=4):
        for cell in row:
            cell.number_format = "#,##0.00"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def render_pdf(report: Dict[str, Any], proposals: List[Dict[str, Any]], *, days: Optional[int] = None) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import LETTER, landscape
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    from app.rendering.brand_styles import (
        BRAND_BORDER, BRAND_DEEP_NAVY, BRAND_MUTED, BRAND_PRIMARY_INDIGO, BRAND_SOFT_INDIGO_SURFACE, BRAND_TEXT,
    )

    styles = getSampleStyleSheet()
    title = ParagraphStyle("PT", parent=styles["Title"], fontName="Helvetica-Bold", fontSize=20, leading=24,
                           textColor=colors.HexColor(BRAND_DEEP_NAVY), alignment=0, spaceAfter=4)
    meta = ParagraphStyle("PM", parent=styles["Normal"], fontName="Helvetica", fontSize=9, leading=12,
                          textColor=colors.HexColor(BRAND_MUTED), spaceAfter=12)
    heading = ParagraphStyle("PH", parent=styles["Heading3"], fontName="Helvetica-Bold", fontSize=11,
                             textColor=colors.HexColor(BRAND_DEEP_NAVY), spaceBefore=10, spaceAfter=6)
    cell = ParagraphStyle("PC", parent=styles["Normal"], fontName="Helvetica", fontSize=8, leading=10,
                          textColor=colors.HexColor(BRAND_TEXT))
    head = ParagraphStyle("PHd", parent=cell, fontName="Helvetica-Bold", textColor=colors.white)

    def table(headers: List[str], rows: List[List[Any]], widths: List[int]):
        data = [[Paragraph(h, head) for h in headers]]
        for row in rows:
            data.append([Paragraph(f"{v:,.2f}" if isinstance(v, float) and h == "Monto" else str(v), cell)
                         for v, h in zip(row, headers)])
        t = Table(data, colWidths=widths, repeatRows=1)
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(BRAND_PRIMARY_INDIGO)),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor(BRAND_SOFT_INDIGO_SURFACE)]),
            ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor(BRAND_BORDER)),
            ("INNERGRID", (0, 0), (-1, -1), 0.35, colors.HexColor(BRAND_BORDER)),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        return t

    detail = detail_rows(proposals, days=days) or [["Sin propuestas en el período.", "", "", "", "", "", "", ""]]
    story = [
        Paragraph("Reporte de pipeline de Ventas", title),
        Paragraph(f"NoonDalton AI Marketing Suite · {report['period']['label']} · {report['generatedAt'][:10]}", meta),
        table(["Indicador", "Valor"], summary_rows(report), [260, 400]),
        Paragraph("Propuestas por estado", heading),
        table(STATUS_HEADERS, status_rows(report), [180, 100, 100, 130, 150]),
        Paragraph("Detalle de propuestas", heading),
        table(DETAIL_HEADERS, detail, [150, 110, 80, 80, 45, 65, 65, 65]),
        Spacer(1, 8),
    ]
    if report.get("truncated"):
        story.append(Paragraph(f"El reporte se limitó a las {MAX_PROPOSALS} propuestas más recientes.", meta))
    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=landscape(LETTER), leftMargin=36, rightMargin=36, topMargin=40, bottomMargin=40).build(story)
    return buf.getvalue()
