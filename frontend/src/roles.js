// Static per-GATE-TYPE metadata (not per block instance, since v4 has a dynamic number of trees/devs).
// A block's actual key at runtime is e.g. "tree_1_team_lead", "tree_2_dev_1", or just "auditor" for
// the one top-level block — these match orchestrator/pipeline.py's block_status keys exactly.
//
// Which provider each gate is restricted to, the default model per gate, and the selectable model
// list per provider all come from GET /models at runtime (see App.jsx's modelConfig state) rather
// than being duplicated here — the backend (orchestrator/agents.py) is the single source of truth,
// so a model rename/retirement only ever needs updating in one place.
export const GATE_MODELS = {
  planner: "Claude", team_lead: "OpenAI", dev: "OpenAI", check_and_test: "OpenAI", auditor: "Claude",
};

export const GATE_ICONS = {
  planner: "compass", team_lead: "briefcase", dev: "code",
  check_and_test: "shield", auditor: "check-shield",
};

export const GATE_DESCRIPTIONS = {
  planner: "Reads your prompt and the target repo, then decides how many trees are needed, what " +
    "each one owns, its subtasks with acceptance criteria, and how many developers it needs. Runs " +
    "once, before the job starts, so you can review and edit it. Restricted to Claude models.",
  team_lead: "Assigns this tree's subtasks to its developers, merges their branches together, and " +
    "runs a quality gate focused purely on UX and accuracy — not scope, security, or formatting. " +
    "Configurable retry cap below controls how many times this gate can reject before the tree (and " +
    "the job) is marked stuck. Restricted to OpenAI models.",
  dev: "Developer, working in its own isolated git worktree. Writes the code and self-tests it " +
    "before handing off. Restricted to OpenAI models.",
  check_and_test: "One combined pass covering scope creep, security issues, and formatting (the old " +
    "Checker's job) AND actually running the code to catch functional bugs (the old Tester's job) — " +
    "reviewed once instead of twice. Configurable retry cap below. Restricted to OpenAI models.",
  auditor: "Final review of the combined result across every tree before handing the branch back to " +
    "you. Approves, optionally polishes the code, and writes your summary — or flags it, in which " +
    "case a coordinator decides which tree(s) are actually at fault and only those re-run. " +
    "Configurable retry cap below. Restricted to Claude models.",
};

// Gate types that have a configurable rejection cap (shown as a number input in their info modal).
export const CAPPED_GATE_TYPES = ["team_lead", "check_and_test", "auditor"];
