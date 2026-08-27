"""Job-finished notifications (email today, push later). Gracefully no-ops if NOTIFY_EMAIL_* aren't
set — this is an optional layer, not a dependency of the core pipeline.

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


def notify_job_finished(job_id: str, prompt: str, status: str, cost_estimate: float):
    if not (NOTIFY_EMAIL_ADDRESS and NOTIFY_EMAIL_APP_PASSWORD and NOTIFY_EMAIL_TO):
        return

    subject = f"Agent Swarm job {status}: {prompt[:60]}"
    body = (
        f"Job {job_id} finished with status: {status}\n"
        f"Cost estimate: ${cost_estimate:.4f}\n\n"
        f"Prompt:\n{prompt}"
    )
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = NOTIFY_EMAIL_ADDRESS
    msg["To"] = NOTIFY_EMAIL_TO

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(NOTIFY_EMAIL_ADDRESS, NOTIFY_EMAIL_APP_PASSWORD)
            server.send_message(msg)
    except Exception as e:
        print(f"notify_job_finished: failed to send email for job {job_id}: {e}")
