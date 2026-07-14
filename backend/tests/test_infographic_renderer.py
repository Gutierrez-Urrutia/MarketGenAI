"""Tests for the Book Concepts infographic PDF renderer."""
from __future__ import annotations

from app.rendering.infographic import build_infographic_pdf


def test_build_infographic_pdf_returns_pdf_bytes():
    pdf = build_infographic_pdf({
        "title": "AI Marketing Infographic",
        "subtitle": "A visual summary of the book concept",
        "sections": [
            {
                "heading": "Faster content production",
                "stat": "3x",
                "description": "Teams can turn long-form chapters into campaign assets more quickly.",
            },
            {
                "heading": "Better follow-up",
                "stat": "24h",
                "description": "Sales teams get fresh assets for timely outreach.",
            },
        ],
        "keyPoints": ["Reuse chapters", "Package insights", "Launch campaigns"],
        "callToAction": "Turn this book into a campaign-ready asset.",
    }, {"book_title": "AI Marketing Playbook"})

    assert pdf.startswith(b"%PDF")
    assert len(pdf) > 1000


def test_build_infographic_pdf_handles_sparse_data():
    pdf = build_infographic_pdf({"title": "Sparse"})

    assert pdf.startswith(b"%PDF")
