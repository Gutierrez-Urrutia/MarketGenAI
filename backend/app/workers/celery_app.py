"""
Celery application factory.

Workers are started with:
  celery -A app.workers.celery_app worker --loglevel=info -Q default,llm,exports

Queues:
  default  — general tasks
  llm      — LLM generation tasks (may be scaled independently)
  exports  — document export tasks
"""
import ssl
from celery import Celery
from app.config import settings

DEFAULT_REDIS_URL = "redis://localhost:6379/0"
DEFAULT_RESULT_BACKEND = "redis://localhost:6379/1"


def _broker_url() -> str:
    if settings.celery_broker_url and settings.celery_broker_url != DEFAULT_REDIS_URL:
        return settings.celery_broker_url
    return settings.redis_url or DEFAULT_REDIS_URL


def _result_backend_url() -> str:
    if settings.celery_result_backend and settings.celery_result_backend != DEFAULT_RESULT_BACKEND:
        return settings.celery_result_backend
    return settings.redis_url or DEFAULT_RESULT_BACKEND


_broker = _broker_url()
_backend = _result_backend_url()

celery_app = Celery(
    "nd_marketing",
    broker=_broker,
    backend=_backend,
    include=[
        "app.workers.tasks.pilot_tasks",
        "app.workers.tasks.content_tasks",
        "app.workers.tasks.asset_tasks",
        "app.workers.tasks.proposal_tasks",
        "app.workers.tasks.campaign_tasks",
        "app.workers.tasks.pipeline_tasks",
    ],
)

celery_app.conf.update(
    task_default_queue="default",
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,                   # ack only after task completes
    worker_prefetch_multiplier=1,           # one task at a time per worker
    task_publish_retry=False,
    task_publish_retry_policy={"max_retries": 1},
    broker_connection_timeout=5,            # per connection attempt
    broker_connection_retry_on_startup=True,
    broker_connection_max_retries=3,
    broker_transport_options={
        "socket_connect_timeout": 5,
        "socket_timeout": 5,
        "socket_keepalive": True,
        "health_check_interval": 25,
    },
    result_backend_transport_options={
        "socket_connect_timeout": 5,
        "socket_timeout": 5,
        "socket_keepalive": True,
        "health_check_interval": 25,
    },
    task_routes={
        "app.workers.tasks.content_tasks.*": {"queue": "llm"},
        "app.workers.tasks.asset_tasks.*": {"queue": "llm"},
        "app.workers.tasks.proposal_tasks.*": {"queue": "llm"},
        "app.workers.tasks.campaign_tasks.*": {"queue": "llm"},
        "app.workers.tasks.pipeline_tasks.*": {"queue": "llm"},
    },
    beat_schedule={},                       # add periodic tasks here if needed
)

# Soporte para Upstash Redis y conexiones seguras (rediss://)
if _broker.startswith("rediss://"):
    celery_app.conf.update(
        broker_use_ssl={"ssl_cert_reqs": ssl.CERT_NONE},
    )

if _backend.startswith("rediss://"):
    celery_app.conf.update(
        redis_backend_use_ssl={"ssl_cert_reqs": ssl.CERT_NONE},
    )

