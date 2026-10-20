"""Editor effects: color looks on parts of a clip, fades, and transitions at cuts.

Every filter here exists in BridgeClip's LGPL FFmpeg builds (no eq/hue/
colorbalance, which are GPL-only) and supports timeline `enable`, so a look
applies exactly to its source interval on the edited clock.
"""
import math
from typing import Optional

MAX_LOOKS = 20
TRANSITIONS = ("none", "dip", "flash")


def _finite(value, lo, hi):
    return type(value) in (int, float) and math.isfinite(value) and lo <= value <= hi


def validate_effects(value, duration_ms) -> dict:
    """Normalized effects; raises ValueError for anything malformed."""
    if value is None:
        value = {}
    if not isinstance(value, dict) or set(value) - {"fade_in_ms", "fade_out_ms", "transition", "transition_ms", "looks"}:
        raise ValueError("Invalid effects")
    effects = {"fade_in_ms": value.get("fade_in_ms", 0), "fade_out_ms": value.get("fade_out_ms", 0),
               "transition": value.get("transition", "none"), "transition_ms": value.get("transition_ms", 300),
               "looks": value.get("looks", [])}
    if not (type(effects["fade_in_ms"]) is int and 0 <= effects["fade_in_ms"] <= 3000
            and type(effects["fade_out_ms"]) is int and 0 <= effects["fade_out_ms"] <= 3000
            and effects["transition"] in TRANSITIONS
            and type(effects["transition_ms"]) is int and 100 <= effects["transition_ms"] <= 1000
            and isinstance(effects["looks"], list) and len(effects["looks"]) <= MAX_LOOKS):
        raise ValueError("Invalid effects settings")
    looks = []
    for look in effects["looks"]:
        if not (isinstance(look, dict) and set(look) == {"start_ms", "end_ms", "brightness", "contrast", "saturation", "sharpen", "vignette"}
                and _finite(look["start_ms"], 0, duration_ms) and _finite(look["end_ms"], 0, duration_ms)
                and look["end_ms"] - look["start_ms"] >= 100
                and _finite(look["brightness"], -.3, .3) and _finite(look["contrast"], .5, 1.8)
                and _finite(look["saturation"], 0, 2) and _finite(look["sharpen"], 0, 2) and type(look["vignette"]) is bool):
            raise ValueError("Invalid look")
        looks.append(dict(look))
    effects["looks"] = looks
    return effects


def _enable(intervals) -> str:
    return "+".join(f"between(t,{a / 1000:.3f},{b / 1000:.3f})" for a, b in intervals)


def look_filters(looks, window_start_ms: int, time_map) -> str:
    """Comma-separated filters grading the composed picture, or "" (edited clock, before speed)."""
    from clip_engine.services.text_overlays import output_intervals
    filters = []
    for look in looks:
        intervals = [(a, b) for a, b, _ in output_intervals(look["start_ms"], look["end_ms"], window_start_ms, time_map)]
        if not intervals:
            continue
        enable = f":enable='{_enable(intervals)}'"
        b, c, s = look["brightness"], look["contrast"], look["saturation"]
        if b or c != 1 or s != 1:
            filters.append(
                f"lutyuv=y='clip((val-maxval/2)*{c:.4g}+maxval/2+{b:.4g}*maxval,minval,maxval)'"
                f":u='clip((val-maxval/2)*{s:.4g}+maxval/2,minval,maxval)'"
                f":v='clip((val-maxval/2)*{s:.4g}+maxval/2,minval,maxval)'{enable}")
        if look["sharpen"] > 0:
            filters.append(f"unsharp=lx=5:ly=5:la={look['sharpen']:.4g}:cx=5:cy=5:ca=0{enable}")
        if look["vignette"]:
            filters.append(f"vignette=angle=PI/5{enable}")
    return ",".join(filters)


def picture_filters(effects: dict, keeps: list[tuple[int, int]], speed: float, output_ms: int,
                    fade_in: bool = True, fade_out: bool = True) -> str:
    """Fades and cut transitions on the final clock (after speed), or ""."""
    filters = []
    total = output_ms / speed / 1000
    if fade_in and effects["fade_in_ms"]:
        filters.append(f"fade=t=in:st=0:d={min(effects['fade_in_ms'] / 1000, total / 2):.3f}")
    if fade_out and effects["fade_out_ms"]:
        d = min(effects["fade_out_ms"] / 1000, total / 2)
        filters.append(f"fade=t=out:st={max(0, total - d):.3f}:d={d:.3f}")
    if effects["transition"] != "none" and len(keeps) > 1:
        color = "white" if effects["transition"] == "flash" else "black"
        half = effects["transition_ms"] / 2000
        offset = 0
        for start, end in keeps[:-1]:
            offset += end - start
            cut = offset / speed / 1000
            d = min(half, cut, total - cut)
            if d <= 0:
                continue
            filters.append(f"fade=t=out:st={cut - d:.3f}:d={d:.3f}:color={color}:enable='between(t,{cut - d:.3f},{cut:.3f})'")
            filters.append(f"fade=t=in:st={cut:.3f}:d={d:.3f}:color={color}:enable='between(t,{cut:.3f},{cut + d:.3f})'")
    return ",".join(filters)


def audio_fade_filters(effects: dict, speed: float, edited_ms: int, fade_in: bool = True, fade_out: bool = True) -> str:
    """afade on the edited clock before speed (durations scaled so they last as asked), or ""."""
    filters = []
    total = edited_ms / 1000
    if fade_in and effects["fade_in_ms"]:
        filters.append(f"afade=t=in:st=0:d={min(effects['fade_in_ms'] * speed / 1000, total / 2):.3f}")
    if fade_out and effects["fade_out_ms"]:
        d = min(effects["fade_out_ms"] * speed / 1000, total / 2)
        filters.append(f"afade=t=out:st={max(0, total - d):.3f}:d={d:.3f}")
    return ",".join(filters)


def describe(effects: Optional[dict]) -> bool:
    """Whether the effects change anything."""
    return bool(effects) and bool(effects["fade_in_ms"] or effects["fade_out_ms"] or effects["transition"] != "none" or effects["looks"])
