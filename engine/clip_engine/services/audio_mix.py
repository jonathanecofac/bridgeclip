"""Editor audio: voice level, mute, loudness normalization and background music.

Music is imported once into the editor folder as AAC in MP4
(editor-music-<id>.mp4), looped to the clip's length, and mixed after the
speed change, so it always plays at its own tempo. Ducking lowers it while
people speak, using the transcript's word timing on the final clock; the
editor's live preview uses the same intervals and ramps.
"""
import math
import re
from typing import Optional

from clip_engine.services.layout_renderer import AUDIO_FORMAT, FINITE_AUDIO

MUSIC_FILE = re.compile(r"^editor-music-[a-f0-9]{32}\.mp4$")
MUSIC_INPUT_FORMATS = "mp3,wav,ogg,flac,aac,mov,matroska,webm"
MAX_MUSIC_MS = 30 * 60 * 1000
# Pauses shorter than this keep the music down; ramps take DUCK_RAMP_MS.
SPEECH_GAP_MS = 600
DUCK_RAMP_MS = 200
MAX_SPEECH_INTERVALS = 400
DEFAULT_AUDIO = {"volume_db": 0, "mute": False, "normalize": True, "music": None}
MUSIC_KEYS = {"file", "name", "volume_db", "offset_ms", "duck", "duck_db", "fade_in_ms", "fade_out_ms"}


def _finite(value, lo, hi):
    return type(value) in (int, float) and math.isfinite(value) and lo <= value <= hi


def _int(value, lo, hi):
    return type(value) is int and lo <= value <= hi


def validate_audio(value) -> dict:
    """Normalized audio settings; raises ValueError for anything malformed."""
    if value is None:
        value = {}
    if not isinstance(value, dict) or set(value) - set(DEFAULT_AUDIO):
        raise ValueError("Invalid audio settings")
    audio = {**DEFAULT_AUDIO, **value}
    if not (_finite(audio["volume_db"], -20, 12) and type(audio["mute"]) is bool and type(audio["normalize"]) is bool):
        raise ValueError("Invalid audio settings")
    music = audio["music"]
    if music is not None:
        if not (isinstance(music, dict) and set(music) == MUSIC_KEYS
                and isinstance(music["file"], str) and MUSIC_FILE.match(music["file"])
                and isinstance(music["name"], str) and 1 <= len(music["name"]) <= 200
                and not any(ord(c) < 32 for c in music["name"])
                and _finite(music["volume_db"], -40, 6) and _int(music["offset_ms"], 0, MAX_MUSIC_MS)
                and type(music["duck"]) is bool and _finite(music["duck_db"], -30, 0)
                and _int(music["fade_in_ms"], 0, 5000) and _int(music["fade_out_ms"], 0, 5000)):
            raise ValueError("Invalid background music")
        audio["music"] = dict(music)
    return audio


def describe(audio: Optional[dict]) -> bool:
    """Whether the settings change the export's sound."""
    return bool(audio) and (audio["volume_db"] != 0 or audio["mute"] or not audio["normalize"] or audio["music"] is not None)


def voice_filters(audio: dict) -> str:
    """Voice level on the edited clock, before speed, or ""."""
    if audio["mute"]:
        return "volume=0"
    return f"volume={audio['volume_db']:.4g}dB" if audio["volume_db"] else ""


def loudness_override(audio: dict) -> Optional[str]:
    """Replacement for the loudness filter when normalization is off (None keeps it)."""
    return None if audio["normalize"] else f"{FINITE_AUDIO},{AUDIO_FORMAT}"


def speech_intervals(words, keeps, speed: float) -> list[tuple[int, int]]:
    """Where people speak on the final clock (ms, after cuts and speed), merged across short pauses.

    `words` are (start_ms, end_ms) in source time; `keeps` the clip's kept
    source ranges in order.
    """
    pieces = []
    offset = 0
    for keep_start, keep_end in keeps:
        for start, end in words:
            lo, hi = max(start, keep_start), min(end, keep_end)
            if hi > lo:
                pieces.append(((offset + lo - keep_start) / speed, (offset + hi - keep_start) / speed))
        offset += keep_end - keep_start
    pieces.sort()
    merged: list[list[float]] = []
    for a, b in pieces:
        if merged and a - merged[-1][1] < SPEECH_GAP_MS:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    gap = SPEECH_GAP_MS
    while len(merged) > MAX_SPEECH_INTERVALS:
        # Very talkative clips: widen the merge so the expression stays small.
        gap *= 2
        joined: list[list[float]] = []
        for a, b in merged:
            if joined and a - joined[-1][1] < gap:
                joined[-1][1] = b
            else:
                joined.append([a, b])
        merged = joined
    return [(round(a), round(b)) for a, b in merged]


def duck_expression(intervals, duck_db: float) -> str:
    """Gain over time `t` (seconds): 1, easing to the ducked level DUCK_RAMP_MS before
    speech and back DUCK_RAMP_MS after it. Ramps never overlap (gaps exceed two ramps)."""
    gain = 10 ** (duck_db / 20)
    r = DUCK_RAMP_MS / 1000
    terms = "+".join(f"clip(min((t-{a / 1000 - r:.3f})/{r},({b / 1000 + r:.3f}-t)/{r}),0,1)" for a, b in intervals)
    return f"1-{1 - gain:.5f}*clip({terms},0,1)"


def music_chain(input_index: int, music: dict, music_ms: int, total_ms: int, speech) -> str:
    """Filters from the looped music input to [music], on the final clock."""
    total = total_ms / 1000
    offset = (music["offset_ms"] % music_ms) / 1000 if music_ms > 0 else 0
    chain = (f"[{input_index}:a:0]{AUDIO_FORMAT},atrim=start={offset:.3f},asetpts=PTS-STARTPTS,"
             f"atrim=duration={total:.6f},asetpts=PTS-STARTPTS,volume={music['volume_db']:.4g}dB")
    if music["duck"] and speech:
        chain += f",volume=eval=frame:volume='{duck_expression(speech, music['duck_db'])}'"
    if music["fade_in_ms"]:
        chain += f",afade=t=in:st=0:d={min(music['fade_in_ms'] / 1000, total / 2):.3f}"
    if music["fade_out_ms"]:
        d = min(music["fade_out_ms"] / 1000, total / 2)
        chain += f",afade=t=out:st={max(0, total - d):.3f}:d={d:.3f}"
    return chain + "[music]"


def mix_graph(voice_label: str, input_index: int, music: dict, music_ms: int, total_ms: int, speech) -> str:
    """Graph fragment mixing `voice_label` with the music into [aout]."""
    return (f"{music_chain(input_index, music, music_ms, total_ms, speech)};"
            f"[{voice_label}][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,"
            f"alimiter=limit=0.95:level=disabled:latency=1,{AUDIO_FORMAT},asettb=1/48000,asetpts=N[aout]")
