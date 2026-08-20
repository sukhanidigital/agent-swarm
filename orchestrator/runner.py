"""Best-effort "just run it" launcher for a completed job's output — detects package.json /
requirements.txt in the job's worktree, installs deps if needed, starts each detected service in the
background, and scrapes its own console output for the URL it's listening on. Intentionally simple:
detects at most one Node frontend and one Python backend per directory checked, not a general
multi-service orchestrator — most single-tree/small-multi-tree projects put these at the root or in an
obvious /frontend, /backend split, so that's what's checked. State lives in memory only, keyed by
job_id — an app you're running to look at is disposable dev-server state, not job history worth
persisting to SQLite."""
import platform
import re
import subprocess
import threading
import time
from pathlib import Path

URL_RE = re.compile(r"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s'\"<>]*")
URL_WAIT_TIMEOUT = 90  # seconds to watch a service's own output for a URL before giving up on that part

_runs: dict[str, dict] = {}  # job_id -> {"services": [{...}], "processes": [Popen, ...]}


def _is_windows() -> bool:
    return platform.system() == "Windows"


def detect_services(project_path: str) -> list[dict]:
    """Returns [{"name", "cwd", "install_cmd", "run_cmd"}]."""
    root = Path(project_path)
    services = []

    def check_dir(d: Path, label: str):
        if (d / "package.json").exists():
            services.append({
                "name": f"{label} (node)", "cwd": str(d),
                "install_cmd": "npm install", "run_cmd": "npm run dev",
            })
        if (d / "requirements.txt").exists():
            entry = next((e for e in ("app.py", "main.py", "server.py") if (d / e).exists()), None)
            if entry:
                bin_dir = "Scripts" if _is_windows() else "bin"
                py_name = "python.exe" if _is_windows() else "python"
                venv_python = str(d / ".venv" / bin_dir / py_name)
                services.append({
                    "name": f"{label} (python)", "cwd": str(d),
                    "install_cmd": f'python -m venv .venv && "{venv_python}" -m pip install -r requirements.txt',
                    "run_cmd": f'"{venv_python}" {entry}',
                })

    check_dir(root, "root")
    for sub in ("frontend", "backend", "client", "server"):
        d = root / sub
        if d.is_dir():
            check_dir(d, sub)

    return services


def start_run(job_id: str, project_path: str) -> dict:
    services = detect_services(project_path)
    if not services:
        raise ValueError("Couldn't detect anything to run — no package.json or requirements.txt found "
                          "at the project root or in frontend/backend/client/server.")

    state = {
        "services": [{"name": s["name"], "status": "installing", "url": None, "log": []} for s in services],
        "processes": [],
    }
    _runs[job_id] = state

    for i, svc in enumerate(services):
        threading.Thread(target=_run_one, args=(job_id, i, svc), daemon=True).start()
    return get_run_status(job_id)


def _run_one(job_id: str, index: int, svc: dict):
    state = _runs[job_id]
    entry = state["services"][index]
    try:
        install = subprocess.run(svc["install_cmd"], shell=True, cwd=svc["cwd"],
                                  capture_output=True, text=True, timeout=300)
        if install.stdout or install.stderr:
            entry["log"].append((install.stdout[-1500:] + install.stderr[-1500:]).strip())
        if install.returncode != 0:
            entry["status"] = "failed"
            entry["log"].append(f"install failed (exit {install.returncode})")
            return

        entry["status"] = "starting"
        proc = subprocess.Popen(svc["run_cmd"], shell=True, cwd=svc["cwd"],
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        state["processes"].append(proc)

        deadline = time.time() + URL_WAIT_TIMEOUT
        while time.time() < deadline:
            line = proc.stdout.readline()  # blocks until a line arrives or the process exits (EOF)
            if not line:
                if proc.poll() is not None:
                    entry["status"] = "failed"
                    entry["log"].append(f"process exited early (code {proc.returncode})")
                    return
                continue
            entry["log"].append(line.rstrip())
            match = URL_RE.search(line)
            if match:
                entry["url"] = match.group(0)
                entry["status"] = "running"
                return
        entry["status"] = "running"  # started, still alive, just never printed a recognizable URL

    except Exception as exc:  # noqa: BLE001 - surface to the UI instead of a silent dead thread
        entry["status"] = "failed"
        entry["log"].append(f"ERROR: {exc}")


def get_run_status(job_id: str) -> dict:
    state = _runs.get(job_id)
    if state is None:
        return {"services": []}
    return {"services": [{"name": s["name"], "status": s["status"], "url": s["url"], "log": s["log"][-20:]}
                          for s in state["services"]]}


def stop_run(job_id: str):
    state = _runs.pop(job_id, None)
    if not state:
        return
    for proc in state["processes"]:
        try:
            if _is_windows():
                # `npm run dev` under shell=True spawns node as a child of the shell — plain
                # terminate() only kills the shell and leaves the dev server orphaned and still
                # listening. /T kills the whole process tree.
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
            else:
                proc.terminate()
        except Exception:  # noqa: BLE001 - best-effort cleanup, never let this raise
            pass
