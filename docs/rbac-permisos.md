# RNF-01 · Control de acceso por rol (RBAC)

Referencia de permisos del sistema. La verifican las pruebas de `backend/tests/test_rnf01_access_control.py` (CP-064, 065, 066, 097, 098, 160, 161, 162 y HU-13); si el código cambia y esta tabla no, las pruebas fallan.

## 1. Autenticación
- Todas las rutas exigen un access token JWT (`Authorization: Bearer …`, HS256, `typ=access`), salvo las de la sección 2.
- Sin token, token vencido, con firma alterada, de otra clave o con `typ` distinto → **401** con `WWW-Authenticate: Bearer`. El **403** queda para «con sesión, sin permiso».
- El access token vence a los `ACCESS_TOKEN_EXPIRE_MINUTES` (30 por defecto; el `.env` de cada entorno puede cambiarlo).
- Renovación: el refresh token es opaco, de un solo uso (rota en cada renovación) y revocable. **Cerrar sesión revoca el refresh token**; el access token ya emitido sigue siendo válido hasta que vence (decisión: no se mantiene una lista de tokens revocados).
- **Bloqueo por intentos fallidos:** 5 inicios de sesión fallidos por correo dentro de 15 minutos bloquean la cuenta 15 minutos (`429 ACCOUNT_LOCKED`, con `Retry-After`). Cuenta por correo exista o no la cuenta, para no revelar qué correos están registrados; un inicio de sesión correcto reinicia el contador. Además hay un límite por IP (10 por minuto). Configurable con `LOGIN_MAX_ATTEMPTS`, `LOGIN_ATTEMPT_WINDOW_MINUTES` y `LOGIN_LOCK_MINUTES`. Si el almacén de intentos falla, el inicio de sesión sigue funcionando.

## 2. Rutas públicas (única excepción a «todos exigen autenticación»)
Fuente única: `backend/app/core/public_routes.py` (una prueba falla si aparece una ruta sin sesión que no esté ahí).

| Ruta | Motivo |
|---|---|
| `GET /`, `GET /api/v1/health`, `GET /api/v1/health/db` | Monitoreo; `/health/db` no entrega el detalle del error |
| `POST /auth/login`, `/auth/register`, `/auth/refresh`, `/auth/forgot-password`, `/auth/reset-password` | Entrada a la cuenta; el registro siempre crea rol `user` |
| `GET /auth/google`, `/auth/google/callback`, `/auth/microsoft`, `/auth/microsoft/callback` | Flujo OAuth (state firmado) |
| `POST /mail-connection/callback`, `GET /mail-connection/google/callback`, `GET /settings/social/facebook/callback` | Retorno de proveedores (state firmado) |
| `GET /proposals/{id}/signed-document/file` | Enlace temporal firmado, ligado a la propuesta y al archivo |
| `GET /assets/local/{ruta}` | Respaldo en disco del almacenamiento. **Solo responde en desarrollo con almacenamiento local**; con almacenamiento en la nube (`STORAGE_BACKEND=gcs`) o en producción devuelve 404 |

## 3. Roles
Jerarquía: `admin` ⊃ `manager` ⊃ `user`. Un usuario nuevo siempre es `user`. Los roles solo cambian con `PATCH /auth/users/{id}/roles` (solo admin); `PUT /auth/me` solo acepta `name`, y el rol viaja firmado en el token, así que no se puede modificar desde el cliente.

| Acción | anónimo | user | manager | admin |
|---|:-:|:-:|:-:|:-:|
| Crear y editar servicios y tipos del catálogo (precios) | 401 | 403 | ✔ | ✔ |
| Ver el catálogo | 401 | ✔ | ✔ | ✔ |
| Cargar documentos a la base de conocimiento | 401 | ✔ | ✔ | ✔ |
| Eliminar documentos de la base de conocimiento | 401 | 403 | ✔ | ✔ |
| Cambiar roles de usuarios | 401 | 403 | 403 | ✔ |
| Consultar el registro de auditoría | 401 | 403 | 403 | ✔ |
| Rutas de diagnóstico y tareas de administración | 401 | 403 | 403 | ✔ |
| Clientes, propuestas, leads, libros, oportunidades | 401 | ✔ (solo los propios) | ✔ (solo los propios) | ✔ (solo los propios) |

El rol nuevo de un usuario rige al renovar el token: puede haber un desfase de hasta lo que dure el access token.

## 4. Datos: cada usuario ve solo los suyos
Clientes, propuestas, leads, libros, oportunidades, borradores de Sales enablement y demás datos de trabajo guardan `userId`. Pedir por id el dato de otro usuario → **403** (sin filtrar el contenido); un id que no existe → **404**; los listados se piden filtrados por usuario.

**Excepciones por diseño (datos de la empresa, no personales):**
- **Catálogo de servicios**: lo leen todos; lo editan manager y admin.
- **Base de conocimiento**: la ven y la usan todos; la cargan todos; la eliminan manager y admin.

## 5. Fuera de alcance
- **Aprobación de descuentos.** El criterio de RNF-VTA-01 la menciona, pero ningún requerimiento funcional define una función de descuentos, así que no hay qué proteger. Queda como solicitud de cambio; mientras tanto, la edición de precios del catálogo sí está restringida a manager y admin.
- **Invalidar el access token al cerrar sesión** (lista de tokens revocados): se descartó; el access token vence solo.
- **Pantalla de gestión de roles (HU-13):** el cambio de rol se hace por API (`PATCH /auth/users/{id}/roles`); no hay pantalla ni listado de usuarios.
