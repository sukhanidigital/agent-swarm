# Backend only — the API layer (api/) + job engine (orchestrator/). The frontend is a separate static
# build (see frontend/Dockerfile) served by its own container/nginx, same split as local dev where
# `python swarm.py` and `npm run dev` are two independent processes.
FROM python:3.12-slim

# git: every job branches real worktrees off a target repo (orchestrator/git_tools.py) — without the
# git binary present, every run would fail immediately, not degrade gracefully.
# ffmpeg: dev agents' run_shell (orchestrator/dev_tools.py) executes directly in this container, so
# any job whose app shells out to ffmpeg (video processing, etc.) needs the binary present here too —
# not just in whatever repo it's building.
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Every git commit made inside this container (create_repo's initial commit, every dev/team-lead
# merge commit — see orchestrator/git_tools.py) needs a configured author or git refuses outright.
# Root's global config, not per-repo — every worktree this container ever creates is a fresh clone.
RUN git config --global user.email "swarm@agent-swarm.local" \
    && git config --global user.name "Agent Swarm"

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY api/ api/
COPY orchestrator/ orchestrator/
COPY swarm.py .

# jobs/ (SQLite job history + git worktrees) is runtime state, not part of the image — see the volume
# mount in docker-compose.yml. Created here too so a container run without that mount still works.
RUN mkdir -p jobs

EXPOSE 8000
CMD ["python", "swarm.py"]
