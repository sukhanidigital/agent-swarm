import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import NodeBox from "./components/NodeBox";
import Modal from "./components/Modal";
import Icon from "./components/Icon";
import { GATE_MODELS, GATE_ICONS, GATE_DESCRIPTIONS, CAPPED_GATE_TYPES, PHASE_LABELS, AGENT_LIBRARY } from "./roles";
import {
  planProject, submitJob, getJob, stopJob, resumeJob,
  startChat, sendChatMessage, startRun, getRunStatus, stopRun,
  startPathRun, getPathRunStatus, stopPathRun, getModelConfig, login,
  listProjects, createProject,
} from "./api";
import { estimatePlan, formatMinutes } from "./estimate";
import { getApiUrl, setApiUrl, getApiKey, setApiKey, isConfigured } from "./config";
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
  if (rest === "design") return { gateType: "design", label: `Tree ${treeId} — Design` };
  if (rest === "team_lead") return { gateType: "team_lead", label: `Tree ${treeId} — Team Lead` };
  if (rest === "check_and_test") return { gateType: "check_and_test", label: `Tree ${treeId} — Check & Test` };
  const devMatch = rest.match(/^dev_(\d+)$/);
  if (devMatch) return { gateType: "dev", label: `Tree ${treeId} — Dev ${devMatch[1]}` };
  return { gateType: rest, label: `Tree ${treeId} — ${rest}` };
}

function App() {
  // --- pre-run planning state ---
  const [prompt, setPrompt] = useState("");
  const [repoPath, setRepoPath] = useState(""); // the real server-side path — never shown to the
  // user directly; the Projects modal is what sets this, displayed to the user only as a name
  const [selectedProjectName, setSelectedProjectName] = useState("");
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
    if (!isConfigured()) return; // nothing to fetch yet — the login screen replaces the whole app in this case
    getModelConfig().then((cfg) => {
      setModelConfig(cfg);
      setBlockModels(cfg.default_models);
    }).catch(() => {
      // if this fails the model dropdowns just won't render — everything else still works
    });
  }, []);

  // --- auth gate — a dedicated full-page login screen replaces the *entire* app (nothing else in
  // this component's tree mounts) until both a URL and key are on record, so there's no way to glimpse
  // any app content, even briefly, without the key. Distinct from `settingsOpen` below, which is the
  // already-authed path for switching backends or rotating the key later via the gear button.
  //
  // The login screen itself only ever asks for an email + password — the API key is an internal
  // implementation detail exchanged for those credentials by the backend's /login (see api/main.py),
  // never typed in or shown. The API URL is resolved automatically (build-time VITE_API_BASE_URL, or
  // whatever's already in localStorage) and only surfaced as a field if neither of those gave us one
  // — the true local-dev case config.js's own guessApiUrl() fallback doesn't cover. ---
  const [authed, setAuthed] = useState(() => isConfigured());
  const [loginUrl, setLoginUrl] = useState(() => getApiUrl());
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginChecking, setLoginChecking] = useState(false);

  function handleLogin() {
    const url = loginUrl.trim();
    const email = loginEmail.trim();
    const password = loginPassword.trim();
    if (!url || !email || !password) {
      setLoginError("Email and password are required.");
      return;
    }
    setLoginError("");
    setLoginChecking(true);
    setApiUrl(url); // needed before the /login call itself, which reads it via getApiUrl()
    login({ email, password }).then(({ api_key }) => {
      setApiKey(api_key);
      return getModelConfig();
    }).then((cfg) => {
      setModelConfig(cfg);
      setBlockModels(cfg.default_models);
      setAuthed(true);
    }).catch(() => {
      setApiUrl("");
      setApiKey("");
      setLoginError("Incorrect email or password.");
    }).finally(() => setLoginChecking(false));
  }

  // --- settings (API URL + key), reachable via the gear button once already authed — for switching
  // backends or rotating the key. ---
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftApiUrl, setDraftApiUrl] = useState(() => getApiUrl());
  const [draftApiKey, setDraftApiKey] = useState(() => getApiKey());

  function saveSettings() {
    setApiUrl(draftApiUrl.trim());
    setApiKey(draftApiKey.trim());
    setSettingsOpen(false);
    getModelConfig().then((cfg) => {
      setModelConfig(cfg);
      setBlockModels(cfg.default_models);
    }).catch(() => {
      // wrong URL/key — the dropdowns just won't populate; the fields stay editable via the gear icon
    });
  }

  // --- agent library + add/remove-agent wizard (stacked on top of the library, same pattern as
  // create-repo stacking on top of Boot-up) ---
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [wizard, setWizard] = useState(null); // null = closed; else { agent, step, treeIndex, instructions, model, cap }

  function startWizard(agent) {
    setWizard({
      agent,
      step: 0,
      treeIndex: plan && plan.length === 1 ? 0 : null,
      instructions: "",
      model: blockModels[agent.blockGateType] || modelConfig?.default_models?.[agent.blockGateType] || "",
      cap: gateCaps[agent.blockGateType] ?? 5,
    });
  }

  // --- projects (stacked modal, reachable from Boot-up's "Select project", the "Ask about your
  // code" chat panel, the home screen's "Manage projects"/"New project", and the standalone Run-task
  // card — one picker, every consumer supplies its own onSelect so each writes the chosen project
  // wherever *it* keeps that state (global repoPath for Boot-up/chat, HomeRunCard's own local state
  // for Run-task) instead of this being hardwired to one of them. See PROJECTS_ROOT in api/main.py. ---
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [projectsMode, setProjectsMode] = useState("list"); // "list" | "create"
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState("");
  const [projectsOnSelect, setProjectsOnSelect] = useState(null); // (project) => void, set per-open
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectCreating, setNewProjectCreating] = useState(false);
  const [newProjectError, setNewProjectError] = useState("");

  function openProjects(onSelect) {
    setProjectsOnSelect(() => onSelect);
    setProjectsMode("list");
    setProjectsOpen(true);
    setProjectsLoading(true);
    setProjectsError("");
    listProjects().then(setProjects).catch((err) => setProjectsError(err.message))
      .finally(() => setProjectsLoading(false));
  }

  // Same picker, opened straight into the create-name step — for entry points whose whole point is
  // "make a new one" (the home screen's "New project" card) rather than picking an existing one.
  function openCreateProject(onSelect) {
    setProjectsOnSelect(() => onSelect);
    setProjectsMode("create");
    setProjectsOpen(true);
    setNewProjectName("");
    setNewProjectError("");
  }

  function selectProject(project) {
    if (projectsOnSelect) projectsOnSelect(project);
    setProjectsOpen(false);
  }

  // The common case — Boot-up, the header's "Manage projects", and the chat panel all share the
  // same global "current project" (repoPath/selectedProjectName), so they all pass this same callback.
  function selectGlobalProject(project) {
    setRepoPath(project.path);
    setSelectedProjectName(project.name);
  }

  function startCreateProject() {
    setProjectsMode("create");
    setNewProjectName("");
    setNewProjectError("");
  }

  function handleCreateProject() {
    const name = newProjectName.trim();
    if (!name) {
      setNewProjectError("Enter a name.");
      return;
    }
    setNewProjectError("");
    setNewProjectCreating(true);
    createProject(name).then((project) => {
      setProjects((prev) => [project, ...prev]);
      selectProject(project);
    }).catch((err) => setNewProjectError(err.message))
      .finally(() => setNewProjectCreating(false));
  }

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
    setSelectedProjectName("");
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
      setPlanError("A prompt and a selected project are required.");
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
      { summary: "New tree", subtasks: [{ task: "", acceptance: "" }], num_devs: 1, phases: ["review"] }]));
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

  function handleUsePrompt(promptText) {
    setPrompt(promptText);
    setPlan(null); // in case a stale plan from a prior prompt was sitting around
    setActiveModal("boot_up"); // opens straight into PlanForm, pre-filled and ready to hit Plan
  }

  const blockStatus = job?.block_status || {};

  // Placed after every hook in this component has run (Rules of Hooks) — replaces the entire app
  // tree below with a dedicated full-page login, nothing else in this component mounts until authed.
  if (!authed) {
    return (
      <LoginScreen
        apiUrl={loginUrl} setApiUrl={setLoginUrl}
        email={loginEmail} setEmail={setLoginEmail}
        password={loginPassword} setPassword={setLoginPassword}
        error={loginError} checking={loginChecking}
        onLogin={handleLogin}
      />
    );
  }

  return (
    <div className="app">
      <div className={`hero${job ? "" : " hero-idle"}`}>
        <header className="app-header">
          <div className="header-btn-group">
            <button className="library-btn" onClick={() => setLibraryOpen(true)} aria-label="Agent Library">
              <Icon name="briefcase" size={15} /> <span className="library-btn-label">Agent Library</span>
            </button>
            <button className="library-btn" onClick={() => openProjects(selectGlobalProject)} aria-label="Manage projects">
              <Icon name="folder" size={15} /> <span className="library-btn-label">Manage projects</span>
            </button>
          </div>
          <div className="brand"><Icon name="rocket" size={22} /> <span>Agent Swarm</span></div>
          <button className="settings-btn" onClick={() => {
            setDraftApiUrl(getApiUrl()); setDraftApiKey(getApiKey()); setSettingsOpen(true);
          }} aria-label="Settings">
            <Icon name="gear" size={17} />
          </button>
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
                <div className="side-card side-idle">
                  <h3>How this works</h3>
                  <p>Click <strong>Boot-up</strong> to plan a run, then review the trees Claude proposes
                    before confirming. Click any node to add instructions or set a retry cap.</p>
                  <p>Once running, this panel fills in with the live log, cost, and (if needed) a resume box.</p>
                </div>

                <div className="side-card">
                  <h3>Ask about your code</h3>
                  <ChatPanel repoPath={repoPath} selectedProjectName={selectedProjectName}
                    onOpenProjects={() => openProjects(selectGlobalProject)} onUsePrompt={handleUsePrompt} />
                </div>

                <div className="side-row-half">
                  <div className="side-card side-half">
                    <h3>Run</h3>
                    <HomeRunCard onOpenProjects={openProjects} />
                  </div>
                  <div className="side-card side-half">
                    <h3>New project</h3>
                    <p className="role-desc">Start a fresh project — no path, no setup, just a name.</p>
                    <button className="btn-primary btn-start" onClick={() => openCreateProject(selectGlobalProject)}>
                      + Create project
                    </button>
                  </div>
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>

      {activeModal === "boot_up" && (
        <Modal title="Boot-up" onClose={closeModal}>
          {jobId ? (
            <JobStatusPanel job={job} onStop={handleStop} onResume={handleResume}
              resumeText={resumeText} setResumeText={setResumeText} onStartNew={startNewRun} />
          ) : !plan ? (
            <PlanForm
              prompt={prompt} setPrompt={setPrompt}
              selectedProjectName={selectedProjectName} onOpenProjects={() => openProjects(selectGlobalProject)}
              plannerInstructions={plannerInstructions} setPlannerInstructions={setPlannerInstructions}
              planLoading={planLoading} planError={planError} onPlan={handlePlan}
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

      {libraryOpen && (
        <AgentLibraryModal plan={plan} onClose={() => setLibraryOpen(false)} onStartWizard={startWizard} />
      )}

      {projectsOpen && (
        <ProjectsModal
          mode={projectsMode} projects={projects} loading={projectsLoading} error={projectsError}
          newProjectName={newProjectName} setNewProjectName={setNewProjectName}
          newProjectCreating={newProjectCreating} newProjectError={newProjectError}
          onSelect={selectProject} onStartCreate={startCreateProject}
          onBackToList={() => openProjects(projectsOnSelect)}
          onCreate={handleCreateProject} onClose={() => setProjectsOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          apiUrl={draftApiUrl} setApiUrl={setDraftApiUrl}
          apiKey={draftApiKey} setApiKey={setDraftApiKey}
          onSave={saveSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {wizard && (
        <AddAgentWizard
          wizard={wizard} setWizard={setWizard} plan={plan} onUpdateTree={updateTree}
          setBlockInstructions={setBlockInstructions} setBlockModels={setBlockModels} setGateCaps={setGateCaps}
          modelConfig={modelConfig} onClose={() => setWizard(null)}
        />
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
  const designBlock = `tree_${treeId}_design`;
  const tlBlock = `tree_${treeId}_team_lead`;
  const cntBlock = `tree_${treeId}_check_and_test`;
  const numDevs = treePlan?.num_devs || 1;
  const phases = treePlan?.phases || [];
  const hasDesign = phases.includes("design");
  return (
    <div className="tree-column">
      <div className="tree-column-label">Tree {treeId}</div>
      {hasDesign && (
        <>
          <NodeBox compact title="Design" subtitle={GATE_MODELS.design} icon={GATE_ICONS.design}
            state={blockStatus[designBlock]?.state} activity={blockStatus[designBlock]?.activity}
            pct={blockStatus[designBlock]?.pct} onInfoClick={() => onInfoClick(designBlock)} />
          <Connector small />
        </>
      )}
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

function PlanForm({ prompt, setPrompt, selectedProjectName, onOpenProjects, plannerInstructions, setPlannerInstructions,
  planLoading, planError, onPlan, plannerModel, setPlannerModel, claudeModels }) {
  return (
    <>
      <label>What do you want built?</label>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)}
        placeholder="e.g. Add input validation to the signup form and a unit test for it" />
      <label>Project</label>
      <button type="button" className="project-picker-btn" onClick={onOpenProjects}>
        <Icon name="folder" size={16} />
        <span>{selectedProjectName || "Select project"}</span>
      </button>
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

function ChatPanel({ repoPath, selectedProjectName, onOpenProjects, onUsePrompt, onBack }) {
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
      setError("Select a project first.");
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
          <label>Project</label>
          <button type="button" className="project-picker-btn" onClick={onOpenProjects}>
            <Icon name="folder" size={16} />
            <span>{selectedProjectName || "Select project"}</span>
          </button>
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

function ProjectsModal({ mode, projects, loading, error, newProjectName, setNewProjectName,
  newProjectCreating, newProjectError, onSelect, onStartCreate, onBackToList, onCreate, onClose }) {
  if (mode === "create") {
    return (
      <Modal title="Create a new project" onClose={onClose}>
        <button type="button" className="btn-link" onClick={onBackToList}>&larr; back to projects</button>
        <label>Project name</label>
        <input value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)}
          placeholder="e.g. Sunrise Dental Website" autoFocus />
        {newProjectError && <p className="error-text">{newProjectError}</p>}
        <button className="btn-primary btn-start" onClick={onCreate} disabled={newProjectCreating}>
          {newProjectCreating ? "Creating..." : "Create project"}
        </button>
      </Modal>
    );
  }

  return (
    <Modal title="Projects" onClose={onClose}>
      <button type="button" className="btn-primary btn-start" onClick={onStartCreate}>+ Create project</button>
      {loading && <p className="role-desc">Loading...</p>}
      {error && <p className="error-text">{error}</p>}
      {!loading && !error && projects.length === 0 && (
        <p className="role-desc">No projects yet — create one to get started.</p>
      )}
      <div className="project-list">
        {projects.map((project) => (
          <button type="button" key={project.id} className="project-list-item" onClick={() => onSelect(project)}>
            <Icon name="folder" size={16} />
            <span>{project.name}</span>
          </button>
        ))}
      </div>
    </Modal>
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
          <label>SDLC phases for this tree</label>
          <div className="phase-toggle-row">
            {Object.entries(PHASE_LABELS).map(([key, label]) => {
              const checked = (tree.phases || []).includes(key);
              return (
                <label key={key} className="checkbox-label phase-toggle">
                  <input type="checkbox" checked={checked} onChange={(e) => {
                    const phases = e.target.checked
                      ? [...(tree.phases || []), key]
                      : (tree.phases || []).filter((p) => p !== key);
                    onUpdateTree(i, { phases });
                  }} />
                  {label}
                </label>
              );
            })}
          </div>
          <p className="role-desc phase-hint">Implementation and Check &amp; Test always run — these
            add an optional design brief and/or a team-lead review pass.</p>
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

function HomeRunCard({ onOpenProjects }) {
  // Standalone from any job — points at any project, same detect-and-launch logic RunBox uses for a
  // finished job's own worktree, just picked directly rather than tied to a run. Its own local
  // project selection (path + display name), independent of Boot-up/chat's shared one — running an
  // app doesn't imply you want it as your next build target too.
  const [path, setPath] = useState("");
  const [projectName, setProjectName] = useState("");
  const [runId, setRunId] = useState(null);
  const [runState, setRunState] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const intervalRef = useRef(null);

  useEffect(() => () => { if (intervalRef.current) clearInterval(intervalRef.current); }, []);

  function selectProject(project) {
    setPath(project.path);
    setProjectName(project.name);
  }

  async function handleRun() {
    if (!path.trim()) {
      setError("Select a project first.");
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
          <label>Project</label>
          <button type="button" className="project-picker-btn" onClick={() => onOpenProjects(selectProject)}>
            <Icon name="folder" size={16} />
            <span>{projectName || "Select project"}</span>
          </button>
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

function LoginScreen({ apiUrl, setApiUrl, email, setEmail, password, setPassword, error, checking, onLogin }) {
  // The API URL is resolved automatically in the normal case (build-time VITE_API_BASE_URL, or a
  // prior session's localStorage) — this field only needs to exist for the true local-dev case where
  // neither of those gave us anything, so a plain email/password form is what everyone else sees.
  const needsUrl = !apiUrl;

  function handleSubmit(e) {
    e.preventDefault();
    onLogin();
  }

  return (
    <div className="login-screen">
      <form className="login-card side-card" onSubmit={handleSubmit}>
        <div className="brand login-brand"><Icon name="rocket" size={22} /> <span>Agent Swarm</span></div>
        <p className="role-desc">Sign in to continue.</p>
        {needsUrl && (
          <>
            <label>API URL</label>
            <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://your-domain.example.com" />
          </>
        )}
        <label>Email</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
          autoFocus={!needsUrl} placeholder="you@example.com" autoComplete="username" />
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder="required" autoComplete="current-password" />
        <button type="submit" className="btn-primary btn-start" disabled={checking}>
          {checking ? "Signing in..." : "Log in"}
        </button>
        {error && <p className="error-text">{error}</p>}
      </form>
    </div>
  );
}

function SettingsModal({ apiUrl, setApiUrl, apiKey, setApiKey, onSave, onClose }) {
  return (
    <Modal title="Settings" onClose={onClose}>
      <p className="role-desc">Where the backend lives, and the key to talk to it. Needed once
        you're not opening this from the same machine running <code>python swarm.py</code> — a real
        deployment, or the mobile app.</p>
      <label>API URL</label>
      <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)}
        placeholder="https://your-domain.example.com" />
      <label>API key</label>
      <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
        placeholder="leave blank if the backend has no API_KEY set" />
      <button className="btn-primary btn-start" onClick={onSave}>Save</button>
    </Modal>
  );
}

function AgentLibraryModal({ plan, onClose, onStartWizard }) {
  const [expanded, setExpanded] = useState(null); // which bubble's description is expanded

  return (
    <Modal title="Agent Library" onClose={onClose}>
      <p className="role-desc">Every agent in the pipeline, non-removable ones first. Design and
        Review are the two dynamic ones — add or remove either from a specific tree.</p>
      <div className="agent-library-grid">
        {AGENT_LIBRARY.map((agent) => (
          // Fragment: the description (when open) is a sibling grid item placed right after this
          // bubble, so it spans the full modal width — but it shares the active bubble's accent
          // border color and sits flush against it (negative margin cancels the grid gap between
          // them) so the two read as one bonded shape, not a disconnected box below the grid.
          <Fragment key={agent.id}>
            <div className={`agent-bubble ${agent.mandatory ? "agent-bubble-mandatory" : "agent-bubble-optional"} ${expanded === agent.id ? "agent-bubble-active" : ""}`}>
              <button className="agent-bubble-info" onClick={() => setExpanded(expanded === agent.id ? null : agent.id)}
                aria-label={`${agent.label} info`}>
                <Icon name="info" size={13} />
              </button>
              <div className="agent-bubble-icon"><Icon name={agent.icon} size={22} /></div>
              <div className="agent-bubble-label">{agent.label}</div>
              <div className="agent-bubble-model">{agent.model}</div>
              {agent.mandatory ? (
                <span className="agent-bubble-badge">Always on</span>
              ) : (
                <button className="btn-link agent-bubble-add" disabled={!plan}
                  onClick={() => onStartWizard(agent)}>
                  + Add / remove
                </button>
              )}
            </div>
            {expanded === agent.id && <p className="agent-bubble-desc">{agent.description}</p>}
          </Fragment>
        ))}
      </div>
      {!plan && <p className="role-desc">Plan a run first (Boot-up) — adding or removing Design or
        Review happens per tree, once trees exist to pick from.</p>}
    </Modal>
  );
}

const WIZARD_STEP_LABELS = ["Which tree?", "Where in the tree?", "Configure"];

function wizardSequence(tree, highlightPhase) {
  const phases = tree.phases || [];
  const nodes = [
    { key: "design", label: "Design", optional: true },
    { key: "team_lead", label: "Team Lead", optional: false },
    { key: "dev", label: `Dev ×${tree.num_devs || 1}`, optional: false },
    { key: "review", label: "Review", optional: true },
    { key: "check_and_test", label: "Check & Test", optional: false },
  ];
  return nodes
    .filter((n) => !n.optional || phases.includes(n.key) || n.key === highlightPhase)
    .map((n) => ({ ...n, highlight: n.key === highlightPhase }));
}

function AddAgentWizard({ wizard, setWizard, plan, onUpdateTree, setBlockInstructions, setBlockModels,
  setGateCaps, modelConfig, onClose }) {
  const { agent, step, treeIndex, instructions, model, cap } = wizard;
  const tree = treeIndex != null ? plan[treeIndex] : null;
  const alreadyIncluded = tree ? (tree.phases || []).includes(agent.phaseKey) : false;
  const modelOptions = modelConfig?.providers?.[agent.blockGateType] === "claude"
    ? modelConfig?.claude_models : modelConfig?.openai_models;

  function patch(p) {
    setWizard((prev) => ({ ...prev, ...p }));
  }

  function apply() {
    const nextPhases = alreadyIncluded
      ? (tree.phases || []).filter((p) => p !== agent.phaseKey)
      : [...(tree.phases || []), agent.phaseKey];
    onUpdateTree(treeIndex, { phases: nextPhases });
    if (!alreadyIncluded) {
      const block = agent.phaseKey === "design" ? `tree_${treeIndex + 1}_design` : `tree_${treeIndex + 1}_team_lead`;
      if (instructions.trim()) setBlockInstructions((prev) => ({ ...prev, [block]: instructions.trim() }));
      if (model) setBlockModels((prev) => ({ ...prev, [agent.blockGateType]: model }));
      if (agent.blockGateType === "team_lead") {
        setGateCaps((prev) => ({ ...prev, team_lead: Math.max(1, cap || 5) }));
      }
    }
    setWizard(null);
  }

  return (
    <Modal title={`${alreadyIncluded ? "Remove" : "Add"} ${agent.label}`} onClose={onClose}>
      <div className="wizard-steps">
        {WIZARD_STEP_LABELS.map((label, i) => (
          <div key={label} className={`wizard-step-dot ${i === step ? "active" : ""} ${i < step ? "done" : ""}`}>
            {i + 1}
          </div>
        ))}
      </div>

      <div className="wizard-viewport">
      <div className="wizard-track" style={{ transform: `translateX(-${step * 100}%)` }}>
        <div className="wizard-panel">
          <p className="role-desc">Which tree should get {agent.label.toLowerCase()}?</p>
          {plan.map((t, i) => (
            <label key={i} className="wizard-tree-option">
              <input type="radio" name="wizard-tree" checked={treeIndex === i} onChange={() => patch({ treeIndex: i })} />
              <span>Tree {i + 1} — {t.summary}</span>
              {(t.phases || []).includes(agent.phaseKey) && <span className="wizard-tag">already included</span>}
            </label>
          ))}
        </div>

        <div className="wizard-panel">
          {tree && (
            <>
              <p className="role-desc">
                {agent.phaseKey === "design"
                  ? "Design always runs first in a tree — before Team Lead assigns any work."
                  : "Review always runs after implementation, right before Check & Test."}
                {" "}That's fixed by the pipeline, not something this step can move — this just shows
                where it lands in Tree {treeIndex + 1}'s sequence.
              </p>
              <div className="wizard-sequence">
                {wizardSequence(tree, agent.phaseKey).map((node) => (
                  <span key={node.key} className={`wizard-seq-node ${node.highlight ? "wizard-seq-highlight" : ""}`}>
                    {node.label}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="wizard-panel">
          {!alreadyIncluded ? (
            <>
              <label>Instructions for this phase specifically (optional)</label>
              <textarea value={instructions} onChange={(e) => patch({ instructions: e.target.value })}
                placeholder="e.g. Focus the design brief on the data model" />
              {modelOptions && modelOptions.length > 0 && (
                <>
                  <label>Model (shared across every tree's {agent.label})</label>
                  <select value={model} onChange={(e) => patch({ model: e.target.value })}>
                    {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </>
              )}
              {agent.blockGateType === "team_lead" && (
                <>
                  <label>Max retries before stuck (shared across every tree's Review)</label>
                  <input type="number" min="1" max="20" value={cap} onChange={(e) => patch({ cap: Number(e.target.value) })} />
                </>
              )}
            </>
          ) : (
            <p className="role-desc">This removes {agent.label} from Tree {treeIndex + 1} only — other
              trees that have it keep it. Its saved instructions/model stick around in case you add it
              back later.</p>
          )}
        </div>
      </div>
      </div>

      <div className="wizard-actions">
        <button className="btn-secondary" disabled={step === 0} onClick={() => patch({ step: step - 1 })}>Back</button>
        {step < 2 ? (
          <button className="btn-primary" disabled={treeIndex === null} onClick={() => patch({ step: step + 1 })}>Next</button>
        ) : (
          <button className="btn-primary" onClick={apply}>{alreadyIncluded ? "Remove" : "Add"} {agent.label}</button>
        )}
      </div>
    </Modal>
  );
}

export default App;
