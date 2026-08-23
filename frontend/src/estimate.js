// Rough, non-billing-accurate cost/time heuristic shown during plan review — recomputed live as the
// user edits trees/subtasks/dev counts/models/caps. Calibrated loosely against real logged job costs
// (see orchestrator/cost.py for what actually gets billed); this is a planning aid, not an invoice.
//
// Three things make this complexity-aware rather than a flat per-subtask formula:
// 1. Each tree carries a planner-suggested "complexity" (low/medium/high) that scales its base cost —
//    a domain-fiddly tree (e.g. one needing real iterative testing) costs more than a simple one, even
//    with the same subtask count, which a flat formula can't tell apart.
// 2. The high end scales with whatever retry caps are actually set for that tree's gates — raise a
//    cap because you expect a tree to need more iteration, and the worst-case estimate reflects that.
// 3. If you've picked a specific model for a block, its real per-token price (from GET /models,
//    passed in as `pricing`) scales that block's contribution relative to the default model for that
//    role — a pricier model shows up as a pricier estimate, not silently ignored.
const TEAM_LEAD_ASSIGN = 0.008;   // per tree, one call
const TEAM_LEAD_GATE = 0.010;     // per tree, fed the full diff
const DEV_BASE = 0.004;           // per dev, fixed setup/wrap-up turns
const DEV_PER_SUBTASK = 0.006;    // per subtask, tool-heavy multi-turn work
const CHECK_BASE = 0.006;         // per tree
const CHECK_PER_SUBTASK = 0.0025; // scales with diff size
const SUMMARIZER = 0.003;         // once per job
const AUDITOR = 0.025;            // once per job, tool-using

const TEAM_LEAD_ASSIGN_MIN = 1.5;
const TEAM_LEAD_GATE_MIN = 1.5;
const DEV_MIN_PER_SUBTASK = 3; // parallelized across a tree's devs
const CHECK_MIN = 2;
const SUMMARIZER_MIN = 1;
const AUDITOR_MIN = 3;

const COMPLEXITY_FACTOR = { low: 0.7, medium: 1.0, high: 1.6 };
const RETRY_COST_MULT = { low: 1.4, medium: 2.0, high: 3.0 };
const RETRY_TIME_MULT = { low: 1.3, medium: 1.8, high: 2.5 };
const DEFAULT_CAP = 5;
const MAX_CAP_SCALE = 2; // clamp so an extreme cap doesn't blow the estimate up absurdly

// Rough input/output blend for a typical agentic tool-loop call (mostly resent context, modest output
// per turn) — just enough to turn a model's two-number pricing into one comparable rate.
const BLEND_INPUT_WEIGHT = 0.75;

function blendedRate(model, pricing) {
  const p = pricing && pricing[model];
  if (!p) return null;
  const [inRate, outRate] = p;
  return inRate * BLEND_INPUT_WEIGHT + outRate * (1 - BLEND_INPUT_WEIGHT);
}

function priceRatio(selectedModel, defaultModel, pricing) {
  if (!pricing || !selectedModel || !defaultModel) return 1;
  const selected = blendedRate(selectedModel, pricing);
  const base = blendedRate(defaultModel, pricing);
  if (!selected || !base) return 1;
  return selected / base;
}

function complexityOf(tree) {
  return COMPLEXITY_FACTOR[tree.complexity] ? tree.complexity : "medium";
}

// opts: { gateCaps, blockModels, defaultModels, pricing } — all optional; omit any of them and that
// part of the estimate just falls back to the flat, model/cap-agnostic behavior this had before.
export function estimatePlan(plan, opts = {}) {
  if (!plan || !plan.length) return null;
  const { gateCaps = {}, blockModels = {}, defaultModels = {}, pricing = null } = opts;
  let costLow = 0, costHigh = 0, timeLow = 0, timeHigh = 0;

  plan.forEach((tree, i) => {
    const treeId = i + 1;
    const subtasks = Math.max(1, (tree.subtasks || []).length);
    const devs = Math.max(1, tree.num_devs || 1);
    const complexity = complexityOf(tree);
    const factor = COMPLEXITY_FACTOR[complexity];

    const tlBlock = `tree_${treeId}_team_lead`;
    const cntBlock = `tree_${treeId}_check_and_test`;
    const devBlock = `tree_${treeId}_dev_1`; // representative — devs in a tree share one suggested model

    const tlRatio = priceRatio(blockModels[tlBlock], defaultModels.team_lead, pricing);
    const devRatio = priceRatio(blockModels[devBlock], defaultModels.dev, pricing);
    const cntRatio = priceRatio(blockModels[cntBlock], defaultModels.check_and_test, pricing);

    const baseCost = (
      (TEAM_LEAD_ASSIGN + TEAM_LEAD_GATE) * tlRatio
      + (DEV_BASE * devs + DEV_PER_SUBTASK * subtasks) * devRatio
      + (CHECK_BASE + CHECK_PER_SUBTASK * subtasks) * cntRatio
    ) * factor;
    const baseTime = (TEAM_LEAD_ASSIGN_MIN + (DEV_MIN_PER_SUBTASK * subtasks) / devs
      + TEAM_LEAD_GATE_MIN + CHECK_MIN) * factor;

    const tlCap = gateCaps[tlBlock] ?? DEFAULT_CAP;
    const cntCap = gateCaps[cntBlock] ?? DEFAULT_CAP;
    // Clamped to [1, MAX_CAP_SCALE]: a below-default cap should never shrink the retry multiplier
    // below the complexity-based baseline (a retry always costs more than zero retries, never less)
    // — this only ever scales the ceiling *up* for an above-default cap, never down.
    const capScale = Math.min(MAX_CAP_SCALE, Math.max(1, Math.max(tlCap, cntCap) / DEFAULT_CAP));

    costLow += baseCost;
    costHigh += baseCost * RETRY_COST_MULT[complexity] * capScale;
    timeLow += baseTime;
    timeHigh += baseTime * RETRY_TIME_MULT[complexity] * capScale;
  });

  const auditorRatio = priceRatio(blockModels.auditor, defaultModels.auditor, pricing);
  const auditorCap = gateCaps.auditor ?? DEFAULT_CAP;
  const auditorCapScale = Math.min(MAX_CAP_SCALE, Math.max(1, auditorCap / DEFAULT_CAP));
  const mergeOverheadMin = Math.max(0, plan.length - 1) * 0.5;

  costLow += SUMMARIZER + AUDITOR * auditorRatio;
  costHigh += (SUMMARIZER + AUDITOR * auditorRatio) * 1.8 * auditorCapScale;
  timeLow += SUMMARIZER_MIN + AUDITOR_MIN + mergeOverheadMin;
  timeHigh += (SUMMARIZER_MIN + AUDITOR_MIN) * 1.6 * auditorCapScale + mergeOverheadMin;

  return {
    costLow, costHigh: Math.max(costLow, costHigh),
    timeLow: Math.round(timeLow), timeHigh: Math.round(Math.max(timeLow, timeHigh)),
  };
}

export function formatMinutes(min) {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
