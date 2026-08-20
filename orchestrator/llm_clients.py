"""Thin wrappers around the Anthropic and OpenAI SDKs used by every agent role."""
import json
import os
import re

import anthropic
from dotenv import load_dotenv
from openai import OpenAI

from orchestrator import cost

load_dotenv()

# Explicit timeouts so a stalled connection fails loudly (surfaced in the job log, retryable) instead
# of hanging a whole job indefinitely — neither SDK sets a sane default on its own.
anthropic_client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"), timeout=90.0)
openai_client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"), timeout=90.0)

CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-5")
# gpt-5.4 is the newest OpenAI generation with a genuine mini counterpart (gpt-5.5, as of this
# writing, doesn't have one yet) — the cleanest match for the old Gemini Pro/Flash split: one strong
# tier for team-lead/quality-gate work, one cheap-and-fast tier for dev/check-and-test volume.
OPENAI_PRO_MODEL = os.environ.get("OPENAI_PRO_MODEL", "gpt-5.4")
OPENAI_FLASH_MODEL = os.environ.get("OPENAI_FLASH_MODEL", "gpt-5.4-mini")


def safe_json_load(text: str):
    """Strip markdown code fences and parse JSON defensively, as LLMs often wrap JSON in ```json blocks."""
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE)
    return json.loads(cleaned)


def extract_json_object(text: str):
    """Pull the last {...} object out of a longer message — gate agents narrate their tool use
    before ending with a JSON verdict, so we can't assume the whole message is JSON."""
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError(f"No JSON object found in response: {text[:300]}")
    return safe_json_load(text[start:end + 1])


def _cacheable_system(system: str) -> list[dict]:
    """Marks the (static, reused-across-many-calls-in-a-job) system prompt as cacheable so Anthropic
    only charges full price the first time and a steep discount on every repeat within the cache TTL —
    real savings, same reasoning, since every dev/gate call in a job reuses the same handful of
    system prompts verbatim."""
    return [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]


def _record_claude_usage(model: str, usage):
    cost.record(
        model, usage.input_tokens, usage.output_tokens,
        cache_write_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
        cache_read_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
    )


def call_claude(system: str, prompt: str, model: str = CLAUDE_MODEL, max_tokens: int = 4096) -> str:
    response = anthropic_client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=_cacheable_system(system),
        messages=[{"role": "user", "content": prompt}],
    )
    _record_claude_usage(model, response.usage)
    return "".join(block.text for block in response.content if block.type == "text")


def call_claude_with_tools(system: str, prompt: str, tool_defs: list[dict], tool_impls: dict,
                            model: str = CLAUDE_MODEL, max_turns: int = 8, max_tokens: int = 4096) -> str:
    """Manual tool-use loop for Claude (the Anthropic SDK has no automatic-function-calling helper) —
    used by the final auditor, which may inspect/polish code before verdict."""
    cacheable_system = _cacheable_system(system)
    messages = [{"role": "user", "content": prompt}]
    ran_out_of_budget = False
    for _ in range(max_turns):
        if cost.over_budget():
            ran_out_of_budget = True
            break
        response = anthropic_client.messages.create(
            model=model, max_tokens=max_tokens, system=cacheable_system, messages=messages, tools=tool_defs,
        )
        _record_claude_usage(model, response.usage)
        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason != "tool_use":
            return "".join(block.text for block in response.content if block.type == "text")

        tool_results = []
        for block in response.content:
            if block.type == "tool_use":
                try:
                    result = tool_impls[block.name](**block.input)
                except Exception as exc:  # noqa: BLE001 - surface tool failures to the model, not a crash
                    result = f"ERROR: {exc}"
                tool_results.append({"type": "tool_result", "tool_use_id": block.id, "content": str(result)})
        messages.append({"role": "user", "content": tool_results})

    # Ran out of turns (or the job's own budget cap, checked every turn above) still investigating —
    # force a real answer instead of returning an unparseable fallback string that would just fail JSON
    # parsing and burn the whole call for nothing. Tools are withheld on this call so it can't keep
    # stalling by requesting yet another tool use.
    tail_reason = "You're out of budget for this job." if ran_out_of_budget else "You're out of tool-call budget."
    messages.append({"role": "user", "content": f"{tail_reason} Give your final "
                      "verdict now, in the required JSON format, based on everything you've seen so far."})
    response = anthropic_client.messages.create(
        model=model, max_tokens=max_tokens, system=cacheable_system, messages=messages,
    )
    _record_claude_usage(model, response.usage)
    return "".join(block.text for block in response.content if block.type == "text")


def _record_openai_usage(model: str, usage):
    """OpenAI's own prompt caching is automatic (no separate params to set) and discounts cached
    input tokens ~90% — close enough to Anthropic's cache-read discount that reusing the same 0.1x
    multiplier here is a reasonable approximation rather than adding a second, provider-specific
    discount constant to cost.py for a difference under 5 percentage points."""
    if usage is None:
        return
    cached = getattr(getattr(usage, "prompt_tokens_details", None), "cached_tokens", 0) or 0
    fresh_input = max(0, usage.prompt_tokens - cached)
    cost.record(model, fresh_input, usage.completion_tokens, cache_read_tokens=cached)


def call_openai(system: str, prompt: str, model: str) -> str:
    """One-shot, no-tools OpenAI call (team-lead assign/revise, summarizer, coordinator)."""
    response = openai_client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
    )
    _record_openai_usage(model, response.usage)
    return response.choices[0].message.content or ""


def _run_openai_tool_loop(model: str, messages: list, tool_defs: list[dict], tool_impls: dict,
                           max_turns: int) -> str:
    """Shared loop body behind call_openai_with_tools (fresh one-shot call) and openai_chat_turn
    (persisted multi-turn chat) — mutates `messages` in place, turn by turn, including tool call/result
    entries, so a caller holding onto the same list across calls gets a real accumulating conversation.
    Same manual-loop reasoning as Claude's: full control over the turn cap and per-turn cost recording,
    instead of an SDK-managed loop that could run away or under-report usage."""
    ran_out_of_budget = False
    for _ in range(max_turns):
        if cost.over_budget():
            ran_out_of_budget = True
            break
        response = openai_client.chat.completions.create(model=model, messages=messages, tools=tool_defs)
        _record_openai_usage(model, response.usage)
        message = response.choices[0].message
        if not message.tool_calls:
            messages.append({"role": "assistant", "content": message.content or ""})
            return message.content or ""

        messages.append({
            "role": "assistant", "content": message.content,
            "tool_calls": [tc.model_dump() for tc in message.tool_calls],
        })
        for tc in message.tool_calls:
            try:
                args = json.loads(tc.function.arguments or "{}")
                result = tool_impls[tc.function.name](**args)
            except Exception as exc:  # noqa: BLE001 - surface tool failures to the model, not a crash
                result = f"ERROR: {exc}"
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": str(result)})

    # Ran out of turns (or the job's own budget cap, checked every turn above) still investigating —
    # force a real answer with tools withheld, same reasoning as Claude's manual loop.
    tail_reason = ("You're out of budget for this job." if ran_out_of_budget
                   else "You're out of tool-call budget.")
    messages.append({"role": "user", "content": f"{tail_reason} Give your final answer now, in the "
                      "required format, based on everything you've seen so far."})
    response = openai_client.chat.completions.create(model=model, messages=messages)
    _record_openai_usage(model, response.usage)
    text = response.choices[0].message.content or ""
    messages.append({"role": "assistant", "content": text})
    return text


def call_openai_with_tools(model: str, system: str, tool_defs: list[dict], tool_impls: dict, prompt: str,
                            max_turns: int = 10) -> str:
    """One-shot tool-using call — used by every dev/gate agent, which never needs its conversation to
    outlive the call. tool_defs/tool_impls follow the same shape as Claude's manual loop above
    (WorkspaceTools.openai_tool_defs() / WorkspaceTools.tool_impls())."""
    messages = [{"role": "system", "content": system}, {"role": "user", "content": prompt}]
    return _run_openai_tool_loop(model, messages, tool_defs, tool_impls, max_turns)


def openai_chat_turn(model: str, system: str, tool_defs: list[dict], tool_impls: dict, messages: list,
                      message: str, max_turns: int = 8) -> tuple[str, list]:
    """One turn of a persisted multi-turn chat (the advisory chat) — `messages` is the full prior
    conversation, mutated in place and returned so the caller can hold onto it for the next turn."""
    if not messages:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": message})
    reply = _run_openai_tool_loop(model, messages, tool_defs, tool_impls, max_turns)
    return reply, messages
