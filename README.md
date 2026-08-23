# Agent Swarm

Autonomous coding swarm. A prompt is planned once, up front, into 1-4 independent "trees" — parallel
workstreams with non-overlapping scope — each with its own subtasks and dev count. You review and edit
that plan before anything runs. Each tree then runs its own gate chain (Team Lead assign → devs →
Team Lead quality gate → combined Checker+Tester), restarting from the quality gate on local rejection.
Once every tree merges, one top-level Summarizer → Claude Auditor pass reviews the combined result; if
it rejects, a coordinator decides which tree(s) are actually at fault and only those re-run.

Every run happens in an isolated git worktree on a fresh `swarm/...` branch in your target repo —
nothing is ever pushed or merged automatically. You review the branch and push it yourself.

## Setup

Backend:
```bash
env\Scripts\activate
pip install -r requirements.txt
```

`.env` needs `ANTHROPIC_API_KEY` and `GOOGLE_API_KEY` (both required). `SUPABASE_URL`/`SUPABASE_KEY`
are optional — see "Lessons-learned memory" below; the pipeline runs fine without them.

Frontend (needs [Node.js](https://nodejs.org) LTS installed first):
```bash
cd frontend
npm install
```

## Run

Two processes, in two terminals:

```bash
python swarm.py
```
```bash
cd frontend
npm run dev
```

Open whatever URL the Vite dev server prints (typically http://localhost:5173).

1. Click **Boot-up** → fill in prompt, target repo path, optional planner instructions → **Plan**.
2. Review the plan: how many trees, each one's scope/subtasks/dev count. Edit anything, add/remove
   trees or subtasks, set a max cost → **Confirm & Start**.
3. Before starting, click any other block's info button to give it instructions, and — for **Team
   Lead**, **Check & Test**, and **Auditor** — set its retry cap (default 5; shared across every
   tree's instance of that gate type).
4. Once running, the status bar and diagram fill in live. The Boot-up modal doubles as the detail
   panel — log stream, cost, emergency stop, and (if a cap gets hit) a resume box.

## How a job works

1. **Claude (planner)** — one call, pre-run — decides how many trees are needed, each tree's scope,
   subtasks with acceptance criteria, and dev count. You review/edit this before confirming.
2. Each **tree** runs independently (sequentially, one after another): its **Team Lead** (Gemini Pro)
   assigns subtasks to 1-3 dev agents, each in their own isolated git worktree — devs self-test via
   `run_shell` before reporting done, and the Team Lead merges every dev branch together.
3. The tree's **Team Lead quality gate** judges UX/accuracy only, fed the diff directly, and lightly
   polishes the code in the same pass *only if there's something genuinely worth improving*.
4. **Check & Test** (Gemini Flash) — one combined pass covering scope/security/formatting AND actually
   running the code, instead of two separate reviewers each re-reading the diff from scratch.
5. Once every tree's local gates approve, its branch merges into the job branch and the next tree
   starts. Non-overlapping scope (enforced by the planner) keeps this merge mostly mechanical.
6. After all trees merge: **Summarizer** (Flash) writes a recap, then **Claude (auditor)** reviews the
   combined diff — spot-checking with tools only where genuinely unsure — and either approves (writes
   your final summary, commits) or flags it.
7. On an auditor rejection, a **coordinator** (Gemini Pro) reads the audit notes plus every tree's own
   summary and decides which tree(s) are actually at fault — only those re-run, not everything.

Each gate *type* (Team Lead, Check & Test, Auditor) has its own configurable rejection cap (default 5,
shared across every tree's instance of that gate) plus a job-wide budget cap. Hitting either marks the
job `stuck` rather than looping forever — resume with corrective instructions from the UI, which routes
through the same coordinator logic whether the job got stuck mid-tree or at the top-level audit.

## Cost estimate

Every LLM call's token usage is recorded against a small pricing table (`orchestrator/cost.py`) and
shown live in the UI. Anthropic prompt caching is wired in for the repeated static system prompts
(cache writes ~1.25x normal input price, cache reads ~0.1x) and accounted for in the estimate. Still an
estimate, not a billing-accurate number — Gemini's automatic function-calling tool loops don't cleanly
expose per-internal-turn usage, so multi-turn calls may be undercounted. Claude's manual tool loop is
fully accurate.

## Lessons-learned memory (optional, Supabase)

If `SUPABASE_URL`/`SUPABASE_KEY` are set, every gate verdict and job outcome gets logged, and the
most recent rejections for a target repo are folded into a short digest fed back into the planner and
dev prompts — so repeated mistakes on the same repo get less likely over time. Create the two tables
manually in your Supabase project's SQL editor first — the `CREATE TABLE` statements are in the
docstring at the top of `orchestrator/memory.py`. Left as placeholders, this whole layer is a no-op;
nothing else in the pipeline depends on it.

## Notes

- `jobs/swarm.db` (SQLite job history) and `jobs/worktrees/` (per-run git worktrees) are gitignored —
  they're local runtime state, not part of the tool itself.
- Phase 2 (cloud deployment + auth) and Phase 3 (native mobile client) are both done: see
  [`DEPLOY.md`](DEPLOY.md) for running this on AWS EC2 behind nginx + TLS with API key auth
  (`api/auth.py`), and [`frontend/MOBILE.md`](frontend/MOBILE.md) for building the iOS/Android app
  (Capacitor, same React codebase — `frontend/android/`, `frontend/ios/`). Still Phase 1-friendly:
  running everything locally with no `API_KEY` set works exactly as before.
