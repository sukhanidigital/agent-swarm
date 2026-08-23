"""SQLite job store — one row per swarm run, with a JSON blob for the assembled transcript."""
import json
import sqlite3
import time
import uuid
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "jobs" / "swarm.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    config TEXT NOT NULL,
    status TEXT NOT NULL,
    branch TEXT,
    commit_sha TEXT,
    summary TEXT,
    audit_verdict TEXT,
    audit_notes TEXT,
    gate_attempts TEXT NOT NULL DEFAULT '{}',
    current_gate TEXT,
    cost_estimate REAL NOT NULL DEFAULT 0,
    stop_requested INTEGER NOT NULL DEFAULT 0,
    max_cost REAL NOT NULL DEFAULT 1.0,
    stuck_reason TEXT,
    job_wt_path TEXT,
    job_branch TEXT,
    job_base_sha TEXT,
    subtasks TEXT,
    block_status TEXT NOT NULL DEFAULT '{}',
    plan TEXT,
    gate_caps TEXT NOT NULL DEFAULT '{}',
    models TEXT NOT NULL DEFAULT '{}',
    log TEXT NOT NULL DEFAULT '[]',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
"""

_MIGRATIONS = [
    ("gate_attempts", "TEXT NOT NULL DEFAULT '{}'"),
    ("current_gate", "TEXT"),
    ("cost_estimate", "REAL NOT NULL DEFAULT 0"),
    ("stop_requested", "INTEGER NOT NULL DEFAULT 0"),
    ("max_cost", "REAL NOT NULL DEFAULT 1.0"),
    ("stuck_reason", "TEXT"),
    ("job_wt_path", "TEXT"),
    ("job_branch", "TEXT"),
    ("job_base_sha", "TEXT"),
    ("subtasks", "TEXT"),  # legacy (v3 single-tree decompose output) — unused since v4's `plan` replaced it
    ("block_status", "TEXT NOT NULL DEFAULT '{}'"),
    ("plan", "TEXT"),
    # Per-gate-INSTANCE (not per-type) override, keyed by the exact block label — e.g.
    # "tree_1_team_lead" and "tree_2_team_lead" can each have their own cap/model now, rather than one
    # value shared across every tree's team_lead. Empty dict means "use the fallback default for
    # anything not explicitly set" (DEFAULT_GATE_CAP for caps, agents.DEFAULT_MODELS for models) —
    # these columns only ever need to hold what was actually overridden for a specific block.
    ("gate_caps", "TEXT NOT NULL DEFAULT '{}'"),
    ("next_tree_index", "INTEGER NOT NULL DEFAULT 0"),
    ("models", "TEXT NOT NULL DEFAULT '{}'"),
]


def _connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(SCHEMA)
    for column, decl in _MIGRATIONS:
        try:
            conn.execute(f"ALTER TABLE jobs ADD COLUMN {column} {decl}")
        except sqlite3.OperationalError:
            pass  # column already exists — fine, this just covers DBs created before v2
    return conn


DEFAULT_GATE_CAP = 5  # fallback used for any capped block that isn't explicitly in a job's gate_caps


def create_job(prompt: str, repo_path: str, config: dict, plan: list, max_cost: float = 1.0,
               gate_caps: dict = None, models: dict = None) -> str:
    """`plan` is the confirmed tree/subtask/dev-count breakdown from the pre-run POST /plan step —
    the job never re-plans, it just executes what was already decided and shown to the user."""
    job_id = str(uuid.uuid4())
    now = time.time()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO jobs (id, prompt, repo_path, config, status, max_cost, plan, gate_caps, models, "
            "log, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, '[]', ?, ?)",
            (job_id, prompt, repo_path, json.dumps(config), max_cost, json.dumps(plan),
             json.dumps(gate_caps or {}), json.dumps(models or {}), now, now),
        )
    return job_id


def append_log(job_id: str, line: str):
    with _connect() as conn:
        row = conn.execute("SELECT log FROM jobs WHERE id = ?", (job_id,)).fetchone()
        log = json.loads(row[0]) if row else []
        log.append({"t": time.time(), "line": line})
        conn.execute("UPDATE jobs SET log = ?, updated_at = ? WHERE id = ?", (json.dumps(log), time.time(), job_id))


def update_job(job_id: str, **fields):
    if not fields:
        return
    fields = {k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in fields.items()}
    fields["updated_at"] = time.time()
    columns = ", ".join(f"{k} = ?" for k in fields)
    with _connect() as conn:
        conn.execute(f"UPDATE jobs SET {columns} WHERE id = ?", (*fields.values(), job_id))


def request_stop(job_id: str):
    """Set the emergency-stop flag. The pipeline checks this at loop checkpoints and halts —
    it can't interrupt a single LLM call already in flight, but stops the next one from starting."""
    with _connect() as conn:
        conn.execute("UPDATE jobs SET stop_requested = 1, updated_at = ? WHERE id = ?", (time.time(), job_id))


def is_stop_requested(job_id: str) -> bool:
    with _connect() as conn:
        row = conn.execute("SELECT stop_requested FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return bool(row and row[0])


def update_block(job_id: str, block: str, state: str = None, activity: str = None, pct: int = None):
    """Read-modify-write a single node's status for the Dash diagram — state (pending/active/done/
    failed), activity (short live text like "writing primes.py"), pct (0-100 fill heuristic)."""
    with _connect() as conn:
        row = conn.execute("SELECT block_status FROM jobs WHERE id = ?", (job_id,)).fetchone()
        blocks = json.loads(row[0]) if row and row[0] else {}
        entry = blocks.get(block, {"state": "pending", "activity": "", "pct": 0})
        if state is not None:
            entry["state"] = state
        if activity is not None:
            entry["activity"] = activity
        if pct is not None:
            entry["pct"] = pct
        blocks[block] = entry
        conn.execute("UPDATE jobs SET block_status = ?, updated_at = ? WHERE id = ?",
                     (json.dumps(blocks), time.time(), job_id))


def get_job(job_id: str) -> dict | None:
    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            return None
        job = dict(row)
        job["config"] = json.loads(job["config"])
        job["log"] = json.loads(job["log"])
        job["gate_attempts"] = json.loads(job["gate_attempts"])
        job["subtasks"] = json.loads(job["subtasks"]) if job["subtasks"] else None
        job["block_status"] = json.loads(job["block_status"])
        job["plan"] = json.loads(job["plan"]) if job["plan"] else None
        job["gate_caps"] = json.loads(job["gate_caps"])
        job["models"] = json.loads(job["models"]) if job["models"] else {}
        return job


def list_jobs() -> list[dict]:
    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM jobs ORDER BY created_at DESC").fetchall()
        jobs = []
        for row in rows:
            job = dict(row)
            job["config"] = json.loads(job["config"])
            job["log"] = json.loads(job["log"])
            job["gate_attempts"] = json.loads(job["gate_attempts"])
            job["subtasks"] = json.loads(job["subtasks"]) if job["subtasks"] else None
            job["block_status"] = json.loads(job["block_status"])
            job["plan"] = json.loads(job["plan"]) if job["plan"] else None
            job["gate_caps"] = json.loads(job["gate_caps"])
            job["models"] = json.loads(job["models"]) if job["models"] else {}
            jobs.append(job)
        return jobs
