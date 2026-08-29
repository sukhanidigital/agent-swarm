"""Job-finished and self-heal notifications (email today, push later). Gracefully no-ops if
NOTIFY_EMAIL_* aren't set — this is an optional layer, not a dependency of the core pipeline.

Uses Gmail's SMTP relay with an app password (not your normal Gmail password) — generate one at
https://myaccount.google.com/apppasswords (requires 2-Step Verification enabled on the account).
"""
import os
import smtplib
from email.mime.text import MIMEText

from dotenv import load_dotenv

load_dotenv()

NOTIFY_EMAIL_ADDRESS = os.environ.get("NOTIFY_EMAIL_ADDRESS")
NOTIFY_EMAIL_APP_PASSWORD = os.environ.get("NOTIFY_EMAIL_APP_PASSWORD")
NOTIFY_EMAIL_TO = os.environ.get("NOTIFY_EMAIL_TO") or NOTIFY_EMAIL_ADDRESS


def _send(subject: str, body: str, job_id: str):
    if not (NOTIFY_EMAIL_ADDRESS and NOTIFY_EMAIL_APP_PASSWORD and NOTIFY_EMAIL_TO):
        return
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = NOTIFY_EMAIL_ADDRESS
    msg["To"] = NOTIFY_EMAIL_TO
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(NOTIFY_EMAIL_ADDRESS, NOTIFY_EMAIL_APP_PASSWORD)
            server.send_message(msg)
    except Exception as e:
        print(f"notify: failed to send email for job {job_id}: {e}")


def notify_job_finished(job_id: str, prompt: str, status: str, cost_estimate: float):
    subject = f"Agent Swarm job {status}: {prompt[:60]}"
    body = (
        f"Job {job_id} finished with status: {status}\n"
        f"Cost estimate: ${cost_estimate:.4f}\n\n"
        f"Prompt:\n{prompt}"
    )
    _send(subject, body, job_id)


def notify_self_heal(job_id: str, summary: str, tb: str):
    """A materially different event than a normal job outcome — the tool patched and restarted
    itself with no human in the loop, so the person running it should know it happened, what the bug
    was, and that the crashed job is resuming on its own (see orchestrator/self_heal.py)."""
    subject = f"Agent Swarm self-healed a bug (job {job_id[:8]})"
    body = (
        f"Job {job_id} hit an unhandled bug in the swarm's own code. It diagnosed and patched the "
        f"bug, committed the fix, and is restarting to apply it — the job will resume automatically "
        f"once it's back up.\n\n"
        f"Fix: {summary}\n\n"
        f"Original traceback:\n{tb}"
    )
    _send(subject, body, job_id)
