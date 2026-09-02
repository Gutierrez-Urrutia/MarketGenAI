"""Jobs router — poll async job status."""
from fastapi import APIRouter, Depends, HTTPException

from app.dependencies.auth import CurrentUser, get_current_user
from app.services.firestore_service import jobs_repo

router = APIRouter(prefix="/jobs", tags=["Jobs"])


@router.get("/{job_id}", response_model=dict)
async def get_job(
    job_id: str,
    user:   CurrentUser = Depends(get_current_user),
):
    try:
        job = await jobs_repo.get_or_404(job_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")

    if job.get("userId") != user.sub:
        raise HTTPException(status_code=403, detail="Access denied.")

    return job
