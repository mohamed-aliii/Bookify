import os
from collections.abc import Iterator

import litellm

from .config import settings

litellm.suppress_debug_info = True

REQUEST_TIMEOUT_SECONDS = 60


def _completion_kwargs(temperature: float | None) -> dict:
    kwargs: dict = {"model": settings.llm.model, "timeout": REQUEST_TIMEOUT_SECONDS}
    effective_temp = settings.llm.temperature if temperature is None else temperature
    if effective_temp is not None:
        kwargs["temperature"] = effective_temp
    if settings.llm.extra_body:
        kwargs["extra_body"] = settings.llm.extra_body
    api_key = os.getenv(settings.llm.api_key_env)
    if api_key:
        kwargs["api_key"] = api_key
    kwargs["num_retries"] = 2
    return kwargs


class LLMClient:
    def stream(self, messages: list[dict], temperature: float | None = None) -> Iterator[tuple[str, str]]:
        response = litellm.completion(messages=messages, stream=True, **_completion_kwargs(temperature))
        for event in response:
            delta = event.choices[0].delta
            content = delta.content
            reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
            if content:
                yield "content", content
            elif reasoning:
                yield "reasoning", str(reasoning)

    def complete(self, messages: list[dict], temperature: float | None = None) -> str:
        return "".join(value for kind, value in self.stream(messages, temperature) if kind == "content")


llm_client = LLMClient()
