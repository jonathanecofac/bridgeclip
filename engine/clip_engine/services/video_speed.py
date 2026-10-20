"""Export speed on the edited timeline; source analysis stays at original speed."""

import math


def validate_video_speed(speed: float, minimum: float = .5) -> float:
    # Below 1x is slow motion, offered by the editor; atempo and setpts both
    # support 0.5x. Automatic clipping keeps its 1x-2x range (minimum=1).
    if type(speed) not in (int, float) or not math.isfinite(speed) or not minimum <= speed <= 2:
        raise ValueError(f"Video speed must be between {minimum:g}x and 2x")
    return speed


def scaled_duration_ms(duration_ms: int, speed: float) -> int:
    return round(duration_ms / validate_video_speed(speed))


def speed_video_filter(speed: float, fps: str, output_ms: int | None = None) -> str:
    validate_video_speed(speed)
    if speed == 1:
        return "null"
    # Use a fine time base before scaling, then return to the export frame grid.
    graph = f"settb=AVTB,setpts=(PTS-STARTPTS)/{speed:.8g},fps={fps}:start_time=0:round=near"
    if speed < 1 and output_ms:
        # Slowed down, the last source frame must also fill the time after its
        # timestamp; fps stops at that timestamp, leaving the end short.
        graph += f",tpad=stop_mode=clone:stop_duration=1,trim=duration={output_ms / 1000:.6f}"
    return graph


def speed_audio_filter(speed: float, duration_ms: int) -> str:
    validate_video_speed(speed)
    if speed == 1:
        return ""
    # atempo preserves pitch. Its overlap windows can leave a short tail;
    # bound/pad samples to the requested duration before rebuilding the clock.
    samples = round(duration_ms * 48 / speed)
    return f"atempo={speed:.8g},apad=whole_len={samples},atrim=end_sample={samples},"
