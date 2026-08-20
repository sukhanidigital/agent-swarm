// Rough, non-billing-accurate cost/time heuristic shown during plan review — recomputed live as the
// user edits trees/subtasks/dev counts. Calibrated loosely against real logged job costs (see
// orchestrator/cost.py for what actually gets billed); this is a planning aid, not an invoice.
const TEAM_LEAD_ASSIGN = 0.008;   // Gemini Pro, per tree, one call
const TEAM_LEAD_GATE = 0.010;     // Gemini Pro, per tree, fed the full diff
const DEV_BASE = 0.004;           // Gemini Flash, per dev, fixed setup/wrap-up turns
const DEV_PER_SUBTASK = 0.006;    // Gemini Flash, per subtask, tool-heavy multi-turn work
const CHECK_BASE = 0.006;         // Gemini Flash, per tree
const CHECK_PER_SUBTASK = 0.0025; // scales with diff size
const SUMMARIZER = 0.003;         // Gemini Flash, once per job
const AUDITOR = 0.025;            // Claude w/ tools, once per job
const RETRY_COST_MULT_HIGH = 2.4; // accounts for full-chain restarts on gate rejection

const TEAM_LEAD_ASSIGN_MIN = 1.5;
const TEAM_LEAD_GATE_MIN = 1.5;
const DEV_MIN_PER_SUBTASK = 3; // parallelized across a tree's devs
const CHECK_MIN = 2;
const SUMMARIZER_MIN = 1;
const AUDITOR_MIN = 3;
const RETRY_TIME_MULT_HIGH = 2.0;

export function estimatePlan(plan) {
  if (!plan || !plan.length) return null;
  let costLow = 0;
  let timeLow = 0;
  for (const tree of plan) {
    const subtasks = Math.max(1, (tree.subtasks || []).length);
    const devs = Math.max(1, tree.num_devs || 1);
    costLow += TEAM_LEAD_ASSIGN + TEAM_LEAD_GATE + DEV_BASE * devs + DEV_PER_SUBTASK * subtasks
      + CHECK_BASE + CHECK_PER_SUBTASK * subtasks;
    timeLow += TEAM_LEAD_ASSIGN_MIN + (DEV_MIN_PER_SUBTASK * subtasks) / devs + TEAM_LEAD_GATE_MIN + CHECK_MIN;
  }
  costLow += SUMMARIZER + AUDITOR;
  timeLow += SUMMARIZER_MIN + AUDITOR_MIN + Math.max(0, plan.length - 1) * 0.5;
  return {
    costLow, costHigh: costLow * RETRY_COST_MULT_HIGH,
    timeLow: Math.round(timeLow), timeHigh: Math.round(timeLow * RETRY_TIME_MULT_HIGH),
  };
}

export function formatMinutes(min) {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
