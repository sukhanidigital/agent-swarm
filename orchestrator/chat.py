"""Read-only advisory chat for scoping out a build before committing to a job — a cheap, fast
conversation layer in front of the (expensive, autonomous) swarm pipeline. Deliberately has no write
tools: it can discuss and explore the repo, but the only thing it can hand off is a proposed prompt for
the existing /plan endpoint, never a direct edit — that boundary is what keeps every actual code change
going through the same gate-chain review as everything else, instead of opening a second, unaccountable
path to touching files. State is in-memory only, per backend process — losing a chat on a backend
restart is an acceptable tradeoff for a local dev tool; it's not job history worth persisting."""
import uuid

from orchestrator.dev_tools import WorkspaceTools
from orchestrator.llm_clients import OPENAI_FLASH_MODEL, openai_chat_turn

CHAT_SYSTEM = """You are a helpful assistant discussing a codebase with its owner, who is deciding what
to build next. You have read-only tools (list_dir, read_file) scoped to their repo — use them to
explore and ground your answers in the actual code, not guesses.

Help them think through scope, ambiguity, and tradeoffs like a colleague would. You cannot make any
changes yourself — only a separate autonomous build pipeline can, and only after the user reviews a
concrete prompt for it. Once you and the user have landed on something clear and well-scoped enough to
hand off, propose it as a build prompt wrapped EXACTLY like this, on its own:

---PROPOSED PROMPT---
<the actual prompt text, written as a clear, self-contained build request>
---END PROMPT---

Only include a proposed-prompt block when you're genuinely confident it's ready — don't force one into
every reply. Keep everything else conversational and concise."""

_sessions: dict[str, dict] = {}  # chat_id -> {"repo_path": str, "messages": list}


def start_chat(repo_path: str) -> str:
    chat_id = str(uuid.uuid4())
    _sessions[chat_id] = {"repo_path": repo_path, "messages": []}
    return chat_id


def send_message(chat_id: str, message: str) -> str:
    session = _sessions.get(chat_id)
    if session is None:
        raise ValueError("Chat session not found — it may have expired (backend restarted?). Start a new chat.")
    tools = WorkspaceTools(session["repo_path"])
    reply, messages = openai_chat_turn(
        OPENAI_FLASH_MODEL, CHAT_SYSTEM, tools.openai_discovery_tool_defs(), tools.tool_impls(),
        session["messages"], message,
    )
    session["messages"] = messages
    return reply
