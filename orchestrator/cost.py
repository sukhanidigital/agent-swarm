"""Thread-safe running cost estimate for a single job. Dev agents run in their own threads
(ThreadPoolExecutor), so every thread that makes LLM calls must `bind()` to the same accumulator
instance for a job's total to actually add up across parallel work.

This is an ESTIMATE, not a billing-accurate figure. Both Claude's and OpenAI's manual tool loops
(llm_clients.py) record usage after every turn, so per-call totals should track real spend closely —
but published per-token pricing can drift after a model update, so treat this as a strong estimate,
not an invoice."""
import threading

# $ per 1M tokens, as (input, output). Keep in sync with CLAUDE_MODEL/OPENAI_*_MODEL in llm_clients.py
# and MODEL_OPTIONS in frontend/src/roles.js. OpenAI prices sourced from public pricing pages as of
# Aug 2026 — re-verify if OpenAI revises pricing, this table won't update itself.
PRICING = {
    "claude-sonnet-5": (3.00, 15.00),
    "gpt-5.5": (5.00, 30.00),
    "gpt-5.4": (2.50, 15.00),
    "gpt-5.4-mini": (0.75, 4.50),
    "gpt-5.4-nano": (0.20, 1.25),
    "gpt-4.1": (2.00, 8.00),
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4.1-nano": (0.10, 0.40),
    "o4-mini": (1.10, 4.40),
}


class CostAccumulator:
    def __init__(self, starting_total: float = 0.0, max_cost: float | None = None):
        """starting_total lets a resumed job carry its prior spend forward instead of the running
        total (and any budget cap check against it) resetting to zero on resume. max_cost, if set,
        lets over_budget() below be checked *inside* a call's own tool loop (every turn), not just at
        the coarse pipeline checkpoints between stages — a single runaway dev/gate call can no longer
        blow past the job's budget before anyone notices."""
        self._lock = threading.Lock()
        self.total = starting_total
        self.calls = 0
        self.max_cost = max_cost

    def add(self, model: str, input_tokens: int, output_tokens: int,
             cache_write_tokens: int = 0, cache_read_tokens: int = 0) -> float:
        """cache_write is Anthropic-specific (billed at ~1.25x normal input rate); cache_read applies
        to both providers (Anthropic's own cache reads and OpenAI's automatic prompt-cache discount,
        both ballparked here at ~0.1x normal input rate — a real discount, not just an estimate quirk,
        even though OpenAI's actual discount runs a bit steeper than Anthropic's)."""
        in_rate, out_rate = PRICING.get(model, (0.0, 0.0))
        call_cost = (
            input_tokens * in_rate
            + output_tokens * out_rate
            + cache_write_tokens * in_rate * 1.25
            + cache_read_tokens * in_rate * 0.1
        ) / 1_000_000
        with self._lock:
            self.total += call_cost
            self.calls += 1
        return call_cost


_local = threading.local()


def bind(accumulator: CostAccumulator):
    """Call once at the start of any thread (main pipeline thread, or a dev worker thread)
    that's about to make LLM calls for this job."""
    _local.accumulator = accumulator


def record(model: str, input_tokens: int, output_tokens: int, cache_write_tokens: int = 0, cache_read_tokens: int = 0):
    """No-op if the current thread never bound an accumulator — keeps llm_clients.py usable
    standalone (e.g. in a smoke test) without wiring cost tracking everywhere."""
    accumulator = getattr(_local, "accumulator", None)
    if accumulator is not None:
        accumulator.add(model, input_tokens or 0, output_tokens or 0, cache_write_tokens or 0, cache_read_tokens or 0)


def over_budget() -> bool:
    """Checked after every turn inside call_openai_with_tools/call_claude_with_tools — lets a tool
    loop cut itself short mid-call instead of only being caught at the next pipeline checkpoint.
    False (never trips) if the current thread never bound an accumulator, or no max_cost was set."""
    accumulator = getattr(_local, "accumulator", None)
    return accumulator is not None and accumulator.max_cost is not None and accumulator.total >= accumulator.max_cost
