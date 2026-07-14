"""
Celery application factory.

Workers are started with:
  celery -A app.workers.celery_app worker --loglevel=info -Q default,llm,exports

Queues:
  default  — general tasks
  llm      — LLM generation tasks (may be scaled independently)
  exports  — document export tasks
"""
from celery import Celery
from app.config import settings

DEFAULT_REDIS_URL = "redis://localhost:6379/0"
DEFAULT_RESULT_BACKEND = "redis://localhost:6379/1"


def _broker_url() -> str:
    if settings.celery_broker_url != DEFAULT_REDIS_URL:
        return settings.celery_broker_url
    return settings.redis_url


def _result_backend_url() -> str:
    if settings.celery_result_backend != DEFAULT_RESULT_BACKEND:
        return settings.celery_result_backend
    return settings.redis_url


celery_app = Celery(
    "nd_marketing",
    broker=_broker_url(),
    backend=_result_backend_url(),
    include=[
        "app.workers.tasks.content_tasks",
        "app.workers.tasks.asset_tasks",
    ],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,                   # ack only after task completes
    worker_prefetch_multiplier=1,           # one task at a time per worker
    broker_connection_timeout=2,            # fail fast if Redis is unreachable
    broker_connection_retry_on_startup=False,
    broker_connection_max_retries=1,        # so the sync fallback kicks in quickly
    broker_transport_options={"socket_connect_timeout": 2, "socket_timeout": 2},
    result_backend_transport_options={"socket_connect_timeout": 2, "socket_timeout": 2},
    task_routes={
        "app.workers.tasks.content_tasks.*": {"queue": "llm"},
    },
    beat_schedule={},                       # add periodic tasks here if needed
)
