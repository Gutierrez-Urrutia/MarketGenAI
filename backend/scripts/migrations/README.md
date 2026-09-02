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
