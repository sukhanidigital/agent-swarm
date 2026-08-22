// Static per-GATE-TYPE metadata (not per block instance, since v4 has a dynamic number of trees/devs).
// A block's actual key at runtime is e.g. "tree_1_team_lead", "tree_2_dev_1", or just "auditor" for
// the one top-level block — these match orchestrator/pipeline.py's block_status keys exactly.
//
// Which provider each gate is restricted to, the default model per gate, and the selectable model
// list per provider all come from GET /models at runtime (see App.jsx's modelConfig state) rather
// than being duplicated here — the backend (orchestrator/agents.py) is the single source of truth,
// so a model rename/retirement only ever needs updating in one place.
export const GATE_MODELS = {
  planner: "Claude", design: "OpenAI", team_lead: "OpenAI", dev: "OpenAI",
  check_and_test: "OpenAI", auditor: "Claude",
};

export const GATE_ICONS = {
  planner: "compass", design: "flask", team_lead: "briefcase", dev: "code",
  check_and_test: "shield", auditor: "check-shield",
};

export const GATE_DESCRIPTIONS = {
  planner: "Reads your prompt and the target repo, then decides how many trees are needed, what " +
    "each one owns, its subtasks with acceptance criteria, how many developers it needs, and which " +
    "optional SDLC phases (design/review) each tree gets. Runs once, before the job starts, so you " +
    "can review and edit it. Restricted to Claude models.",
  design: "Optional phase — only runs when the planner (or you, editing the plan) included it for " +
    "this tree. Writes a short brief (approach, key files/interfaces, tradeoffs) before any code " +
    "gets written, handed to every developer on the tree as context. Not itself gated/approved — " +
    "kept lightweight on purpose. Restricted to OpenAI models.",
  team_lead: "Assigns this tree's subtasks to its developers and merges their branches together. If " +
    "the \"review\" phase is included, it also runs a quality gate focused purely on UX and accuracy " +
    "— not scope, security, or formatting — after implementation. Configurable retry cap below " +
    "controls how many times that gate can reject before the tree (and the job) is marked stuck. " +
    "Restricted to OpenAI models.",
  dev: "Developer, working in its own isolated git worktree. Writes the code and self-tests it " +
    "before handing off. Restricted to OpenAI models.",
  check_and_test: "One combined pass covering scope creep, security issues, and formatting (the old " +
    "Checker's job) AND actually running the code to catch functional bugs (the old Tester's job) — " +
    "reviewed once instead of twice. Always runs, on every tree, regardless of which optional phases " +
    "are included — this is the floor. Configurable retry cap below. Restricted to OpenAI models.",
  auditor: "Final review of the combined result across every tree before handing the branch back to " +
    "you. Approves, optionally polishes the code, and writes your summary — or flags it, in which " +
    "case a coordinator decides which tree(s) are actually at fault and only those re-run. " +
    "Configurable retry cap below. Restricted to Claude models.",
};

// Gate types that have a configurable rejection cap (shown as a number input in their info modal).
// "design" isn't here — it's a single unGated generation, not a loop with a verdict.
export const CAPPED_GATE_TYPES = ["team_lead", "check_and_test", "auditor"];

// The two optional per-tree SDLC phases the planner staffs — kept in sync with
// orchestrator/agents.py's TREE_PHASES (also served live via GET /models as modelConfig.tree_phases,
// which is what the plan-review UI actually renders from; this is just the human-readable labels).
export const PHASE_LABELS = {
  design: "Design", review: "Review",
};
