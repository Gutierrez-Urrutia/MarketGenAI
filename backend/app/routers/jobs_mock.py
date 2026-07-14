from fastapi import APIRouter

router = APIRouter(
    prefix="/jobs",
    tags=["Jobs"]
)


@router.get("/{job_id}")
async def get_job_status(job_id: str):

    return {
        "jobId": job_id,
        "status": "completed",
        "progress": 100,
        "result": {
            "message": "Job completed successfully"
        },
        "createdAt": "2026-03-01T00:00:00Z",
        "updatedAt": "2026-03-01T00:00:05Z"
    }