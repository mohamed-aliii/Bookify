import os
import threading
from typing import List

_lock = threading.Lock()
_next_index = 0

# We support OPENROUTER_API_KEY + OPENROUTER_API_KEY_2..10
_CANDIDATE_ENVS = ["OPENROUTER_API_KEY"] + [f"OPENROUTER_API_KEY_{i}" for i in range(2, 11)]


def collect_openrouter_keys() -> List[str]:
    """Collect all configured OpenRouter keys from environment (loaded via .env).

    Deduplicates, preserves order, ignores empty values.
    Does NOT read .env file directly — relies on os.environ already populated
    by config.load_dotenv.
    """
    from .config import settings  # local import to avoid cycle at module load

    keys: List[str] = []
    seen = set()
    for env_name in _CANDIDATE_ENVS:
        val = os.getenv(env_name)
        if val:
            val = val.strip().strip('"').strip("'")
            if val and val not in seen:
                keys.append(val)
                seen.add(val)

    # Include custom api_key_env if it points to a non-standard env var
    custom = getattr(settings.llm, "api_key_env", None)
    if custom and custom not in _CANDIDATE_ENVS:
        val = os.getenv(custom)
        if val:
            val = val.strip().strip('"').strip("'")
            if val and val not in seen:
                # custom primary should be tried first
                keys.insert(0, val)
                seen.add(val)
    return keys


def get_keys_in_rotation_order() -> List[str]:
    """Return keys rotated in round-robin order for load distribution."""
    keys = collect_openrouter_keys()
    if not keys:
        return []
    if len(keys) == 1:
        return keys
    global _next_index
    with _lock:
        start = _next_index % len(keys)
        _next_index = (_next_index + 1) % len(keys)
    # rotate
    return keys[start:] + keys[:start]


def is_rate_limit_error(exc: Exception) -> bool:
    """Heuristic to detect OpenRouter/free-tier rate limiting."""
    try:
        import litellm

        if isinstance(exc, getattr(litellm, "RateLimitError", ())):
            return True
        # litellm may wrap in APIError
        if hasattr(litellm, "exceptions"):
            try:
                from litellm.exceptions import RateLimitError as LRate

                if isinstance(exc, LRate):
                    return True
            except Exception:
                pass
    except Exception:
        pass

    msg = str(exc).lower()
    name = type(exc).__name__.lower()
    if "ratelimit" in name:
        return True
    # OpenRouter free tier message
    if "429" in msg:
        return True
    if "rate limit" in msg or "rate_limit" in msg:
        return True
    if "free-models-per-day" in msg:
        return True
    if "free model" in msg and "limit" in msg:
        return True
    if "openrouter" in msg and "limit" in msg:
        return True
    if "too many requests" in msg:
        return True
    return False
