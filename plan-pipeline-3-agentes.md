# Plan de Implementación — Pipeline de Prospección de 3 Agentes
### ND Sales Assistant v2 — Módulo Outreach

---

## 0. Contexto

**Estado actual del código** (confirmado por auditoría técnica sobre `MarketGen-AI/backend`):

- No existe ningún scraping ni integración con portales de empleo en el backend.
- No existe un paso separado de búsqueda de contactos: `generate_from_campaign` (en `routers/outreach.py`) asume que el contacto, su cargo y su empresa ya vienen cargados manualmente en la Oportunidad.
- El único código real de "prospección" hoy es una sola llamada a DeepSeek que redacta el mensaje y se auto-clasifica en la misma respuesta.
- No existen las colecciones `leads`, `contacts`, `pipeline_configs`, `pipeline_runs` en Firestore.

**Objetivo de este documento:** dejar un plan completo, paso a paso, de los 3 agentes tal como los describe la especificación original (`v2-agent-pipeline-spec.md`), con dos ajustes ya decididos:

1. **LLM único: DeepSeek.** Todos los prompts del pipeline (antes escritos para Gemini) se adaptan a DeepSeek — no se suma un segundo proveedor de LLM.
2. Se documenta el pipeline **completo**, incluyendo las partes que en una primera entrega podrían acotarse (scheduling automático, múltiples fuentes, dashboard). Ese recorte es una decisión de alcance aparte; este documento cubre la funcionalidad completa para que el equipo sepa exactamente qué construir cuando llegue el momento de cada pieza.

---

## 1. Visión general del pipeline

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  AGENTE 1        │     │  AGENTE 2         │     │  AGENTE 3         │
│  Job Scout       │────▶│  Lead Researcher  │────▶│  Email Composer   │
│                  │     │                   │     │                   │
│  Busca vacantes  │     │  Encuentra        │     │  Genera correo    │
│  por keywords    │     │  contactos de     │     │  personalizado    │
│  en fuentes      │     │  contratación     │     │  de venta         │
│  configuradas    │     │  (nombre, email)  │     │                   │
└─────────────────┘     └──────────────────┘     └──────────────────┘
         │                       │                        │
         ▼                       ▼                        ▼
   ┌──────────┐          ┌──────────┐            ┌──────────────┐
   │ leads    │          │ contacts │            │ outreach     │
   │ (Firestore)         │ (Firestore)           │ emails       │
   └──────────┘          └──────────┘            │ (Firestore)  │
                                                   └──────┬───────┘
                                                          │
                                                ┌─────────▼─────────┐
                                                │  COLA DE REVISIÓN │
                                                │  (UI Dashboard)   │
                                                │                   │
                                                │  Auto-envío si    │
                                                │  confidence ≥ 80  │
                                                │  Revisión manual  │
                                                │  si < 80          │
                                                └─────────┬─────────┘
                                                          │
                                                          ▼
                                                ┌───────────────────┐
                                                │  SMTP Sender      │
                                                │  (tarea Celery)   │
                                                └───────────────────┘
```

**Regla de negocio central:** el pipeline **no envía nada automáticamente sin pasar por el scoring de confianza**. Un lead de baja confianza en cualquiera de las 3 etapas (vacante poco relevante, contacto no verificado, email de baja calidad) termina en revisión manual, no en la bandeja de salida.

---

## 2. Modelo de datos (Firestore)

### 2.1 `pipeline_configs/{configId}`

Configuración global del pipeline por usuario/organización.

```python
from enum import Enum
from typing import Optional
from datetime import datetime
from pydantic import BaseModel

class SourceType(str, Enum):
    API = "api"           # APIs de job boards (JSearch, Adzuna, etc.)
    RSS = "rss"            # RSS/Atom feeds
    SCRAPER = "scraper"    # Web scraping con selectores CSS
    WEBHOOK = "webhook"    # Recibir datos push desde terceros

class JobSource(BaseModel):
    id: str
    name: str                          # "LinkedIn via RapidAPI", "Indeed RSS"
    source_type: SourceType
    enabled: bool = True
    config: dict                       # Flexible: api_key, url, selectors, headers
    rate_limit: Optional[int] = None   # requests por minuto
    last_fetched_at: Optional[datetime] = None

class PipelineConfig(BaseModel):
    id: str
    user_id: str
    keywords: list[str]                # ["BPO", "outsourcing", "back office", "data entry", ...]
    industries: list[str]              # ["finance", "healthcare", "retail"]
    excluded_companies: list[str]
    sources: list[JobSource]
    # Email settings
    smtp_host: str
    smtp_port: int = 587
    smtp_user: str
    smtp_password: str                 # Encriptado en Firestore (ver sección 9)
    sender_email: str
    sender_name: str
    # Umbrales de automatización
    auto_send_threshold: float = 0.80  # Confidence ≥ 80% → auto-envío
    max_emails_per_day: int = 50
    # Programación
    scan_frequency_hours: int = 24
    is_active: bool = True
    created_at: datetime
    updated_at: datetime
```

### 2.2 `leads/{leadId}`

Una vacante detectada que matchea con las keywords de NoonDalton.

```python
class LeadStatus(str, Enum):
    NEW = "new"                       # Recién encontrado por Agente 1
    RESEARCHING = "researching"       # Agente 2 buscando contactos
    CONTACTS_FOUND = "contacts_found"
    COMPOSING = "composing"           # Agente 3 generando email
    READY_FOR_REVIEW = "ready_for_review"
    APPROVED = "approved"
    AUTO_APPROVED = "auto_approved"
    SENT = "sent"
    REPLIED = "replied"
    REJECTED = "rejected"             # Descartado por el usuario
    ERROR = "error"

class Lead(BaseModel):
    id: str
    pipeline_config_id: str
    user_id: str
    # Datos de la vacante
    job_title: str
    company_name: str
    job_description: str
    job_url: str
    source_id: str
    location: Optional[str] = None
    salary_range: Optional[str] = None
    posted_date: Optional[datetime] = None
    # Matching
    matched_keywords: list[str]
    relevance_score: float             # 0-1, calculado por DeepSeek
    # Estado del pipeline
    status: LeadStatus = LeadStatus.NEW
    pipeline_run_id: str
    # Deduplicación
    fingerprint: str                   # hash(normalize(company) + normalize(job_title))
    created_at: datetime
    updated_at: datetime
```

### 2.3 `contacts/{contactId}`

```python
class ContactRole(str, Enum):
    HIRING_MANAGER = "hiring_manager"
    HR_RECRUITER = "hr_recruiter"
    DEPARTMENT_HEAD = "department_head"
    PROCUREMENT = "procurement"
    UNKNOWN = "unknown"

class Contact(BaseModel):
    id: str
    lead_id: str
    user_id: str
    full_name: str
    email: Optional[str] = None
    linkedin_url: Optional[str] = None
    job_title: str
    role: ContactRole
    company: str
    confidence_score: float            # 0-1
    source: str                        # "linkedin", "company_website", "apollo", etc.
    verified: bool = False             # Si el email fue verificado (MX check)
    created_at: datetime
```

### 2.4 `outreach_emails/{emailId}`

```python
class EmailStatus(str, Enum):
    DRAFT = "draft"
    PENDING_REVIEW = "pending_review"
    APPROVED = "approved"
    AUTO_APPROVED = "auto_approved"
    SENDING = "sending"
    SENT = "sent"
    FAILED = "failed"
    BOUNCED = "bounced"
    OPENED = "opened"
    REPLIED = "replied"

class OutreachEmail(BaseModel):
    id: str
    lead_id: str
    contact_id: str
    user_id: str
    subject: str
    body_html: str
    body_plain: str
    personalization_notes: str
    value_proposition: str
    confidence_score: float            # lead.relevance × 0.4 + contact.confidence × 0.3 + email_quality × 0.3
    auto_approved: bool = False
    status: EmailStatus = EmailStatus.DRAFT
    reviewed_by: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    sent_at: Optional[datetime] = None
    open_count: int = 0
    reply_received: bool = False
    created_at: datetime
    updated_at: datetime
```

### 2.5 `pipeline_runs/{runId}`

Registro de cada ejecución del pipeline (auditoría).

```python
class PipelineRunStatus(str, Enum):
    RUNNING = "running"
    COMPLETED = "completed"
    PARTIAL = "partial"
    FAILED = "failed"
    CANCELLED = "cancelled"

class PipelineRun(BaseModel):
    id: str
    pipeline_config_id: str
    user_id: str
    status: PipelineRunStatus
    leads_found: int = 0
    leads_new: int = 0
    contacts_found: int = 0
    emails_generated: int = 0
    emails_auto_approved: int = 0
    emails_pending_review: int = 0
    emails_sent: int = 0
    started_at: datetime
    agent1_completed_at: Optional[datetime] = None
    agent2_completed_at: Optional[datetime] = None
    agent3_completed_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    errors: list[dict] = []            # [{agent, message, lead_id, timestamp}]
```

---

## 3. Agente 1 — Job Scout

**Responsabilidad:** escanear las fuentes configuradas, extraer vacantes y evaluar su relevancia para NoonDalton.

### 3.1 Flujo paso a paso

1. Leer `PipelineConfig` (keywords, sources, excluded_companies).
2. Para cada fuente habilitada:
   1. Obtener datos según `source_type` (llamada a API, parseo de RSS, o scraping).
   2. Extraer: `job_title`, `company`, `description`, `url`, `location`, `date`.
   3. Generar `fingerprint = hash(normalize(company) + normalize(job_title))` y verificar si ya existe en Firestore.
   4. Si es nuevo → enviar a DeepSeek para scoring de relevancia.
3. DeepSeek analiza: ¿esta vacante indica que la empresa necesita servicios que NoonDalton ofrece?
4. Filtrar: solo se guardan leads con `relevance_score ≥ 0.6`.
5. Persistir en Firestore con `status = NEW`.

### 3.2 Prompt DeepSeek (scoring de relevancia)

```python
SYSTEM_PROMPT = """Eres un analista de ventas B2B para NoonDalton, empresa de outsourcing/BPO.
Respondes ÚNICAMENTE con un objeto JSON válido, sin texto adicional antes ni después."""

USER_PROMPT_TEMPLATE = """
Servicios de NoonDalton: {keywords_and_services}

Analiza esta vacante y determina si la empresa podría beneficiarse de los
servicios de NoonDalton (es decir, si la vacante indica que la empresa busca
talento que NoonDalton podría proveer como servicio externalizado).

Vacante:
- Título: {job_title}
- Empresa: {company}
- Descripción: {job_description}

Responde con este formato exacto:
{{
  "relevance_score": 0.0,
  "matched_keywords": ["keyword1", "keyword2"],
  "reasoning": "Explicación breve",
  "suggested_value_prop": "Propuesta de valor específica para esta empresa"
}}
"""
```

> **Nota DeepSeek vs Gemini:** DeepSeek no siempre respeta "solo JSON" tan estrictamente como Gemini con `response_mime_type`. Usar el parámetro `response_format={"type": "json_object"}` si el cliente de DeepSeek lo soporta, y de todas formas envolver el `json.loads()` en un `try/except` con un paso de limpieza (strip de ```json y ``` si el modelo los agrega).

### 3.3 Implementación técnica

```python
# backend/app/services/job_scout_service.py

class JobScoutService:
    """Adaptador por tipo de fuente."""

    def __init__(self, deepseek_client, firestore_client):
        self.deepseek = deepseek_client
        self.db = firestore_client

    async def scan_source(self, source: JobSource, keywords: list[str]) -> list["RawJobPosting"]:
        match source.source_type:
            case SourceType.API:
                return await self._scan_api(source, keywords)
            case SourceType.RSS:
                return await self._scan_rss(source, keywords)
            case SourceType.SCRAPER:
                return await self._scan_scraper(source, keywords)
            case SourceType.WEBHOOK:
                return []  # los webhooks son push, no pull

    async def _scan_api(self, source, keywords):
        """Llamada a API de job board (JSearch, Adzuna, The Muse, etc.).
        La config del source trae base_url, headers, query_template."""
        ...

    async def _scan_rss(self, source, keywords):
        """Parseo de RSS/Atom con filtro por keywords (feedparser)."""
        ...

    async def _scan_scraper(self, source, keywords):
        """Scraping con selectores CSS configurables (httpx + beautifulsoup4)."""
        ...

    async def score_relevance(self, posting: "RawJobPosting", pipeline_config: PipelineConfig) -> dict:
        """Llama a DeepSeek con el prompt de la sección 3.2 y parsea el JSON de salida."""
        ...

    def compute_fingerprint(self, company: str, job_title: str) -> str:
        import hashlib
        normalized = f"{company.strip().lower()}|{job_title.strip().lower()}"
        return hashlib.sha256(normalized.encode()).hexdigest()

    async def scan_all_sources(self, pipeline_run: PipelineRun) -> list[Lead]:
        """Orquesta el escaneo de todas las fuentes habilitadas, dedup, scoring y persistencia."""
        ...
```

### 3.4 Checklist de tareas

- [ ] Definir `SourceType` y `JobSource` como colección `pipeline_configs`
- [ ] Implementar `_scan_api` para al menos un proveedor real (JSearch o Adzuna)
- [ ] Implementar `_scan_rss` con `feedparser`
- [ ] Implementar `_scan_scraper` con `httpx` + `beautifulsoup4`
- [ ] Implementar deduplicación por `fingerprint`
- [ ] Adaptar y probar el prompt de scoring contra DeepSeek con vacantes reales
- [ ] Filtrar por `relevance_score ≥ 0.6` antes de persistir
- [ ] Endpoint `POST /pipeline/runs` para disparar el escaneo manualmente
- [ ] Tarea Celery `task_run_job_scout`

---

## 4. Agente 2 — Lead Researcher

**Responsabilidad:** para cada lead con `status = NEW`, encontrar personas involucradas en la contratación.

### 4.1 Flujo paso a paso

1. Tomar leads con `status = NEW`.
2. Para cada lead:
   1. Actualizar `status → RESEARCHING`.
   2. Buscar en fuentes de datos de contacto:
      - API de enriquecimiento (Apollo.io, Hunter.io, Clearbit)
      - Scraping del sitio corporativo ("About Us", "Team")
      - LinkedIn (perfil de empresa → empleados)
   3. DeepSeek analiza los perfiles encontrados y determina quién es probablemente el hiring manager o quién en HR/Procurement decidiría el outsourcing.
   4. Verificar emails (formato + chequeo MX básico).
   5. Persistir contactos en Firestore.
   6. Actualizar `status → CONTACTS_FOUND`.

### 4.2 Prompt DeepSeek (identificación de decisores)

```python
SYSTEM_PROMPT = """Eres un analista de ventas B2B para NoonDalton.
Respondes ÚNICAMENTE con un array JSON válido, sin texto adicional."""

USER_PROMPT_TEMPLATE = """
Analiza estos perfiles de la empresa {company} y determina quiénes son las
personas más relevantes para contactar respecto a una propuesta de outsourcing/BPO
para el rol: {job_title}.

Perfiles encontrados:
{profiles_json}

Prioriza:
1. Hiring manager directo del puesto
2. VP/Director del departamento relevante
3. Head of HR / Talent Acquisition
4. Procurement / Vendor Management

Responde con este formato exacto:
[
  {{
    "name": "...",
    "title": "...",
    "role": "hiring_manager|hr_recruiter|department_head|procurement",
    "confidence": 0.0,
    "reasoning": "..."
  }}
]
"""
```

### 4.3 Servicios de enriquecimiento (proveedores plegables)

```python
# backend/app/services/enrichment_service.py

class EnrichmentService:
    """Orquesta múltiples proveedores de datos de contacto."""

    def __init__(self, providers: list["BaseProvider"]):
        self.enabled_providers = providers

    async def find_contacts(self, company: str, job_context: str) -> list["RawContact"]:
        results = []
        for provider in self.enabled_providers:
            try:
                contacts = await provider.search(company, job_context)
                results.extend(contacts)
            except Exception as e:
                logger.warning(f"Provider {provider.name} failed: {e}")
        return self._deduplicate(results)

    def _deduplicate(self, contacts: list["RawContact"]) -> list["RawContact"]:
        ...

class BaseProvider:
    name: str
    async def search(self, company: str, job_context: str) -> list["RawContact"]:
        raise NotImplementedError

class ApolloProvider(BaseProvider):
    """Integración con Apollo.io API."""
    ...

class HunterProvider(BaseProvider):
    """Hunter.io — email finder."""
    ...

class WebScraperProvider(BaseProvider):
    """Scraping de la página corporativa (About/Team)."""
    ...
```

### 4.4 Verificación de email

```python
# backend/app/services/email_verification_service.py
import email_validator
import dns.resolver  # dnspython

def verify_email_format(email: str) -> bool:
    try:
        email_validator.validate_email(email)
        return True
    except email_validator.EmailNotValidError:
        return False

def check_mx_record(domain: str) -> bool:
    try:
        records = dns.resolver.resolve(domain, "MX")
        return len(records) > 0
    except Exception:
        return False
```

### 4.5 Checklist de tareas

- [ ] Definir `Contact` y `ContactRole` como colección `contacts`
- [ ] Implementar al menos un `BaseProvider` real (recomendado: `WebScraperProvider`, sin costo de API externa)
- [ ] Implementar `ApolloProvider` / `HunterProvider` si el presupuesto del proyecto lo permite
- [ ] Adaptar y probar el prompt de identificación de decisores contra DeepSeek
- [ ] Implementar verificación de formato + MX check
- [ ] Endpoint `POST /leads/{id}/research` para re-ejecutar el Agente 2 sobre un lead puntual
- [ ] Tarea Celery `task_run_lead_researcher`

---

## 5. Agente 3 — Email Composer

**Responsabilidad:** generar correos de venta personalizados y calcular un confidence score compuesto.

### 5.1 Estado actual vs objetivo

| | Estado actual (`generate_from_campaign`) | Objetivo |
|---|---|---|
| Entrada | Contacto/empresa cargados a mano | Lead + Contact generados por Agentes 1 y 2 |
| Pasos | 1 sola llamada a DeepSeek que redacta y clasifica a la vez | Mantiene 1 llamada, pero ahora consume datos reales del pipeline |
| Confidence score | No existe / no se usa para decidir nada | Score compuesto que decide auto-envío vs revisión manual |
| Salida | Mensaje de outreach genérico | `OutreachEmail` persistido con estado y trazabilidad |

**Importante:** el Agente 3 en sí ya tiene una implementación funcional (la llamada a DeepSeek existe y funciona). El trabajo real de este agente es **refactorizar su entrada** para que deje de asumir datos cargados a mano y empiece a consumir los `Lead` y `Contact` reales que producen los Agentes 1 y 2, y **agregar el cálculo del confidence score** que hoy no existe.

### 5.2 Flujo paso a paso

1. Tomar leads con `status = CONTACTS_FOUND`.
2. Para cada lead + sus contactos:
   1. Actualizar `status → COMPOSING`.
   2. Recopilar contexto: datos de la vacante, datos del contacto, keywords matcheados y value proposition del Agente 1, templates de NoonDalton si existen.
   3. DeepSeek genera el email personalizado (subject, body, CTA).
   4. Calcular `confidence_score` compuesto:
      - `lead.relevance_score × 0.4`
      - `contact.confidence_score × 0.3`
      - `email_quality_score × 0.3` (evaluado también por DeepSeek en la misma respuesta)
   5. Persistir `OutreachEmail`.
   6. Si `confidence_score ≥ auto_send_threshold` → `AUTO_APPROVED`; si no → `PENDING_REVIEW`.
   7. Actualizar `status → READY_FOR_REVIEW`.

### 5.3 Prompt DeepSeek (composición de email)

```python
SYSTEM_PROMPT = """Eres un experto en ventas B2B para NoonDalton, empresa líder en outsourcing y BPO.
Respondes ÚNICAMENTE con un objeto JSON válido, sin texto adicional."""

USER_PROMPT_TEMPLATE = """
Contexto:
- Empresa target: {company}
- Vacante detectada: {job_title}
- Descripción: {job_description_summary}
- Keywords matcheados: {matched_keywords}
- Propuesta de valor sugerida: {value_proposition}

Contacto:
- Nombre: {contact_name}
- Cargo: {contact_title}
- Rol en la contratación: {contact_role}

Instrucciones:
1. Escribe un email de venta corto (150-250 palabras)
2. Personaliza al contexto exacto de la vacante
3. Explica cómo NoonDalton puede resolver la necesidad que indica la vacante
4. Incluye un CTA claro (llamada, demo, reunión)
5. Tono profesional pero cercano, no genérico
6. NO menciones que detectaste la vacante mediante scraping

Responde con este formato exacto:
{{
  "subject": "...",
  "body_html": "...",
  "body_plain": "...",
  "personalization_notes": "Qué elementos se personalizaron",
  "quality_score": 0.0
}}
"""
```

### 5.4 Checklist de tareas

- [ ] Refactorizar `generate_from_campaign` para recibir `lead_id` + `contact_id` en vez de datos sueltos ingresados a mano
- [ ] Adaptar el prompt existente al formato de arriba (mantiene DeepSeek, solo cambia la fuente de los datos)
- [ ] Implementar el cálculo del `confidence_score` compuesto
- [ ] Implementar la lógica de `AUTO_APPROVED` vs `PENDING_REVIEW` según `auto_send_threshold`
- [ ] Endpoint `POST /leads/{id}/compose` para re-ejecutar el Agente 3 sobre un lead puntual
- [ ] Tarea Celery `task_run_email_composer`

---

## 6. Orquestador del pipeline

Coordina los 3 agentes en secuencia y registra métricas de cada corrida.

```python
# backend/app/services/pipeline_orchestrator.py

class PipelineOrchestrator:
    def __init__(self, job_scout, lead_researcher, email_composer, config):
        self.job_scout = job_scout
        self.lead_researcher = lead_researcher
        self.email_composer = email_composer
        self.config = config

    async def run_full_pipeline(self, pipeline_config_id: str, user_id: str) -> PipelineRun:
        """Ejecuta el pipeline completo. Se invoca desde Celery."""
        run = await self._create_run(pipeline_config_id, user_id)

        try:
            # Fase 1: escanear fuentes
            leads = await self.job_scout.scan_all_sources(run)
            run.leads_found = len(leads)
            run.leads_new = len([l for l in leads if l.status == LeadStatus.NEW])
            run.agent1_completed_at = datetime.utcnow()

            # Fase 2: investigar contactos (en lotes, para no saturar rate limits)
            for batch in self._batch(leads, size=5):
                contacts = await self.lead_researcher.research_batch(batch, run)
                run.contacts_found += len(contacts)
            run.agent2_completed_at = datetime.utcnow()

            # Fase 3: componer emails
            leads_with_contacts = await self._get_leads_with_contacts(run.id)
            for lead, contacts in leads_with_contacts:
                emails = await self.email_composer.compose_for_lead(lead, contacts, run)
                for email in emails:
                    if email.auto_approved:
                        run.emails_auto_approved += 1
                    else:
                        run.emails_pending_review += 1
                run.emails_generated += len(emails)
            run.agent3_completed_at = datetime.utcnow()

            run.status = PipelineRunStatus.COMPLETED
        except Exception as e:
            run.status = PipelineRunStatus.FAILED
            run.errors.append({"agent": "orchestrator", "message": str(e)})

        run.completed_at = datetime.utcnow()
        await self._save_run(run)
        return run

    async def run_single_agent(self, agent_name: str, lead_ids: list[str]):
        """Ejecuta un solo agente sobre leads específicos (para re-ejecuciones manuales)."""
        ...

    def _batch(self, items: list, size: int):
        for i in range(0, len(items), size):
            yield items[i:i + size]
```

**Checklist:**
- [ ] Implementar `run_full_pipeline` con manejo de errores por fase (que una fase falle no debe perder el trabajo de la fase anterior)
- [ ] Implementar `run_single_agent` para re-ejecuciones manuales desde la UI
- [ ] Registrar timestamps por agente (`agent1_completed_at`, etc.) para poder medir cuánto tarda cada etapa

---

## 7. Endpoints API nuevos

### 7.1 Pipeline Config (`/api/v1/pipeline`)

```
GET    /pipeline/config                    Obtener config del pipeline
PUT    /pipeline/config                    Actualizar config
POST   /pipeline/config/sources            Agregar fuente de datos
PUT    /pipeline/config/sources/{id}       Editar fuente
DELETE /pipeline/config/sources/{id}       Eliminar fuente
POST   /pipeline/config/sources/{id}/test  Probar conexión de fuente
PUT    /pipeline/config/keywords           Actualizar keywords/especializaciones
```

### 7.2 Pipeline Runs (`/api/v1/pipeline/runs`)

```
POST   /pipeline/runs                      Iniciar ejecución completa (job async)
GET    /pipeline/runs                      Listar ejecuciones (paginado)
GET    /pipeline/runs/{id}                 Detalle de ejecución con métricas
POST   /pipeline/runs/{id}/cancel          Cancelar ejecución en curso
POST   /pipeline/runs/{id}/retry           Re-ejecutar desde un punto
```

### 7.3 Leads (`/api/v1/leads`)

```
GET    /leads                              Listar leads (filtros: status, score, fecha, keyword)
GET    /leads/{id}                         Detalle con contactos y emails
PUT    /leads/{id}                         Actualizar (override manual de status/score)
DELETE /leads/{id}                         Descartar lead
POST   /leads/{id}/research                Re-ejecutar Agente 2 para este lead
POST   /leads/{id}/compose                 Re-ejecutar Agente 3 para este lead
```

### 7.4 Outreach Emails (`/api/v1/outreach`)

```
GET    /outreach                           Listar emails (filtros: status, auto_approved)
GET    /outreach/review-queue              Emails pendientes de revisión
GET    /outreach/{id}                      Detalle del email
PUT    /outreach/{id}                      Editar contenido del email
POST   /outreach/{id}/approve              Aprobar y encolar envío
POST   /outreach/{id}/reject               Rechazar email
POST   /outreach/bulk-approve              Aprobar múltiples a la vez
POST   /outreach/bulk-reject               Rechazar múltiples
POST   /outreach/{id}/regenerate           Re-generar con Agente 3
POST   /outreach/{id}/send                 Envío manual inmediato
```

### 7.5 Dashboard de Prospección (`/api/v1/pipeline/dashboard`)

```
GET    /pipeline/dashboard                 KPIs: leads/día, tasa de conversión, emails enviados
GET    /pipeline/dashboard/funnel          Funnel: encontrados → contactados → respondidos
```

---

## 8. Tareas Celery

```python
# backend/app/workers/tasks/pipeline_tasks.py

@celery_app.task(queue="llm", max_retries=2)
def task_run_full_pipeline(pipeline_config_id: str, user_id: str):
    """Ejecuta el pipeline completo de 3 agentes."""

@celery_app.task(queue="llm", max_retries=2)
def task_run_job_scout(pipeline_config_id: str, run_id: str):
    """Solo Agente 1: escanear fuentes."""

@celery_app.task(queue="llm", max_retries=2)
def task_run_lead_researcher(lead_ids: list[str], run_id: str):
    """Solo Agente 2: investigar contactos para leads específicos."""

@celery_app.task(queue="llm", max_retries=2)
def task_run_email_composer(lead_ids: list[str], run_id: str):
    """Solo Agente 3: componer emails para leads con contactos."""

@celery_app.task(queue="default", max_retries=3)
def task_send_email(email_id: str):
    """Enviar un email aprobado vía SMTP."""

@celery_app.task(queue="default")
def task_send_auto_approved_batch(run_id: str):
    """Enviar todos los emails auto-aprobados de un run."""

@celery_app.task(queue="default")
def task_scheduled_pipeline_scan():
    """Tarea periódica (Celery Beat): ejecutar el pipeline para configs activas."""
```

**Checklist:**
- [ ] Agregar `celery-beat` a las dependencias (no está en el proyecto actual)
- [ ] Configurar la tarea periódica `task_scheduled_pipeline_scan` en el scheduler
- [ ] Definir `max_retries` y backoff para cada tarea según su criticidad

---

## 9. Páginas frontend nuevas

### 9.1 Pipeline Settings (`/settings/pipeline`)
- Configurar keywords y especializaciones (tag input)
- Gestionar fuentes (CRUD con botón "Probar conexión")
- Configurar SMTP (con botón "Enviar email de prueba")
- Ajustar threshold de auto-aprobación (slider 0–100%)
- Configurar frecuencia de escaneo y límite diario de emails

### 9.2 Pipeline Dashboard (`/pipeline`)
- KPIs: leads encontrados hoy, emails pendientes, tasa de conversión
- Gráfico de funnel (Recharts)
- Timeline de las últimas corridas del pipeline
- Botón "Ejecutar pipeline ahora"

### 9.3 Leads List (`/pipeline/leads`)
- Tabla con filtros: status, relevance score, keyword, fuente, fecha
- Acciones masivas: research, compose, descartar
- Click → detalle del lead con timeline del pipeline

### 9.4 Review Queue (`/pipeline/review`)
- Vista tipo "inbox" de emails pendientes de revisión
- Preview del email con datos del lead y contacto al lado
- Botones: Aprobar, Editar y Aprobar, Rechazar, Regenerar
- Aprobación/rechazo masivo
- Badge en el sidebar con el conteo de pendientes

### 9.5 Outreach History (`/pipeline/outreach`)
- Historial de emails enviados
- Seguimiento de estado: enviado, abierto, respondido, rebotado
- Métricas de performance por keyword, fuente, template

---

## 10. Nuevas dependencias

### Backend

```
feedparser==6.0.11          # RSS/Atom parsing
beautifulsoup4==4.12.3      # Web scraping
httpx==0.27.0                # Cliente HTTP async (confirmar si ya está en uso)
aiosmtplib==3.0.1            # SMTP async
email-validator==2.1.0       # Validación de emails
dnspython==2.6.1              # Chequeo de registros MX
cryptography==42.0.0          # Encriptar SMTP passwords y API keys
celery[redis]==5.4.0          # Ya existe en el proyecto; agregar celery-beat
```

### Frontend

No se necesitan librerías nuevas mayores — Recharts, React Hook Form, TanStack Query y Zustand ya están instalados en el proyecto.

---

## 11. Seguridad y rate limiting

- **Passwords SMTP:** encriptados con Fernet (`cryptography`) antes de guardarse en Firestore.
- **API keys de proveedores** (job boards, Apollo, Hunter): mismo tratamiento que las passwords SMTP.
- **Rate limiting por fuente:** configurable en cada `JobSource`, aplicado en `JobScoutService`.
- **Límite diario de emails:** configurable en `PipelineConfig`, aplicado en el sender.
- **Deduplicación:** `fingerprint = hash(normalize(company) + normalize(job_title))`, evita contactar la misma vacante dos veces.
- **Opt-out tracking:** si un contacto responde pidiendo no ser contactado, se agrega a una lista negra que el Agente 1/2 debe respetar en corridas futuras.

---

## 12. Estrategia de testing

| Nivel | Qué cubrir |
|---|---|
| Unitario | Cada servicio (`JobScoutService`, `EnrichmentService`, cálculo de `confidence_score`) con mocks de las APIs externas y del cliente DeepSeek |
| Unitario | Parseo del JSON de salida de cada prompt, incluyendo casos donde DeepSeek devuelve texto extra fuera del JSON |
| Integración | El orquestador completo con datos de prueba controlados (sin llamar APIs reales) |
| Integración | Al menos una corrida end-to-end contra las APIs reales (job board real, DeepSeek real) en un entorno de staging, no en cada corrida de CI |
| Edge cases | Fuente sin resultados, empresa sin sitio web o sin página "Team", DeepSeek devolviendo un score fuera de rango, email sin MX válido |

---

## 13. Plan de implementación por fases

> Referencia de esfuerzo original (spec v1): ~9-10 semanas para el pipeline completo. Usar esta tabla para trackear avance real contra estimado.

### Fase 1 — Infraestructura (1-2 semanas)
- [ ] Modelos Firestore: `pipeline_configs`, `leads`, `contacts`, `outreach_emails`, `pipeline_runs`
- [ ] Schemas Pydantic
- [ ] Router de `PipelineConfig` + UI de Settings (keywords, sources, SMTP)
- [ ] Celery Beat para tareas programadas

### Fase 2 — Agente 1: Job Scout (1-2 semanas)
- [ ] `JobScoutService` con adaptadores por `source_type`
- [ ] Integración DeepSeek para scoring de relevancia
- [ ] Deduplicación
- [ ] Tarea Celery + endpoint de disparo manual
- [ ] UI de listado de leads

### Fase 3 — Agente 2: Lead Researcher (1-2 semanas)
- [ ] `EnrichmentService` con providers plegables
- [ ] Integración DeepSeek para identificar decisores
- [ ] Verificación de email (formato + MX)
- [ ] UI de contactos en el detalle del lead

### Fase 4 — Agente 3: Email Composer (1 semana)
- [ ] Refactor de `generate_from_campaign` para consumir Lead + Contact reales
- [ ] Prompt DeepSeek de personalización adaptado
- [ ] Confidence scoring compuesto
- [ ] Lógica de auto-aprobación

### Fase 5 — Cola de revisión + envío (1 semana)
- [ ] UI de Review Queue (estilo inbox)
- [ ] Servicio de envío SMTP (`aiosmtplib`)
- [ ] Aprobación/rechazo masivo
- [ ] Dashboard del pipeline con KPIs

### Fase 6 — Orquestador + scheduling (1 semana)
- [ ] `PipelineOrchestrator` (pipeline completo + corridas de un solo agente)
- [ ] Escaneos programados con Celery Beat
- [ ] Manejo de errores robusto + lógica de reintentos
- [ ] UI de historial de corridas

### Fase 7 — Pulido + testing (1 semana)
- [ ] Tests unitarios para cada servicio
- [ ] Tests de integración del pipeline
- [ ] Optimización de prompts DeepSeek
- [ ] Manejo de edge cases (sin resultados, API caída, etc.)

---

## 14. Estructura de archivos nuevos

```
backend/app/
├── routers/
│   ├── pipeline.py          # Config, runs, dashboard
│   ├── leads.py              # CRUD de leads + re-ejecución de agentes
│   └── outreach.py           # Emails, review queue, envío (extiende el existente)
├── schemas/
│   ├── pipeline.py           # PipelineConfig, JobSource, PipelineRun
│   ├── lead.py                # Lead, RawJobPosting
│   ├── contact.py             # Contact
│   └── outreach.py            # OutreachEmail
├── services/
│   ├── job_scout_service.py           # Agente 1
│   ├── lead_researcher_service.py     # Agente 2
│   ├── email_composer_service.py      # Agente 3 (refactor del existente)
│   ├── pipeline_orchestrator.py       # Orquestador
│   ├── enrichment_service.py          # Providers de datos de contacto
│   ├── email_verification_service.py  # Formato + MX check
│   ├── smtp_service.py                # Envío de emails
│   └── encryption_service.py          # Fernet encrypt/decrypt
└── workers/tasks/
    └── pipeline_tasks.py              # Todas las tareas Celery del pipeline

frontend/src/pages/
├── pipeline/
│   ├── PipelineDashboard.jsx
│   ├── PipelineSettings.jsx
│   ├── LeadList.jsx
│   ├── LeadDetail.jsx
│   ├── ReviewQueue.jsx
│   └── OutreachHistory.jsx
```

---

## 15. Dependencias externas a resolver antes de empezar a codear

| Dependencia | Para qué | Decisión pendiente |
|---|---|---|
| API de job board (JSearch, Adzuna, u otra) | Agente 1 | Elegir proveedor, crear cuenta y API key |
| Proveedor de enriquecimiento de contactos (Apollo/Hunter) | Agente 2 — opcional | Definir si se usa uno de pago o solo scraping propio |
| Credenciales SMTP reales | Envío de emails | Definir si se usa la cuenta de NoonDalton o una de pruebas del equipo |
| Cuenta DeepSeek con cupo suficiente | Los 3 agentes | Confirmar límites de uso frente al volumen esperado de leads |
