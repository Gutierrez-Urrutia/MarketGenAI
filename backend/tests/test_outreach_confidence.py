import json

import pytest

from app.routers import outreach


def test_normalize_classification_confidence_clamps_to_practical_max():
    assert outreach._normalize_classification_confidence(100) == 97
    assert outreach._normalize_classification_confidence("98") == 97
    assert outreach._normalize_classification_confidence(-4) == 0


def test_classification_confidence_from_payload_uses_conservative_fallback():
    assert outreach._classification_confidence_from_payload({}) == 50
    assert outreach._classification_confidence_from_payload({"classification_confidence": "bad"}) == 50


def test_with_classification_confidence_alias_keeps_legacy_score():
    payload = outreach._with_classification_confidence_alias({"subject": "Hello"}, 99)

    assert payload["classification_confidence"] == 97
    assert payload["score"] == 97
    assert payload["subject"] == "Hello"


@pytest.mark.asyncio
async def test_classify_response_type_returns_llm_classification_confidence(monkeypatch):
    async def fake_generate_text(prompt, **kwargs):
        return json.dumps({
            "response_type": "proposal",
            "reasoning": "The contact asked for pricing.",
            "subject": "Pricing next steps",
            "classification_confidence": 96,
        })

    monkeypatch.setattr(outreach.deepseek_service, "generate_text", fake_generate_text)

    body = outreach.GenerateResponseRequest(
        contact_message="Can you send pricing and rollout details?",
        name="Jordan Lee",
        company="Acme Growth",
        role="VP Marketing",
    )

    result = await outreach._classify_response_type(body)

    assert result["response_type"] == "proposal"
    assert result["classification_confidence"] == 96
    assert result["subject"] == "Pricing next steps"
