import { useEffect, useMemo, useRef, useState } from "react";
import NodeBox from "./components/NodeBox";
import Modal from "./components/Modal";
import Icon from "./components/Icon";
import { GATE_MODELS, GATE_ICONS, GATE_DESCRIPTIONS, CAPPED_GATE_TYPES } from "./roles";
import {
  planProject, submitJob, getJob, stopJob, resumeJob,
  createRepo, startChat, sendChatMessage, startRun, getRunStatus, stopRun,
  startPathRun, getPathRunStatus, stopPathRun, getModelConfig,
} from "./api";
import { estimatePlan, formatMinutes } from "./estimate";
import "./App.css";

const TERMINAL_STATUSES = ["done", "failed", "stopped", "stuck"];
const STATUS_LABELS = {
  queued: "Queued", running: "Running", done: "Done", failed: "Failed",
  stopped: "Stopped", stuck: "Stuck",
};
const DEFAULT_GATE_CAPS = { team_lead: 5, check_and_test: 5, auditor: 5 };
const LAST_JOB_KEY = "swarm_last_job_id";

function parseBlockKey(block) {
  if (block === "auditor") return { gateType: "auditor", label: "Auditor" };
  if (block === "planner") return { gateType: "planner", label: "Planner" };
  const treeMatch = block.match(/^tree_(\d+)_(.+)$/);
  if (!treeMatch) return { gateType: block, label: block };
  const [, treeId, rest] = treeMatch;
  if (rest === "team_lead") return { gateType: "team_lead", label: `Tree ${treeId} — Team Lead` };
  if (rest === "check_and_test") return { gateType: "check_and_test", label: `Tree ${treeId} — Check & Test` };
  const devMatch = rest.match(/^dev_(\d+)$/);
  if (devMatch) return { gateType: "dev", label: `Tree ${treeId} — Dev ${devMatch[1]}` };
  return { gateType: rest, label: `Tree ${treeId} — ${rest}` };
}

function App() {
  // --- pre-run planning state ---
  const [prompt, setPrompt] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [plannerInstructions, setPlannerInstructions] = useState("");
  const [plan, setPlan] = useState(null); // null = not planned yet; array of trees once planned
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState("");

  const [maxCost, setMaxCost] = useState(1.0);
  const [gateCaps, setGateCaps] = useState(DEFAULT_GATE_CAPS);
  const [blockInstructions, setBlockInstructions] = useState({});
  const [startError, setStartError] = useState("");
  const [starting, setStarting] = useState(false); // guards against a double-click firing /jobs twice

  // --- model selection ---
  // modelConfig (providers/default_models/claude_models/openai_models) comes from GET /models —
  // the backend (orchestrator/agents.py) is the single source of truth, fetched once on mount rather
  // than duplicated here, so a model rename only ever needs updating in one place. blockModels holds
  // the (possibly user-edited) per-gate-type selection, keyed the same as gateCaps/blockInstructions;
  // seeded from modelConfig.default_models once that arrives.
  const [modelConfig, setModelConfig] = useState(null);
  const [blockModels, setBlockModels] = useState({});
  const [draftModel, setDraftModel] = useState("");

  useEffect(() => {
    getModelConfig().then((cfg) => {
      setModelConfig(cfg);
      setBlockModels(cfg.default_models);
    }).catch(() => {
      // if this fails the model dropdowns just won't render — everything else still works
    });
  }, []);

  // --- create-repo (stacked modal, doesn't close Boot-up) ---
  const [createRepoOpen, setCreateRepoOpen] = useState(false);
  const [createRepoPath, setCreateRepoPath] = useState("");
  const [createRepoGithub, setCreateRepoGithub] = useState(false);
  const [createRepoLoading, setCreateRepoLoading] = useState(false);
  const [createRepoError, setCreateRepoError] = useState("");

  // --- run state ---
  // Seeded from localStorage so a page reload (a laptop sleep/wake can trigger one) reattaches to
  // whatever job was in flight instead of losing it — the actual state always lives server-side.
  const [jobId, setJobIdState] = useState(() => localStorage.getItem(LAST_JOB_KEY));
  const [job, setJob] = useState(null);
  const [activeModal, setActiveModal] = useState(null); // block key, "boot_up", or null
  const [resumeText, setResumeText] = useState("");
  const [draftInstructions, setDraftInstructions] = useState("");
  const [draftCap, setDraftCap] = useState(5);

  const intervalRef = useRef(null);

  function setJobId(id) {
    if (id) localStorage.setItem(LAST_JOB_KEY, id);
    else localStorage.removeItem(LAST_JOB_KEY);
    setJobIdState(id);
  }

  function startNewRun() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setJobId(null);
    setJob(null);
    setPlan(null);
    setPrompt("");
    setRepoPath("");
    setPlannerInstructions("");
    setBlockInstructions({});
    setGateCaps(DEFAULT_GATE_CAPS);
    setBlockModels(modelConfig?.default_models || {});
  }

  function startPolling(id) {
    const poll = async () => {
      try {
        const data = await getJob(id);
        setJob(data);
        if (TERMINAL_STATUSES.includes(data.status) && intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } catch {
        // transient poll failure — try again next tick
      }
    };
    poll();
    intervalRef.current = setInterval(poll, 2000);
  }

  useEffect(() => {
    if (jobId) startPolling(jobId);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const activePlan = job?.plan || plan;

  function openModal(block) {
    setDraftInstructions(blockInstructions[block] || "");
    const { gateType } = parseBlockKey(block);
    setDraftCap(gateCaps[gateType] ?? 5);
    setDraftModel(blockModels[gateType] || modelConfig?.default_models?.[gateType] || "");
    setActiveModal(block);
  }

  function closeModal() {
    setActiveModal(null);
  }

  function saveInstructions() {
    setBlockInstructions((prev) => {
      const next = { ...prev };
      if (draftInstructions.trim()) next[activeModal] = draftInstructions.trim();
      else delete next[activeModal];
      return next;
    });
    const { gateType } = parseBlockKey(activeModal);
    if (CAPPED_GATE_TYPES.includes(gateType)) {
      setGateCaps((prev) => ({ ...prev, [gateType]: Math.max(1, draftCap) }));
    }
    if (draftModel) {
      setBlockModels((prev) => ({ ...prev, [gateType]: draftModel }));
    }
    setActiveModal(null);
  }

  async function handlePlan() {
    if (!prompt.trim() || !repoPath.trim()) {
      setPlanError("Prompt and repo path are required.");
      return;
    }
    setPlanError("");
    setPlanLoading(true);
    try {
      const plannerModel = blockModels.planner || modelConfig?.default_models?.planner;
      const trees = await planProject({ prompt, repoPath, instructions: plannerInstructions, model: plannerModel });
      setPlan(trees);
    } catch (err) {
      setPlanError(err.message);
    } finally {
      setPlanLoading(false);
    }
  }

  function updateTree(index, patch) {
    setPlan((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  }

  function updateSubtask(treeIndex, subIndex, patch) {
    setPlan((prev) => prev.map((t, i) => {
      if (i !== treeIndex) return t;
      const subtasks = t.subtasks.map((s, j) => (j === subIndex ? { ...s, ...patch } : s));
      return { ...t, subtasks };
    }));
  }

  function addSubtask(treeIndex) {
    setPlan((prev) => prev.map((t, i) => (i === treeIndex
      ? { ...t, subtasks: [...t.subtasks, { task: "", acceptance: "" }] } : t)));
  }

  function removeSubtask(treeIndex, subIndex) {
    setPlan((prev) => prev.map((t, i) => (i === treeIndex
      ? { ...t, subtasks: t.subtasks.filter((_, j) => j !== subIndex) } : t)));
  }

  function addTree() {
    setPlan((prev) => (prev.length >= 4 ? prev : [...prev,
      { summary: "New tree", subtasks: [{ task: "", acceptance: "" }], num_devs: 1 }]));
  }

  function removeTree(index) {
    setPlan((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  async function handleStart() {
    if (starting) return;
    setStartError("");
    setStarting(true);
    try {
      const { job_id } = await submitJob({ prompt, repoPath, plan, maxCost, blockInstructions, gateCaps, models: blockModels });
      setJobId(job_id);
      setActiveModal(null);
    } catch (err) {
      setStartError(err.message);
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    if (!jobId) return;
    if (!window.confirm("Stop this run? It halts at the next checkpoint, not mid-call.")) return;
    await stopJob(jobId);
  }

  async function handleResume() {
    if (!jobId || !resumeText.trim()) return;
    await resumeJob(jobId, resumeText.trim());
    setResumeText("");
    if (!intervalRef.current) startPolling(jobId);
  }

  async function handleCreateRepo() {
    if (!createRepoPath.trim()) {
      setCreateRepoError("Enter a path.");
      return;
    }
    setCreateRepoError("");
    setCreateRepoLoading(true);
    try {
      const { path } = await createRepo({ path: createRepoPath, github: createRepoGithub });
      setRepoPath(path); // fills the Boot-up modal's repo path field underneath
      setCreateRepoOpen(false);
      setCreateRepoPath("");
    } catch (err) {
      setCreateRepoError(err.message);
    } finally {
      setCreateRepoLoading(false);
    }
  }

  function handleUsePrompt(promptText) {
    setPrompt(promptText);
    setPlan(null); // in case a stale plan from a prior prompt was sitting around
    setActiveModal("boot_up"); // opens straight into PlanForm, pre-filled and ready to hit Plan
  }

  const blockStatus = job?.block_status || {};

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand"><Icon name="rocket" size={22} /> <span>Agent Swarm</span></div>
      </header>

      {job && <StatusBar job={job} onStop={handleStop} onOpenDetail={() => setActiveModal("boot_up")} />}

      <div className="layout">
        <div className="diagram">
          <NodeBox title="Boot-up" icon="rocket" highlight onInfoClick={() => setActiveModal("boot_up")} />
          <Connector />

          <div className="tree-forest">
            {(activePlan || []).map((treePlan, i) => (
              <TreeColumn key={i} treeId={i + 1} treePlan={treePlan} blockStatus={blockStatus} onInfoClick={openModal} />
            ))}
          </div>

          <Connector branching={(activePlan || []).length > 1} />
          <NodeBox title="Merge trees" subtitle="git" icon="check-shield"
            state={blockStatus.merge?.state} activity={blockStatus.merge?.activity}
            pct={blockStatus.merge?.pct} onInfoClick={() => {}} />
          <Connector />
          <NodeBox title="Auditor" subtitle={GATE_MODELS.auditor} icon={GATE_ICONS.auditor}
            state={blockStatus.auditor?.state} activity={blockStatus.auditor?.activity}
            pct={blockStatus.auditor?.pct} onInfoClick={() => openModal("auditor")} />
        </div>

        <aside className="side-panel">
          {job ? (
            <div className="side-card">
              <h3>Run detail</h3>
              <JobStatusPanel job={job} onStop={handleStop} onResume={handleResume}
                resumeText={resumeText} setResumeText={setResumeText} onStartNew={startNewRun} />
            </div>
          ) : (
            <div className="side-idle-stack">
              <div className="side-card">
                <h3>Ask about your code</h3>
                <ChatPanel repoPath={repoPath} setRepoPath={setRepoPath} onUsePrompt={handleUsePrompt} />
              </div>

              <div className="side-row-half">
                <div className="side-card side-half">
                  <h3>Run</h3>
                  <HomeRunCard />
                </div>
                <div className="side-card side-half">
                  <h3>Create repo</h3>
                  <CreateRepoFields
                    path={createRepoPath} setPath={setCreateRepoPath}
                    github={createRepoGithub} setGithub={setCreateRepoGithub}
                    loading={createRepoLoading} error={createRepoError}
                    onSubmit={handleCreateRepo} compact
                  />
                </div>
              </div>

              <div className="side-card side-idle">
                <h3>How this works</h3>
                <p>Click <strong>Boot-up</strong> to plan a run — Claude reads your prompt and decides
                  how many trees (1-4 independent workstreams) it needs, with subtasks and dev counts
                  per tree. Review and edit the plan before confirming.</p>
                <p>Click any other node before starting to give it instructions, and (for Team Lead,
                  Check & Test, and Auditor) set how many times it's allowed to reject before the job
                  gets marked stuck.</p>
                <p>Once running, this panel fills in with the live log, cost, and (if needed) a resume box.</p>
              </div>
            </div>
          )}
        </aside>
      </div>

      {activeModal === "boot_up" && (
        <Modal title="Boot-up" onClose={closeModal}>
          {jobId ? (
            <JobStatusPanel job={job} onStop={handleStop} onResume={handleResume}
              resumeText={resumeText} setResumeText={setResumeText} onStartNew={startNewRun} />
          ) : !plan ? (
            <PlanForm
              prompt={prompt} setPrompt={setPrompt}
              repoPath={repoPath} setRepoPath={setRepoPath}
              plannerInstructions={plannerInstructions} setPlannerInstructions={setPlannerInstructions}
              planLoading={planLoading} planError={planError} onPlan={handlePlan}
              onOpenCreateRepo={() => { setCreateRepoError(""); setCreateRepoOpen(true); }}
              plannerModel={blockModels.planner || modelConfig?.default_models?.planner || ""}
              setPlannerModel={(m) => setBlockModels((prev) => ({ ...prev, planner: m }))}
              claudeModels={modelConfig?.claude_models || []}
            />
          ) : (
            <PlanReview
              plan={plan} maxCost={maxCost} setMaxCost={setMaxCost} startError={startError}
              onUpdateTree={updateTree} onUpdateSubtask={updateSubtask} onAddSubtask={addSubtask}
              onRemoveSubtask={removeSubtask} onAddTree={addTree} onRemoveTree={removeTree}
              onReplan={() => setPlan(null)} onStart={handleStart} starting={starting}
            />
          )}
        </Modal>
      )}

      {createRepoOpen && (
        <Modal title="Create a new repo" onClose={() => setCreateRepoOpen(false)}>
          <CreateRepoFields
            path={createRepoPath} setPath={setCreateRepoPath}
            github={createRepoGithub} setGithub={setCreateRepoGithub}
            loading={createRepoLoading} error={createRepoError}
            onSubmit={handleCreateRepo}
          />
        </Modal>
      )}

      {activeModal && activeModal !== "boot_up" && (
        <BlockModal
          block={activeModal} onClose={closeModal} jobId={jobId}
          draftInstructions={draftInstructions} setDraftInstructions={setDraftInstructions}
          draftCap={draftCap} setDraftCap={setDraftCap} onSave={saveInstructions}
          blockStatus={blockStatus[activeModal]} savedInstructions={blockInstructions[activeModal]}
          gateCaps={gateCaps}
          draftModel={draftModel} setDraftModel={setDraftModel}
          blockModels={blockModels} modelConfig={modelConfig}
        />
      )}
    </div>
  );
}

function TreeColumn({ treeId, treePlan, blockStatus, onInfoClick }) {
  const tlBlock = `tree_${treeId}_team_lead`;
  const cntBlock = `tree_${treeId}_check_and_test`;
  const numDevs = treePlan?.num_devs || 1;
  return (
    <div className="tree-column">
      <div className="tree-column-label">Tree {treeId}</div>
      <NodeBox compact title="Team Lead" subtitle={GATE_MODELS.team_lead} icon={GATE_ICONS.team_lead}
        state={blockStatus[tlBlock]?.state} activity={blockStatus[tlBlock]?.activity}
        pct={blockStatus[tlBlock]?.pct} onInfoClick={() => onInfoClick(tlBlock)} />
      <Connector small />
      <div className="tree-dev-row">
        {Array.from({ length: numDevs }, (_, i) => i + 1).map((devNum) => {
          const devBlock = `tree_${treeId}_dev_${devNum}`;
          return (
            <NodeBox compact key={devNum} title={`Dev ${devNum}`} subtitle={GATE_MODELS.dev} icon={GATE_ICONS.dev}
              state={blockStatus[devBlock]?.state} activity={blockStatus[devBlock]?.activity}
              pct={blockStatus[devBlock]?.pct} onInfoClick={() => onInfoClick(devBlock)} />
          );
        })}
      </div>
      <Connector small />
      <NodeBox compact title="Check & Test" subtitle={GATE_MODELS.check_and_test} icon={GATE_ICONS.check_and_test}
        state={blockStatus[cntBlock]?.state} activity={blockStatus[cntBlock]?.activity}
        pct={blockStatus[cntBlock]?.pct} onInfoClick={() => onInfoClick(cntBlock)} />
    </div>
  );
}

function Connector({ branching = false, small = false }) {
  return <div className={`connector ${branching ? "connector-branch" : ""} ${small ? "connector-small" : ""}`} />;
}

function StatusBar({ job, onStop, onOpenDetail }) {
  const statusClass = {
    running: "bar-running", done: "bar-done", failed: "bar-failed",
    stopped: "bar-failed", stuck: "bar-stuck", queued: "bar-running",
  }[job.status] || "bar-running";

  return (
    <div className={`status-bar ${statusClass}`} onClick={onOpenDetail}>
      <div className="status-bar-left">
        <span className={`status-dot ${job.status === "running" ? "pulse" : ""}`} />
        <span className="status-label">{STATUS_LABELS[job.status] || job.status}</span>
        <span className="status-sep">•</span>
        <span className="status-gate">{job.current_gate || "starting"}</span>
      </div>
      <div className="status-bar-right">
        <span className="status-cost">${(job.cost_estimate || 0).toFixed(4)}</span>
        {job.status === "running" && (
          <button className="btn-danger btn-sm" onClick={(e) => { e.stopPropagation(); onStop(); }}>
            <Icon name="stop" size={14} /> Stop
          </button>
        )}
        {job.status === "stuck" && <span className="status-badge">needs input — click for details</span>}
      </div>
    </div>
  );
}

function PlanForm({ prompt, setPrompt, repoPath, setRepoPath, plannerInstructions, setPlannerInstructions,
  planLoading, planError, onPlan, onOpenCreateRepo, plannerModel, setPlannerModel, claudeModels }) {
  return (
    <>
      <label>What do you want built?</label>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)}
        placeholder="e.g. Add input validation to the signup form and a unit test for it" />
      <div className="label-row">
        <label>Target repo path</label>
        <button className="btn-link" onClick={onOpenCreateRepo}>+ create new repo</button>
      </div>
      <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="C:\path\to\your\project" />
      <label>Instructions for the planner (optional)</label>
      <textarea value={plannerInstructions} onChange={(e) => setPlannerInstructions(e.target.value)}
        placeholder="e.g. Keep this to 1 tree, don't over-split" />
      {claudeModels.length > 0 && (
        <>
          <label>Planner model</label>
          <select value={plannerModel} onChange={(e) => setPlannerModel(e.target.value)}>
            {claudeModels.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </>
      )}
      {planError && <p className="error-text">{planError}</p>}
      <button className="btn-primary btn-start" onClick={onPlan} disabled={planLoading}>
        {planLoading ? "Planning..." : "Plan"}
      </button>
    </>
  );
}

function ChatPanel({ repoPath, setRepoPath, onUsePrompt, onBack }) {
  const [chatId, setChatId] = useState(null);
  const [turns, setTurns] = useState([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const logRef = useRef(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [turns, loading]);

  async function handleStartChat() {
    if (!repoPath.trim()) {
      setError("Enter a repo path first.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const { chat_id } = await startChat({ repoPath });
      setChatId(chat_id);
      setTurns([]);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSend() {
    if (!message.trim() || !chatId || loading) return;
    const text = message.trim();
    setMessage("");
    setTurns((t) => [...t, { role: "user", text }]);
    setLoading(true);
    setError("");
    try {
      const { reply } = await sendChatMessage(chatId, text);
      setTurns((t) => [...t, { role: "assistant", text: reply }]);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {onBack && <button className="btn-link" onClick={onBack}>&larr; back to plan form</button>}
      <p className="role-desc">Read-only — it can look at files but can't change any. Talk through
        what you want, and when it's ready it'll propose a build prompt you can send to the planner.</p>
      {!chatId ? (
        <>
          <label>Repo path</label>
          <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="C:\path\to\your\project" />
          {error && <p className="error-text">{error}</p>}
          <button className="btn-primary btn-start" onClick={handleStartChat} disabled={loading}>
            {loading ? "Starting..." : "Start chat"}
          </button>
        </>
      ) : (
        <>
          <div className="chat-log" ref={logRef}>
            {turns.map((t, i) => <ChatTurn key={i} turn={t} onUsePrompt={onUsePrompt} />)}
            {loading && <div className="chat-turn chat-turn-assistant chat-typing">thinking...</div>}
          </div>
          <div className="chat-input-row">
            <textarea value={message} onChange={(e) => setMessage(e.target.value)}
              placeholder="Ask about the code, or describe what you want..."
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }} />
            <button className="btn-primary" onClick={handleSend} disabled={loading || !message.trim()}>Send</button>
          </div>
          {error && <p className="error-text">{error}</p>}
        </>
      )}
    </>
  );
}

// Tolerant on purpose: the model reliably opens with the exact "---PROPOSED PROMPT---" marker, but
// often drops the trailing dashes on close (observed "---END PROMPT" instead of "---END PROMPT---"
// in real testing) — asking an LLM to reproduce a literal string exactly and then hard-requiring that
// exact match downstream is fragile, so the parser accepts 0-3 trailing dashes, and if the closing
// marker is missing entirely, falls back to treating everything to the end of the message as the
// proposed prompt rather than showing the user raw, unparsed delimiter syntax.
const PROMPT_BLOCK_RE = /---PROPOSED PROMPT---\s*([\s\S]*?)\s*(?:---END PROMPT-{0,3}|$)/;

function ChatTurn({ turn, onUsePrompt }) {
  const match = turn.role === "assistant" && turn.text.match(PROMPT_BLOCK_RE);
  if (match) {
    const before = turn.text.slice(0, match.index).trim();
    const proposed = match[1].trim();
    const after = turn.text.slice(match.index + match[0].length).trim();
    return (
      <div className="chat-turn chat-turn-assistant">
        {before && <p>{before}</p>}
        <div className="proposed-prompt-box">
          <div className="proposed-prompt-label">Proposed prompt</div>
          <p>{proposed}</p>
          <button className="btn-primary btn-sm" onClick={() => onUsePrompt(proposed)}>Use this prompt &rarr;</button>
        </div>
        {after && <p>{after}</p>}
      </div>
    );
  }
  return <div className={`chat-turn chat-turn-${turn.role}`}>{turn.text}</div>;
}

function CreateRepoFields({ path, setPath, github, setGithub, loading, error, onSubmit, compact = false }) {
  return (
    <>
      {!compact && (
        <p className="role-desc">Runs a plain <code>git init</code> at this path (plus a starter
          commit, needed before a job can branch off it) — doesn't touch any files already there.</p>
      )}
      <label>Path</label>
      <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\path\to\new\project" />
      <label className="checkbox-label">
        <input type="checkbox" checked={github} onChange={(e) => setGithub(e.target.checked)} disabled />
        Also create on GitHub and sync (coming soon)
      </label>
      {error && <p className="error-text">{error}</p>}
      <button className="btn-primary btn-start" onClick={onSubmit} disabled={loading}>
        {loading ? "Creating..." : "Create repo"}
      </button>
    </>
  );
}

function PlanReview({ plan, maxCost, setMaxCost, startError, onUpdateTree, onUpdateSubtask,
  onAddSubtask, onRemoveSubtask, onAddTree, onRemoveTree, onReplan, onStart, starting }) {
  const estimate = useMemo(() => estimatePlan(plan), [plan]);
  return (
    <>
      <p className="role-desc">Review the plan Claude came up with — edit anything, then confirm to start.</p>
      {estimate && (
        <div className="estimate-card">
          <div className="estimate-item">
            <span className="estimate-label">Est. cost</span>
            <span className="estimate-value">${estimate.costLow.toFixed(2)} – ${estimate.costHigh.toFixed(2)}</span>
          </div>
          <div className="estimate-divider" />
          <div className="estimate-item">
            <span className="estimate-label">Est. time</span>
            <span className="estimate-value">{formatMinutes(estimate.timeLow)} – {formatMinutes(estimate.timeHigh)}</span>
          </div>
          <p className="estimate-note">Rough heuristic, not a bill — low end assumes a clean run, high end assumes a couple of gate rejections.</p>
        </div>
      )}
      {plan.map((tree, i) => (
        <div className="tree-plan-card" key={i}>
          <div className="tree-plan-header">
            <strong>Tree {i + 1}</strong>
            {plan.length > 1 && <button className="btn-link" onClick={() => onRemoveTree(i)}>remove</button>}
          </div>
          <label>Summary / scope</label>
          <input value={tree.summary} onChange={(e) => onUpdateTree(i, { summary: e.target.value })} />
          <label>Developers: {tree.num_devs}</label>
          <input type="range" min="1" max="3" value={tree.num_devs}
            onChange={(e) => onUpdateTree(i, { num_devs: Number(e.target.value) })} />
          <label>Subtasks</label>
          {tree.subtasks.map((s, j) => (
            <div className="subtask-row" key={j}>
              <input placeholder="task" value={s.task} onChange={(e) => onUpdateSubtask(i, j, { task: e.target.value })} />
              <input placeholder="acceptance criterion" value={s.acceptance}
                onChange={(e) => onUpdateSubtask(i, j, { acceptance: e.target.value })} />
              <button className="btn-link" onClick={() => onRemoveSubtask(i, j)}>×</button>
            </div>
          ))}
          <button className="btn-link" onClick={() => onAddSubtask(i)}>+ add subtask</button>
        </div>
      ))}
      {plan.length < 4 && <button className="btn-link" onClick={onAddTree}>+ add tree</button>}
      <label>Max cost for this job ($)</label>
      <input type="number" min="0.1" step="0.1" value={maxCost} onChange={(e) => setMaxCost(Number(e.target.value))} />
      {startError && <p className="error-text">{startError}</p>}
      <div className="plan-review-actions">
        <button className="btn-secondary" onClick={onReplan} disabled={starting}>Re-plan</button>
        <button className="btn-primary" onClick={onStart} disabled={starting}>
          {starting ? "Starting..." : "Confirm & Start"}
        </button>
      </div>
    </>
  );
}

function BlockModal({ block, onClose, jobId, draftInstructions, setDraftInstructions, draftCap, setDraftCap,
  onSave, blockStatus, savedInstructions, gateCaps, draftModel, setDraftModel, blockModels, modelConfig }) {
  const { gateType, label } = parseBlockKey(block);
  const capped = CAPPED_GATE_TYPES.includes(gateType);
  const provider = modelConfig?.providers?.[gateType];
  const modelOptions = provider === "claude" ? modelConfig?.claude_models : modelConfig?.openai_models;
  return (
    <Modal
      title={label} onClose={onClose}
      footer={!jobId && <button className="btn-primary" onClick={onSave}>Save</button>}
    >
      <div className="modal-model-badge">{GATE_MODELS[gateType] || ""}</div>
      <p className="role-desc">{GATE_DESCRIPTIONS[gateType] || ""}</p>
      {!jobId ? (
        <>
          <label>Instructions for this block specifically (optional)</label>
          <textarea value={draftInstructions} onChange={(e) => setDraftInstructions(e.target.value)}
            placeholder="e.g. Only touch primes.py" />
          {modelOptions && modelOptions.length > 0 && (
            <>
              <label>Model (shared across every tree's {label.split(" — ").pop()})</label>
              <select value={draftModel} onChange={(e) => setDraftModel(e.target.value)}>
                {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </>
          )}
          {capped && (
            <>
              <label>Max retries before stuck (shared across every tree's {label.split(" — ").pop()})</label>
              <input type="number" min="1" max="20" value={draftCap} onChange={(e) => setDraftCap(Number(e.target.value))} />
            </>
          )}
        </>
      ) : (
        <>
          {savedInstructions && <p><strong>Your instructions:</strong> {savedInstructions}</p>}
          <p><strong>Model:</strong> {blockModels[gateType] || modelConfig?.default_models?.[gateType] || "default"}</p>
          {capped && <p><strong>Retry cap:</strong> {gateCaps[gateType]}</p>}
          <p><strong>State:</strong> {blockStatus?.state || "pending"}</p>
          <p><strong>Current task:</strong> {blockStatus?.activity || "(nothing yet)"}</p>
        </>
      )}
    </Modal>
  );
}

function JobStatusPanel({ job, onStop, onResume, resumeText, setResumeText, onStartNew }) {
  if (!job) return <p>Loading...</p>;
  return (
    <>
      <p><strong>Status:</strong> {job.status}</p>
      <p><strong>Est. cost so far:</strong> ${(job.cost_estimate || 0).toFixed(4)}</p>
      <p><strong>Branch:</strong> {job.branch || "(pending)"}</p>
      {job.branch && (
        <p className="branch-note">
          This branch lives in <code>{job.repo_path}</code> — the isolated worktree the job actually
          ran in is temporary and just for isolation, not where the code lives. To see it:
          <br /><code>cd {job.repo_path} &amp;&amp; git checkout {job.branch}</code>
        </p>
      )}
      <pre className="job-log">{(job.log || []).map((l) => l.line).join("\n")}</pre>
      {job.summary && <p><strong>Summary:</strong> {job.summary}</p>}
      {job.audit_verdict && (
        <p>
          <strong>Audit:</strong>{" "}
          <span className={job.audit_verdict === "approve" ? "verdict-approve" : "verdict-flag"}>
            {job.audit_verdict}
          </span>{" "}
          — {job.audit_notes}
        </p>
      )}
      {job.commit_sha && (
        <p>Commit: {job.commit_sha} — check out <code>{job.branch}</code> and review before pushing.</p>
      )}
      {job.commit_sha && <RunBox jobId={job.id} />}
      {job.status === "running" && <button className="btn-danger" onClick={onStop}>Emergency stop</button>}
      {job.status === "stopped" && <p className="verdict-flag">Stopped by emergency stop.</p>}
      {job.status === "stuck" && (
        <div className="resume-box">
          <p className="verdict-flag">Stuck: {job.stuck_reason || "a gate hit its cap"}. Fix the underlying issue below and resume, or start over.</p>
          <textarea value={resumeText} onChange={(e) => setResumeText(e.target.value)}
            placeholder="e.g. Only touch primes.py, don't add a requirements.txt" />
          <button className="btn-primary" onClick={onResume}>Resume with these instructions</button>
        </div>
      )}
      {TERMINAL_STATUSES.includes(job.status) && (
        <button className="btn-secondary" style={{ marginTop: "1rem" }} onClick={onStartNew}>
          Start a new run
        </button>
      )}
    </>
  );
}

const RUN_TERMINAL_STATUSES = ["running", "failed"];

function RunBox({ jobId }) {
  const [runState, setRunState] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const intervalRef = useRef(null);

  useEffect(() => () => { if (intervalRef.current) clearInterval(intervalRef.current); }, []);

  async function handleRun() {
    setError("");
    setStarting(true);
    try {
      const state = await startRun(jobId);
      setRunState(state);
      intervalRef.current = setInterval(async () => {
        try {
          const s = await getRunStatus(jobId);
          setRunState(s);
          if (s.services.every((svc) => RUN_TERMINAL_STATUSES.includes(svc.status))) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
        } catch {
          // transient poll failure — try again next tick
        }
      }, 2000);
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    await stopRun(jobId);
    setRunState(null);
  }

  return (
    <div className="run-box">
      {!runState ? (
        <button className="btn-primary" onClick={handleRun} disabled={starting}>
          {starting ? "Starting..." : "▶ Run app"}
        </button>
      ) : (
        <>
          {runState.services.map((svc) => (
            <div className="run-service" key={svc.name}>
              <span className={`run-status run-status-${svc.status}`}>{svc.status}</span>
              <strong>{svc.name}</strong>
              {svc.url && <a href={svc.url} target="_blank" rel="noreferrer">{svc.url}</a>}
            </div>
          ))}
          <button className="btn-secondary btn-sm" onClick={handleStop}>Stop</button>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function HomeRunCard() {
  // Standalone from any job — points at any local project, same detect-and-launch logic RunBox
  // uses for a finished job's own worktree, just against a path you type in directly.
  const [path, setPath] = useState("");
  const [runId, setRunId] = useState(null);
  const [runState, setRunState] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const intervalRef = useRef(null);

  useEffect(() => () => { if (intervalRef.current) clearInterval(intervalRef.current); }, []);

  async function handleRun() {
    if (!path.trim()) {
      setError("Enter a project path first.");
      return;
    }
    setError("");
    setStarting(true);
    try {
      const state = await startPathRun(path);
      setRunId(state.run_id);
      setRunState(state);
      intervalRef.current = setInterval(async () => {
        try {
          const s = await getPathRunStatus(state.run_id);
          setRunState(s);
          if (s.services.every((svc) => RUN_TERMINAL_STATUSES.includes(svc.status))) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
        } catch {
          // transient poll failure — try again next tick
        }
      }, 2000);
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (runId) await stopPathRun(runId);
    setRunState(null);
    setRunId(null);
  }

  return (
    <div className="run-box run-box-compact">
      {!runState ? (
        <>
          <label>Path</label>
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\path\to\a\project" />
          {error && <p className="error-text">{error}</p>}
          <button className="btn-primary btn-start" onClick={handleRun} disabled={starting}>
            {starting ? "Starting..." : "▶ Run app"}
          </button>
        </>
      ) : (
        <>
          {runState.services.map((svc) => (
            <div className="run-service" key={svc.name}>
              <span className={`run-status run-status-${svc.status}`}>{svc.status}</span>
              <strong>{svc.name}</strong>
              {svc.url && <a href={svc.url} target="_blank" rel="noreferrer">{svc.url}</a>}
            </div>
          ))}
          <button className="btn-secondary btn-sm" onClick={handleStop}>Stop</button>
          {error && <p className="error-text">{error}</p>}
        </>
      )}
    </div>
  );
}

export default App;
