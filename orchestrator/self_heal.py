"""Autonomous self-healing for genuine bugs in the swarm's OWN orchestrator code (not the app being
built — a bug in the target repo already gets fixed via the normal Team Lead/Check & Test retry loop,
this is a different, rarer case: an unhandled Python exception reaching run_job/resume_job's top-level
handler, almost always a bug in orchestrator/ or api/ itself).

Rather than just failing the job, an LLM reads the traceback plus whatever source it points to,
patches the bug directly in this running deployment's own source tree, commits the patch, and triggers
an in-place self-restart (os.execv — same process id, same container, no rebuild/redeploy needed) so
the fix takes effect immediately. The crashed job is marked stuck with a dedicated reason and
auto-resumes once the process comes back up (see api/main.py's startup hook).

Guardrails, because an LLM getting real write access to its own control-plane code and the ability to
restart the whole server is genuinely more dangerous than anything else in this codebase:
- Capped at MAX_SELF_HEAL_ATTEMPTS per job — a second crash after a "fix" means the fix was wrong;
  give up cleanly (falls back to a normal failed job) rather than loop forever.
- SelfHealTools below can only write inside orchestrator/ or api/ — never a target repo, never .env,
  never git/docker config, never frontend/.
- Every patch is a real git commit (reviewable, revertible with `git revert`) on this same branch —
  never silent.
- Every attempt (success or failure) is worth knowing about, so it sends an email notification (see
  orchestrator/notify.py) — a self-patch is a materially different event than a normal job outcome.
- If self-healing itself errors, that failure is caught here and never allowed to become a second,
  louder unhandled crash — it just falls back to the normal finish("failed") path."""
import os
import subprocess
import sys
import threading
import traceback
from pathlib import Path

from orchestrator import cost, notify, store
from orchestrator.cost import CostAccumulator
from orchestrator.dev_tools import WorkspaceTools
from orchestrator.llm_clients import call_openai_with_tools

SWARM_ROOT = Path(__file__).resolve().parent.parent
MAX_SELF_HEAL_ATTEMPTS = 2

SELF_HEAL_SYSTEM = """You are fixing a bug in your OWN orchestration code — the Python backend that
runs this whole pipeline (not the application a job is building; that's a separate codebase entirely
and off-limits here). You'll be given a traceback from an unhandled exception. Read whatever file(s)
the traceback points to, find the root cause, and make the minimal fix. You may only touch files under
orchestrator/ or api/ — nothing else (no .env, no docker/git config, no frontend/, no target repos).
Do not add unrelated improvements or refactor anything the traceback doesn't implicate.

When you're done, reply with one plain-text sentence summarizing the bug and the fix, then stop
calling tools."""


class SelfHealTools(WorkspaceTools):
    """WorkspaceTools scoped to the swarm's own source, restricted further to orchestrator/ and api/
    only — the one place in this codebase where write access is deliberately narrower than "the whole
    workspace root", since that root here is the swarm's own control-plane code."""

    def _resolve(self, rel_path: str) -> Path:
        target = super()._resolve(rel_path)
        allowed = (self.root / "orchestrator", self.root / "api")
        if not any(target == d or d in target.parents for d in allowed):
            raise ValueError(f"'{rel_path}' is outside orchestrator/ or api/ — self-heal can't touch it")
        return target


def _git(*args) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=SWARM_ROOT, capture_output=True, text=True, timeout=30)


def try_self_heal(job_id: str) -> bool:
    """Call from inside an `except Exception:` block (needs traceback.format_exc() to still resolve,
    i.e. before any further exception handling clears it). Returns True if a patch was applied and a
    restart+resume was scheduled — the caller must NOT also call finish("failed") in that case, this
    owns finishing the job (via the post-restart auto-resume). Returns False if the attempt cap is hit
    or self-healing itself errors — the caller should fall back to its normal failed-job path."""
    job = store.get_job(job_id)
    attempts = (job.get("self_heal_attempts") or 0) if job else 0
    if attempts >= MAX_SELF_HEAL_ATTEMPTS:
        return False

    tb = traceback.format_exc()
    try:
        # A fresh accumulator, not the job's own — this is the swarm fixing its own bug, not spend
        # the user's job budget should absorb, and shouldn't be able to immediately re-stick the job
        # on its own budget cap the moment it resumes.
        cost.bind(CostAccumulator())

        tools = SelfHealTools(str(SWARM_ROOT))
        prompt = f"Traceback from job {job_id}:\n\n{tb}\n\nFix the underlying bug."
        summary = call_openai_with_tools(
            "gpt-5.4", SELF_HEAL_SYSTEM, tools.openai_tool_defs(), tools.tool_impls(), prompt, max_turns=8,
        )

        if not _git("diff", "--stat", "--", "orchestrator", "api").stdout.strip():
            return False  # nothing actually changed — no fix was made, nothing to restart for

        _git("add", "--", "orchestrator", "api")
        _git("commit", "-m", f"self-heal: {summary[:200]}")

        store.update_job(
            job_id, self_heal_attempts=attempts + 1, pending_self_heal_resume=1, self_heal_notes=summary,
            status="stuck", stuck_reason="self_heal_restarting",
        )
        store.append_log(job_id, f"Self-heal: {summary}\nPatched and committed — restarting to apply "
                                  f"the fix, will resume automatically once back up.")
        notify.notify_self_heal(job_id, summary, tb)

        # A short delay so the log write and email above land before the process image is replaced —
        # os.execv swaps this whole process in place (same pid, same container) rather than exiting
        # and relying on something else to relaunch it, so every other in-flight job thread ends here
        # too, not just this one. Acceptable for how this tool is actually run (one job at a time);
        # worth knowing if that ever changes.
        threading.Timer(1.5, lambda: os.execv(sys.executable, [sys.executable] + sys.argv)).start()
        return True
    except Exception as heal_exc:  # noqa: BLE001 - self-heal failing must fall back cleanly, never crash louder
        print(f"[self_heal] attempt failed for job {job_id}: {heal_exc}")
        return False
