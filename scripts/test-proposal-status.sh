#!/usr/bin/env bash
# Manual check of RF-VTA-05 proposal states (PATCH /proposals/{id}/status).
#
# Against a running backend it creates ONE test proposal and walks it through:
#   create (must start in borrador, even if another value is sent)
#   borrador -> enviada          valid, 200
#   enviada  -> borrador         invalid transition, 409
#   "Entregada" (old label)      invalid target, 422
#   PUT {proposal_status}        ignored, state unchanged
#   enviada  -> rechazada        valid, 200
#   rechazada -> en_negociacion  reopen: 403 if you are NOT admin, 200 if you are
# At the end it offers to delete the test proposal.
#
# Every line is printed when the event happens, prefixed with the seconds
# elapsed since the test started; read it top to bottom.
#
# Run from Git Bash:   bash scripts/test-proposal-status.sh
# Backend URL:         API_URL=http://host:port/api/v1 bash scripts/test-proposal-status.sh
#                      (default http://127.0.0.1:8000/api/v1)
#
# Credentials are typed at the prompt (password hidden), never passed on the
# command line, never written to disk and never stored in shell history.
# To check the reopen as non-admin AND as admin, run it twice with each user.

set -u

API_URL="${API_URL:-http://127.0.0.1:8000/api/v1}"

PY="$(command -v python || command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "ERROR: se necesita python en el PATH." >&2
  exit 2
fi

# ── Chronological logging ────────────────────────────────────────────────────
T0=""
elapsed() { awk -v a="$T0" -v b="$(date +%s.%N)" 'BEGIN { printf "%.1f", b - a }'; }
log() {   # log <TAG> <message>   -- one printf per line, printed when it happens
  local tag="$1"; shift
  printf '[%7ss] %-8s %s\n' "$(elapsed)" "$tag" "$*"
}
FAILS=0
INCONCLUSIVE=0
ok()   { log "OK" "$*"; }
fail() { log "FALLA" "$*"; FAILS=$((FAILS + 1)); }
info() { log ".." "$*"; }
skip() { log "N/CONCL" "$*"; INCONCLUSIVE=$((INCONCLUSIVE + 1)); }

# ── 1. Warning + confirmation, before doing anything ─────────────────────────
cat <<EOF
==================================== ATENCION ====================================
Esta prueba trabaja contra: $API_URL

  - ESCRIBE en Firestore (el proyecto que use ese backend):
      * una propuesta de prueba nueva en proposals/ (titulo "RF-VTA-05 prueba manual ...")
      * sus cambios de estado
      * registros en auditLogs/ (middleware y "proposal_status_changed")
  - No llama a DeepSeek ni al CRM; no toca otras propuestas.
  - Al final puedes borrar la propuesta de prueba. Los registros de auditoria quedan.
==================================================================================
EOF
read -r -p "Escribe SI (en mayusculas) para continuar: " CONFIRM
if [ "$CONFIRM" != "SI" ]; then
  echo "Cancelado. No se ejecuto nada."
  exit 1
fi

# ── 2. Credentials (hidden) ──────────────────────────────────────────────────
read -r -p "Correo: " LOGIN_USER
read -r -s -p "Clave (no se muestra): " LOGIN_PASS
echo

WORK="$(mktemp -d)"
chmod 700 "$WORK"
cleanup() {
  rm -rf "$WORK"
  unset LOGIN_USER LOGIN_PASS TOKEN
}
trap cleanup EXIT

# JSON body built by python (handles quotes / special characters in the
# password) and piped to curl on stdin, so it never appears on a command line.
LOGIN_CODE="$(
  LOGIN_USER="$LOGIN_USER" LOGIN_PASS="$LOGIN_PASS" "$PY" -c \
    'import json, os; print(json.dumps({"usernameOrEmail": os.environ["LOGIN_USER"], "password": os.environ["LOGIN_PASS"]}))' \
  | curl -s -o "$WORK/login.json" -w '%{http_code}' -X POST "$API_URL/auth/login" \
      -H 'Content-Type: application/json' --data-binary @-
)"
unset LOGIN_PASS

# Small JSON reader: jget <file> <dotted.path>  -> value or empty
jget() {
  "$PY" -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    for k in sys.argv[2].split("."):
        d = d.get(k) if isinstance(d, dict) else None
        if d is None:
            break
    print("" if d is None else d)
except Exception:
    print("")
' "$1" "$2"
}

if [ "$LOGIN_CODE" != "200" ]; then
  echo "[FALLA] Login: HTTP $LOGIN_CODE (backend levantado en $API_URL? credenciales correctas?)"
  exit 1
fi
TOKEN="$(jget "$WORK/login.json" accessToken)"
rm -f "$WORK/login.json"
if [ -z "$TOKEN" ]; then
  echo "[FALLA] El login respondio 200 pero sin accessToken."
  exit 1
fi

# Roles as the backend sees them: the "roles" claim of the access token
# (read without verifying the signature; only used to choose the expected code).
IS_ADMIN="$(
  TOKEN="$TOKEN" "$PY" -c '
import base64, json, os
part = os.environ["TOKEN"].split(".")[1]
claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
print("1" if "admin" in (claims.get("roles") or ["user"]) else "0")
' 2>/dev/null || echo "?"
)"

# Token goes in a header file (curl -H @file), not on the command line.
printf 'Authorization: Bearer %s\n' "$TOKEN" > "$WORK/auth.hdr"
chmod 600 "$WORK/auth.hdr"
unset TOKEN

T0="$(date +%s.%N)"
echo
echo "Cada linea lleva los segundos transcurridos desde el inicio y se imprime cuando ocurre."
echo
log ".." "Login correcto (HTTP 200). Usuario admin: $([ "$IS_ADMIN" = "1" ] && echo si || echo no)."

# call <label> <METHOD> <path> [json-body] -> sets CODE; body in $WORK/<label>.json
call() {
  local label="$1" method="$2" path="$3" body="${4:-}"
  if [ -n "$body" ]; then
    CODE="$(printf '%s' "$body" | curl -s -o "$WORK/$label.json" -w '%{http_code}' -X "$method" "$API_URL$path" \
      -H @"$WORK/auth.hdr" -H 'Content-Type: application/json' --data-binary @-)"
  else
    CODE="$(curl -s -o "$WORK/$label.json" -w '%{http_code}' -X "$method" "$API_URL$path" -H @"$WORK/auth.hdr")"
  fi
  log "$method" "$path -> HTTP $CODE  $(head -c 160 "$WORK/$label.json")"
}

# expect_status <label> <target> <expected-code> <expected-state-or-empty>
expect_status() {
  local label="$1" target="$2" want="$3" want_state="$4"
  call "$label" PATCH "/proposals/$PID/status" "{\"status\": \"$target\"}"
  if [ "$CODE" != "$want" ]; then
    fail "$label: se esperaba HTTP $want y llego $CODE."
    return
  fi
  if [ -n "$want_state" ]; then
    local got; got="$(jget "$WORK/$label.json" proposal_status)"
    if [ "$got" = "$want_state" ]; then ok "$label: HTTP $want, proposal_status=$got."
    else fail "$label: HTTP $want pero proposal_status='$got' (esperado '$want_state')."; fi
  else
    ok "$label: HTTP $want (detail: $(jget "$WORK/$label.json" detail | head -c 120))."
  fi
}

# ── 3. Create: must start in borrador even if another value is sent ──────────
call create POST "/proposals" "{\"title\": \"RF-VTA-05 prueba manual $(date +%Y%m%dT%H%M%S)\", \"clientName\": \"Prueba\", \"proposal_status\": \"firmada\"}"
if [ "$CODE" != "201" ]; then
  fail "crear: se esperaba 201 y llego $CODE. No se puede seguir."
  exit 1
fi
PID="$(jget "$WORK/create.json" id)"
STATE="$(jget "$WORK/create.json" proposal_status)"
info "propuesta de prueba: $PID"
if [ "$STATE" = "borrador" ]; then ok "crear: nace en borrador aunque se envio 'firmada'."
else fail "crear: proposal_status='$STATE' (esperado 'borrador')."; fi

# ── 4. Transitions ───────────────────────────────────────────────────────────
expect_status p_enviada   enviada   200 enviada
expect_status p_volver    borrador  409 ""
expect_status p_viejo     Entregada 422 ""

# PUT cannot change the commercial state (it is dropped silently).
call put PUT "/proposals/$PID" '{"proposal_status": "firmada"}'
call get GET "/proposals/$PID"
GOT="$(jget "$WORK/get.json" proposal_status)"
if [ "$GOT" = "enviada" ]; then ok "PUT con proposal_status: ignorado, sigue en enviada."
else fail "PUT con proposal_status: el estado quedo en '$GOT' (esperado 'enviada')."; fi

expect_status p_rechazar  rechazada 200 rechazada

# ── 5. Reopen rechazada -> en_negociacion ────────────────────────────────────
if [ "$IS_ADMIN" = "1" ]; then
  expect_status p_reabrir en_negociacion 200 en_negociacion
  skip "eres admin: la reapertura SIN admin (403) no se probo. Repite con un usuario sin rol admin."
elif [ "$IS_ADMIN" = "0" ]; then
  expect_status p_reabrir en_negociacion 403 ""
  skip "no eres admin: la reapertura CON admin (200) no se probo. Repite con un usuario admin."
else
  skip "no se pudieron leer los roles del token: no se prueba la reapertura."
fi

# ── 6. Optional: delete the test proposal ────────────────────────────────────
echo
read -r -p "Escribe SI para borrar la propuesta de prueba $PID, Enter para dejarla: " DEL
if [ "$DEL" = "SI" ]; then
  call delete DELETE "/proposals/$PID"
  if [ "$CODE" = "204" ]; then ok "propuesta de prueba borrada (los registros de auditoria quedan)."
  else fail "borrar: se esperaba 204 y llego $CODE."; fi
else
  info "la propuesta de prueba queda en Firestore: $PID"
fi

# ── 7. Verdict (only counts what was already printed above, in its moment) ────
echo
echo "VEREDICTO (los hechos estan arriba, en su momento; esto solo cuenta):"
if [ "$FAILS" -gt 0 ]; then
  echo "  HAY $FAILS FALLA(S). Copia toda esta salida (y el log de uvicorn si hubo 500)."
  exit 1
fi
if [ "$INCONCLUSIVE" -gt 0 ]; then
  echo "  OK, CON $INCONCLUSIVE COMPROBACION(ES) PENDIENTE(S): ver las lineas N/CONCL."
  exit 3
fi
echo "  ESTADOS OK."
exit 0
