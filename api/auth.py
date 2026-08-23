"""Single-key auth for the API. Off by default (API_KEY unset) so local dev stays frictionless — the
same failure mode this whole cloud-hosting effort exists to close is leaving this backend reachable
with no auth once it's not just localhost, since it executes arbitrary shell/dev-agent commands
against whatever repo_path it's given. Set API_KEY once this is anywhere but localhost."""
import os
import secrets

from fastapi import Header, HTTPException


def require_api_key(x_api_key: str | None = Header(default=None)):
    expected = os.environ.get("API_KEY")
    if not expected:
        return  # no key configured — auth is a no-op, matches today's local-dev behavior
    if not x_api_key or not secrets.compare_digest(x_api_key, expected):
        raise HTTPException(401, "Missing or invalid X-API-Key header")
