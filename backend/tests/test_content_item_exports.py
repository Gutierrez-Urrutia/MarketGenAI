from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from tests.conftest import FAKE_USER_SUB

API = "/api/v1/content/generate"


def fake_content_item(item_type: str = "template") -> dict:
    content_by_type = {
        "case_study": """
<h1>42% faster follow-up for Atlas Retail</h1>
<div class="cs-meta"><span>Retail</span><span>North America</span><span>3 months</span></div>
<div class="cs-metrics">
  <div class="cs-metric"><span class="cs-metric-value">42%</span><span class="cs-metric-label">Faster response</span></div>
  <div class="cs-metric"><span class="cs-metric-value">31%</span><span class="cs-metric-label">Lower CAC</span></div>
  <div class="cs-metric"><span class="cs-metric-value">2.8x</span><span class="cs-metric-label">Campaign ROI</span></div>
</div>
<h2>The Challenge</h2>
<p>The team needed faster lead routing and more consistent campaign follow-up.</p>
<h2>The Solution</h2>
<ul><li>Automated lead prioritization.</li><li>Personalized outbound sequences.</li></ul>
<h2>Results</h2>
<p>The new workflow improved speed and visibility across sales and marketing.</p>
<blockquote class="cs-testimonial">"The workflow gave our team a cleaner operating rhythm." - Jamie Lee, VP Marketing</blockquote>
""",
        "whitepaper": """
<h1>AI Workflow Governance</h1>
<p class="wp-subtitle">A practical guide for commercial teams</p>
<div class="wp-meta"><span>NoonDalton Research</span><span>2026</span><span>8 pages</span></div>
<h2>Abstract</h2>
<p>Commercial teams need governed automation that improves throughput without losing accountability.</p>
<h2>Table of Contents</h2>
<ol><li>Operating model</li><li>Measurement</li><li>Rollout</li></ol>
<h2>Operating model</h2>
<p>Teams should define ownership, approval rules, and exception paths before scaling automation.</p>
""",
        "one_pager": """
<h1>NoonDalton Campaign Engine</h1>
<p class="op-tagline">Launch governed campaigns faster.</p>
<p class="op-intro">The engine helps marketing teams plan, generate, and measure outreach workflows.</p>
<h2>What's included</h2>
<ol><li>Campaign planning with reusable prompts.</li><li>Approval-ready content generation.</li><li>Performance reporting.</li></ol>
<h2>Typical results</h2>
<div class="op-metrics">
  <div class="op-metric"><span class="op-metric-value">35%</span><span class="op-metric-label">Faster launch</span></div>
  <div class="op-metric"><span class="op-metric-value">24%</span><span class="op-metric-label">More replies</span></div>
  <div class="op-metric"><span class="op-metric-value">18%</span><span class="op-metric-label">Lower effort</span></div>
</div>
<h2>How it works</h2>
<ol><li><strong>Step 1:</strong> Connect campaign context.</li><li><strong>Step 2:</strong> Generate assets.</li><li><strong>Step 3:</strong> Measure and optimize.</li></ol>
<div class="op-cta"><p>Book a working session</p><a href="https://example.com/demo">https://example.com/demo</a></div>
""",
    }
    return {
        "id": "content-item-001",
        "userId": FAKE_USER_SUB,
        "type": item_type,
        "title": "Post-demo Follow-up",
        "language": "en",
        "input_data": {
            "channel": "email",
            "category": "post_demo",
            "tone": "consultative",
            "merge_variables": ["first_name", "company", "demo_topic"],
        },
        "content": content_by_type.get(item_type, """
<h1>Post-demo Follow-up</h1>
<div class="tpl-meta">
  <span class="tpl-channel">email</span>
  <span class="tpl-category">post_demo</span>
  <span class="tpl-tone">consultative</span>
</div>
<div class="tpl-subject">
  <strong>Subject line:</strong>
  <p>Your {{demo_topic}} demo, {{first_name}}</p>
</div>
<div class="tpl-body">
  <p>Hi {{first_name}},</p>
  <p>Thank you for exploring how AI automation can support {{company}}.</p>
  <p>NoonDalton can help your team turn the demo workflow into a governed operating process.</p>
  <p>Would you like to schedule a working session next week?</p>
  <p>Best regards,</p>
</div>
<div class="tpl-variables">
  <h2>Merge Variables</h2>
  <ul>
    <li>{{first_name}} - recipient first name</li>
    <li>{{company}} - recipient company</li>
    <li>{{demo_topic}} - demo topic discussed</li>
  </ul>
</div>
""",
        ),
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("item_type", ["template", "case_study", "whitepaper", "one_pager"])
async def test_supported_content_item_download_returns_valid_pdf(client, item_type):
    with patch(
        "app.routers.content_types.content_items_repo.get",
        new_callable=AsyncMock,
        return_value=fake_content_item(item_type),
    ):
        resp = await client.get(f"{API}/content-items/content-item-001/download?format=pdf")

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"
    assert resp.content.startswith(b"%PDF")
    assert len(resp.content) > 1000


@pytest.mark.asyncio
async def test_social_post_stays_on_client_side_export_flow(client):
    item_type = "social_post"
    item = fake_content_item(item_type)
    item["title"] = item_type
    with patch(
        "app.routers.content_types.content_items_repo.get",
        new_callable=AsyncMock,
        return_value=item,
    ):
        resp = await client.get(f"{API}/content-items/content-item-001/download?format=pdf")

    assert resp.status_code == 422
    assert "not available" in resp.json()["detail"]
