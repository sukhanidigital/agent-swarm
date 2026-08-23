# Deploying to AWS EC2

This is the part I can't do for you from here — provisioning needs your AWS account. Everything up
to "point a domain at it" is copy-pasteable; DNS and cert steps need your actual domain registrar.

## 1. Launch the instance

- **AMI**: Ubuntu 22.04 LTS (or newer)
- **Instance type**: `t3.small` is enough to start — this backend's own work (planning/gate calls) is
  mostly waiting on Anthropic/OpenAI, not CPU-bound. Go up if you're running many trees/devs at once.
- **Storage**: 20-30 GB gp3. Job worktrees are real git checkouts and get deleted after each run, but
  give yourself room for a few concurrent jobs plus your target repos.
- **Security group**: only open
  - `22` (SSH) — restrict this to your own IP, not `0.0.0.0/0`
  - `80` and `443` (HTTP/HTTPS) — for nginx + certbot
  - Do **not** open `8000` or `8080` publicly — those are internal, nginx is the only thing that
    should reach them (see step 4).
- Note the instance's public IP once it's running.

## 2. Point a domain at it

In your DNS provider, add two A records to the instance's public IP:
- `app.yourdomain.com` (the web frontend)
- `api.yourdomain.com` (the backend — this is also what you'll put in the mobile app's Settings
  screen, and what `VITE_API_BASE_URL` should point to when you build the frontend)

Wait for DNS to propagate (`dig app.yourdomain.com` should return the instance's IP) before step 5.

## 3. Install Docker + nginx + certbot

SSH in, then:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx git
sudo systemctl enable --now docker
sudo usermod -aG docker $USER   # log out/in once for this to take effect
```

## 4. Clone the repo and configure

```bash
git clone https://github.com/<you>/agent-swarm.git
cd agent-swarm
cp .env.example .env
```

Edit `.env`:
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` — required
- `API_KEY` — **set this**. Anyone who can reach the API without it can run arbitrary shell commands
  via the dev agents against any `repo_path` you give it. Generate one with `openssl rand -hex 32`.
- `VITE_API_BASE_URL=https://api.yourdomain.com`
- `REPOS_DIR` — where your target repos live on this instance, e.g. `/home/ubuntu/repos`. Clone
  whatever projects you want the swarm to work on into there first; use `/repos/<name>` as the
  `repo_path` you type into the app (that's the mount point inside the container, see
  `docker-compose.yml`).

## 5. Build and start

```bash
docker compose build
docker compose up -d
```

`backend` is now listening on `127.0.0.1:8000`, `frontend` on `127.0.0.1:8080` — reachable from the
instance itself, not yet from the internet. That's what nginx is for next.

## 6. nginx reverse proxy + TLS

Create `/etc/nginx/sites-available/agent-swarm`:

```nginx
server {
    listen 80;
    server_name app.yourdomain.com;
    location / { proxy_pass http://127.0.0.1:8080; }
}

server {
    listen 80;
    server_name api.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # jobs are long-running — an SSE/polling connection sitting idle shouldn't get cut off
        proxy_read_timeout 3600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/agent-swarm /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d app.yourdomain.com -d api.yourdomain.com
```

Certbot rewrites the config to add the TLS `listen 443` blocks and sets up auto-renewal — that's it,
`https://app.yourdomain.com` and `https://api.yourdomain.com` are live.

## 7. Verify

```bash
curl -H "X-API-Key: <your API_KEY>" https://api.yourdomain.com/models
```

Should return the models JSON. Open `https://app.yourdomain.com` in a browser — Settings (gear icon)
should already work with `https://api.yourdomain.com` + your key.

## Updating after a code change

```bash
git pull
docker compose build
docker compose up -d
```

`jobs/` (job history + worktrees) lives in a bind-mounted volume, so it survives this.

## Restart on reboot

`docker compose up -d` was run with `restart: unless-stopped` already set in `docker-compose.yml`, so
the containers come back on their own after an instance reboot as long as Docker's own service is
enabled (`systemctl enable docker`, done in step 3). Nginx and certbot's renewal timer are systemd
services too, enabled by their own package install — nothing extra needed there.
