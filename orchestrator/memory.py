"""Cross-run memory — logs every gate verdict and job outcome, and surfaces the most recent
rejections for a target repo as a short "lessons learned" digest fed into the next job's design/dev
prompts. Backed by the same local SQLite store as job history (orchestrator/store.py) — no external
service, no config, works out of the box for every deployment.

This module is just the three functions re-exported so orchestrator/pipeline.py's `memory.xxx` call
sites didn't need to change when this moved off Supabase."""
from orchestrator.store import get_lessons, log_gate_verdict, log_job_summary  # noqa: F401
