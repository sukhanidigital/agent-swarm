"""Isolates every swarm run to its own git worktree + branch so nothing ever touches
the user's working branch or main directly."""
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path


GIT_TIMEOUT = 60  # seconds — a git call on a local repo should never legitimately take this long;
                   # better to fail loudly (surfaced to the job log, retryable) than hang forever.

# Dev agents install dependencies into a local .venv/node_modules per the shared-venv convention
# (orchestrator/agents.py's DEPENDENCY_CONVENTION). `git add -A` doesn't know to skip those unless
# something ignores them — and the target repo's own .gitignore may not, since it's not our repo to
# edit. info/exclude is the equivalent of .gitignore that lives outside tracked files (never committed,
# never touches the user's own .gitignore) and applies immediately to every `git add -A`.
_LOCAL_EXCLUDES = [".venv/", "venv/", "env/", "node_modules/", "__pycache__/", "*.pyc",
                   ".pytest_cache/", ".mypy_cache/", "dist/", "build/", "*.egg-info/"]


def _ensure_local_excludes(worktree_path: str):
    """Also flips core.longpaths on for this worktree as defense-in-depth against Windows' ~260-char
    MAX_PATH — vendored packages nest deep enough to hit it even when they are correctly excluded from
    being added, e.g. mid-install before the exclude file is read.

    `<worktree>/.git/info/exclude` is NOT a valid path in a worktree: `git worktree add` makes `.git`
    a plain *file* (a `gitdir: <real path>` pointer) everywhere except the original checkout, so
    treating it as a directory throws (WinError 3, then WinError 183 on the retry) — that exact crash
    is what orphaned worktree directories on disk without ever registering with git. `info/exclude` is
    also a *shared* file across every worktree of a repo in real git (not per-worktree), so resolving
    it via `git rev-parse --git-path` — which correctly follows the pointer either way — is both the
    fix and the more accurate mental model."""
    git_path = _run(["rev-parse", "--git-path", "info/exclude"], cwd=worktree_path)
    exclude_file = Path(git_path)
    if not exclude_file.is_absolute():
        exclude_file = Path(worktree_path) / exclude_file
    exclude_file.parent.mkdir(parents=True, exist_ok=True)
    existing = exclude_file.read_text() if exclude_file.exists() else ""
    missing = [p for p in _LOCAL_EXCLUDES if p not in existing]
    if missing:
        with exclude_file.open("a") as f:
            if existing and not existing.endswith("\n"):
                f.write("\n")
            f.write("\n".join(missing) + "\n")
    _run(["config", "core.longpaths", "true"], cwd=worktree_path)


def _run(args, cwd):
    try:
        result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=GIT_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"git {' '.join(args)} in {cwd} timed out after {GIT_TIMEOUT}s")
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed in {cwd}: {result.stderr.strip()}")
    return result.stdout.strip()


def _slugify(prompt: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", prompt.lower()).strip("-")
    return slug[:40] or "task"


def init_repo(path: str) -> dict:
    """`git init` at path plus a starter commit, so a job can `git worktree add -b` off it
    immediately — a brand-new repo has no commits and an unborn HEAD, which that command can't branch
    from. Only writes a placeholder README if the directory is genuinely empty; if it already has
    files (a project you haven't gotten around to git-initializing), those become the initial commit
    as-is instead of being touched."""
    target = Path(path)
    if (target / ".git").exists():
        raise RuntimeError(f"{path} is already a git repo")
    target.mkdir(parents=True, exist_ok=True)
    was_empty = not any(target.iterdir())  # must check before `git init`, which creates .git/ itself
    _run(["init"], cwd=str(target))
    if was_empty:
        (target / "README.md").write_text(f"# {target.name}\n")
    _run(["add", "-A"], cwd=str(target))
    if _run(["status", "--porcelain"], cwd=str(target)):
        _run(["commit", "-m", "Initial commit"], cwd=str(target))
    return {"path": str(target.resolve())}


def create_worktree(repo_path: str, prompt: str, worktrees_root: str) -> dict:
    """Create a fresh branch off the current HEAD and check it out into an isolated worktree dir.
    The uuid suffix guards against two job starts landing in the same wall-clock second (e.g. a
    double-submit, or two backend processes both alive), which would otherwise collide on the same
    branch/directory name and fail with "file already exists" — the per-tree/per-dev worktrees
    already get an equivalent suffix for the same reason."""
    repo_path = str(Path(repo_path).resolve())
    branch = f"swarm/{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}-{_slugify(prompt)}"
    worktree_path = str(Path(worktrees_root).resolve() / branch.replace("/", "_"))

    Path(worktrees_root).mkdir(parents=True, exist_ok=True)
    _run(["worktree", "add", "-b", branch, worktree_path], cwd=repo_path)
    _ensure_local_excludes(worktree_path)

    return {"repo_path": repo_path, "branch": branch, "worktree_path": worktree_path}


def create_branch_worktree(repo_path: str, base_branch: str, label: str, worktrees_root: str) -> dict:
    """One worktree per unit of work (a dev's round, a tree, ...) branched off base_branch's current
    tip. `label` must be unique per call (e.g. "dev1-r1", "tree2") so branches/worktrees never collide
    and parallel writes can't race."""
    branch = f"{base_branch}--{label}"
    worktree_path = str(Path(worktrees_root).resolve() / branch.replace("/", "_"))
    _run(["worktree", "add", "-b", branch, worktree_path, base_branch], cwd=repo_path)
    _ensure_local_excludes(worktree_path)
    return {"branch": branch, "worktree_path": worktree_path}


def merge_branch(target_worktree_path: str, source_branch: str) -> dict:
    """Merge a finished branch (a dev's work, a whole tree) into whatever branch is checked out at
    target_worktree_path. Reports conflicts instead of raising — the caller resolves them with file
    tools, it's not a hard failure."""
    try:
        result = subprocess.run(
            ["git", "merge", "--no-ff", "--no-edit", source_branch],
            cwd=target_worktree_path, capture_output=True, text=True, timeout=GIT_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"git merge {source_branch} in {target_worktree_path} timed out after {GIT_TIMEOUT}s")
    if result.returncode == 0:
        return {"conflict": False}
    status = _run(["status", "--porcelain"], cwd=target_worktree_path)
    conflicted = [line[3:].strip() for line in status.splitlines() if line[:2] in ("UU", "AA", "AU", "UA")]
    return {"conflict": True, "conflicted_files": conflicted, "message": (result.stdout + result.stderr).strip()}


def finish_merge(job_worktree_path: str, message: str = "resolve merge conflict") -> str:
    """Stage the Team Lead's conflict-resolved files and complete the in-progress merge commit."""
    _run(["add", "-A"], cwd=job_worktree_path)
    _run(["commit", "-m", message], cwd=job_worktree_path)
    return _run(["rev-parse", "HEAD"], cwd=job_worktree_path)


def delete_branch(repo_path: str, branch: str):
    """Best-effort cleanup of a merged/abandoned dev branch."""
    try:
        _run(["branch", "-D", branch], cwd=repo_path)
    except RuntimeError:
        pass


def current_commit(worktree_path: str) -> str:
    return _run(["rev-parse", "HEAD"], cwd=worktree_path)


def diff_against(worktree_path: str, base_sha: str) -> str:
    """Full diff of everything committed since the job started — what every gate actually reviews."""
    return _run(["diff", base_sha, "HEAD"], cwd=worktree_path)


def commit_all(worktree_path: str, message: str) -> str | None:
    """Stage and commit everything in the worktree. Returns the commit SHA, or None if nothing changed."""
    _run(["add", "-A"], cwd=worktree_path)
    status = _run(["status", "--porcelain"], cwd=worktree_path)
    if not status:
        return None
    _run(["commit", "-m", message], cwd=worktree_path)
    return _run(["rev-parse", "HEAD"], cwd=worktree_path)


def diff_summary(worktree_path: str) -> str:
    """Full diff of staged+unstaged changes against HEAD, for the summarizer/auditor to read."""
    _run(["add", "-A"], cwd=worktree_path)
    return _run(["diff", "--cached"], cwd=worktree_path)


def remove_worktree(repo_path: str, worktree_path: str):
    """Best-effort cleanup. Never call this if the job failed and you want to inspect the branch manually."""
    try:
        _run(["worktree", "remove", "--force", worktree_path], cwd=repo_path)
    except RuntimeError:
        shutil.rmtree(worktree_path, ignore_errors=True)
