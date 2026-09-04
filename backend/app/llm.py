import logging
import os
from collections.abc import Iterator

import litellm

from .config import settings
from .openrouter_rotation import get_cross_kg_key, get_keys_for_cross_kg, get_keys_in_rotation_order, is_rate_limit_error

logger = logging.getLogger(__name__)

litellm.suppress_debug_info = True

REQUEST_TIMEOUT_SECONDS = 60


def _completion_kwargs(temperature: float | None, api_key: str | None = None) -> dict:
    kwargs: dict = {"model": settings.llm.model, "timeout": REQUEST_TIMEOUT_SECONDS}
    effective_temp = settings.llm.temperature if temperature is None else temperature
    if effective_temp is not None:
        kwargs["temperature"] = effective_temp
    if settings.llm.extra_body:
        kwargs["extra_body"] = settings.llm.extra_body
    # If caller provides a key, use it; otherwise fall back to env (used only when rotation list is empty)
    if api_key is not None:
        kwargs["api_key"] = api_key
    else:
        fallback = os.getenv(settings.llm.api_key_env)
        if fallback:
            kwargs["api_key"] = fallback
    # We handle retries ourselves via rotation, so disable litellm internal retries to avoid masking rate limits
    kwargs["num_retries"] = 0
    return kwargs


class LLMClient:
    def stream(self, messages: list[dict], temperature: float | None = None) -> Iterator[tuple[str, str]]:
        keys = get_keys_in_rotation_order()
        # If no keys configured, try once with whatever is in env (will fail with clear error)
        if not keys:
            response = litellm.completion(messages=messages, stream=True, **_completion_kwargs(temperature))
            for event in response:
                delta = event.choices[0].delta
                content = delta.content
                reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
                if content:
                    yield "content", content
                elif reasoning:
                    yield "reasoning", str(reasoning)
            return

        last_exc: Exception | None = None
        for attempt, key in enumerate(keys):
            try:
                response = litellm.completion(messages=messages, stream=True, **_completion_kwargs(temperature, api_key=key))
                yielded_any = False
                for event in response:
                    delta = event.choices[0].delta
                    content = delta.content
                    reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
                    if content:
                        yielded_any = True
                        yield "content", content
                    elif reasoning:
                        yielded_any = True
                        yield "reasoning", str(reasoning)
                # If we got here without exception, stream succeeded
                return
            except Exception as exc:
                last_exc = exc
                if is_rate_limit_error(exc) and attempt < len(keys) - 1:
                    logger.warning("LLM rate-limited on key %d/%d — rotating to next OpenRouter key", attempt + 1, len(keys))
                    continue
                # Non-rate-limit or last key — re-raise
                raise
        if last_exc:
            raise last_exc

    def complete(self, messages: list[dict], temperature: float | None = None) -> str:
        keys = get_keys_in_rotation_order()
        if not keys:
            return "".join(value for kind, value in self.stream(messages, temperature) if kind == "content")

        last_exc: Exception | None = None
        for attempt, key in enumerate(keys):
            try:
                # Use non-streaming path with explicit key to avoid double rotation via stream()
                resp = litellm.completion(messages=messages, stream=False, **_completion_kwargs(temperature, api_key=key))
                # litellm non-stream returns object with choices[0].message.content
                try:
                    content = resp.choices[0].message.content or ""
                except Exception:
                    # Fallback: treat as string
                    content = str(resp)
                return content
            except Exception as exc:
                last_exc = exc
                if is_rate_limit_error(exc) and attempt < len(keys) - 1:
                    logger.warning("LLM rate-limited on key %d/%d — rotating", attempt + 1, len(keys))
                    continue
                raise
        if last_exc:
            raise last_exc
        return ""

    def complete_for_cross_kg(self, messages: list[dict], temperature: float | None = None) -> str:
        """Cross KG path — prefers OPENROUTER_API_KEY_PROVIDER_2, then falls back to pool."""
        keys = get_keys_for_cross_kg()
        if not keys:
            # Fallback to regular path
            return self.complete(messages, temperature)
        # Use cross_kg_model if configured
        model_override = getattr(settings.llm, "cross_kg_model", None)
        last_exc: Exception | None = None
        for attempt, key in enumerate(keys):
            try:
                kwargs = _completion_kwargs(temperature, api_key=key)
                if model_override:
                    kwargs["model"] = model_override
                resp = litellm.completion(messages=messages, stream=False, **kwargs)
                try:
                    content = resp.choices[0].message.content or ""
                except Exception:
                    content = str(resp)
                return content
            except Exception as exc:
                last_exc = exc
                if is_rate_limit_error(exc) and attempt < len(keys) - 1:
                    logger.warning("Cross-KG LLM rate-limited on key %d/%d (provider_2 first) — rotating", attempt + 1, len(keys))
                    continue
                raise
        if last_exc:
            raise last_exc
        return ""


llm_client = LLMClient()
