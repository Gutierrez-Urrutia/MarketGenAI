"""Enciende, apaga o consulta la VM del worker (Celery + Redis) de marketgen-dev.

    python infra/gcp/vm.py start     # enciende y espera a que Redis y el worker estén arriba (~1 min)
    python infra/gcp/vm.py stop      # apaga (queda solo el costo del disco, ~US$1/mes)
    python infra/gcp/vm.py status    # estado actual

Con la VM apagada la API sigue funcionando; solo las tareas en segundo plano fallan o usan el respaldo síncrono.
Apaga cuando no haya generaciones en curso. En Windows define GCLOUD con la ruta completa a gcloud.cmd.
"""
import os, subprocess, sys, time

G = os.environ.get("GCLOUD", "gcloud")
PROJECT, ZONE, VM = "marketgen-dev", "us-central1-a", "marketgen-worker"
READY = "worker y redis iniciados"


def gc(*args):
    r = subprocess.run([G, *args, f"--project={PROJECT}"], capture_output=True)
    return r.returncode, (r.stdout + r.stderr).decode("utf-8", "replace")


def status():
    rc, out = gc("compute", "instances", "describe", VM, f"--zone={ZONE}", "--format=value(status)")
    return out.strip() if rc == 0 else f"error: {out.strip()[-120:]}"


def ready_count():
    rc, out = gc("compute", "instances", "get-serial-port-output", VM, f"--zone={ZONE}")
    return out.count(READY) if rc == 0 else 0


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "status":
        print(f"{VM}: {status()}")
    elif cmd == "start":
        antes = ready_count()
        rc, out = gc("compute", "instances", "start", VM, f"--zone={ZONE}")
        if rc != 0:
            sys.exit(out.strip()[-300:])
        print("encendiendo...", flush=True)
        t0 = time.time()
        while time.time() - t0 < 360:
            time.sleep(10)
            if ready_count() > antes:
                print(f"listo en {int(time.time() - t0)} s: Redis y worker arriba")
                return
        sys.exit("la VM encendió pero no se confirmó el worker en 6 minutos; revisa el registro serial")
    elif cmd == "stop":
        rc, out = gc("compute", "instances", "stop", VM, f"--zone={ZONE}")
        print("apagada" if rc == 0 else out.strip()[-300:])
    else:
        sys.exit("uso: vm.py start|stop|status")


main()
