"""Cross-run memory in Supabase: logs every gate verdict and job outcome, and surfaces the most
recent rejections for a target repo as a short "lessons learned" digest fed into the next job's
decompose + dev prompts. Gracefully no-ops if SUPABASE_URL/SUPABASE_KEY aren't set — this is an
optional layer, not a dependency of the core pipeline.

Schema (create manually in the Supabase dashboard — this repo follows cpg-thin-portal's convention
of no migration files, schema inferred from the queries below):

create table swarm_runs (
    id uuid primary key default gen_random_uuid(),
    job_id text not null,
    repo_path text not null,
    prompt text not null,
    status text not null,
    cost_estimate numeric,
    total_retries integer,
    created_at timestamptz not null default now()
);

create table swarm_gate_events (
    id uuid primary key default gen_random_uuid(),
    job_id text not null,
    repo_path text not null,
    gate text not null,
    round integer not null,
    verdict text not null,
    notes text,
    created_at timestamptz not null default now()
);
"""
import os

from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

_client = None
_warned = False


def _get_client():
    global _client, _warned
    if not SUPABASE_URL or not SUPABASE_KEY or "your_" in (SUPABASE_URL or "") + (SUPABASE_KEY or ""):
        if not _warned:
            print("[memory] SUPABASE_URL/SUPABASE_KEY not configured — lessons-learned logging is disabled.")
            _warned = True
        return None
    if _client is None:
        from supabase import create_client
        _client = create_client(SUPABASE_URL, SUPABASE_KEY)
    return _client


def log_gate_verdict(job_id: str, repo_path: str, gate: str, round_num: int, verdict: str, notes: str):
    client = _get_client()
    if client is None:
        return
    try:
        client.table("swarm_gate_events").insert({
            "job_id": job_id, "repo_path": repo_path, "gate": gate,
            "round": round_num, "verdict": verdict, "notes": notes,
        }).execute()
    except Exception as exc:  # noqa: BLE001 - logging failures should never break a job
        print(f"[memory] failed to log gate verdict: {exc}")


def log_job_summary(job_id: str, repo_path: str, prompt: str, status: str, cost_estimate: float, total_retries: int):
    client = _get_client()
    if client is None:
        return
    try:
        client.table("swarm_runs").insert({
            "job_id": job_id, "repo_path": repo_path, "prompt": prompt, "status": status,
            "cost_estimate": cost_estimate, "total_retries": total_retries,
        }).execute()
    except Exception as exc:  # noqa: BLE001
        print(f"[memory] failed to log job summary: {exc}")


def get_lessons(repo_path: str, limit: int = 8) -> str:
    """Short digest of recent rejection notes for this repo, meant to be folded into a prompt —
    not full history, just enough to steer the next attempt away from repeated mistakes."""
    client = _get_client()
    if client is None:
        return ""
    try:
        result = (
            client.table("swarm_gate_events")
            .select("gate, notes")
            .eq("repo_path", repo_path)
            .neq("verdict", "approve")
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        rows = result.data or []
        if not rows:
            return ""
        return "\n".join(f"- [{row['gate']}] {row['notes']}" for row in rows)
    except Exception as exc:  # noqa: BLE001
        print(f"[memory] failed to fetch lessons: {exc}")
        return ""
