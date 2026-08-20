"""v4 tree pipeline. A job is planned once, pre-run (see agents.plan_project, called from the /plan
API endpoint before a job even exists), into 1-4 independent "trees" — each with its own scope,
subtasks, and dev count. Trees run sequentially (devs *within* a tree still run in parallel); each
tree has its own local gate loop: Team Lead assign -> dev round -> Team Lead quality gate ->
check_and_test (combined Checker+Tester), restarting from the quality gate on any local rejection.
Once a tree's local gates approve, it's merged into the job branch and the pipeline moves to the next
tree. After every tree has merged, one top-level pass runs: Summarizer -> Claude Auditor. If the
auditor rejects, a coordinator (the team-lead-tier model) decides which tree(s) are actually at fault and only those
re-run (via run_tree's `initial_notes`, which skips straight to a revision round) before re-merging
and re-auditing — never blindly re-running every tree.

Each of the three gate *types* (team_lead, check_and_test, auditor) has its own configurable rejection
cap (job.gate_caps — same cap value applies to that gate type across every tree, editable from any of
that gate's info modals in the UI) plus a job-wide budget cap. Hitting either marks the job "stuck"
with enough state persisted (job.plan, job.next_tree_index) to resume: resume_job() routes your
correction through the same coordinator that handles auditor rejections, then continues any trees that
hadn't run yet if the job got stuck mid-sequence."""
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from orchestrator import cost, memory, store
from orchestrator.agents import (
    DEFAULT_MODELS,
    audit,
    check_and_test,
    coordinate_revision,
    long_summarize,
    resolve_merge_conflict,
    run_dev_agent,
    team_lead_plan,
    team_lead_quality_gate,
    team_lead_revise,
)
from orchestrator.git_tools import (
    commit_all,
    create_branch_worktree,
    create_worktree,
    current_commit,
    delete_branch,
    diff_against,
    finish_merge,
    merge_branch,
    remove_worktree,
)

WORKTREES_ROOT = str(Path(__file__).resolve().parent.parent / "jobs" / "worktrees")

DEFAULT_CONFIG = {
    "block_instructions": {},  # {"planner": "...", "tree_1_team_lead": "...", "tree_1_dev_1": "...", "auditor": "...", ...}
}


def repo_listing(repo_path: str) -> str:
    """Shared with api/main.py's /plan endpoint, which needs this before any job exists."""
    entries = sorted(p.name for p in Path(repo_path).iterdir() if p.name != ".git")
    return "\n".join(entries)


def _build_context(job_id: str, prompt: str, repo_path: str, config: dict, max_cost: float, gate_caps: dict,
                    gate_attempts: dict, accumulator: cost.CostAccumulator, models: dict = None):
    cost.bind(accumulator)
    block_instructions = config.get("block_instructions", {})
    # Per-gate-type model override (team_lead/dev/check_and_test/auditor — same "one value shared
    # across every tree's instance of that gate type" convention gate_caps already uses), falling
    # back to the DEFAULT_MODELS baked into agents.py for anything the job didn't specify.
    models_cfg = {**DEFAULT_MODELS, **(models or {})}

    def log(line: str):
        store.append_log(job_id, line)
        store.update_job(job_id, cost_estimate=accumulator.total)

    def set_gate(name: str):
        store.update_job(job_id, current_gate=name)

    def start_block(block: str, activity: str = "starting..."):
        store.update_block(job_id, block, state="active", activity=activity, pct=5)

    def finish_block(block: str, activity: str, failed: bool = False):
        store.update_block(job_id, block, state="failed" if failed else "done", activity=activity, pct=100)

    def make_reporter(block: str):
        counter = {"pct": 10}

        def report(text: str):
            counter["pct"] = min(90, counter["pct"] + 15)
            store.update_block(job_id, block, state="active", activity=text, pct=counter["pct"])

        return report

    def check_stop() -> bool:
        if store.is_stop_requested(job_id):
            log("Emergency stop requested — halting (cannot interrupt a call already in flight).")
            store.update_job(job_id, status="stopped", current_gate="stopped")
            return True
        return False

    def check_budget() -> bool:
        if accumulator.total >= max_cost:
            log(f"Hit the ${max_cost:.2f} budget cap (spent ${accumulator.total:.4f}) — "
                f"job stuck, resume with a higher cap or manual instructions if you want to continue.")
            store.update_job(job_id, status="stuck", stuck_reason="budget_cap")
            memory.log_job_summary(job_id, repo_path, prompt, "stuck", accumulator.total, sum(gate_attempts.values()))
            return True
        return False

    def finish(status: str, stuck_reason: str = None):
        store.update_job(job_id, status=status, stuck_reason=stuck_reason)
        memory.log_job_summary(job_id, repo_path, prompt, status, accumulator.total, sum(gate_attempts.values()))

    def bump(block_label: str, gate_type: str) -> bool:
        """Increment one gate instance's rejection count against its gate-TYPE cap. Returns True if
        the job should stop (cap hit)."""
        gate_attempts[block_label] = gate_attempts.get(block_label, 0) + 1
        store.update_job(job_id, gate_attempts=gate_attempts)
        cap = gate_caps.get(gate_type, 5)
        if gate_attempts[block_label] > cap:
            log(f"{block_label} has rejected {cap} times — job stuck, needs your input.")
            finish("stuck", stuck_reason=f"{block_label} hit its {gate_type} cap ({cap} attempts)")
            return True
        return False

    def run_dev_round(block_prefix: str, assignments: list, base_branch: str, base_wt_path: str,
                       lessons: str, round_id: str):
        """Run each assigned dev in its own worktree branched off base_branch, then merge every dev
        branch back into base_wt_path. block_prefix e.g. "tree_1_dev_" -> dev block "tree_1_dev_2"."""
        def do_one(assignment):
            cost.bind(accumulator)
            dev_id = assignment["developer"]
            block = f"{block_prefix}{dev_id}"
            extra = block_instructions.get(block, "")
            start_block(block, f"starting: {assignment['tasks'][0][:60]}")
            log(f"{block} starting in own worktree: {assignment['tasks']}")
            try:
                dev_wt = create_branch_worktree(repo_path, base_branch, f"{block}-{round_id}", WORKTREES_ROOT)
                result = run_dev_agent(dev_id, assignment["tasks"], dev_wt["worktree_path"], extra, lessons,
                                        report=make_reporter(block), model=models_cfg["dev"])
                commit_all(dev_wt["worktree_path"], f"{block} ({round_id}): {assignment['tasks']}")
            except Exception as exc:  # noqa: BLE001 - one dev's transient failure (git hiccup, API
                # blip, subprocess error) must not take the whole job down with an opaque thread trace
                # and lose every other dev's work in the same round — isolate it, report it clearly,
                # and let the round finish with whatever devs did succeed.
                finish_block(block, f"ERROR: {exc}"[:120], failed=True)
                log(f"{block} CRASHED: {exc}")
                return block, None, str(exc)
            finish_block(block, result["report"][:120])
            log(f"{block} finished: {result['report'][:200]}")
            return block, dev_wt, None

        with ThreadPoolExecutor(max_workers=len(assignments)) as pool:
            results = list(pool.map(do_one, assignments))

        failures = [(block, err) for block, dev_wt, err in results if dev_wt is None]
        for block, dev_wt, _ in results:
            if dev_wt is None:
                continue
            merge = merge_branch(base_wt_path, dev_wt["branch"])
            if merge["conflict"]:
                log(f"Merge conflict from {block}, resolving: {merge['conflicted_files']}")
                resolve_merge_conflict(base_wt_path, dev_wt["branch"], merge["conflicted_files"],
                                        report=make_reporter(block), model=models_cfg["team_lead"])
                finish_merge(base_wt_path, f"merge {block} ({round_id}), conflict resolved")
            remove_worktree(repo_path, dev_wt["worktree_path"])
            delete_branch(repo_path, dev_wt["branch"])

        if failures:
            # Whatever succeeded is already merged into base_wt_path above — not lost. Raising here
            # (instead of silently continuing with missing work) still surfaces to run_job's outer
            # handler as a failed job, but now with one clear aggregated message instead of a raw
            # ThreadPoolExecutor trace, and every non-crashed dev's work preserved on the branch.
            summary = "; ".join(f"{block}: {err[:150]}" for block, err in failures)
            raise RuntimeError(f"{len(failures)} dev(s) crashed this round — {summary}")

    return {
        "log": log, "set_gate": set_gate, "check_stop": check_stop, "check_budget": check_budget,
        "finish": finish, "bump": bump, "start_block": start_block, "finish_block": finish_block,
        "make_reporter": make_reporter, "run_dev_round": run_dev_round, "block_instructions": block_instructions,
        "models": models_cfg,
    }


def run_tree(ctx: dict, job_id: str, repo_path: str, tree_id: int, tree_plan: dict, job_branch: str,
             job_wt_path: str, lessons: str, initial_notes: str = None) -> bool:
    """Runs one tree's full local pipeline to approval, then merges it into the job branch.
    initial_notes, when given (a resume or coordinator-flagged revision), skips straight to a
    revision dev round instead of a fresh assignment. Returns True on success, False if the tree's
    own local gate cap was hit (caller marks the job stuck) — None-ish early exits (stop/budget) are
    signaled by the caller re-checking job status after this returns."""
    log, start_block, finish_block = ctx["log"], ctx["start_block"], ctx["finish_block"]
    make_reporter, run_dev_round, bump = ctx["make_reporter"], ctx["run_dev_round"], ctx["bump"]
    block_instructions, models = ctx["block_instructions"], ctx["models"]

    tl_block, cnt_block, dev_prefix = f"tree_{tree_id}_team_lead", f"tree_{tree_id}_check_and_test", f"tree_{tree_id}_dev_"
    subtasks = tree_plan["subtasks"]
    num_devs = max(1, min(3, tree_plan.get("num_devs", 1)))

    # Unique suffix per call: a stuck tree's abandoned worktree/branch is deliberately never deleted
    # (kept for inspection), so a resume or coordinator re-visit of the same tree_id must not collide
    # with it — reusing the plain "tree{id}" label would try to recreate an already-existing branch.
    tree_wt = create_branch_worktree(repo_path, job_branch, f"tree{tree_id}-{uuid.uuid4().hex[:8]}", WORKTREES_ROOT)
    tree_branch, tree_wt_path = tree_wt["branch"], tree_wt["worktree_path"]
    tree_base_sha = current_commit(tree_wt_path)

    round_counter = [0]

    def next_round_id():
        round_counter[0] += 1
        return f"r{round_counter[0]}"

    if initial_notes is None:
        start_block(tl_block, f"assigning {len(subtasks)} subtask(s) to {num_devs} developer(s)")
        log(f"Tree {tree_id}: team lead assigning {len(subtasks)} subtask(s) to {num_devs} developer(s)...")
        assignments = team_lead_plan(subtasks, num_devs, block_instructions.get(tl_block, ""), model=models["team_lead"])
        finish_block(tl_block, "assignments made")
    else:
        log(f"Tree {tree_id}: revising with — {initial_notes}")
        assignments = team_lead_revise("coordinator", initial_notes, subtasks, num_devs, model=models["team_lead"])
    run_dev_round(dev_prefix, assignments, tree_branch, tree_wt_path, lessons, next_round_id())

    while True:
        if ctx["check_stop"]() or ctx["check_budget"]():
            return False

        ctx["set_gate"](tl_block)
        start_block(tl_block, "quality gate: reviewing UX/accuracy")
        diff = diff_against(tree_wt_path, tree_base_sha)
        ql = team_lead_quality_gate(subtasks, diff, tree_wt_path, block_instructions.get(tl_block, ""),
                                     report=make_reporter(tl_block), model=models["team_lead"])
        commit_all(tree_wt_path, f"tree {tree_id}: quality gate pass")
        log(f"Tree {tree_id} team lead verdict: {ql['verdict']} — {ql['notes']}")
        memory.log_gate_verdict(job_id, repo_path, tl_block, round_counter[0], ql["verdict"], ql["notes"])
        if ql["verdict"] != "approve":
            finish_block(tl_block, f"revise: {ql['notes'][:100]}")
            if bump(tl_block, "team_lead"):
                return False
            assignments = team_lead_revise("team lead (quality)", ql["notes"], subtasks, num_devs, model=models["team_lead"])
            run_dev_round(dev_prefix, assignments, tree_branch, tree_wt_path, lessons, next_round_id())
            continue
        finish_block(tl_block, "approved")

        if ctx["check_stop"]() or ctx["check_budget"]():
            return False

        ctx["set_gate"](cnt_block)
        start_block(cnt_block, "checking scope/security/formatting and running the code")
        diff = diff_against(tree_wt_path, tree_base_sha)
        cnt = check_and_test(subtasks, diff, tree_wt_path, block_instructions.get(cnt_block, ""),
                              report=make_reporter(cnt_block), model=models["check_and_test"])
        log(f"Tree {tree_id} check&test verdict: {cnt['verdict']} — {cnt['notes']}")
        memory.log_gate_verdict(job_id, repo_path, cnt_block, round_counter[0], cnt["verdict"], cnt["notes"])
        if cnt["verdict"] != "approve":
            finish_block(cnt_block, f"revise: {cnt['notes'][:100]}")
            if bump(cnt_block, "check_and_test"):
                return False
            assignments = team_lead_revise("checker/tester", cnt["notes"], subtasks, num_devs, model=models["team_lead"])
            run_dev_round(dev_prefix, assignments, tree_branch, tree_wt_path, lessons, next_round_id())
            continue
        finish_block(cnt_block, "approved")
        break

    start_block("merge", f"merging tree {tree_id}")
    log(f"Merging tree {tree_id} into job branch...")
    merge = merge_branch(job_wt_path, tree_branch)
    if merge["conflict"]:
        log(f"Merge conflict from tree {tree_id}, resolving: {merge['conflicted_files']}")
        resolve_merge_conflict(job_wt_path, tree_branch, merge["conflicted_files"],
                                report=make_reporter("merge"), model=models["team_lead"])
        finish_merge(job_wt_path, f"merge tree {tree_id}, conflict resolved")
    finish_block("merge", f"tree {tree_id} merged")
    remove_worktree(repo_path, tree_wt_path)
    delete_branch(repo_path, tree_branch)
    return True


def _run_top_level(ctx: dict, job_id: str, prompt: str, repo_path: str, plan: list, job_branch: str,
                    job_wt_path: str, job_base_sha: str, lessons: str, accumulator: cost.CostAccumulator):
    """After every tree has merged: Summarizer -> Auditor, looping (via the coordinator, targeting
    only the tree(s) actually at fault) on rejection."""
    log, start_block, finish_block, bump = ctx["log"], ctx["start_block"], ctx["finish_block"], ctx["bump"]
    models = ctx["models"]

    while True:
        if ctx["check_stop"]() or ctx["check_budget"]():
            return

        ctx["set_gate"]("auditor")
        start_block("auditor", "reviewing combined diff")
        diff = diff_against(job_wt_path, job_base_sha)
        log("Summarizer writing recap for the auditor...")
        detailed_summary = long_summarize(diff, model=models["check_and_test"])

        log("Claude auditing final diff (spot-check only, trusting the diff + summary)...")
        aud = audit(prompt, detailed_summary, diff, job_wt_path, ctx["block_instructions"].get("auditor", ""),
                    report=ctx["make_reporter"]("auditor"), model=models["auditor"])
        commit_all(job_wt_path, "auditor: polish")
        log(f"Audit verdict: {aud['verdict']} — {aud['notes']}")
        memory.log_gate_verdict(job_id, repo_path, "auditor", 0, aud["verdict"], aud["notes"])
        if aud["verdict"] != "approve":
            finish_block("auditor", f"flagged: {aud['notes'][:100]}")
            if bump("auditor", "auditor"):
                return
            revise_flagged_trees(ctx, job_id, repo_path, plan, aud["notes"], job_branch, job_wt_path, lessons)
            continue
        finish_block("auditor", "approved")

        sha = current_commit(job_wt_path)
        log(f"Approved. Final commit {sha} on {job_branch} — review and push yourself. "
            f"Total estimated cost: ${accumulator.total:.4f}")
        store.update_job(
            job_id, commit_sha=sha, summary=aud["final_summary"], audit_verdict=aud["verdict"],
            audit_notes=aud["notes"], current_gate="done",
        )
        ctx["finish"]("done")
        return


def revise_flagged_trees(ctx: dict, job_id: str, repo_path: str, plan: list, notes: str, job_branch: str,
                          job_wt_path: str, lessons: str) -> bool:
    """Used by both the auditor-rejection loop and resume_job(): ask the coordinator which tree(s)
    are at fault given free-text notes (audit notes, or your own resume instructions), then re-run
    only those. Returns False if any flagged tree hit its own local cap (job already marked stuck)."""
    trees_to_revise = coordinate_revision(notes, plan, model=ctx["models"]["team_lead"])
    for item in trees_to_revise:
        tree_id, tree_notes = item["tree_id"], item["notes"]
        ok = run_tree(ctx, job_id, repo_path, tree_id, plan[tree_id - 1], job_branch, job_wt_path,
                       lessons, initial_notes=tree_notes)
        if not ok:
            return False
    return True


def run_job(job_id: str):
    job = store.get_job(job_id)
    prompt, repo_path, config = job["prompt"], job["repo_path"], {**DEFAULT_CONFIG, **job["config"]}
    plan, max_cost, gate_caps = job["plan"], job["max_cost"] or 1.0, job["gate_caps"]

    gate_attempts = {}
    accumulator = cost.CostAccumulator(max_cost=max_cost)
    ctx = _build_context(job_id, prompt, repo_path, config, max_cost, gate_caps, gate_attempts, accumulator,
                          models=job.get("models"))
    log, finish = ctx["log"], ctx["finish"]

    try:
        store.update_job(job_id, status="running", gate_attempts=gate_attempts, cost_estimate=0, block_status={})

        log(f"Fetching lessons learned for {repo_path} from Supabase (if configured)...")
        lessons = memory.get_lessons(repo_path)
        if lessons:
            log(f"Found lessons from past runs:\n{lessons}")

        log("Creating isolated job worktree...")
        wt = create_worktree(repo_path, prompt, WORKTREES_ROOT)
        job_wt_path, job_branch = wt["worktree_path"], wt["branch"]
        job_base_sha = current_commit(job_wt_path)
        store.update_job(job_id, branch=job_branch, job_wt_path=job_wt_path,
                          job_branch=job_branch, job_base_sha=job_base_sha)
        log(f"Job worktree ready on branch {job_branch}. Plan: {len(plan)} tree(s).")

        for tree_id in range(1, len(plan) + 1):
            if ctx["check_stop"]() or ctx["check_budget"]():
                return
            log(f"Starting tree {tree_id}/{len(plan)}: {plan[tree_id - 1].get('summary', '')}")
            ok = run_tree(ctx, job_id, repo_path, tree_id, plan[tree_id - 1], job_branch, job_wt_path, lessons)
            if not ok:
                return  # stuck, stopped, or over budget — already recorded
            store.update_job(job_id, next_tree_index=tree_id)

        _run_top_level(ctx, job_id, prompt, repo_path, plan, job_branch, job_wt_path, job_base_sha, lessons, accumulator)

    except Exception as exc:  # noqa: BLE001 - surface any failure to the job log instead of crashing the server
        log(f"ERROR: {exc}")
        finish("failed")
        raise


def resume_job(job_id: str, instructions: str):
    """Resume a stuck job. If it got stuck partway through the sequential tree run (next_tree_index <
    len(plan)), fix the tree it was on with your instructions, then continue any trees that hadn't
    started yet. Otherwise (stuck at the top-level auditor or the budget cap after every tree already
    ran), route your instructions through the same coordinator the auditor-rejection path uses, to
    decide which tree(s) actually need the fix."""
    job = store.get_job(job_id)
    if job["status"] != "stuck":
        raise ValueError(f"job {job_id} is not stuck (status={job['status']}) — nothing to resume")
    if not job["job_wt_path"] or not job["plan"]:
        raise ValueError(f"job {job_id} is missing resumable state — can't reconstruct where it left off")

    prompt, repo_path, config = job["prompt"], job["repo_path"], {**DEFAULT_CONFIG, **job["config"]}
    plan, max_cost, gate_caps = job["plan"], job["max_cost"] or 1.0, job["gate_caps"]
    job_branch, job_wt_path, job_base_sha = job["job_branch"], job["job_wt_path"], job["job_base_sha"]
    next_tree_index = job["next_tree_index"] or 0

    gate_attempts = {}  # fresh budget on resume
    accumulator = cost.CostAccumulator(starting_total=job["cost_estimate"] or 0.0, max_cost=max_cost)
    ctx = _build_context(job_id, prompt, repo_path, config, max_cost, gate_caps, gate_attempts, accumulator,
                          models=job.get("models"))
    log, finish = ctx["log"], ctx["finish"]

    try:
        store.update_job(job_id, status="running", stuck_reason=None, stop_requested=0, gate_attempts=gate_attempts)
        log(f"Resuming with your instructions: {instructions}")
        lessons = memory.get_lessons(repo_path)

        if next_tree_index < len(plan):
            log(f"Was mid-sequence on tree {next_tree_index + 1}/{len(plan)} — retrying it with your instructions.")
            ok = run_tree(ctx, job_id, repo_path, next_tree_index + 1, plan[next_tree_index], job_branch,
                          job_wt_path, lessons, initial_notes=instructions)
            if not ok:
                return
            store.update_job(job_id, next_tree_index=next_tree_index + 1)
            for tree_id in range(next_tree_index + 2, len(plan) + 1):
                if ctx["check_stop"]() or ctx["check_budget"]():
                    return
                log(f"Starting tree {tree_id}/{len(plan)}: {plan[tree_id - 1].get('summary', '')}")
                ok = run_tree(ctx, job_id, repo_path, tree_id, plan[tree_id - 1], job_branch, job_wt_path, lessons)
                if not ok:
                    return
                store.update_job(job_id, next_tree_index=tree_id)
        else:
            ok = revise_flagged_trees(ctx, job_id, repo_path, plan, instructions, job_branch, job_wt_path, lessons)
            if not ok:
                return

        _run_top_level(ctx, job_id, prompt, repo_path, plan, job_branch, job_wt_path, job_base_sha, lessons, accumulator)

    except Exception as exc:  # noqa: BLE001
        log(f"ERROR: {exc}")
        finish("failed")
        raise
