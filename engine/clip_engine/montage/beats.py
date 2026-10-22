"""Beat grid of a music track, for cutting on the beat. Local, numpy only."""
import math
import tempfile
from pathlib import Path

import numpy as np

from clip_engine.services.media_process import run_media

RATE = 11025
HOP = 256


def onset_envelope(samples: np.ndarray) -> np.ndarray:
    frames = len(samples) // HOP
    if frames < 8:
        return np.zeros(0)
    energy = np.sqrt(np.mean(samples[:frames * HOP].reshape(frames, HOP) ** 2, axis=1))
    log = np.log1p(100 * energy)
    flux = np.maximum(0, np.diff(log, prepend=log[0]))
    return flux - np.convolve(flux, np.ones(16) / 16, mode='same')


def beat_times(samples: np.ndarray, rate: int = RATE, min_bpm=70, max_bpm=180) -> tuple[float, list[int]]:
    """(tempo in BPM, beat times in ms) from mono samples; (0, []) when there is no clear pulse."""
    env = onset_envelope(samples)
    if len(env) < 64 or not np.any(env > 0):
        return 0.0, []
    fps = rate / HOP
    lo, hi = int(fps * 60 / max_bpm), int(fps * 60 / min_bpm) + 1
    centered = env - env.mean()
    corr = np.correlate(centered, centered, mode='full')[len(centered) - 1:]
    if hi >= len(corr) or corr[0] <= 0:
        return 0.0, []
    lags = np.arange(lo, hi)
    period = lags[np.argmax(corr[lo:hi])]
    if corr[period] / corr[0] < .05:
        return 0.0, []
    # Refine to a fractional period, with the phase that lands the grid on the strongest onsets.
    best = (-np.inf, float(period), 0.0)
    for candidate in np.arange(period - 1, period + 1.001, .02):
        for phase in np.arange(0, candidate, .5):
            idx = np.round(np.arange(phase, len(env) - 1, candidate)).astype(int)
            score = env[idx].sum()
            if score > best[0]:
                best = (score, float(candidate), float(phase))
    _, period_f, phase = best
    beats = [round((phase + k * period_f) / fps * 1000) for k in range(math.ceil((len(env) - phase) / period_f))]
    return round(60 * fps / period_f, 1), beats


def music_beats(path) -> tuple[float, list[int]]:
    with tempfile.TemporaryDirectory(prefix='bridgeclip-beats-') as work:
        raw = Path(work) / 'music.raw'
        run_media(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe,fd', '-format_whitelist', 'mov',
                   '-i', str(path), '-map', '0:a:0', '-ac', '1', '-ar', str(RATE), '-t', '600', '-f', 's16le', str(raw)], timeout=300, check=True)
        samples = np.fromfile(raw, dtype='<i2').astype(np.float32) / 32768
    return beat_times(samples)


def snap_cuts(pieces: list[dict], beats: list[int], offset_ms: int, limits: list[tuple[int, int]], window_ms=600, min_ms=800) -> list[dict]:
    """Move each cut (a piece's end) onto the nearest beat of the final clock.

    `offset_ms` is where the music starts in the track; `limits` gives each
    piece's (earliest, latest) allowed end in its rush. Cuts that cannot reach
    a beat within `window_ms` (more than one beat apart at 100+ BPM) stay where they are.
    """
    if not beats:
        return pieces
    grid = np.array(beats) - offset_ms
    out, clock = [], 0
    for piece, (earliest, latest) in zip(pieces, limits):
        piece = dict(piece)
        length = piece['end_ms'] - piece['start_ms']
        cut = clock + length
        # The nearest beat this piece can reach: lengthen into its handle or shorten, within the window.
        for delta in sorted((int(b) - cut for b in grid[np.abs(grid - cut) <= window_ms]), key=abs):
            end = piece['end_ms'] + delta
            if max(earliest, piece['start_ms'] + min_ms) <= end <= latest:
                piece['end_ms'] = end
                break
        clock += piece['end_ms'] - piece['start_ms']
        out.append(piece)
    return out
