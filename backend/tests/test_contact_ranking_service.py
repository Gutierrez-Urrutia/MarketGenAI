"""Tests for contact_ranking_service (RF15, Agente 2): role, ranking,
confidence and email verification. Pure, no network: the verifier is a
fake. Every name, address and domain is invented; the job titles are
generic ones seen in Hunter responses."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.core.pipeline_constants import (
    CONFIDENCE_FACTOR_BY_VERIFICATION,
    GENERIC_EMAIL_CONFIDENCE_CAP,
    HUNTER_MAX_VERIFICATIONS_PER_LEAD,
    RANK_TIER_AREA_HEAD,
    RANK_TIER_AREA_MANAGER,
    RANK_TIER_EXECUTIVE_LARGE,
    RANK_TIER_EXECUTIVE_MEDIUM,
    RANK_TIER_EXECUTIVE_SMALL,
    RANK_TIER_FINANCE,
    RANK_TIER_LAST_RESORT,
    RANK_TIER_OTHER_HEAD,
    RANK_TIER_PROCUREMENT,
    RANK_TIER_UNKNOWN_SENIOR,
    RANK_TOP_N,
)
from app.schemas.contact import ContactRole
from app.services import contact_ranking_service as svc
from app.services.contact_ranking_service import LeadContext, classify_title, company_size, rank_contacts, select_contacts
from app.services.enrichment_service import CompanyInfo, RawContact

CUSTOMER_LEAD = LeadContext(job_title="Customer Support Agent", company_name="Example Holdings", company_domain="example.com")
BACK_OFFICE_LEAD = LeadContext(job_title="Data Entry Clerk", company_name="Example Holdings")
NO_AREA_LEAD = LeadContext(job_title="Warehouse Picker", company_name="Example Holdings")

_counter = iter(range(10_000))


def contact(job_title="Operations Director", seniority="executive", confidence=0.9, status="valid", **extra):
    n = next(_counter)
    base = dict(
        full_name=f"Persona {n}", job_title=job_title, company="Example Holdings",
        email=f"persona{n}@example.com", confidence_score=confidence, provider_confidence_score=confidence,
        source="hunter", seniority=seniority, email_verification_status=status, email_type="personal",
    )
    base.update(extra)
    return RawContact(**base)


def company(headcount=None, **extra):
    return CompanyInfo(domain="example.com", organization="Example Holdings", headcount=headcount, **extra)


def titles(contacts):
    return [c.job_title for c in contacts]


# ── Role, one case per rule ───────────────────────────────────────────────────
@pytest.mark.parametrize("title, role", [
    ("CEO", ContactRole.EXECUTIVE),
    ("Chief Executive Officer", ContactRole.EXECUTIVE),
    ("Chief Growth Officer", ContactRole.EXECUTIVE),
    ("Co-Founder & CEO", ContactRole.EXECUTIVE),
    ("Owner", ContactRole.EXECUTIVE),
    ("President", ContactRole.EXECUTIVE),
    ("Managing Director", ContactRole.EXECUTIVE),
    ("Operations Director", ContactRole.DEPARTMENT_HEAD),
    ("Director of Sustainability", ContactRole.DEPARTMENT_HEAD),
    ("Vice President, Customer Experience", ContactRole.DEPARTMENT_HEAD),
    ("Head of Customer Care", ContactRole.DEPARTMENT_HEAD),
    ("Chief Operating Officer", ContactRole.DEPARTMENT_HEAD),
    ("Chief Financial Officer", ContactRole.DEPARTMENT_HEAD),
    ("CFO", ContactRole.DEPARTMENT_HEAD),
    ("Financial Controller", ContactRole.DEPARTMENT_HEAD),
    ("Head of Procurement", ContactRole.PROCUREMENT),
    ("Chief Procurement Officer", ContactRole.PROCUREMENT),
    ("Vendor Manager", ContactRole.PROCUREMENT),
    ("Strategic Sourcing Lead", ContactRole.PROCUREMENT),
    ("Buyer", ContactRole.PROCUREMENT),
    ("Talent Acquisition Partner", ContactRole.HR_RECRUITER),
    ("Senior Recruiter", ContactRole.HR_RECRUITER),
    ("Customer Operations Manager", ContactRole.HIRING_MANAGER),
    ("Technical Services Manager", ContactRole.HIRING_MANAGER),
    ("Station Manager", ContactRole.HIRING_MANAGER),
    ("Shift Supervisor", ContactRole.HIRING_MANAGER),
])
def test_role_by_title(title, role):
    classification = classify_title(title, "senior")
    assert classification.role == role
    assert classification.excluded is False


def test_vice_president_and_product_owner_are_not_executives():
    assert classify_title("Vice President of Operations", "executive").role == ContactRole.DEPARTMENT_HEAD
    assert classify_title("Product Owner", "senior").role == ContactRole.UNKNOWN


def test_titles_are_matched_ignoring_case_and_accents():
    assert classify_title("DIRECTÓR de Operaciones", "senior").role == ContactRole.DEPARTMENT_HEAD
    assert classify_title("ceo", None).role == ContactRole.EXECUTIVE


@pytest.mark.parametrize("title", [
    "Delivery Driver", "Bicycle Messenger", "Event Coordinator", "Airport Fire Officer",
    "Customer Service Representative", "Executive Assistant", "Data Entry Clerk",
])
def test_operational_staff_is_excluded_even_when_senior(title):
    classification = classify_title(title, "executive")
    assert classification.excluded is True


def test_an_operational_word_with_a_leadership_word_is_kept():
    assert classify_title("Driver Operations Manager", None).excluded is False
    assert classify_title("Assistant Director", None).role == ContactRole.DEPARTMENT_HEAD


@pytest.mark.parametrize("seniority, excluded", [(None, True), ("junior", True), ("", True),
                                                  ("senior", False), ("executive", False), ("SENIOR", False)])
def test_unknown_title_is_kept_only_when_senior(seniority, excluded):
    classification = classify_title("Account Executive", seniority)
    assert classification.role == ContactRole.UNKNOWN
    assert classification.excluded is excluded


def test_a_null_seniority_does_not_exclude_a_known_title():
    assert classify_title("Operations Director", None).excluded is False


@pytest.mark.parametrize("title, merchandise", [
    ("Buyer", True), ("Senior Buyer", True), ("Supplier Buyer", False),
    ("Strategic Sourcing Buyer", False), ("Head of Purchasing", False),
])
def test_buyer_of_merchandise_vs_supplier_management(title, merchandise):
    classification = classify_title(title, "senior")
    assert classification.role == ContactRole.PROCUREMENT
    assert classification.merchandise_buyer is merchandise


@pytest.mark.parametrize("title, areas", [
    ("Customer Operations Manager", {"customer", "operations"}),
    ("Technical Services Manager", {"technology"}),
    ("Chief Financial Officer", {"finance"}),
    ("Director of Sustainability", set()),
])
def test_title_areas(title, areas):
    assert classify_title(title, "senior").areas == areas


@pytest.mark.parametrize("job_title, area", [
    ("Customer Support Agent", "customer_service"),
    ("Call Center Representative", "customer_service"),
    ("Senior Software Developer", "software_it"),
    ("Data Entry Clerk", "back_office"),
    ("Loan Underwriter", "underwriting"),
    ("E-commerce Order Specialist", "ecommerce"),
    ("Claims Processor", "insurance"),
    ("Recruitment Coordinator", "hr_recruitment"),
    ("Warehouse Picker", None),
    ("", None),
    (None, None),
])
def test_vacancy_area(job_title, area):
    assert svc.vacancy_area(job_title) == area


# ── Company size (inactive in practice: Hunter sends no headcount) ────────────
@pytest.mark.parametrize("headcount, size", [
    ("1-10", "small"), ("11-50", "small"), ("50", "small"),
    ("51", "medium"), ("51-200", "medium"), ("201-500", "medium"), ("500", "medium"),
    ("501", "large"), ("501-1000", "large"), ("10001+", "large"), ("10K+", "large"), ("1,001-5,000", "large"),
    (None, "medium"), ("", "medium"), ("unknown", "medium"), (250, "medium"),
])
def test_company_size(headcount, size):
    assert company_size(headcount) == size


@pytest.mark.parametrize("headcount, expected_tier", [
    ("11-50", RANK_TIER_EXECUTIVE_SMALL),
    ("51-200", RANK_TIER_EXECUTIVE_MEDIUM),
    (None, RANK_TIER_EXECUTIVE_MEDIUM),
    ("501-1000", RANK_TIER_EXECUTIVE_LARGE),
])
def test_executive_tier_by_company_size(headcount, expected_tier):
    classification = classify_title("CEO", "executive")
    assert svc.tier(classification, "customer_service", company_size(headcount)) == expected_tier


def test_small_company_ranks_the_ceo_first_and_large_after_other_heads():
    contacts = [contact("Director of Sustainability"), contact("Operations Director"), contact("CEO")]
    assert titles(rank_contacts(contacts, CUSTOMER_LEAD, company("1-10")))[0] == "CEO"
    assert titles(rank_contacts(contacts, CUSTOMER_LEAD, company("5001-10000"))) == [
        "Operations Director", "Director of Sustainability", "CEO",
    ]
    assert titles(rank_contacts(contacts, CUSTOMER_LEAD, company())) == [
        "Operations Director", "CEO", "Director of Sustainability",
    ]


# ── Tiers ─────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("title, lead_area, expected_tier", [
    ("Operations Director", "customer_service", RANK_TIER_AREA_HEAD),
    ("Vice President, Customer Experience", "customer_service", RANK_TIER_AREA_HEAD),
    ("Director of Sustainability", "customer_service", RANK_TIER_OTHER_HEAD),
    ("Head of Procurement", "customer_service", RANK_TIER_PROCUREMENT),
    ("Chief Financial Officer", "back_office", RANK_TIER_FINANCE),
    ("Chief Financial Officer", "customer_service", RANK_TIER_OTHER_HEAD),
    ("Customer Operations Manager", "customer_service", RANK_TIER_AREA_MANAGER),
    ("Technical Services Manager", "customer_service", RANK_TIER_LAST_RESORT),
    ("Technical Services Manager", "software_it", RANK_TIER_AREA_MANAGER),
    ("Station Manager", "customer_service", RANK_TIER_LAST_RESORT),
    ("Talent Acquisition Partner", "customer_service", RANK_TIER_LAST_RESORT),
    ("Buyer", "customer_service", RANK_TIER_LAST_RESORT),
    ("Supplier Buyer", "customer_service", RANK_TIER_PROCUREMENT),
    ("Account Executive", "customer_service", RANK_TIER_UNKNOWN_SENIOR),
    ("Operations Director", None, RANK_TIER_OTHER_HEAD),
])
def test_tier(title, lead_area, expected_tier):
    assert svc.tier(classify_title(title, "senior"), lead_area, "medium") == expected_tier


def test_full_priority_order_for_a_customer_service_lead():
    contacts = [
        contact("Account Executive", seniority="senior"),
        contact("Station Manager"),
        contact("Buyer"),
        contact("Director of Sustainability"),
        contact("CEO"),
        contact("Customer Operations Manager"),
        contact("Head of Procurement"),
        contact("Operations Director"),
        contact("Delivery Driver"),
    ]
    ranked = rank_contacts(contacts, CUSTOMER_LEAD)
    assert titles(ranked) == [
        "Operations Director",          # 1 area head
        "Customer Operations Manager",  # 2 area manager; full tie with procurement → input order
        "Head of Procurement",          # 2 procurement
        "CEO",                          # 3 executive, medium company (default)
        "Director of Sustainability",   # 4 other head
        "Station Manager",              # 6 last resort
        "Buyer",
        "Account Executive",            # 7 unknown senior
    ]
    assert "Delivery Driver" not in titles(ranked)


def test_back_office_lead_puts_finance_with_procurement():
    contacts = [contact("Director of Sustainability"), contact("Chief Financial Officer"), contact("Operations Director")]
    assert titles(rank_contacts(contacts, BACK_OFFICE_LEAD)) == [
        "Operations Director", "Chief Financial Officer", "Director of Sustainability",
    ]


def test_ranking_sets_the_role():
    ranked = rank_contacts([contact("CEO", role="unknown"), contact("Buyer")], CUSTOMER_LEAD)
    assert {c.job_title: c.role for c in ranked} == {"CEO": ContactRole.EXECUTIVE, "Buyer": ContactRole.PROCUREMENT}


# ── Ties ──────────────────────────────────────────────────────────────────────
def test_tie_broken_by_seniority_then_confidence_then_verification_then_order():
    a = contact("Operations Director", seniority="senior", confidence=0.99, full_name="A")
    b = contact("Operations Director", seniority="executive", confidence=0.50, full_name="B")
    c = contact("Operations Director", seniority="executive", confidence=0.80, full_name="C")
    d = contact("Operations Director", seniority="executive", confidence=0.80, status="valid", full_name="D")
    e = contact("Operations Director", seniority=None, confidence=1.0, full_name="E")
    ranked = rank_contacts([a, b, c, d, e], CUSTOMER_LEAD)
    assert [x.full_name for x in ranked] == ["C", "D", "B", "A", "E"]


def test_same_confidence_better_verification_wins():
    # accept_all 1.0 x 0.85 == valid 0.85 x 1.0: the valid one goes first.
    accept_all = contact("Operations Director", confidence=1.0, status="accept_all", full_name="AcceptAll")
    valid = contact("Operations Director", confidence=0.85, status="valid", full_name="Valid")
    assert [c.full_name for c in rank_contacts([accept_all, valid], CUSTOMER_LEAD)] == ["Valid", "AcceptAll"]


def test_full_tie_keeps_the_input_order():
    first, second = contact(full_name="First"), contact(full_name="Second")
    assert [c.full_name for c in rank_contacts([first, second], CUSTOMER_LEAD)] == ["First", "Second"]
    assert [c.full_name for c in rank_contacts([second, first], CUSTOMER_LEAD)] == ["Second", "First"]


# ── Confidence ────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("status, factor", [
    ("valid", 1.0), ("accept_all", 0.85), ("unknown", 0.75), ("webmail", 0.75), ("weird", 0.75), (None, 0.6), ("", 0.6),
])
def test_confidence_by_verification_status(status, factor):
    [ranked] = rank_contacts([contact(confidence=0.8, status=status)], CUSTOMER_LEAD)
    assert ranked.confidence_score == pytest.approx(0.8 * factor)
    assert ranked.provider_confidence_score == 0.8


def test_confidence_factors_are_the_approved_values():
    assert CONFIDENCE_FACTOR_BY_VERIFICATION == {"valid": 1.0, "accept_all": 0.85, "unknown": 0.75, None: 0.6}
    assert GENERIC_EMAIL_CONFIDENCE_CAP == 0.3


@pytest.mark.parametrize("status", ["invalid", "disposable", "INVALID"])
def test_invalid_and_disposable_addresses_are_dropped(status):
    assert rank_contacts([contact(status=status)], CUSTOMER_LEAD) == []


def test_generic_address_is_capped():
    [ranked] = rank_contacts([contact(confidence=0.95, email_type="generic")], CUSTOMER_LEAD)
    assert ranked.confidence_score == GENERIC_EMAIL_CONFIDENCE_CAP


def test_without_provider_confidence_the_confidence_score_is_the_base():
    raw = contact(confidence=0.8, status="unknown", provider_confidence_score=None)
    [ranked] = rank_contacts([raw], CUSTOMER_LEAD)
    assert ranked.provider_confidence_score == 0.8
    assert ranked.confidence_score == pytest.approx(0.6)


def test_ranking_is_idempotent():
    contacts = [contact("CEO", status="accept_all"), contact("Operations Director", status=None)]
    once = rank_contacts(contacts, CUSTOMER_LEAD)
    assert rank_contacts(once, CUSTOMER_LEAD) == once


# ── select_contacts: top N and verification ───────────────────────────────────
class FakeVerification:
    def __init__(self, status, verified_at=datetime(2026, 4, 1, tzinfo=timezone.utc)):
        self.status = status
        self.verified_at = verified_at
        self.source = "hunter_email_verifier"


class FakeVerifier:
    def __init__(self, answers=None, exc=None):
        self.answers = answers or {}
        self.exc = exc
        self.calls = []

    async def verify_email(self, email):
        self.calls.append(email)
        if self.exc:
            raise self.exc
        answer = self.answers.get(email, "valid")
        return None if answer is None else FakeVerification(answer)


def five_heads(**overrides):
    return [contact("Operations Director", confidence=0.9 - i / 100, **overrides) for i in range(5)]


async def test_top_n_without_verifier():
    selected = await select_contacts(five_heads(), CUSTOMER_LEAD)
    assert len(selected) == RANK_TOP_N == 3


@pytest.mark.parametrize("count", [0, 1, 2])
async def test_fewer_than_two_candidates_delivers_what_there_is(count):
    contacts = five_heads()[:count] + [contact("Delivery Driver"), contact("Account Executive", seniority=None)]
    assert len(await select_contacts(contacts, CUSTOMER_LEAD)) == count


async def test_valid_top_contacts_are_not_verified():
    verifier = FakeVerifier()
    await select_contacts(five_heads(status="valid"), CUSTOMER_LEAD, company(), verifier)
    assert verifier.calls == []


async def test_only_one_verification_per_lead_and_only_from_the_top():
    assert HUNTER_MAX_VERIFICATIONS_PER_LEAD == 1
    contacts = five_heads(status="unknown")
    verifier = FakeVerifier()
    selected = await select_contacts(contacts, CUSTOMER_LEAD, company(), verifier)
    assert verifier.calls == [contacts[0].email]
    assert selected[0].email == contacts[0].email
    assert selected[0].email_verification_status == "valid"
    assert selected[0].email_verified_at == datetime(2026, 4, 1, tzinfo=timezone.utc)
    assert selected[0].email_verification_source == "hunter_email_verifier"
    assert selected[0].confidence_score == pytest.approx(0.9)  # factor 0.75 → 1.0


async def test_the_verified_contact_climbs_after_reranking():
    head_unknown = contact("Operations Director", confidence=0.90, status="unknown", full_name="Unknown")  # 0.675
    head_valid = contact("Operations Director", confidence=0.70, status="valid", full_name="Valid")        # 0.70
    selected = await select_contacts([head_unknown, head_valid], CUSTOMER_LEAD, company(), FakeVerifier())
    assert [c.full_name for c in selected] == ["Unknown", "Valid"]  # 0.90 valid now leads


@pytest.mark.parametrize("status", ["invalid", "disposable"])
async def test_an_address_found_invalid_gives_its_place_to_the_next(status):
    contacts = five_heads(status=None)
    verifier = FakeVerifier({contacts[0].email: status})
    selected = await select_contacts(contacts, CUSTOMER_LEAD, company(), verifier)
    assert contacts[0].email not in [c.email for c in selected]
    assert [c.email for c in selected] == [c.email for c in contacts[1:4]]
    assert len(verifier.calls) == 1  # the promoted one is not verified


async def test_webmail_result_counts_as_unknown():
    contacts = five_heads(status=None)
    selected = await select_contacts(contacts, CUSTOMER_LEAD, company(), FakeVerifier({contacts[0].email: "webmail"}))
    verified = next(c for c in selected if c.email == contacts[0].email)
    assert verified.email_verification_status == "webmail"
    assert verified.confidence_score == pytest.approx(0.9 * 0.75)


async def test_verifier_returning_none_keeps_the_contact_as_it_was():
    # None: Hunter answered 202 (still verifying), no credits left, or failed.
    contacts = five_heads(status="unknown")
    verifier = FakeVerifier({contacts[0].email: None})
    selected = await select_contacts(contacts, CUSTOMER_LEAD, company(), verifier)
    assert verifier.calls == [contacts[0].email]
    assert selected == rank_contacts(contacts, CUSTOMER_LEAD)[:3]


async def test_verifier_raising_keeps_the_contact_as_it_was():
    contacts = five_heads(status="unknown")
    selected = await select_contacts(contacts, CUSTOMER_LEAD, company(), FakeVerifier(exc=RuntimeError("boom")))
    assert selected == rank_contacts(contacts, CUSTOMER_LEAD)[:3]


async def test_accept_all_domain_is_never_verified():
    verifier = FakeVerifier()
    selected = await select_contacts(five_heads(status="unknown"), CUSTOMER_LEAD, company(accept_all=True), verifier)
    assert verifier.calls == []
    assert len(selected) == 3


async def test_accept_all_address_is_not_verified_but_the_next_is():
    contacts = [contact("Operations Director", confidence=0.95, status="accept_all"),
                contact("Operations Director", confidence=0.90, status="unknown")]
    verifier = FakeVerifier()
    await select_contacts(contacts, CUSTOMER_LEAD, company(), verifier)
    assert verifier.calls == [contacts[1].email]


async def test_contact_without_email_is_not_verified():
    contacts = [contact(status=None, email=None), contact(status=None, confidence=0.5)]
    verifier = FakeVerifier()
    await select_contacts(contacts, CUSTOMER_LEAD, company(), verifier)
    assert verifier.calls == [contacts[1].email]


async def test_contacts_outside_the_top_are_never_verified():
    contacts = five_heads(status="valid")[:3] + [contact("Operations Director", confidence=0.1, status=None)]
    verifier = FakeVerifier()
    await select_contacts(contacts, CUSTOMER_LEAD, company(), verifier)
    assert verifier.calls == []


async def test_logs_never_contain_contact_data(caplog):
    with caplog.at_level("DEBUG"):
        await select_contacts(
            [contact("Delivery Driver"), contact(status="invalid"), contact(status="unknown")],
            CUSTOMER_LEAD, company(), FakeVerifier(exc=RuntimeError("persona@example.com")),
        )
    assert "@example.com" not in caplog.text
    assert "Persona" not in caplog.text
