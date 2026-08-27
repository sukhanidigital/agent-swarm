"""Single-key auth for the API. Off by default (API_KEY unset) so local dev stays frictionless — the
same failure mode this whole cloud-hosting effort exists to close is leaving this backend reachable
with no auth once it's not just localhost, since it executes arbitrary shell/dev-agent commands
against whatever repo_path it's given. Set API_KEY once this is anywhere but localhost.

/login is exempted (see below) since it's how the frontend's email/password screen exchanges
credentials for the API_KEY in the first place — it can't send a key it doesn't have yet."""
import os
import secrets

from fastapi import Header, HTTPException, Request


def require_api_key(request: Request, x_api_key: str | None = Header(default=None)):
    if request.url.path == "/login":
        return
    expected = os.environ.get("API_KEY")
    if not expected:
        return  # no key configured — auth is a no-op, matches today's local-dev behavior
    if not x_api_key or not secrets.compare_digest(x_api_key, expected):
        raise HTTPException(401, "Missing or invalid X-API-Key header")
