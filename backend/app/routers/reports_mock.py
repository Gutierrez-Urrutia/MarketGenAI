from fastapi import APIRouter

router = APIRouter(prefix="/reports", tags=["Reports"])


@router.get("/dashboard")
def get_dashboard():
    return {
        "totalProposals": 12,
        "totalProposalValue": 250000,
        "totalBooks": 5,
        "topAsset": "BPO Guide for Finance",
        "detected": 999,
        "researched": 214,
        "contacted": 156,
        "pending_review": 12,
        "replied": 18,
        "won": 7,
    }

@router.get("/proposals")
async def reports_proposals():
    return {
        "dimension": "status",
        "data": [
            {"label": "draft", "count": 5, "totalValue": 12000},
            {"label": "uploaded", "count": 3, "totalValue": 28000},
        ],
        "timeSeries": [
            {"date": "2026-03-01", "count": 2, "value": 8000},
            {"date": "2026-03-02", "count": 3, "value": 15000},
        ],
    }


@router.get("/content")
async def reports_content():
    return {
        "data": [
            {
                "bookId": "book_001",
                "bookTitle": "AI Marketing Guide",
                "status": "generated",
                "assetCount": 4,
                "downloadCount": 32,
                "createdAt": "2026-03-01",
            }
        ]
    }


@router.get("/export")
async def reports_export(format: str = "csv"):
    return {
        "message": "Report export generated",
        "format": format,
        "downloadUrl": f"/mock/reports/export.{format}",
    }