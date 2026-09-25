#!/usr/bin/env bash
# Manual check of the per-config run lock (POST /pipeline/runs).
#
# Fires two POST /pipeline/runs at the same instant against a running backend
# and verifies that exactly one is accepted (202) and the other is rejected
# (409) naming the accepted run. While the accepted scan is still running it
# also checks GET /pipeline/runs/active and sends a THIRD POST (a "click while
# a scan is running"), which must be rejected too. Finally it checks that the
# lock is released.
#
# Reading the output: every line is printed at the moment the event happens and
# is prefixed with the seconds elapsed since the test started. Read it top to
# bottom; the order IS the chronological order. Nothing is grouped or replayed.
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

# Token goes in a header file (curl -H @file), not on the command line.
printf 'Authorization: Bearer %s\n' "$TOKEN" > "$WORK/auth.hdr"
chmod 600 "$WORK/auth.hdr"
unset TOKEN

T0="$(date +%s.%N)"
echo
echo "Cada linea lleva los segundos transcurridos desde el inicio y se imprime cuando ocurre."
echo "Leela de arriba hacia abajo: ese orden es el orden real."
echo
log ".." "Login correcto (HTTP 200). Inicio de la prueba."

# post_run <label> [background]: POST /pipeline/runs. The response is logged the
# instant it arrives (from inside this function), then the code file is written.
post_run() {
  local code detail
  code="$(curl -s -o "$WORK/$1.json" -w '%{http_code}' -X POST "$API_URL/pipeline/runs" -H @"$WORK/auth.hdr")"
  case "$code" in
    202) detail="job_id=$(jget "$WORK/$1.json" job_id)" ;;
    409) detail="run_id=$(jget "$WORK/$1.json" detail.run_id)" ;;
    *)   detail="cuerpo: $(head -c 200 "$WORK/$1.json")" ;;
  esac
  log "POST" "$1 respondio HTTP $code  $detail"
  echo "$code" > "$WORK/$1.code"
}

get_active() {   # get_active -> sets A_CODE, A_ID, A_STATUS
  local f="$WORK/active.json"
  A_CODE="$(curl -s -o "$f" -w '%{http_code}' "$API_URL/pipeline/runs/active" -H @"$WORK/auth.hdr")"
  A_ID="$(jget "$f" run.id)"
  A_STATUS="$(jget "$f" run.status)"
}

# ── 3. Two simultaneous POSTs ────────────────────────────────────────────────
log "POST" "lanzando p1 y p2 al mismo tiempo"
post_run p1 &
post_run p2 &

# ── 4. As soon as the first one answers, the other is normally still running
#      the scan (sync fallback). Probe /active and send the THIRD POST now,
#      before waiting for the scan to finish. ────────────────────────────────
until [ -f "$WORK/p1.code" ] || [ -f "$WORK/p2.code" ]; do sleep 0.1; done
sleep 0.2   # let the log line of the first response print before ours

get_active
log "ACTIVE" "GET /runs/active -> HTTP $A_CODE  run=${A_ID:-<ninguna>}  status=${A_STATUS:-<n/a>}"
if [ "$A_CODE" != "200" ]; then
  fail "/runs/active no respondio 200."
fi

THIRD_SENT=0
if [ -n "$A_ID" ]; then
  log "POST3" "hay corrida activa ($A_ID): envio un tercer POST (un clic con el escaneo corriendo)"
  post_run p3
  THIRD_SENT=1
  if [ "$(cat "$WORK/p3.code")" = "409" ]; then
    ok "el tercer POST fue rechazado (409) mientras la corrida estaba activa."
    R3="$(jget "$WORK/p3.json" detail.run_id)"
    if [ "$R3" = "$A_ID" ]; then ok "y el 409 nombra la corrida activa ($R3)."; else fail "el 409 nombra '$R3', pero la activa es '$A_ID'."; fi
  else
    fail "el tercer POST NO fue 409 con la corrida activa: el bloqueo no la vio."
  fi
else
  skip "no hay corrida activa en este instante (el escaneo ya termino): el tercer POST NO se envia, no se puede probar."
fi

# ── 5. Wait for both original POSTs; the scan finishes when the winner answers ─
info "esperando a que respondan los dos POST originales..."
wait

C1="$(cat "$WORK/p1.code")"; C2="$(cat "$WORK/p2.code")"
ACCEPTED=""; REJECTED=""
if   [ "$C1" = "202" ] && [ "$C2" = "409" ]; then ACCEPTED=p1; REJECTED=p2
elif [ "$C1" = "409" ] && [ "$C2" = "202" ]; then ACCEPTED=p2; REJECTED=p1
fi
if [ -n "$ACCEPTED" ]; then
  ok "los dos POST originales: exactamente un 202 y un 409."
  JOB_ID="$(jget "$WORK/$ACCEPTED.json" job_id)"
  RUN_ID_409="$(jget "$WORK/$REJECTED.json" detail.run_id)"
  if [ -n "$JOB_ID" ] && [ "$JOB_ID" = "$RUN_ID_409" ]; then
    ok "COINCIDEN: job_id del 202 ($JOB_ID) = run_id del 409."
  else
    fail "NO COINCIDEN: job_id del 202 = '${JOB_ID}', run_id del 409 = '${RUN_ID_409}'."
  fi
  if [ -n "$A_ID" ] && [ "$A_ID" != "$JOB_ID" ]; then
    fail "la corrida activa observada ($A_ID) no era la aceptada ($JOB_ID)."
  fi
elif [ "$C1" = "202" ] && [ "$C2" = "202" ]; then
  fail "DOS 202: el bloqueo NO funciono, se lanzaron dos corridas."
else
  fail "respuestas inesperadas en los POST originales (p1=$C1, p2=$C2). Si hay un 500, copia el traceback de uvicorn."
fi

# ── 6. Wait until no run is active, then confirm the lock was released ───────
info "esperando a que no quede corrida activa (max ${MAX_WAIT_SECONDS}s)..."
WAITED=0
while :; do
  get_active
  [ "$A_CODE" = "200" ] && [ -z "$A_ID" ] && break
  if [ "$WAITED" -ge "$MAX_WAIT_SECONDS" ]; then break; fi
  log "ACTIVE" "sigue activa: ${A_ID:-?} (${A_STATUS:-?})"
  sleep 5; WAITED=$((WAITED + 5))
done
log "ACTIVE" "GET /runs/active -> HTTP $A_CODE  run=${A_ID:-<ninguna>}"
if [ "$A_CODE" = "200" ] && [ -z "$A_ID" ]; then
  ok "sin corrida activa: el bloqueo se libero."
else
  fail "sigue habiendo una corrida activa tras ${WAITED}s (bloqueo no liberado, o el escaneo no termino)."
fi

# ── 7. Optional: the lock really was released -> a new run is accepted ──────
echo
echo "Prueba opcional: nueva corrida tras liberarse el bloqueo (lanza OTRO escaneo real, mismo costo)."
read -r -p "Escribe SI para probarlo, Enter para omitir: " AGAIN
if [ "$AGAIN" = "SI" ]; then
  log "POST4" "enviando un POST nuevo con el bloqueo ya liberado"
  post_run p4
  if [ "$(cat "$WORK/p4.code")" = "202" ]; then ok "aceptado (202): el bloqueo se libero correctamente."; else fail "se esperaba 202 y llego $(cat "$WORK/p4.code")."; fi
else
  info "omitida."
fi

# ── 8. Verdict (only counts what was already printed above, in its moment) ────
echo
echo "VEREDICTO (los hechos estan arriba, en su momento; esto solo cuenta):"
if [ "$FAILS" -gt 0 ]; then
  echo "  HAY $FAILS FALLA(S). Copia toda esta salida (y el log de uvicorn si hubo 500)."
  exit 1
fi
if [ "$INCONCLUSIVE" -gt 0 ]; then
  echo "  NO CONCLUYENTE: $INCONCLUSIVE comprobacion(es) no se pudieron hacer (el escaneo termino antes)."
  echo "  Repite la prueba; con un escaneo mas largo o el tercer POST antes."
  exit 3
fi
echo "  BLOQUEO OK: un solo escaneo a la vez; el perdedor y el clic durante el escaneo recibieron 409."
exit 0
