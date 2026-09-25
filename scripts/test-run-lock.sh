#!/usr/bin/env bash
# Manual check of the per-config run lock (POST /pipeline/runs).
#
# Fires two POST /pipeline/runs at the same instant against a running backend
# and verifies that exactly one is accepted (202) and the other is rejected
# (409) naming the accepted run. Then checks GET /pipeline/runs/active during
# and after the scan.
#
# Run from Git Bash:   bash scripts/test-run-lock.sh
# Backend URL:         API_URL=http://host:port/api/v1 bash scripts/test-run-lock.sh
#                      (default http://127.0.0.1:8000/api/v1)
#
# Credentials are typed at the prompt (password hidden), never passed on the
# command line, never written to disk and never stored in shell history.

set -u

API_URL="${API_URL:-http://127.0.0.1:8000/api/v1}"
MAX_WAIT_SECONDS=420   # a run is presumed dead by the backend after 360 s

PY="$(command -v python || command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "ERROR: se necesita python en el PATH." >&2
  exit 2
fi

FAILS=0
ok()   { echo "  [OK]    $*"; }
fail() { echo "  [FALLA] $*"; FAILS=$((FAILS + 1)); }
info() { echo "  [..]    $*"; }
step() { echo; echo "== $* =="; }

# ── 1. Warning + confirmation, before doing anything ─────────────────────────
cat <<EOF
==================================== ATENCION ====================================
Esta prueba lanza un ESCANEO REAL contra: $API_URL

  - Consume llamadas a DeepSeek (tiene costo).
  - ESCRIBE en Firestore: una corrida, el documento de bloqueo
    pipeline_run_locks/<tu id> y los prospectos nuevos que el escaneo encuentre.

Si el bloqueo funciona, solo UNO de los dos POST simultaneos debe escanear.
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
# Credentials reach python only through its environment.
step "Login"
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
  echo "  [FALLA] Login: HTTP $LOGIN_CODE (backend levantado en $API_URL? credenciales correctas?)"
  exit 1
fi
TOKEN="$(jget "$WORK/login.json" accessToken)"
rm -f "$WORK/login.json"
if [ -z "$TOKEN" ]; then
  echo "  [FALLA] El login respondio 200 pero sin accessToken."
  exit 1
fi
ok "Login correcto (HTTP 200)"

# Token goes in a header file (curl -H @file), not on the command line.
printf 'Authorization: Bearer %s\n' "$TOKEN" > "$WORK/auth.hdr"
chmod 600 "$WORK/auth.hdr"
unset TOKEN

post_run() {   # post_run <label>  -> writes $WORK/<label>.code and <label>.json
  local code
  code="$(curl -s -o "$WORK/$1.json" -w '%{http_code}' -X POST "$API_URL/pipeline/runs" -H @"$WORK/auth.hdr")"
  echo "$code" > "$WORK/$1.code"
}
get_active() { # get_active <label> -> prints "<code>|<run id or empty>|<status or empty>"
  local code
  code="$(curl -s -o "$WORK/$1.json" -w '%{http_code}' "$API_URL/pipeline/runs/active" -H @"$WORK/auth.hdr")"
  echo "$code|$(jget "$WORK/$1.json" run.id)|$(jget "$WORK/$1.json" run.status)"
}

# ── 3. Two simultaneous POSTs ────────────────────────────────────────────────
step "Dos POST /pipeline/runs simultaneos"
post_run p1 &
post_run p2 &

# The fast one (normally the 409) finishes first; look at /active right away,
# while the winning scan is still running.
until [ -f "$WORK/p1.code" ] || [ -f "$WORK/p2.code" ]; do sleep 0.1; done
DURING="$(get_active during)"
wait

C1="$(cat "$WORK/p1.code")"; C2="$(cat "$WORK/p2.code")"
echo "  POST 1 -> HTTP $C1"
echo "  POST 2 -> HTTP $C2"

ACCEPTED=""; REJECTED=""
if   [ "$C1" = "202" ] && [ "$C2" = "409" ]; then ACCEPTED=p1; REJECTED=p2
elif [ "$C1" = "409" ] && [ "$C2" = "202" ]; then ACCEPTED=p2; REJECTED=p1
fi

if [ -n "$ACCEPTED" ]; then
  ok "Exactamente un 202 y un 409."
  JOB_ID="$(jget "$WORK/$ACCEPTED.json" job_id)"
  RUN_ID_409="$(jget "$WORK/$REJECTED.json" detail.run_id)"
  echo "  job_id del 202 : ${JOB_ID:-<vacio>}"
  echo "  run_id del 409 : ${RUN_ID_409:-<vacio>}"
  if [ -n "$JOB_ID" ] && [ "$JOB_ID" = "$RUN_ID_409" ]; then
    ok "COINCIDEN: el 409 apunta a la corrida que gano."
  else
    fail "NO COINCIDEN: el 409 no nombra la corrida aceptada."
  fi
else
  JOB_ID=""
  if [ "$C1" = "202" ] && [ "$C2" = "202" ]; then
    fail "DOS 202: el bloqueo NO funciono, se lanzaron dos corridas."
    echo "  job_id 1: $(jget "$WORK/p1.json" job_id)"
    echo "  job_id 2: $(jget "$WORK/p2.json" job_id)"
  else
    fail "Respuestas inesperadas (esperado: un 202 y un 409). Cuerpos:"
    echo "  POST 1: $(head -c 400 "$WORK/p1.json")"
    echo "  POST 2: $(head -c 400 "$WORK/p2.json")"
    echo "  Si hay un 500, copia el traceback del log de uvicorn."
  fi
fi

# ── 4. /runs/active during the scan ──────────────────────────────────────────
step "GET /pipeline/runs/active durante el escaneo"
IFS='|' read -r A_CODE A_ID A_STATUS <<< "$DURING"
echo "  HTTP $A_CODE  run=${A_ID:-<ninguna>}  status=${A_STATUS:-<n/a>}"
if [ "$A_CODE" = "200" ] && [ -n "$A_ID" ] && [ -n "$JOB_ID" ] && [ "$A_ID" = "$JOB_ID" ]; then
  ok "Durante el escaneo la corrida activa es la aceptada."
elif [ "$A_CODE" = "200" ] && [ -z "$A_ID" ]; then
  info "No habia corrida activa en ese instante (el escaneo pudo terminar antes de consultar)."
else
  fail "La corrida activa no es la esperada."
fi

# A third POST while the run is active must also be rejected. Only sent if the
# run is still active, so it can never start a scan on its own.
if [ -n "$A_ID" ]; then
  post_run p3
  C3="$(cat "$WORK/p3.code")"
  echo "  Tercer POST durante el escaneo -> HTTP $C3"
  if [ "$C3" = "409" ]; then ok "El tercer POST tambien fue rechazado (409)."; else fail "El tercer POST no fue 409."; fi
fi

# ── 5. Wait for the scan to finish, then /runs/active again ──────────────────
step "Esperando a que termine el escaneo (max ${MAX_WAIT_SECONDS}s)"
WAITED=0
while :; do
  IFS='|' read -r W_CODE W_ID W_STATUS <<< "$(get_active poll)"
  [ "$W_CODE" = "200" ] && [ -z "$W_ID" ] && break
  if [ "$WAITED" -ge "$MAX_WAIT_SECONDS" ]; then break; fi
  printf '  ... %ss, corrida %s (%s)\n' "$WAITED" "${W_ID:-?}" "${W_STATUS:-?}"
  sleep 5; WAITED=$((WAITED + 5))
done

step "GET /pipeline/runs/active despues del escaneo"
IFS='|' read -r F_CODE F_ID F_STATUS <<< "$(get_active after)"
echo "  HTTP $F_CODE  run=${F_ID:-<ninguna>}"
if [ "$F_CODE" = "200" ] && [ -z "$F_ID" ]; then
  ok "Sin corrida activa: el bloqueo se libero."
else
  fail "Sigue habiendo una corrida activa tras ${WAITED}s (bloqueo no liberado, o el escaneo no termino)."
fi

# ── 6. Optional: the lock really was released -> a new run is accepted ───────
step "Prueba opcional: nueva corrida tras liberarse el bloqueo"
echo "  Esto lanza OTRO escaneo real (mismo costo)."
read -r -p "  Escribe SI para probarlo, Enter para omitir: " AGAIN
if [ "$AGAIN" = "SI" ]; then
  post_run p4
  C4="$(cat "$WORK/p4.code")"
  echo "  POST -> HTTP $C4"
  if [ "$C4" = "202" ]; then ok "Aceptada (202): el bloqueo se libero correctamente."; else fail "Se esperaba 202 y llego $C4."; fi
else
  info "Omitida."
fi

# ── 7. Verdict ───────────────────────────────────────────────────────────────
step "VEREDICTO"
if [ "$FAILS" -eq 0 ]; then
  echo "  BLOQUEO OK: un solo escaneo a la vez, el perdedor recibio 409 apuntando al ganador."
  exit 0
fi
echo "  HAY $FAILS FALLA(S). Copia toda esta salida (y el log de uvicorn si hubo 500)."
exit 1
