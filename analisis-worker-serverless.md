# Análisis: Celery Beat/Worker vs. backend serverless en Vercel

**Estado:** documento de análisis para discusión con el equipo. No implica ningún cambio de código.
**Contexto:** confirmado que la plataforma de despliegue es Vercel (ver `README.es.md` → sección
Despliegue). `v2-agent-pipeline-spec.md` y `plan-pipeline-3-agentes.md` (Fase 5-6) diseñan el pipeline de
prospección de 3 agentes asumiendo **Celery + Celery Beat** para la cola de trabajo y el escaneo
programado. Ese diseño choca con el modelo de ejecución de Vercel.

---

## 1. El problema

Vercel ejecuta el backend (`api/index.py` → `app.main.app`) como **funciones serverless**: cada request
instancia la función, la ejecuta y la destruye. No hay ningún proceso que permanezca vivo entre
invocaciones. Esto es incompatible con dos piezas que el plan asume:

- **Un worker de Celery**: debe permanecer corriendo, escuchando una cola (Redis), para poder procesar
  tareas encoladas. Una función serverless no puede "quedarse escuchando" nada — termina en cuanto
  responde.
- **Celery Beat**: es un scheduler que también debe correr de forma continua, comparando la hora actual
  contra el `beat_schedule` cada cierto intervalo, para decidir cuándo encolar la siguiente tarea
  periódica (el escaneo programado del pipeline). Tampoco puede vivir dentro de una función serverless.

Estado actual del código, confirmado:
- `backend/app/workers/celery_app.py` tiene `beat_schedule={}` (vacío) — el escaneo programado no está
  implementado, ni como esqueleto.
- `docker-compose.yml` define `worker` (Celery) y `redis`, pero el propio archivo se declara como
  `# Development docker-compose` — no hay evidencia de que ese worker corra en producción.
- El patrón de *sync fallback* ya documentado (`broker_connection_timeout=2`,
  `broker_connection_max_retries=1` en `celery_app.py`, y el manejo en `routers/books.py`:
  "Redis/Celery no disponible — ejecutar síncronamente") sugiere que hoy, en producción, probablemente
  **no hay ningún worker corriendo** y las tareas "asíncronas" existentes se ejecutan síncronas dentro
  de la función serverless cuando no encuentran un broker.

---

## 2. Opciones

### Opción A — Vercel Cron Jobs

Vercel puede invocar una URL propia del proyecto en un horario fijo (cron estándar). No es un worker: es
un *disparador* HTTP.

- **Qué resolvería**: el *scheduling* (reemplazaría a Celery Beat) — Vercel llamaría, por ejemplo,
  `GET /api/v1/pipeline/cron/scan` según los límites verificados del plan **Hobby** (confirmado, ver
  `README.es.md` → Despliegue):
  - **Cron**: 1 vez al día por tarea (expresión cron), hasta **100 tareas por proyecto**, precisión
    **±59 minutos** (Vercel puede invocar en cualquier momento dentro de la hora indicada).
  - **Duración máxima de función**: **300 segundos (5 min)**, sin extensión posible en Hobby (a
    diferencia de Pro/Enterprise, que sí pueden extenderla).
  - **Memoria**: 2 GB. **Payload máximo**: 4,5 MB.
- **Qué NO resolvería**: el trabajo pesado en sí. La función que Vercel invoca sigue siendo serverless,
  con el límite de 300 s de arriba. El pipeline completo (Agente 1 busca vacantes → Agente 2
  investiga contactos → Agente 3 redacta y encola envíos, con varias llamadas a DeepSeek y posible
  scraping) puede fácilmente exceder ese límite si hay muchas fuentes o muchos leads en una corrida.
- **Implica**: si se usa sola, cada scan tendría que ser lo bastante acotado (pocas fuentes, pocos leads
  por corrida) para caber en el timeout, o se necesitaría trocear el trabajo en varias invocaciones
  encadenadas (cron cada N minutos que procesa un lote pequeño y continúa donde quedó la corrida
  anterior) — lo cual es una reimplementación no trivial de lo que Celery Beat + un worker resuelven de
  forma nativa.
- **Costo/complejidad**: bajo (es una feature nativa de Vercel, sin infraestructura nueva), pero con el
  riesgo de timeouts si el volumen crece.

### Opción B — Worker (y Beat) en una plataforma con procesos persistentes

Desplegar el `worker` de Celery —y opcionalmente `beat`— tal como ya están definidos en
`docker-compose.yml`, pero en una plataforma que sí sostenga procesos de larga duración (Render, Railway,
Fly.io, una VM). Vercel seguiría sirviendo el frontend y los endpoints HTTP normales (incluido el que
encola tareas), pero el consumo de la cola y el scheduling correrían en ese servicio aparte, siempre
encendido.

- **Qué resolvería**: ambas piezas (worker + Beat) de forma nativa, sin reinventar nada — es exactamente
  el mismo código y la misma imagen Docker que ya existen (`backend/Dockerfile`,
  `celery -A app.workers.celery_app worker ...`), solo que en un host distinto a Vercel.
- **Qué implica**:
  - Redis debe ser accesible desde ambos lados (la función serverless de Vercel para encolar, y el
    worker en la otra plataforma para consumir). No puede ser el Redis local de `docker-compose.yml`;
    hace falta un Redis administrado con acceso desde internet (ej. Upstash Redis, que soporta TLS y
    tiene un plan gratuito orientado justo a este caso de uso serverless-friendly).
  - Es un segundo servicio a pagar, desplegar, monitorear y mantener actualizado — duplica la superficie
    operativa (dos plataformas, dos pipelines de despliegue, dos lugares donde puede fallar algo).
  - Requiere credenciales compartidas (Redis, Firestore, DeepSeek, SMTP cifrado) entre Vercel y la nueva
    plataforma — dos lugares donde gestionar secretos en vez de uno.
- **Costo/complejidad**: medio-alto (nueva infraestructura), pero es la opción que menos reescritura de
  código pide, porque es la arquitectura que el proyecto ya tiene diseñada y funcionando en
  `docker-compose.yml`.

### Opción C — Ejecución bajo demanda desde el endpoint (sin Celery)

Eliminar la dependencia de un worker persistente para el pipeline de prospección específicamente, y
correr cada paso directamente dentro de la función serverless que atiende la request, apoyándose en
alguna forma de cola/orquestación *serverless-native* en vez de Celery:

- Un cron externo (Vercel Cron, o el cron de cualquier otro servicio) golpea un endpoint que dispara la
  corrida.
- Si el trabajo no cabe en un solo timeout, se usa un servicio de colas serverless (ej. Upstash QStash,
  o colas nativas de la nube que se esté usando) que reintenta/continúa la cadena de pasos mediante
  llamadas HTTP encadenadas, en vez de un worker que consume continuamente.
- **Qué resolvería**: todo, sin agregar una segunda plataforma con procesos persistentes.
- **Qué implica**: es la opción que más reescritura pide — el pipeline (Fases 2-6 del plan, que todavía
  no existen) tendría que diseñarse desde el principio sobre este modelo en vez de sobre Celery/Beat como
  asume hoy `plan-pipeline-3-agentes.md` y `v2-agent-pipeline-spec.md`. Cambia también el patrón de
  reintentos, el manejo de fallos parciales, y probablemente el modelo de datos de `PipelineRun` (que
  hoy asume una corrida continua, no una cadena de invocaciones).
- **Costo/complejidad**: variable — bajo en infraestructura nueva (nada de servidores propios), pero alto
  en trabajo de diseño/reescritura del pipeline que aún no se ha construido.

---

## 3. Restricción adicional: transferencia del hosting al cliente

Los criterios de aceptación firmados comprometen transferir el hosting de Vercel a una cuenta propia de
NoonDalton **después de la defensa**. Esto cambia la evaluación: no solo importa qué tan bien resuelve
cada opción el problema técnico hoy, sino qué tan fácil es que el cliente reciba, mantenga y pague esa
infraestructura sin el equipo de desarrollo al lado.

La Opción B agrega una **segunda plataforma** (Render/Railway/Fly.io u otra) más un **Redis
administrado** (ej. Upstash). Eso significa que la transferencia al cliente ya no es "traspasar un
proyecto de Vercel", sino traspasar dos (o tres) cuentas distintas, cada una con su propia facturación,
su propio panel de administración, y sus propias credenciales que sincronizar con Vercel. Es exactamente
el tipo de complejidad operativa que el compromiso de transferencia busca evitarle al cliente.

## 4. Comparación: costo recurrente, complejidad de transferencia, esfuerzo en lo que queda del semestre

| Criterio | A — Vercel Cron (todo en Vercel) | B — Worker/Beat en otra plataforma + Redis administrado | C — Ejecución encadenada bajo demanda (todo en Vercel) |
|---|---|---|---|
| **Costo recurrente** | Solo la suscripción de Vercel (Cron con granularidad diaria ya viene en el plan Hobby; más frecuente requiere Pro, que probablemente ya se necesita por otras razones del proyecto). Sin costo adicional de infraestructura. | Vercel **+** la plataforma del worker **+** Redis administrado — tres facturas recurrentes en vez de una, aunque cada una sea individualmente barata (o incluso free tier) hoy. | Igual que A: solo Vercel. Si se usa una cola serverless externa (ej. Upstash QStash) para encadenar pasos, se suma un cuarto servicio, pero con planes gratuitos amplios para este volumen. |
| **Complejidad de transferencia al cliente** | Baja: transferir un proyecto de Vercel es una operación soportada nativamente ("Transfer Project"), una sola cuenta que el cliente debe aprender a administrar. | Alta: el cliente recibe y debe mantener **dos o tres** cuentas/paneles distintos, entender cómo se relacionan entre sí, y no romper la sincronización de credenciales entre ellos. Mayor probabilidad de que algo quede mal configurado en la transferencia. | Baja, igual que A — todo vive en el mismo proyecto de Vercel que ya se transfiere. |
| **Esfuerzo de implementación en lo que queda del semestre** | Medio: requiere diseñar el scan como trabajo por lotes acotados (para no exceder el timeout de la función), pero es trabajo que de todas formas hay que hacer porque las Fases 2-6 **no existen aún** — no hay código ya construido para Celery que se esté descartando. | Bajo *si* el objetivo fuera solo terminar rápido: reutiliza el patrón Celery ya armado en `docker-compose.yml`/`celery_app.py`. Pero suma trabajo de infraestructura nueva (elegir plataforma, provisionar Redis administrado, configurar CI/CD para un segundo servicio, probar la conexión entre ambos) que no aporta al pipeline en sí. | Medio-alto: es el diseño que más se aleja de lo que ya asumen `plan-pipeline-3-agentes.md` y `v2-agent-pipeline-spec.md` (pensados para Celery/Beat), así que además de construir las Fases 2-6 hay que adaptar ese diseño al modelo de invocaciones encadenadas. |

## 5. Recomendación revisada

**Cambia respecto al análisis anterior.** Con la restricción de transferencia, la Opción B deja de ser la
mejor opción pese a ser la de menor reescritura de código: el ahorro de esfuerzo hoy se paga con costo
recurrente extra y una transferencia mucho más frágil para el cliente después de la defensa — justo lo
que el compromiso firmado busca evitar.

**Nueva recomendación: Opción A, con el pipeline diseñado desde el inicio para caber en el modelo de
Vercel (más cercana a A que a C puro)** — es decir, Vercel Cron como disparador, y las Fases 2-6 del
pipeline construidas para trabajar en lotes acotados dentro del límite de tiempo de una función
serverless (guardando el progreso de cada `PipelineRun` en Firestore para poder retomar en la siguiente
invocación si un scan no alcanza a completarse en una sola pasada), en vez de asumir un worker
continuo. Esto:

- Mantiene todo en una sola plataforma (Vercel) → transferencia simple, un solo costo recurrente.
- No descarta trabajo ya hecho, porque las Fases 2-6 todavía no se han construido — es el mismo esfuerzo
  de diseño que habría que hacer de todas formas, solo que sobre un modelo distinto al de
  `v2-agent-pipeline-spec.md`.
- Es coherente con la restricción real del proyecto (transferencia al cliente) por sobre la
  conveniencia de reutilizar un patrón (Celery/Beat) que fue diseñado sin considerar esa restricción.

**Riesgo a vigilar**: si el volumen de fuentes/leads por scan resulta ser grande, el modelo por lotes
puede volverse difícil de manejar o lento en practica. Vale la pena validar con el equipo un volumen
aproximado esperado (cuántas fuentes, cuántos leads por corrida) antes de comprometerse con el diseño de
lotes, para confirmar que cabe cómodamente dentro de los límites de tiempo de Vercel.

---

## 6. Múltiples entradas de Cron para simular un escaneo cada N horas (Hobby)

**Verificado en la documentación oficial de Vercel** (`/docs/cron-jobs/usage-and-pricing` y
`/docs/cron-jobs/manage-cron-jobs`): el límite de "una vez al día" aplica **por expresión cron
individual**, no por proyecto. El límite por proyecto es de **100 tareas**, y ese límite de 100 se aplica
por igual en Hobby, Pro y Enterprise (cambio confirmado en el changelog "Cron jobs now support 100 per
project on every plan"). Es decir: **sí es válido y viable** declarar varias entradas en el arreglo
`crons` de `vercel.json`, cada una con su propia expresión diaria a una hora distinta, para que en
conjunto el proyecto reciba invocaciones varias veces al día — siempre que cada expresión individual siga
disparando solo una vez por día.

La propia documentación de Vercel muestra este patrón exacto como caso soportado: varias entradas
`crons` apuntando al **mismo path** con distinto `schedule`, leyendo el header
`x-vercel-cron-schedule` en el handler para saber cuál disparó la invocación:

```json
{
  "crons": [
    { "path": "/api/v1/pipeline/cron/scan", "schedule": "0 0 * * *" },
    { "path": "/api/v1/pipeline/cron/scan", "schedule": "0 4 * * *" },
    { "path": "/api/v1/pipeline/cron/scan", "schedule": "0 8 * * *" },
    { "path": "/api/v1/pipeline/cron/scan", "schedule": "0 12 * * *" },
    { "path": "/api/v1/pipeline/cron/scan", "schedule": "0 16 * * *" },
    { "path": "/api/v1/pipeline/cron/scan", "schedule": "0 20 * * *" }
  ]
}
```

### Restricción real: `vercel.json` es estático, `scan_frequency_hours` es por usuario

Este es el punto que el planteamiento original no resuelve del todo: las entradas de `crons` en
`vercel.json` se fijan **en el momento del deploy**, para todo el proyecto. No se puede crear una entrada
de Cron distinta por cada `PipelineConfig` (cada usuario ya tiene `scan_frequency_hours` como campo libre,
`Field(24, ge=1)`, en `backend/app/schemas/pipeline.py:81`) porque el número de usuarios/configs es
dinámico y Vercel no permite registrar cron jobs vía API en runtime para Hobby.

**Solución: un único set fijo de entradas Cron (la "base"), y filtrado por usuario dentro del handler.**

- Declarar en `vercel.json` una cadencia base fija — se propone **cada 4 horas** (6 entradas: `00, 04,
  08, 12, 16, 20`), que caben cómodas dentro de las 100 tareas permitidas.
- En cada invocación, el endpoint `GET /api/v1/pipeline/cron/scan` no dispara un scan genérico: recorre
  los `PipelineConfig` activos y para cada uno calcula si está **vencido** comparando
  `now - last_scan_at >= scan_frequency_hours` (no una comparación de hora exacta, sino de tiempo
  transcurrido — más robusta frente a la imprecisión de ±59 min de Hobby, ver sección 8). Solo los
  configs vencidos entran a la cola de trabajo de esa invocación.
- Con esto, `scan_frequency_hours` deja de mapear 1:1 a una entrada de Cron y pasa a ser simplemente el
  umbral que usa el filtro `last_scan_at`.

### Acotar las opciones del campo "frecuencia de escaneo (horas)"

Aunque el filtro por tiempo transcurrido funcionaría con cualquier valor entero (`ge=1` como está hoy),
tiene poco sentido exponerlo como número libre en la UI: con una cadencia base de 4 h, un usuario que
pida "cada 2 horas" nunca lo conseguiría (el chequeo más frecuente posible son 4 h), y quedaría
prometiendo algo que el sistema no cumple. Se propone:

| Opción visible en la UI | Cómo se resuelve con la base de 4 h |
|---|---|
| 24 horas | vencido en el primer chequeo del día siguiente (de los 6 posibles) |
| 12 horas | vencido, en la práctica, cada 2do chequeo (~12 h) |
| 8 horas | vencido cada 2do chequeo (~8 h) |
| 6 horas | vencido en el primer chequeo ≥ 6 h — con la base de 4 h esto **no cae exacto** y en la práctica corre cada 8 h (arrastre de hasta un chequeo base), no cada 6 h reales |
| 4 horas | vencido en cada chequeo (el máximo que permite la base) |

**Ajuste recomendado sobre la propuesta del equipo**: si se quiere que las opciones corran en el
intervalo que su nombre promete, la cadencia base de `vercel.json` debe ser un divisor común de todas
ellas, no de 4 h sola — **2 horas** (12 entradas de Cron, `00, 02, 04, ... 22`) es el mayor divisor común
de {2, 4, 6, 8, 12, 24} y sigue muy por debajo del límite de 100 tareas.

**Decisión aprobada por el equipo**: base de **2 horas** (12 entradas de Cron) y conjunto de opciones
`{24, 12, 8, 6, 4, 2}` horas.

### Cron solo "despierta" al sistema — la decisión de a quién le toca vive en el handler

Es importante dejarlo explícito porque es la premisa de la que dependen las secciones 6-11: **el archivo
`vercel.json` no sabe nada de usuarios ni de `PipelineConfig`**. Es estático por despliegue — declara
únicamente las 12 horas del día en que Vercel debe golpear `GET /api/v1/pipeline/cron/scan`. Toda la
lógica de "a qué configuración le toca correr ahora" (el filtro `elapsed >= frequency`, el orden de
atención, el bloqueo por config) vive **dentro del handler**, evaluada en cada invocación contra el
estado real en Firestore. El cron nunca sabe de antemano cuántos usuarios hay ni cuál está vencido — solo
dispara la función cada 2 h y la función decide.

### Holgura en el umbral de vencimiento

Comparar `elapsed >= frequency` a secas es incorrecto dada la imprecisión de ±59 min de Hobby (sección 8)
combinada con una base de chequeo de 2 h: si la config pide **2 horas** y el primer chequeo cae, por mala
suerte, con 59 min de atraso, para cuando el sistema vuelve a mirar (próximo chequeo, ~2 h después) ya
pasaron ~2h59min desde el último scan, pero `elapsed >= 2h` ya se habría cumplido en el chequeo anterior
si no fuera por el atraso — el riesgo real es el inverso: si el chequeo llega **adelantado** (posible
también dentro de la ventana de ±59 min, aunque en la práctica Vercel solo atrasa, nunca adelanta, dentro
de la hora indicada) o si `last_scan_at` quedó fijado unos minutos tarde por el propio procesamiento del
scan anterior, un chequeo puede llegar a *menos* de 2h exactas desde el `last_scan_at` registrado y
saltarse ese ciclo — empujando la config al siguiente chequeo de la base (4 h después), es decir, el
doble del intervalo prometido.

**Solución: aplicar una holgura (tolerancia) explícita al umbral**, comparando:

```
elapsed >= (scan_frequency_hours * 60 - TOLERANCE_MINUTES) minutos
```

con `TOLERANCE_MINUTES = 30` (media hora) como valor propuesto — lo bastante grande para absorber el
desfase entre la hora nominal del chequeo y la hora real de ejecución (recordando que Hobby ya puede
atrasar la invocación hasta 59 min sobre la hora programada) sin ser tan grande como para que una config
de "2 horas" dispare, en la práctica, cada 1h30. Con la base de chequeo cada 2 h y esta holgura de 30 min,
el peor caso para cualquier opción del conjunto {2,4,6,8,12,24} es que corra en el **primer chequeo posible
igual o después de `frequency - 30min`** — nunca salta un ciclo completo porque el próximo chequeo (2 h
después) siempre cae dentro de esa ventana de tolerancia respecto al chequeo anterior.

---

## 7. Tamaño de lote y progreso en `pipeline_runs` para retomar entre invocaciones

Con 300 s de tope por ejecución y un pipeline de 3 agentes (búsqueda de vacantes → investigación de
contactos → redacción/encolado, con llamadas a DeepSeek y posible scraping por medio), una sola invocación
no puede asumir que terminará el scan completo de un `PipelineConfig`. Diseño propuesto, apoyado en el
modelo `PipelineRun` que ya define `plan-pipeline-3-agentes.md` (sección 2.5):

- **Un `PipelineRun` por scan lógico, no por invocación HTTP.** Al detectar un `PipelineConfig` vencido
  (sección 6), el handler busca si ya existe un `PipelineRun` con `status = RUNNING` o `PARTIAL` para ese
  `pipeline_config_id`; si existe, retoma ese run en vez de crear uno nuevo. Si no existe, crea uno con
  `status = RUNNING`.
- **Cursor de progreso dentro de `PipelineRun`.** Se agrega al modelo un campo de cursor explícito —
  p. ej. `current_stage` (`"agent1_sources" | "agent2_contacts" | "agent3_outreach"`) y, dentro de cada
  etapa, un puntero al último ítem procesado (`last_source_index`, `last_lead_id` procesado por Agente 2,
  `last_lead_id` procesado por Agente 3). Cada iteración de trabajo actualiza ese cursor en Firestore
  **antes** de pasar al siguiente ítem del lote, no solo al final — así una invocación que se corta a
  mitad de camino (por timeout o por error) deja el cursor en el último ítem completado, no en el último
  intentado.
- **Tamaño de lote acotado por tiempo, no por cantidad fija.** En vez de fijar "N leads por invocación",
  el handler debe llevar un control de tiempo transcurrido (`invocation_deadline = start_time + margen`,
  con margen conservador — p. ej. cortar a los 260 s de los 300 disponibles, dejando ~40 s de colchón para
  el cierre ordenado y el guardado final del cursor) y detener el procesamiento de ítems nuevos apenas se
  acerca al límite, guardando el cursor y devolviendo `status = PARTIAL`.
- **Reanudación**: la siguiente invocación de Cron (la próxima entrada de la base de 2 h) vuelve a evaluar
  qué `PipelineConfig` están vencidos o tienen un run `PARTIAL` pendiente, y continúa ese `PipelineRun`
  desde el cursor guardado, no desde cero. Esto requiere que cada paso de cada agente sea **idempotente**
  frente a reintentos parciales (ej. el `fingerprint` de vacantes ya mencionado en
  `plan-pipeline-3-agentes.md` sección 3.1 evita reprocesar la misma vacante si una invocación se repite
  sobre un ítem ya guardado) — coherente con la recomendación de la propia documentación de Vercel sobre
  Cron jobs: "cron jobs should be resilient to both missed runs and duplicate runs" (ver sección 8).
- **Cierre del run**: cuando el cursor llega al final de las 3 etapas dentro de una misma invocación,
  `PipelineRun.status` pasa a `COMPLETED` (o `FAILED` si hubo un error no recuperable) y se limpia como
  "run activo" para ese `PipelineConfig`, liberando la próxima invocación vencida para iniciar un run
  nuevo.

### Bloqueo por configuración: evitar que dos invocaciones trabajen la misma config a la vez

Con una base de 12 chequeos/día y, potencialmente, invocaciones de Cron que se entregan duplicadas (ver
sección 8, "Cron job delivery and idempotency" en la documentación de Vercel), dos invocaciones pueden
llegar a solaparse en el tiempo (una que va atrasada por el ±59 min de imprecisión, más la siguiente que
ya dispara puntual) y ambas intentar tomar el mismo `PipelineConfig` vencido. Sin un candado, ambas
avanzarían el mismo `PipelineRun` en paralelo — duplicando llamadas a DeepSeek, corrompiendo el cursor, o
generando leads/emails duplicados.

**Diseño de bloqueo, usando el propio `PipelineRun` como lock (sin infraestructura nueva — sin Redis, sin
locks distribuidos)**:

- Al iniciar o retomar un `PipelineRun`, el handler hace un **update transaccional** en Firestore
  (`run_transaction` o un `update` condicional) que solo tiene éxito si el estado actual del run es
  distinto de `RUNNING`, o si es `RUNNING` pero su `locked_until` (nuevo campo, timestamp UTC) ya
  **venció**. Si la condición no se cumple, el handler asume que otra invocación ya está trabajando esa
  config y la salta.
- Al tomar el lock, el handler fija `status = RUNNING`, `locked_at = now`, y `locked_until = now +
  LOCK_TIMEOUT` (propuesta: `LOCK_TIMEOUT` un poco mayor al margen de la invocación de la sección 7, p.
  ej. **6 minutos**, sobre los ~300 s de tope de función) — así, si la invocación muere a mitad de camino
  (timeout duro de Vercel, crash, corte de red) sin llegar a guardar `status = PARTIAL`, el lock expira
  solo y la siguiente invocación puede retomar el run sin quedar bloqueada indefinidamente.
- Cada vez que el handler actualiza el cursor de progreso (sección 7) dentro de la misma invocación,
  refresca también `locked_until = now + LOCK_TIMEOUT`, para que un run legítimo que va lento no pierda su
  lock a mitad de un lote largo.
- Este mismo mecanismo cubre las invocaciones de Cron duplicadas: la segunda invocación de la misma
  entrada de Cron llega, intenta tomar el lock de los mismos `PipelineConfig` vencidos, lo encuentra
  tomado y vigente, y simplemente no hace nada para esas configs en esa pasada.

### Orden de atención: procesar primero al que lleva más tiempo esperando

Cada invocación tiene ~300 s en total, repartidos entre **todos** los `PipelineConfig` vencidos de **todos
los usuarios**, no solo uno. Si el handler siempre recorre la lista de configs en el mismo orden (p. ej.
por `id` de Firestore o por orden de creación), los primeros de la lista consumen la mayor parte del
presupuesto de tiempo en cada invocación y los últimos pueden quedar sistemáticamente sin turno si el
número de configs vencidas crece — un problema de inanición (*starvation*), no solo de rendimiento.

**Regla propuesta**: antes de procesar, ordenar los `PipelineConfig` vencidos por `last_scan_at`
ascendente (el que lleva **más tiempo sin escanear primero**, `NULL`/nunca escaneado con máxima
prioridad), y consumir esa cola en ese orden hasta agotar el margen de tiempo de la invocación (sección 7).
Esto garantiza que, aunque una invocación no alcance a cubrir a todos los vencidos, el próximo chequeo (2 h
después) vuelve a evaluar el conjunto completo y los que quedaron afuera esta vez pasan a la cabeza de la
cola la próxima vez (porque su `last_scan_at` sigue siendo el más antiguo) — ninguna config queda
indefinidamente al final de la fila.

## 8. Precisión de Cron en Hobby: no se puede prometer una hora exacta

Confirmado en `/docs/cron-jobs/manage-cron-jobs` ("Cron jobs accuracy"): en Hobby, **Vercel puede invocar
la función en cualquier momento dentro de la hora indicada**, para repartir carga entre cuentas — una
entrada `"0 8 * * *"` puede disparar en cualquier punto entre `08:00:00` y `08:59:59`. (En Pro/Enterprise
la precisión es por minuto). Además, la entrega de Cron es *best effort*: puede haber invocaciones
perdidas o duplicadas.

**Implicaciones para el diseño y para lo que se comunica al cliente**:
- La UI de configuración (pestaña Pipeline) **no debe prometer** "el scan corre a las 08:00" ni mostrar
  una hora exacta de próxima ejecución — a lo sumo, "próximo chequeo: dentro de la ventana de las 08:00 a
  las 08:59", o directamente evitar mostrar hora y solo mostrar `last_scan_at` / `next_scan_due_after`
  (calculado, no garantizado).
- El diseño de la sección 6 (comparar tiempo transcurrido, no hora exacta) y de la sección 7 (cursor
  idempotente) ya asume esta imprecisión — es la razón por la que el filtrado usa `now - last_scan_at >=
  scan_frequency_hours` en vez de "¿es la hora X en punto?".
- Por la entrega *best effort*, el endpoint de Cron debe tratar una invocación perdida como algo normal:
  el siguiente chequeo (como máximo 2 h después, con la base propuesta) recogerá cualquier
  `PipelineConfig` que se pasó de su umbral, sin intervención manual.

## 9. Vercel Workflows como alternativa para trabajos largos — sí está disponible en Hobby, pero se descarta por ahora

**Corrección respecto a una primera lectura de la documentación**: verificado en detalle en
`/docs/workflows/pricing`, **Vercel Workflows sí está disponible en el plan Hobby**, con cuota mensual
incluida (no requiere Pro/Enterprise para empezar a usarlo):

- **Hobby incluido**: 50.000 "Workflow Events"/mes y 1 GB de "Workflow Data Written"/mes, sin costo. Sobre
  esa cuota: $0.02 por cada 1.000 eventos adicionales y $0.50/GB adicional.
- **Retención del estado del run**: solo **1 día** en Hobby (7 días en Pro, 30 en Enterprise) — no
  configurable salvo contactando soporte.
- **Duración**: cada paso (`'use step'`) sigue las mismas reglas de duración de Vercel Functions (300 s en
  Hobby, la misma sección 1), pero la duración **total del run no tiene límite** (`Maximum run duration:
  No limit`, `Maximum sleep duration: No limit`) — es decir, sí resuelve el problema de fondo: un run que
  pausa y reanuda a través de múltiples invocaciones de función, sin que el desarrollador tenga que
  implementar el cursor manual de la sección 7 a mano.
- Existe soporte de Python vía el SDK `vercel` (`vercel.workflow` según `/docs/workflows`), no solo
  JS/TS — relevante porque el backend de este proyecto es FastAPI/Python, no Next.js.

**Aun así, se recomienda no adoptarlo todavía para este proyecto — no por incompatibilidad, sino por la
misma razón de la sección 3 (transferencia al cliente) y por madurez/alcance para lo que queda del
semestre**:
- Es un SDK y modelo de programación nuevo (`'use workflow'` / `'use step'`, persistencia gestionada por
  Vercel, Vercel Queues por debajo) que el equipo tendría que aprender y que el cliente heredaría junto
  con el resto del proyecto — más superficie a explicar en la transferencia que un patrón de Cron +
  Firestore que ya usa piezas que el proyecto ya tiene.
- La retención de 1 día en Hobby para el estado gestionado por Workflows es más corta que lo que
  probablemente se quiera conservar como auditoría de `PipelineRun` (el equipo ya modela `pipeline_runs`
  en Firestore con retención propia) — se necesitaría de todas formas seguir escribiendo el resumen del
  run a Firestore aparte, duplicando parte del trabajo.
- El diseño de las secciones 6-8 (Cron + cursor manual en `PipelineRun`) ya cubre el mismo problema con
  las piezas que el proyecto ya conoce (Firestore, sin SDK nuevo), a costo de más código explícito en vez
  de más "magia" administrada por Vercel.
- **Si el volumen de fuentes/leads por scan resulta ser grande** (ver "Riesgo a vigilar" en la sección 5)
  y el diseño por lotes de la sección 7 se vuelve difícil de mantener, **Workflows es la alternativa
  concreta a evaluar primero** — está confirmado que es viable en Hobby y evitaría reescribir el cursor a
  mano. No es una opción teórica descartada por plan, es una decisión de alcance para este semestre.

## 10. Zona horaria: Cron corre en UTC, la app muestra hora de Santiago

Vercel Cron programa y dispara sus invocaciones en **UTC** — las expresiones cron del arreglo `crons` de
`vercel.json` (`"0 0 * * *"`, etc.) se interpretan en UTC, sin excepción por región del proyecto. La app,
en cambio, muestra fechas/horas en horario de Santiago de Chile (`America/Santiago`, con el matiz de que
Chile continental tiene cambio de horario de verano, por lo que el offset respecto a UTC no es constante
todo el año: UTC-3 en horario de verano, UTC-4 en horario de invierno).

**Regla para todo el diseño de las secciones 6-9**: todas las marcas de tiempo que se persisten en
Firestore (`last_scan_at`, `locked_at`, `locked_until`, `started_at`, `completed_at` de `PipelineRun`,
etc.) se guardan **en UTC**, sin excepción — es lo que ya hace el resto del proyecto con `datetime`
consistente, y es indispensable para que la comparación `elapsed >= frequency - tolerancia` (sección 6)
sea correcta sin tener que normalizar zonas horarias en cada cálculo.

**Qué ve el usuario**: la conversión a horario de Santiago ocurre **solo en la capa de presentación**
(frontend), al formatear un timestamp UTC para mostrarlo — nunca al calcular si una config está vencida ni
al decidir el orden de atención. Concretamente:
- La pestaña Pipeline debe mostrar `last_scan_at` convertido a hora de Santiago (ej. "Último escaneo: hoy
  14:32"), consistente con el resto de la UI (que ya usa `LanguageContext`/`i18n` para formato regional).
  El backend sigue entregando el timestamp en UTC (ISO 8601 con offset o `Z`); la conversión de zona
  horaria la hace el frontend con las utilidades de fecha que ya use el proyecto (o `Intl.DateTimeFormat`
  con `timeZone: 'America/Santiago'`), no el backend.
- Consistente con la sección 8 (no prometer hora exacta), evitar mostrar "próximo escaneo: 14:00" como una
  promesa puntual — mejor "próximo escaneo: entre las 14:00 y las 14:59" o, más simple, no mostrar una
  hora futura y limitarse a mostrar el último escaneo completado y su resultado.

## 11. Constantes en un solo lugar

La base de frecuencia de Cron (2 horas) y el conjunto de opciones `{24, 12, 8, 6, 4, 2}` no deben quedar
repetidos como literales en el handler del endpoint de Cron, en `backend/app/schemas/pipeline.py` (donde
hoy `scan_frequency_hours` es un `int` libre con `ge=1`) y en el frontend (el `<select>` de la pestaña
Pipeline) — repetirlos en tres lugares es exactamente el tipo de deuda que hace que, al pasar a Pro y
querer migrar a un Cron real cada 2 h (un solo `schedule` de `vercel.json` en vez de 12 entradas con
filtrado en el handler), alguien tenga que acordarse de actualizar los tres sitios y termine
desincronizado.

**Propuesta**: definir una única fuente de verdad en el backend —
p. ej. `backend/app/core/pipeline_scheduling.py` (o dentro de `app/config.py` si el proyecto prefiere
centralizar constantes ahí) — con:

```python
CRON_BASE_INTERVAL_HOURS = 2
SCAN_FREQUENCY_OPTIONS_HOURS = [2, 4, 6, 8, 12, 24]
SCAN_DUE_TOLERANCE_MINUTES = 30
LOCK_TIMEOUT_MINUTES = 6
```

- `backend/app/schemas/pipeline.py` valida `scan_frequency_hours` contra `SCAN_FREQUENCY_OPTIONS_HOURS`
  (reemplazando el `ge=1` libre actual por una validación de pertenencia al conjunto) en vez de duplicar
  la lista.
- El handler de Cron (`GET /api/v1/pipeline/cron/scan`) importa `CRON_BASE_INTERVAL_HOURS` y
  `SCAN_DUE_TOLERANCE_MINUTES` de ese mismo módulo para el cálculo de vencimiento (sección 6) y de lock
  (sección 7).
- El frontend obtiene el conjunto de opciones **desde el backend** (ej. un endpoint que ya exponga
  `SCAN_FREQUENCY_OPTIONS_HOURS`, o generándolo en build-time desde el schema si el proyecto usa algo como
  `openapi-typescript`) en vez de tener el array `[2, 4, 6, 8, 12, 24]` hardcodeado también en
  `frontend/src/pages/pipeline/` — así una migración a Pro (cambiar `CRON_BASE_INTERVAL_HOURS` y las
  entradas de `vercel.json` a un cron real cada 2 h en vez de 12 chequeos con filtrado) es un cambio en un
  solo archivo de constantes más `vercel.json`, no una búsqueda por todo el código.

## 12. Riesgo abierto: las Fair Use Guidelines de Vercel restringen Hobby a uso no comercial

**Verificado textualmente en `/docs/limits/fair-use-guidelines`** (sección "Commercial usage"):

> "**Hobby teams** are restricted to non-commercial personal use only. All commercial usage of the
> platform requires either a Pro or Enterprise plan."

Y la definición de "uso comercial" que da la misma página es amplia — cubre cualquier *Deployment* usado
"for the purpose of financial gain of **anyone** involved in **any part of the production** of the
project, including a paid employee or consultant writing the code", con ejemplos explícitos como cobrar
por crear/actualizar/alojar el sitio.

**Esto es un riesgo real para este proyecto, no un tecnicismo**: NoonDalton es una empresa que va a operar
este sistema comercialmente después de la transferencia (y el propio equipo de desarrollo ya está siendo
remunerado por construirlo, lo cual — según la definición de Vercel — probablemente ya calza como "uso
comercial" incluso *antes* de la transferencia, durante el desarrollo/defensa). Si el proyecto sigue en
Hobby una vez que NoonDalton lo opere comercialmente, estaría en incumplimiento de las guías de uso justo
de Vercel, con el riesgo de que la cuenta sea pausada o se exija upgrade forzoso sin previo aviso extenso.

**Se deja constancia como punto abierto, no como decisión técnica de este análisis**: todo el diseño de
las secciones 6-11 (base de Cron cada 2 h con filtrado en el handler) está pensado como la solución para
**Hobby específicamente**, porque es el plan confirmado hoy. Si el cliente decide (o el equipo recomienda,
fuera del alcance de este documento) pasar a Pro por la restricción de uso comercial, el mismo diseño
**se simplifica**: con Cron por minuto disponible, la base de 12 chequeos/día con filtrado deja de ser
necesaria y se puede volver a un Cron real por `PipelineConfig` o a una cadencia fina real (sección 11 ya
deja ese cambio acotado a la constante `CRON_BASE_INTERVAL_HOURS` + `vercel.json`). **La decisión de qué
plan de Vercel usar en producción comercial no le corresponde a este análisis técnico — es una decisión de
negocio del cliente/equipo que debe tomarse antes de la transferencia**, y debe registrarse explícitamente
en los criterios de aceptación o en la documentación de traspaso para que NoonDalton no herede una cuenta
en violación de los términos de servicio sin saberlo.

---

**Punto abierto para el equipo**: confirmar el volumen esperado de fuentes/leads por scan (necesario para
dimensionar el margen de tiempo por lote de la sección 7), y decidir — como negocio, no como equipo técnico
— si el proyecto se mantiene en Hobby durante el desarrollo/defensa y migra a Pro/Enterprise antes de que
NoonDalton empiece a operarlo comercialmente (sección 12), lo cual también simplificaría el diseño de Cron
por lotes de las secciones 6-7.
