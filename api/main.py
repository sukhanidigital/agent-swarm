"""FastAPI backend for the swarm — a plain JSON API consumed by the React UI in frontend/
(run separately via `npm run dev`, see frontend/README or the project README). This process owns
the job engine and doesn't serve any frontend assets itself."""
import os
import secrets
import threading
import uuid

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from api.auth import require_api_key
from orchestrator import chat, runner, store
from orchestrator.agents import CLAUDE_MODELS, DEFAULT_MODELS, OPENAI_MODELS, PROVIDERS, TREE_PHASES, plan_project
from orchestrator.git_tools import create_project_repo, init_repo
from orchestrator.pipeline import repo_listing, resume_job, run_job

# Where "Select project"/"Manage projects" (frontend) creates new project repos — /repos inside the
# container (docker-compose.yml's REPOS_DIR bind mount always lands there regardless of the host path
# REPOS_DIR points to), overridable for local non-Docker dev via PROJECTS_ROOT in .env.
PROJECTS_ROOT = os.environ.get("PROJECTS_ROOT", "/repos")

# dependencies=[...] applies to every route below (except /login, exempted in api/auth.py) — this
# backend runs shell/dev-agent commands against whatever repo_path it's given, so once it's reachable
# from anywhere but localhost every endpoint needs to be behind the same gate. See api/auth.py — it's
# a no-op until API_KEY is set.
app = FastAPI(title="Agent Swarm", dependencies=[Depends(require_api_key)])
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.on_event("startup")
def resume_self_healed_jobs():
    """A self-heal (orchestrator/self_heal.py) marks a job pending_self_heal_resume and then replaces
    this whole process (os.execv) to apply its patch — this is the other half, run once on every boot:
    pick up any job left in that state and resume it. Runs unconditionally (not just after a self-heal
    restart) since it's a no-op — list_pending_self_heal_jobs() is empty — on every normal boot."""
    for job_id in store.list_pending_self_heal_jobs():
        store.update_job(job_id, pending_self_heal_resume=0)

        def _resume(job_id=job_id):
            try:
                resume_job(job_id, "Resuming after an orchestrator self-heal patch.")
            except Exception as exc:  # noqa: BLE001 - a broken resume must not crash startup itself
                store.append_log(job_id, f"Could not auto-resume after self-heal restart: {exc}")
                store.update_job(job_id, status="failed", stuck_reason=None)

        threading.Thread(target=_resume, daemon=True).start()


class LoginRequest(BaseModel):
    email: str
    password: str


@app.post("/login")
def login(req: LoginRequest):
    """Exchanges LOGIN_EMAIL/LOGIN_PASSWORD for the real API_KEY, so the frontend's login screen
    only ever asks for an email/password — never the key itself. No-ops (always succeeds, with
    whatever API_KEY is or isn't set) if LOGIN_EMAIL/LOGIN_PASSWORD aren't configured, matching every
    other optional-auth-layer convention in this codebase."""
    expected_email = os.environ.get("LOGIN_EMAIL")
    expected_password = os.environ.get("LOGIN_PASSWORD")
    if expected_email and expected_password:
        email_ok = secrets.compare_digest(req.email, expected_email)
        password_ok = secrets.compare_digest(req.password, expected_password)
        if not (email_ok and password_ok):
            raise HTTPException(401, "Invalid email or password")
    return {"api_key": os.environ.get("API_KEY", "")}


class PlanRequest(BaseModel):
    prompt: str
    repo_path: str
    instructions: str = ""  # optional guidance for the planner block specifically
    model: str = DEFAULT_MODELS["planner"]


class TreeSubtask(BaseModel):
    task: str
    acceptance: str


class Tree(BaseModel):
    summary: str
    subtasks: list[TreeSubtask]
    num_devs: int = 1
    phases: list[str] = ["review"]  # subset of agents.TREE_PHASES ("design", "review") — see PLAN_PROJECT_SYSTEM


class JobRequest(BaseModel):
    prompt: str
    repo_path: str
    plan: list[Tree]  # the (possibly user-edited) plan returned by /plan, confirmed by the user
    block_instructions: dict[str, str] = {}  # keys: planner, tree_1_team_lead, tree_1_dev_1, auditor, ...
    max_cost: float = 1.0
    gate_caps: dict[str, int] = store.DEFAULT_GATE_CAPS  # keys: team_lead, check_and_test, auditor
    models: dict[str, str] = {}  # keys: team_lead, dev, check_and_test, auditor (planner is fixed at /plan time)


class ResumeRequest(BaseModel):
    instructions: str


class CreateRepoRequest(BaseModel):
    path: str
    github: bool = False  # accepted now so the request shape is stable once GitHub sync is built


class ChatStartRequest(BaseModel):
    repo_path: str


class ChatMessageRequest(BaseModel):
    message: str


class RunRequest(BaseModel):
    path: str


@app.get("/models")
def list_models():
    """Backend is the single source of truth for which models exist and which provider each gate
    type is restricted to — the frontend fetches this once instead of keeping its own copy that could
    drift out of sync (e.g. if a model gets renamed/retired, this is the only place to update)."""
    return {
        "providers": PROVIDERS, "default_models": DEFAULT_MODELS,
        "claude_models": CLAUDE_MODELS, "openai_models": OPENAI_MODELS,
        "tree_phases": TREE_PHASES,
    }


@app.post("/plan")
def plan(req: PlanRequest):
    """Stateless — the top-level Sonnet planning call, run before any job exists so you can review
    and edit the tree/dev breakdown before committing to it. No job or cost is recorded here beyond
    this one call; the confirmed plan gets POSTed back as part of /jobs to actually start a run."""
    try:
        trees = plan_project(req.prompt, repo_listing(req.repo_path), instructions=req.instructions,
                              model=req.model)
    except Exception as exc:  # noqa: BLE001 - surface planning failures (bad repo path, bad JSON) to the UI
        raise HTTPException(400, f"Planning failed: {exc}")
    return {"trees": trees}


@app.post("/jobs")
def submit_job(req: JobRequest):
    config = {"block_instructions": req.block_instructions}
    plan_data = [t.model_dump() for t in req.plan]
    job_id = store.create_job(req.prompt, req.repo_path, config, plan_data,
                               max_cost=req.max_cost, gate_caps=req.gate_caps, models=req.models)
    threading.Thread(target=run_job, args=(job_id,), daemon=True).start()
    return {"job_id": job_id}


@app.get("/jobs")
def get_jobs():
    return store.list_jobs()


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    job = store.get_job(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return job


@app.post("/jobs/{job_id}/stop")
def stop_job(job_id: str):
    job = store.get_job(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    store.request_stop(job_id)
    return {"ok": True}


@app.post("/jobs/{job_id}/resume")
def resume(job_id: str, req: ResumeRequest):
    job = store.get_job(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job["status"] != "stuck":
        raise HTTPException(400, f"job is not stuck (status={job['status']}) — nothing to resume")
    threading.Thread(target=resume_job, args=(job_id, req.instructions), daemon=True).start()
    return {"ok": True}


@app.post("/repos")
def create_repo(req: CreateRepoRequest):
    """git-init a fresh repo at `path` so it's immediately usable as a job's target repo — a job
    needs at least one commit to branch a worktree off of, which a bare `git init` alone doesn't give."""
    if req.github:
        raise HTTPException(400, "GitHub sync isn't built yet — create the repo locally for now, "
                                  "you can add a remote and push it yourself afterward.")
    try:
        return init_repo(req.path)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc))


class ProjectRequest(BaseModel):
    name: str


@app.get("/projects")
def list_projects():
    return store.list_projects()


@app.post("/projects")
def create_project_endpoint(req: ProjectRequest):
    """The user-facing counterpart to /repos — takes a plain name ("Sunrise Dental Website") instead
    of a filesystem path, since that's the only thing a non-technical user should ever have to type.
    Slugifies it into a repo under PROJECTS_ROOT (git_tools.create_project_repo) and records the
    name/path pair so the UI can list projects by name and resolve back to the real path on select."""
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "Project name is required.")
    result = create_project_repo(name, PROJECTS_ROOT)
    return store.create_project(name, result["path"])


@app.post("/chat/start")
def chat_start(req: ChatStartRequest):
    return {"chat_id": chat.start_chat(req.repo_path)}


@app.post("/chat/{chat_id}/message")
def chat_message(chat_id: str, req: ChatMessageRequest):
    try:
        return {"reply": chat.send_message(chat_id, req.message)}
    except ValueError as exc:
        raise HTTPException(404, str(exc))
    except Exception as exc:  # noqa: BLE001 - surface real OpenAI/API errors (rate limits, billing,
        # network blips) as a readable message instead of an unhandled exception that the browser
        # only ever sees as a raw connection failure ("Failed to fetch") with no explanation.
        raise HTTPException(502, f"Chat call failed: {exc}")


@app.post("/jobs/{job_id}/run")
def run_app(job_id: str):
    job = store.get_job(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    project_path = job.get("job_wt_path") or job.get("repo_path")
    if not project_path:
        raise HTTPException(400, "job has no worktree to run yet")
    try:
        return runner.start_run(job_id, project_path)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.get("/jobs/{job_id}/run")
def run_status(job_id: str):
    return runner.get_run_status(job_id)


@app.post("/jobs/{job_id}/run/stop")
def stop_run_endpoint(job_id: str):
    runner.stop_run(job_id)
    return {"ok": True}


@app.post("/run")
def run_path(req: RunRequest):
    """Same launcher as /jobs/{id}/run, but for the home-screen Run card — any local project, not
    necessarily one the swarm built. runner.py's functions key on an arbitrary string id (it never
    actually looks the id up in the jobs table), so a freshly minted uuid works exactly like a job_id
    does — no changes needed there."""
    run_id = str(uuid.uuid4())
    try:
        result = runner.start_run(run_id, req.path)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    result["run_id"] = run_id
    return result


@app.get("/run/{run_id}")
def run_path_status(run_id: str):
    return runner.get_run_status(run_id)


@app.post("/run/{run_id}/stop")
def stop_run_path(run_id: str):
    runner.stop_run(run_id)
    return {"ok": True}
