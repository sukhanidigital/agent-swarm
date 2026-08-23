# Backend only — the API layer (api/) + job engine (orchestrator/). The frontend is a separate static
# build (see frontend/Dockerfile) served by its own container/nginx, same split as local dev where
# `python swarm.py` and `npm run dev` are two independent processes.
FROM python:3.12-slim

# git: every job branches real worktrees off a target repo (orchestrator/git_tools.py) — without the
# git binary present, every run would fail immediately, not degrade gracefully.
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

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
