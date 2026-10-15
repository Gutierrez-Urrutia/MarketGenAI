# Estado de la revisión de seguridad — Fase 2

Rama: `Hernan` (sin push a ramas compartidas).

## Cerrado

| Hallazgo | Commit |
|---|---|
| SSRF y lectura de archivos locales en `JobScoutService` | `bc9001b` |
| XSS almacenado por `job_url` (`javascript:`) | `f126efc` |
| Tope de descarga (streaming) en fuentes | `5ec708b` |
| Límite `10/minute` en `POST /pipeline/runs` | `215be33` |
| `cryptography` 42.0.0 → 50.0.1 | `406ca5a` |

Suite del backend: **273 tests en verde** tras el último cambio de código.

## Documentado, no corregido (ver `PR-fase1.md`)

- **CORS amplio** (`allow_origin_regex` `*.vercel.app` + `allow_credentials=True` en `app/main.py`): propuesta `allow_credentials=False`. El frontend no usa cookies ni `withCredentials`. Decisión del equipo.
- **Dependencias vulnerables** (preexistentes): backend 162 hallazgos en 11 paquetes; frontend 47 (0 críticos, 9 altos, 36 moderados, 2 bajos). Tarea aparte.
- **Deuda técnica:** sin ejecutor de pruebas en el frontend; acciones nuevas caen al registro de auditoría genérico; `backend/main.py` sin uso confirmado (no borrado), junto al código sin uso ya listado.

## Pendiente de la Fase 2

- Verificación manual en el navegador (a cargo de Hernán). Es lo único que queda.
