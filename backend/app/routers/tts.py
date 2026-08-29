import asyncio
import io
import os
import re
import wave

import edge_tts
from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel

router = APIRouter(tags=["tts"])

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
MODELS_DIR = os.path.join(BACKEND_DIR, "models", "piper_ar")

PIPER_VOICES = {
    "ar": os.path.join(MODELS_DIR, "ar_JO-kareem-medium.onnx"),
    "ar-SA": os.path.join(MODELS_DIR, "ar_JO-kareem-medium.onnx"),
    "ar-EG": os.path.join(MODELS_DIR, "ar_JO-kareem-medium.onnx"),
}

EDGE_VOICE_MAP = {
    "en": "en-US-GuyNeural",
    "en-US": "en-US-GuyNeural",
    "en-GB": "en-GB-RyanNeural",
}

_EMOJI_RE = re.compile(
    "["
    "\U0001F600-\U0001F64F"
    "\U0001F300-\U0001F5FF"
    "\U0001F680-\U0001F6FF"
    "\U0001F1E0-\U0001F1FF"
    "\U00002702-\U000027B0"
    "\U0000FE00-\U0000FE0F"
    "\U0001F900-\U0001F9FF"
    "\U0001FA00-\U0001FA6F"
    "\U0001FA70-\U0001FAFF"
    "\U00002600-\U000026FF"
    "]+",
    flags=re.UNICODE,
)

_MD_RE = re.compile(r"[*_`#~>\-|]")

_MULTISPACE_RE = re.compile(r"\s{2,}")

_ar_piper_cache = None
_voicetut_cache = None


def _clean(text: str) -> str:
    text = _EMOJI_RE.sub("", text)
    text = _MD_RE.sub("", text)
    text = _MULTISPACE_RE.sub(" ", text).strip()
    return text


class TTSRequest(BaseModel):
    text: str
    lang: str = "en"
    quality: str = "fast"


def _get_piper_voice():
    global _ar_piper_cache
    if _ar_piper_cache is None:
        from piper import PiperVoice
        _ar_piper_cache = PiperVoice.load(PIPER_VOICES["ar"])
    return _ar_piper_cache


def _get_voicetut():
    global _voicetut_cache
    if _voicetut_cache is None:
        from voicetut_tts import VoiceTutTTS
        _voicetut_cache = VoiceTutTTS.from_pretrained(device="cpu", dtype="float32")
    return _voicetut_cache


def _piper_ar(text: str) -> bytes:
    voice = _get_piper_voice()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        voice.synthesize_wav(text, wf)
    return buf.getvalue()


def _voicetut_ar(text: str) -> bytes:
    import soundfile as sf
    import numpy as np
    try:
        model = _get_voicetut()
    except Exception:
        return _piper_ar(text)
    wav = model.synthesize(text, speaker="Abdelrahman")
    buf = io.BytesIO()
    sf.write(buf, wav, model.sampling_rate, format="WAV")
    return buf.getvalue()


async def _edge_tts(text: str, voice: str) -> bytes:
    communicate = edge_tts.Communicate(text, voice)
    audio_chunks: list[bytes] = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_chunks.append(chunk["data"])
    return b"".join(audio_chunks)


@router.post("/tts")
async def text_to_speech(body: TTSRequest):
    text = _clean(body.text)
    if not text:
        return Response(content=b"", media_type="audio/mpeg")

    lang = body.lang or "en"
    quality = body.quality or "fast"

    if lang.startswith("ar"):
        loop = asyncio.get_running_loop()
        if quality == "high":
            audio = await loop.run_in_executor(None, _voicetut_ar, text)
            media_type = "audio/wav"
        else:
            audio = await loop.run_in_executor(None, _piper_ar, text)
            media_type = "audio/wav"
        return Response(
            content=audio,
            media_type=media_type,
            headers={"Cache-Control": "public, max-age=3600"},
        )
    else:
        voice = EDGE_VOICE_MAP.get(lang, EDGE_VOICE_MAP["en"])
        audio = await _edge_tts(text, voice)
        return Response(
            content=audio,
            media_type="audio/mpeg",
            headers={"Cache-Control": "public, max-age=3600"},
        )
