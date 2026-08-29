"""Agent roles in the v4 tree pipeline. Claude plans (once, pre-run) and does the final audit
(2 touchpoints); OpenAI's "pro" tier leads each tree; OpenAI's "flash" tier writes code and runs the
combined check+test pass — that's where the token volume lives. Every role's model is independently
selectable (see PROVIDERS/DEFAULT_MODELS below) — these functions just take a `model` argument rather
than hardcoding one, with the old defaults preserved as fallbacks.

v4 changes from v3: decompose_task/checker/tester are gone, replaced by plan_project() (plans every
tree's subtasks + dev count in one pre-run call, instead of a per-tree sub-orchestrator) and
check_and_test() (one combined pass instead of two separate Checker/Tester calls that each re-read
the diff from scratch). Same cost philosophy as before: every gate is fed the diff directly instead
of rediscovering it via tool calls, and tool calls exist for spot-checking, not primary discovery."""
from orchestrator.dev_tools import WorkspaceTools
from orchestrator.llm_clients import (
    CLAUDE_MODEL,
    OPENAI_FLASH_MODEL,
    OPENAI_PRO_MODEL,
    call_claude,
    call_claude_with_tools,
    call_openai,
    call_openai_with_tools,
    extract_json_object,
    safe_json_load,
)

# Which provider each gate type is restricted to — enforced by the UI (the info modal for an
# OpenAI-provider gate only offers OPENAI_MODELS, a Claude-provider gate only CLAUDE_MODELS) and used
# here as the fallback when a job doesn't specify an override for a gate type.
PROVIDERS = {
    "planner": "claude", "design": "openai", "team_lead": "openai", "dev": "openai",
    "check_and_test": "openai", "auditor": "claude",
}
DEFAULT_MODELS = {
    "planner": CLAUDE_MODEL, "design": OPENAI_PRO_MODEL, "team_lead": OPENAI_PRO_MODEL,
    "dev": OPENAI_FLASH_MODEL, "check_and_test": OPENAI_FLASH_MODEL, "auditor": CLAUDE_MODEL,
}
# The two optional SDLC phases the planner can staff per tree, on top of the always-on floor
# (implementation + check_and_test) — see PLAN_PROJECT_SYSTEM. "review" is the existing team-lead
# quality gate; kept toggleable too since not every tree benefits from a UX pass, but the planner
# is steered to default it on since it's cheap. "design" is genuinely new: a short brief written and
# threaded into every dev's prompt before any code gets written.
TREE_PHASES = ["design", "review"]
# Curated, cost.py-priced selection shown in each gate's model dropdown — not every model OpenAI/
# Anthropic offer, just ones sensible for this kind of agentic coding work.
CLAUDE_MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]
OPENAI_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-4.1", "gpt-4.1-mini",
                  "gpt-4.1-nano", "o4-mini"]

PLAN_PROJECT_SYSTEM = """You are the project planner for an autonomous coding swarm. Given a user's
coding request and a listing of the target repository, decide how to break the work into 1-4
independent "trees" — parallel workstreams that can be developed with minimal risk of touching the
same files. A simple, small request should be exactly 1 tree; only split into more trees when the
request genuinely has separable pieces (distinct features, distinct layers of a stack, distinct
files/directories). More trees costs more — don't split just because you can.

For each tree, write a short list of concrete subtasks with acceptance criteria (like a mini version
of the same planning task, scoped to that tree), and decide how many developers (1-3) that tree
actually needs — most trees need only 1; use 2-3 only when a tree's own subtasks are genuinely
independent of each other and can be safely parallelized.

Every tree always gets implementation (the dev agent(s)) and a final check-and-test pass — those are
never optional, that's the floor of what "done" means here. On top of that floor, choose which of two
extra SDLC phases this specific tree actually needs, and put them in "phases":
- "review": a team-lead quality gate (UX/accuracy) after implementation, before check-and-test. Cheap
  and broadly useful — default this ON for most trees, only drop it for genuinely trivial/mechanical
  work (e.g. a one-line config change) where an extra review pass adds nothing.
- "design": a short design brief (approach, key files/interfaces, tradeoffs) written before any code,
  handed to every developer on the tree as context. Worth it for new features, unfamiliar territory, or
  anything with real architectural decisions to make (data model, module boundaries, cross-file
  interfaces). Skip it for small, well-understood changes — the design doc would just restate the task.
Match the phase list to the tree's actual size and risk — a small tree should end up with just
["review"] or even [], while a large/risky/novel tree should get ["design", "review"]. Don't include
phases out of habit; every phase you add costs real time and money.

Critical: give each tree an explicit, non-overlapping scope (specific files/directories/concerns) so
no two trees ever need to touch the same file — this is what keeps the eventual cross-tree merge cheap
and safe. State each tree's scope explicitly in its summary.

Respond ONLY with JSON:
{"trees": [{"summary": "one line: what this tree owns and its scope",
            "subtasks": [{"task": "...", "acceptance": "..."}], "num_devs": 1,
            "phases": ["review"]}]}"""

TEAM_LEAD_DESIGN_SYSTEM = """You are the engineering team lead writing a short design brief for your
developers before any code gets written. Given this tree's subtasks, decide the concrete approach:
which files/modules are involved, any new interfaces or data shapes, and the key tradeoffs you're
making and why. Keep it tight and actionable — this gets handed directly to the developers as context,
not filed away. No JSON, no headers — just the brief as plain prose, 3-8 sentences."""

TEAM_LEAD_PLAN_SYSTEM = """You are the engineering team lead for a small dev team of {n} developers.
You've been given a subtask list (each with an acceptance criterion) from your manager. Assign each
subtask to a developer (round-robin or by grouping related subtasks together, whichever keeps devs
from touching the same files). Respond ONLY with JSON:
{{"assignments": [{{"developer": 1, "tasks": ["..."]}}, ...]}}."""

TEAM_LEAD_REVISE_SYSTEM = """You are the engineering team lead for a small dev team of {n} developers.
A gate later in your pipeline rejected the last attempt. Read the rejection feedback and assign
targeted fix-up work to whichever developer(s) actually need to act — don't reassign everyone if
only one area is broken. Respond ONLY with JSON: {{"assignments": [{{"developer": 1, "tasks": ["..."]}}, ...]}}."""

DEPENDENCY_CONVENTION = """
If the code needs an external package, you're free to install it — but every agent that touches this
project (including later reviewers, possibly in a different worktree checkout of the same repo) needs
to be able to run the code too, so follow this convention rather than installing ad hoc:
- Use a local virtual environment at `.venv` in the project root. If it doesn't exist yet, create one
  (`python -m venv .venv`) before installing anything into it.
- Every worktree is a separate checkout — a venv created in one worktree does NOT exist in another, and
  each run_shell call is its own fresh process, so "activating" a venv doesn't persist between calls
  either. Always invoke the venv's binaries by their full path instead of relying on activation, e.g.
  `.venv\\Scripts\\pip install X` and `.venv\\Scripts\\python.exe script.py` on Windows (or
  `.venv/bin/pip`/`.venv/bin/python` on Linux/Mac).
- Keep a `requirements.txt` in the project root up to date with anything you install, and commit it —
  that's what lets a later reviewer in a fresh worktree recreate the same environment
  (`.venv\\Scripts\\pip install -r requirements.txt`) instead of guessing what's needed."""

# Recurring categories of thing a quality-gate rejection catches reactively when they could've been
# gotten right the first time — every retry round re-runs the *dev* agents (the expensive tool-calling
# part), so catching these upfront instead of after a rejection is a real cost lever, not just a
# quality one. Shared between DEV_SYSTEM (get it right) and TEAM_LEAD_QUALITY_SYSTEM (check for it),
# so the bar a dev is told to meet and the bar they're actually held to stay the same bar.
QUALITY_STANDARDS = """
A few standing expectations worth getting right the first time, not after a review round flags them:
- If the domain implies an order/sequence to how things get applied (steps, priority, precedence),
  make that ordering explicit in the design (a real field/parameter) — don't leave it implicit and
  assumed, that's exactly the kind of gap a later review finds and sends back for a costly re-round.
- Cover the primary end-to-end path with an integration/happy-path test, not just isolated unit tests
  of individual pieces — the pieces working alone doesn't mean the path through all of them does.
- Wire any side-effecting or background work (kicking off a job, sending a request, starting
  processing) from exactly one place. Double-check a route handler and the service layer underneath
  it aren't both triggering the same action.
- When comparing enum/status values, compare against the actual enum member, not a string that
  happens to match its name — those aren't guaranteed interchangeable."""

MERGE_CONFLICT_SYSTEM = """You are the engineering team lead resolving a git merge conflict. You have
file tools scoped to the project root. Read each conflicted file, resolve the <<<<<<< / ======= / >>>>>>>
markers by keeping the correct combined result (both changes if they don't actually contradict, otherwise
use your judgment), and write the resolved file back with no markers left. Reply with a short confirmation
when every conflicted file is clean."""

DEV_SYSTEM = """You are a software developer working inside a git worktree at the project root.
You have tools to list files, read files, write files, and run shell commands (tests, linters).
Complete your assigned task(s) fully using the tools, matching each one's stated acceptance criterion.
Explore the existing code style before writing new code and match it. Stay strictly within your
assigned scope — don't touch files outside what you were actually asked to do.

Your work will be checked by a later reviewer that both scope-checks it and actually runs it — save a
round trip by meeting that bar on the first pass: match the surrounding code's formatting, no secrets
or unsafe shell/eval usage, and run the project's own tests/linter yourself via run_shell before you
report done, fixing anything that fails.
{quality_standards}
{dependency_convention}

When you are done, reply with a short plain-text summary of what you changed and stop calling tools.
""".format(quality_standards=QUALITY_STANDARDS, dependency_convention=DEPENDENCY_CONVENTION)

TEAM_LEAD_QUALITY_SYSTEM = """You are the engineering team lead reviewing your developers' work,
purely on quality — UX and accuracy. Nothing else: not scope, not security, not formatting, those are
someone else's job. You'll be given the diff directly — read it first; only use read_file/run_shell if
something in it is genuinely ambiguous without more context.

If you approve AND there's a real, worthwhile improvement to make (an unclear name, a missing comment
on a genuinely non-obvious WHY, a small robustness gap), make that one edit with write_file in this
same pass. If the code is already solid, approve and make NO edits — don't invent busywork just to
have touched something; an unnecessary edit costs a tool call and risks introducing a new issue for no
benefit.

Check for these specifically — recurring gaps worth catching here rather than another round later:
{quality_standards}
{dependency_convention}
End your final message with ONLY this JSON on its own, no other text:
{"verdict": "approve" or "revise", "notes": "1-3 sentences — if revise, be specific about what you don't like"}""".replace(
    "{quality_standards}", QUALITY_STANDARDS).replace("{dependency_convention}", DEPENDENCY_CONVENTION)

CHECK_AND_TEST_SYSTEM = """You are both the checker and tester for this code, combined into one pass —
review it once, thoroughly, instead of two separate reviewers each re-reading the same diff from
scratch for different things.

Checking (scope/security/formatting): reject anything that touches files outside the intended scope,
contains secrets or unsafe shell/eval usage, or doesn't match the surrounding code's formatting.
Testing (does it actually work): use run_shell to actually run the project's own tests/linters, or a
basic syntax/import check if no test suite exists — don't just read the diff and assume it runs.

You'll be given the diff and the intended scope directly — read it first; use read_file for anything
genuinely unclear from the diff alone, and run_shell to verify it actually runs.
{dependency_convention}
End your final message with ONLY this JSON on its own, no other text:
{"verdict": "approve" or "revise", "notes": "1-3 sentences covering whichever side(s) failed, if any"}""".replace(
    "{dependency_convention}", DEPENDENCY_CONVENTION)

LONG_SUMMARY_SYSTEM = """You summarize a git diff for a senior engineer about to do a final audit who
hasn't seen any of the work yet. Match your depth to the actual size and complexity of the diff: a
small, simple change gets 2-4 sentences covering what changed and why; a large diff spanning several
areas gets a fuller rundown — what changed, which files, tradeoffs made along the way, anything worth
double-checking. Never pad a small change with unnecessary detail. No code blocks — prose only."""

AUDITOR_SYSTEM = """You are the final auditor for an autonomous coding swarm's output, reviewing before
it's handed back to the user for a manual git push. You're given the original request, a detailed
summary, and the full diff directly — trust them as your primary source; that's usually enough on its
own to decide. You have file tools (list_dir/read_file/run_shell/write_file) scoped to the project
root, but you have a small budget of tool calls — use them only to spot-check the one or two things
you're genuinely unsure about, not to re-verify everything from scratch. You may lightly polish the
code with write_file if you want (don't change behavior). Look for correctness issues, missing pieces,
or anything unsafe. If the diff shows work from more than one independently-developed tree, also check
they integrate cleanly (duplicate logic, naming collisions, inconsistent conventions) — skip this
check entirely if it's a single-tree diff, there's nothing to integrate. You MUST end with a verdict
within your tool budget — if you're genuinely unsure after 1-2 checks, approve with caveats noted
rather than exhausting your turns still investigating.
{dependency_convention}
Respond with ONLY this JSON, no other text:
{"verdict": "approve" or "flag", "notes": "your assessment, 2-5 sentences",
 "final_summary": "short summary for the end user — only needs to be meaningful if you're approving"}""".replace(
    "{dependency_convention}", DEPENDENCY_CONVENTION)

TREE_REVISE_SYSTEM = """You are the project coordinator. The final auditor rejected the combined result
of several independently-developed trees. Given the audit notes and each tree's own scope summary,
decide which tree(s) are actually responsible and what fix-up instructions to give them — don't
re-open a tree that isn't implicated by the notes. Respond ONLY with JSON:
{"trees_to_revise": [{"tree_id": 1, "notes": "specific fix instructions for this tree"}]}"""


def plan_project(prompt: str, repo_listing: str, lessons: str = "", instructions: str = "",
                  model: str = DEFAULT_MODELS["planner"]) -> list[dict]:
    context = f"User request: {prompt}\n\nRepo root listing:\n{repo_listing}"
    if lessons:
        context += f"\n\nLessons from past runs on this repo (avoid repeating these mistakes):\n{lessons}"
    if instructions:
        context += f"\n\nUser instructions for you specifically:\n{instructions}"
    text = call_claude(PLAN_PROJECT_SYSTEM, context, model=model, max_tokens=8192)
    return safe_json_load(text)["trees"]


def team_lead_design(subtasks: list, instructions: str = "",
                      model: str = DEFAULT_MODELS["design"]) -> str:
    """Optional pre-implementation phase (only run when the planner put "design" in a tree's phases).
    Returns a short brief threaded into team_lead_plan and every dev's prompt as extra context — not
    itself gated/approved, kept lightweight on purpose."""
    prompt = f"Subtasks:\n{subtasks}"
    if instructions:
        prompt += f"\n\nUser instructions for you specifically:\n{instructions}"
    return call_openai(TEAM_LEAD_DESIGN_SYSTEM, prompt, model=model).strip()


def team_lead_plan(subtasks: list, num_devs: int, instructions: str = "", design_notes: str = "",
                    model: str = DEFAULT_MODELS["team_lead"]) -> list[dict]:
    system = TEAM_LEAD_PLAN_SYSTEM.format(n=num_devs)
    prompt = f"Subtasks:\n{subtasks}"
    if design_notes:
        prompt += f"\n\nDesign brief for this tree (written before assignment, hand its constraints to devs):\n{design_notes}"
    if instructions:
        prompt += f"\n\nUser instructions for you specifically:\n{instructions}"
    text = call_openai(system, prompt, model=model)
    return safe_json_load(text)["assignments"]


def team_lead_revise(rejection_source: str, notes: str, subtasks: list, num_devs: int,
                      model: str = DEFAULT_MODELS["team_lead"]) -> list[dict]:
    system = TEAM_LEAD_REVISE_SYSTEM.format(n=num_devs)
    prompt = (f"Original subtasks:\n{subtasks}\n\nRejected by: {rejection_source}\nFeedback: {notes}\n\n"
              "Assign fix-up work to address this feedback.")
    text = call_openai(system, prompt, model=model)
    return safe_json_load(text)["assignments"]


def run_dev_agent(developer_id: int, tasks: list, worktree_path: str, extra_instructions: str = "",
                   lessons: str = "", design_notes: str = "", report=None,
                   model: str = DEFAULT_MODELS["dev"]) -> dict:
    tools = WorkspaceTools(worktree_path, report=report)
    prompt = "Your tasks:\n" + "\n".join(f"- {t}" for t in tasks)
    if design_notes:
        prompt += f"\n\nDesign brief for this tree (follow its approach):\n{design_notes}"
    if lessons:
        prompt += f"\n\nLessons from past runs on this repo (avoid repeating these mistakes):\n{lessons}"
    if extra_instructions:
        prompt += f"\n\nAdditional instructions from the user:\n{extra_instructions}"
    report_text = call_openai_with_tools(model, DEV_SYSTEM, tools.openai_tool_defs(), tools.tool_impls(),
                                          prompt, max_turns=14)
    return {"developer": developer_id, "report": report_text, "tool_log": tools.log}


def resolve_merge_conflict(job_worktree_path: str, dev_branch: str, conflicted_files: list, report=None,
                            model: str = DEFAULT_MODELS["team_lead"]) -> str:
    tools = WorkspaceTools(job_worktree_path, report=report)
    prompt = f"Merging branch {dev_branch} produced conflicts in: {conflicted_files}. Resolve them."
    return call_openai_with_tools(model, MERGE_CONFLICT_SYSTEM, tools.openai_tool_defs(), tools.tool_impls(),
                                   prompt, max_turns=8)


def team_lead_quality_gate(subtasks: list, diff: str, worktree_path: str, instructions: str = "", report=None,
                            model: str = DEFAULT_MODELS["team_lead"]) -> dict:
    """Judges quality only, and — if there's a genuine improvement worth making — also lightly
    optimizes/comments in the same pass (folded in here rather than a separate call). Skips the write
    entirely when there's nothing worth touching, per the system prompt."""
    tools = WorkspaceTools(worktree_path, report=report)
    prompt = f"Original subtasks:\n{subtasks}\n\nDiff:\n{diff[:20000]}"
    if instructions:
        prompt += f"\n\nUser instructions for you specifically:\n{instructions}"
    text = call_openai_with_tools(model, TEAM_LEAD_QUALITY_SYSTEM, tools.openai_tool_defs(), tools.tool_impls(),
                                   prompt, max_turns=5)
    return extract_json_object(text)


def check_and_test(subtasks: list, diff: str, worktree_path: str, instructions: str = "", report=None,
                    model: str = DEFAULT_MODELS["check_and_test"]) -> dict:
    """Combined Checker+Tester — one pass covering scope/security/formatting AND actually running the
    code, instead of two separate agents each re-reading the diff from scratch."""
    tools = WorkspaceTools(worktree_path, report=report)
    prompt = f"Intended scope (the original subtasks):\n{subtasks}\n\nDiff:\n{diff[:20000]}\n\nCheck and test these changes."
    if instructions:
        prompt += f"\n\nUser instructions for you specifically:\n{instructions}"
    text = call_openai_with_tools(model, CHECK_AND_TEST_SYSTEM, tools.openai_tool_defs(include_write=False),
                                   tools.tool_impls(), prompt, max_turns=6)
    return extract_json_object(text)


def long_summarize(diff: str, model: str = DEFAULT_MODELS["check_and_test"]) -> str:
    return call_openai(LONG_SUMMARY_SYSTEM, diff[:30000], model=model).strip()


def audit(original_prompt: str, long_summary: str, diff: str, worktree_path: str,
          instructions: str = "", report=None, model: str = DEFAULT_MODELS["auditor"]) -> dict:
    tools = WorkspaceTools(worktree_path, report=report)
    prompt = (f"Original request: {original_prompt}\n\nDetailed summary from the dev team:\n{long_summary}\n\n"
              f"Diff:\n{diff[:20000]}\n\nGive your verdict. Only use tools to spot-check something specific.")
    if instructions:
        prompt += f"\n\nUser instructions for you specifically:\n{instructions}"
    text = call_claude_with_tools(
        AUDITOR_SYSTEM, prompt, tools.anthropic_tool_defs(), tools.tool_impls(), model=model, max_turns=6
    )
    return extract_json_object(text)


def coordinate_revision(audit_notes: str, trees: list, model: str = DEFAULT_MODELS["team_lead"]) -> list[dict]:
    """When the top-level auditor rejects the merged result, decide which tree(s) are actually at
    fault instead of re-running every tree blindly."""
    tree_summaries = [{"tree_id": t["tree_id"], "summary": t.get("summary", "")} for t in trees]
    prompt = f"Audit rejection notes:\n{audit_notes}\n\nTrees:\n{tree_summaries}"
    text = call_openai(TREE_REVISE_SYSTEM, prompt, model=model)
    return safe_json_load(text)["trees_to_revise"]
