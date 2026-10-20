"""Text overlays and hooks for editor exports, burned as ASS after captions.

Overlays are placed in source time and positioned as fractions of the output
frame. Each one follows the edit: it is drawn only on kept footage, moved to
the edited clock with the same TimeMap as captions, and sped up with the rest
of the picture afterwards.
"""
import math
import os
import re
from typing import Optional

from clip_engine.config import CAPTION_FONTS

MAX_OVERLAYS = 20
_HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
ANIMATIONS = ("none", "fade", "pop")
FADE_MS = 200
POP_TAGS = r"\fscx70\fscy70\t(0,120,\fscx108\fscy108)\t(120,220,\fscx100\fscy100)"


def _finite(value, lo, hi):
    return type(value) in (int, float) and math.isfinite(value) and lo <= value <= hi


def validate_text_overlays(value, duration_ms):
    """A clean list of overlays; raises ValueError for anything malformed."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_OVERLAYS:
        raise ValueError("Invalid text overlays")
    clean = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("Invalid text overlay")
        text = item.get("text")
        if (not isinstance(text, str) or not text.strip() or len(text) > 200 or text.count("\n") > 3
                or any(ord(c) < 32 and c != "\n" for c in text)):
            raise ValueError("Invalid text overlay text")
        checks = (
            _finite(item.get("start_ms"), 0, duration_ms) and _finite(item.get("end_ms"), 0, duration_ms)
            and item["end_ms"] - item["start_ms"] >= 100
            and _finite(item.get("x"), .05, .95) and _finite(item.get("y"), .05, .95)
            and type(item.get("size")) is int and 20 <= item["size"] <= 240
            and item.get("font") in CAPTION_FONTS
            and isinstance(item.get("color"), str) and bool(_HEX.match(item["color"]))
            and isinstance(item.get("outline_color"), str) and bool(_HEX.match(item["outline_color"]))
            and type(item.get("outline")) is int and 0 <= item["outline"] <= 20
            and (item.get("background") is None or (isinstance(item.get("background"), str) and bool(_HEX.match(item["background"]))))
            and _finite(item.get("background_opacity"), 0, 1)
            and type(item.get("uppercase")) is bool
            and item.get("animation") in ANIMATIONS
        )
        if not checks:
            raise ValueError("Invalid text overlay settings")
        clean.append({key: item[key] for key in ("text", "start_ms", "end_ms", "x", "y", "size", "font", "color",
                                                  "outline_color", "outline", "background", "background_opacity",
                                                  "uppercase", "animation")})
    return clean


def plate_padding(size: int) -> int:
    """Space between the text and its plate's edges, in output pixels."""
    return max(6, round(size * .22))


def _ass_color(hex_color: str) -> str:
    return f"&H00{hex_color[5:7]}{hex_color[3:5]}{hex_color[1:3]}".upper()


def _alpha(opacity: float) -> str:
    return f"&H{round(255 * (1 - max(0.0, min(1.0, opacity)))):02X}&"


def _time(ms: int) -> str:
    ms = max(0, int(round(ms)))
    return f"{ms // 3600000}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}.{ms // 10 % 100:02d}"


def _text(overlay) -> str:
    lines = [" ".join(line.split()).replace("{", "").replace("}", "").replace("\\", "") for line in overlay["text"].split("\n")]
    text = "\\N".join(line for line in lines if line)
    return text.upper() if overlay["uppercase"] else text


def output_intervals(start_ms: int, end_ms: int, window_start_ms: int, time_map) -> list[tuple[int, int, bool]]:
    """Edited-clock intervals where a source interval is on screen, joined across cuts.

    The flag says whether the interval begins at the overlay's own start
    (so entrance animations play only there, not where a cut resumes it).
    """
    pieces = []
    a, b = start_ms - window_start_ms, end_ms - window_start_ms
    for (keep_start, keep_end), offset in zip(time_map.keeps, time_map._offsets):
        lo, hi = max(a, keep_start), min(b, keep_end)
        if hi <= lo:
            continue
        out_start, out_end = offset + lo - keep_start, offset + hi - keep_start
        if pieces and out_start - pieces[-1][1] <= 2:
            pieces[-1] = (pieces[-1][0], out_end, pieces[-1][2])
        else:
            pieces.append((out_start, out_end, lo == a))
    return pieces


def write_text_overlays(overlays, window_start_ms: int, time_map, out_w: int, out_h: int, path: str) -> Optional[str]:
    """ASS file for the overlays on the edited clock, or None when none are on screen."""
    events = []
    for overlay in overlays:
        x, y = round(overlay["x"] * out_w), round(overlay["y"] * out_h)
        italic = "\\i1" if overlay["font"] == "Instrument Serif Italic" else ""
        face = (f"\\fn{overlay['font']}\\fs{overlay['size']}\\1c{_ass_color(overlay['color'])}\\1a&H00&"
                f"\\3c{_ass_color(overlay['outline_color'])}\\bord{overlay['outline']}\\shad0{italic}")
        plate = None
        if overlay["background"]:
            # BorderStyle 3 (style "Plate"): one opaque rectangle per line, in the outline color.
            plate = (f"\\fn{overlay['font']}\\fs{overlay['size']}\\1a&HFF&\\3a{_alpha(overlay['background_opacity'])}"
                     f"\\3c{_ass_color(overlay['background'])}\\bord{plate_padding(overlay['size'])}\\shad0{italic}")
        text = _text(overlay)
        for start, end, at_start in output_intervals(overlay["start_ms"], overlay["end_ms"], window_start_ms, time_map):
            span = end - start
            lead = f"\\an5\\pos({x},{y})"
            if overlay["animation"] == "fade":
                fade_in = min(FADE_MS, span // 2) if at_start else 0
                lead += f"\\fad({fade_in},{min(FADE_MS, span // 2)})"
            elif overlay["animation"] == "pop" and at_start:
                lead += POP_TAGS
            layers = ([(0, "Plate", plate)] if plate else []) + [(1, "Text", face)]
            for layer, style, tags in layers:
                events.append(f"Dialogue: {layer},{_time(start)},{_time(end)},{style},,0,0,0,,{{{lead}{tags}}}{text}")
    if not events:
        return None
    header = (
        "[Script Info]\nTitle: BridgeClip Text\nScriptType: v4.00+\n"
        f"PlayResX: {out_w}\nPlayResY: {out_h}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        "Style: Text,Montserrat Black,80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1\n"
        "Style: Plate,Montserrat Black,80,&HFF000000,&HFF000000,&H00000000,&HFF000000,0,0,0,0,100,100,0,0,3,0,0,5,0,0,0,1\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(header + "\n".join(events) + "\n")
    return path
