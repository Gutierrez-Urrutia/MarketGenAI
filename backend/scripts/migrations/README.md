# Migraciones one-off

## backfill_user_id.py

Asigna `userId` a documentos de Firestore creados antes del fix de seguridad
(antes de que `proposals`, `books`, `customers`, `templates`, `assets` y `jobs`
guardaran ese campo). Sin `userId`, `_assert_owner` / `_get_X_for_user` los
rechazan con 403 ("you do not have permission") aunque sean tuyos.

**No borra nada.** Solo hace `update({"userId": ...})` en documentos donde ese
campo no existe o esta vacio. Los documentos que ya tienen `userId` no se tocan.

### Como obtener tu `userId` (= `sub` del JWT = id del doc en `users/`)

Tienes dos formas, y el script soporta ambas directamente:

1. **Por email** (mas simple): el script busca en la coleccion `users` por
   `emailLower` y usa el campo `id` del documento encontrado.
   ```
   python -m scripts.migrations.backfill_user_id --email tu-email@ejemplo.com
   ```

2. **Por sub del token**: si ya tienes un access token (guardado por el
   frontend tras el login, normalmente en localStorage/cookies como
   `accessToken`), decodifica el payload (es JWT, no hace falta verificar la
   firma para leer el claim):
   ```
   python -c "import jwt; print(jwt.get_unverified_claims('<TU_TOKEN>')['sub'])"
   ```
   Ese valor es el mismo `id` del documento `users/{id}` y se pasa con:
   ```
   python -m scripts.migrations.backfill_user_id --user-id <SUB>
   ```

### Uso

Ejecutar **desde `backend/`**, con el venv activo (necesita `app.config` /
`app.services.firestore_service`, que a su vez usan las credenciales de
Firestore configuradas en `.env` — ver diagnostico de Firebase Admin SDK).

```
# 1) Dry-run (default): solo cuenta y lista huerfanos, no escribe nada
python -m scripts.migrations.backfill_user_id --email tu-email@ejemplo.com

# 2) Aplicar (pide confirmacion 'yes')
python -m scripts.migrations.backfill_user_id --email tu-email@ejemplo.com --apply
```

Flags opcionales:
- `--collections proposals books ...` — limitar a un subconjunto (default:
  `proposals books customers templates assets jobs`).
- `--yes` — saltar la confirmacion interactiva (util en CI, no recomendado
  para uso manual).
- `--include-public-templates` — por defecto, las plantillas con
  `isPublic: true` y sin `userId` se omiten (son plantillas compartidas, no
  de un usuario en particular). Usa este flag si quieres asignarles dueño
  igualmente.

### Importante

- **Apunta a la base de datos real configurada en tu `.env` local**
  (`GOOGLE_CLOUD_PROJECT` / `FIRESTORE_DATABASE`), que es la misma que usa
  produccion en Vercel. El script imprime el proyecto/DB al inicio — verifica
  que sea el correcto antes de escribir `yes`.
- `books/{id}/chapters` (subcoleccion) no se incluye: los capitulos no tienen
  `userId` propio, heredan el ownership del book padre.
- `settings/{userId}` tampoco se incluye: el id del documento ya **es** el
  `userId` (`get_by_user` busca por id de documento, no por el campo), por lo
  que no sufre el problema de "huerfanos".

## fix_rss_lead_titles.py

Reescribe `job_title`, `company_name`, `fingerprint` y `raw_title` de los
leads que una fuente RSS guardó antes de tener `config.title_format` (Fase 2,
punto 4). Detalle completo en el docstring del script.

**No borra nada.** Los duplicados solo se reportan. Solo toca leads de la
fuente sin `raw_title` (una segunda pasada no hace nada). Los que no pasan la
comprobación cruzada, o cuya oferta ya no está en el feed, quedan como
REVISIÓN MANUAL y no se tocan.

```
# 1) Simulación (default): lee Firestore y el feed, no escribe nada
python -u -m scripts.migrations.fix_rss_lead_titles --config-id <CONFIG_ID> --source-id <SOURCE_ID>

# 2) Aplicar: solo si la fuente ya tiene title_format="company_colon_title".
#    Guarda antes un respaldo en scripts/migrations/backups/ (git-ignored,
#    contiene datos reales) y pide confirmación 'yes'.
python -u -m scripts.migrations.fix_rss_lead_titles --config-id <CONFIG_ID> --source-id <SOURCE_ID> --apply

# 2b) Solo un lead: su propio respaldo (sufijo -only-<id>); se rechaza si
#     ese lead no está en el plan (no es de la fuente, revisión manual u omitido)
python -u -m scripts.migrations.fix_rss_lead_titles --config-id <CONFIG_ID> --source-id <SOURCE_ID> --only <LEAD_ID> --apply

# 3) Deshacer un --apply desde su respaldo: simulación y luego aplicar
python -u -m scripts.migrations.fix_rss_lead_titles --config-id <CONFIG_ID> --source-id <SOURCE_ID> --restore scripts/migrations/backups/<archivo>.json
python -u -m scripts.migrations.fix_rss_lead_titles --config-id <CONFIG_ID> --source-id <SOURCE_ID> --restore scripts/migrations/backups/<archivo>.json --apply
```

Cada lead se escribe dentro de una transacción que lo vuelve a leer: si
cambió desde la lectura, no se toca ("CAMBIÓ DESDE LA LECTURA"). Solo se
escriben `job_title`, `company_name`, `fingerprint`, `raw_title` y
`updatedAt`. Si se interrumpe, se puede volver a correr: los leads ya
corregidos tienen `raw_title` y se omiten.

`--restore` exige también `--config-id` y `--source-id` y solo toca leads de
esa config y fuente ("NO PERTENECE" para el resto). Antes de nada valida el
respaldo: cada fila debe tener exactamente `id`, `original` (job_title,
company_name, fingerprint) y `applied` (esos más raw_title), todo texto; si
no, no hace nada. Un lead que conserva los valores aplicados se restaura;
uno que ya tiene sus valores originales es "SIN CAMBIO"; uno que difiere de
ambos es "CONFLICTO" y no se toca.

Código de salida: 0 bien, 1 si falló alguna escritura, 2 si se rechazó la
corrida.

`_legacy_split_rss_title` / `_legacy_rss_fingerprint` de
`job_scout_service.py` se quedan mientras se pueda restaurar: tras un
`--restore` los leads vuelven a su huella antigua y solo esas funciones
evitan que el siguiente escaneo los guarde de nuevo. Se quitan (junto con
este script) cuando el respaldo ya no haga falta.

**Al terminar:** cuando ya no haga falta restaurar, borra los respaldos de
`scripts/migrations/backups/` (contienen datos reales) y, en el mismo
cambio, quita `_legacy_split_rss_title` / `_legacy_rss_fingerprint` y este
script.
