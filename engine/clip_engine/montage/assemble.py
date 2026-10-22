"""Turn a montage plan into an ordinary editor project.

Every planned piece is rendered from its rush (with a 1.5 s handle on each
side) to one normalized format: same canvas, 30 fps, 48 kHz stereo. The
pieces are concatenated into `editor-source.mp4`, and each planned video
becomes an editor candidate whose cuts are its pieces. From there, the
existing editor (timeline, captions, text, effects, audio, reframing, exact
preview, export) works unchanged, and so does switching to manual editing.
"""
import asyncio
import json
import logging
import math
import os
import shutil
import time
from pathlib import Path

from clip_engine.montage import planner as planning
from clip_engine.montage.analyze import AnalysisError, load_analysis
from clip_engine.services.media_process import MEDIA_INPUT_OPTIONS, run_media

logger = logging.getLogger(__name__)

HANDLE_MS = 1500
FPS = 30
HOOK_MS = 2800

# Each style in terms of the editor's existing settings.
STYLE_SETTINGS = {
    'viral': {'caption_preset': 'viral_bold', 'effects': {'transition': 'flash', 'transition_ms': 240}, 'punch_in': True, 'music_db': -16},
    'gaming': {'caption_preset': 'gaming', 'effects': {'transition': 'flash', 'transition_ms': 200}, 'look': {'contrast': 1.1, 'saturation': 1.18}, 'punch_in': True, 'music_db': -16},
    'cinematic': {'caption_preset': 'cinematic', 'effects': {'transition': 'dip', 'transition_ms': 600, 'fade_in_ms': 400, 'fade_out_ms': 800},
                  'look': {'contrast': 1.08, 'saturation': .9, 'vignette': True}, 'music_db': -14},
    'vlog': {'caption_preset': 'pop', 'effects': {'fade_in_ms': 200, 'fade_out_ms': 400}, 'music_db': -20},
    'podcast': {'caption_preset': 'hormozi', 'effects': {}, 'framing': 'auto', 'music_db': -24},
    'compilation': {'caption_preset': 'viral_bold', 'effects': {'transition': 'dip', 'transition_ms': 300}, 'music_db': -16},
    'minimal': {'caption_preset': 'minimal_clean', 'effects': {}, 'music_db': -20},
}


def _even(n):
    return max(2, int(round(n / 2)) * 2)


def choose_canvas(pieces_info: list[tuple[int, int, int]], aspect: str) -> tuple[int, int]:
    """(width, height) of the assembly from the pieces' (width, height, duration)."""
    portrait = sum(d for w, h, d in pieces_info if h > w)
    landscape = sum(d for w, h, d in pieces_info if h <= w)
    vertical = aspect == '9:16' and portrait >= landscape
    short_side = max((min(w, h) for w, h, _ in pieces_info), default=1080)
    scale = min(1.0, short_side / 1080)
    return (_even(1080 * scale), _even(1920 * scale)) if vertical else (_even(1920 * scale), _even(1080 * scale))


def piece_filter(src_w: int, src_h: int, w: int, h: int) -> str:
    """Video graph for one piece: scaled to the canvas, or whole over a blurred fill when its shape differs."""
    # tpad: a rush that ends a frame early still fills the piece, so every piece has exactly its frame count.
    if abs(src_w / src_h - w / h) < .02:
        return f'[0:v:0]fps={FPS},scale={w}:{h},setsar=1,tpad=stop_mode=clone:stop_duration=1,format=yuv420p[v]'
    return (f'[0:v:0]fps={FPS},split[a][b];[a]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},'
            f'gblur=sigma=24,lutyuv=y=val*0.7[bg];[b]scale={w}:{h}:force_original_aspect_ratio=decrease[fg];'
            f'[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,tpad=stop_mode=clone:stop_duration=1,format=yuv420p[v]')


async def render_piece(renderer, rush: Path, info: dict, start_ms: int, end_ms: int, canvas, out: Path) -> int:
    """Render [start, end) of a rush as an MKV piece (PCM audio, no encoder delay). Returns its exact length in ms."""
    w, h = canvas
    frames = max(1, round((end_ms - start_ms) * FPS / 1000))
    seconds = frames / FPS
    cmd = ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f'{start_ms / 1000:.3f}', '-t', f'{seconds + .5:.3f}', *MEDIA_INPUT_OPTIONS, '-i', str(rush)]
    if not info['has_audio']:
        cmd += ['-f', 'lavfi', '-t', f'{seconds:.6f}', '-i', 'anullsrc=r=48000:cl=stereo']
    audio = '[0:a:0]' if info['has_audio'] else '[1:a:0]'
    graph = (piece_filter(info['width'], info['height'], w, h) +
             f';{audio}aresample=48000:async=1:first_pts=0,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo,apad,atrim=end={seconds:.6f}[a]')
    cmd += ['-filter_complex', graph, '-map', '[v]', '-map', '[a]', '-frames:v', str(frames),
            *renderer._video_codec_args(w, h, str(FPS)), '-pix_fmt', 'yuv420p', '-r', str(FPS), '-c:a', 'pcm_s16le', str(out)]
    await asyncio.to_thread(run_media, cmd, timeout=30 * 60, check=True)
    return round(frames * 1000 / FPS)


def map_transcript(rows: list[dict], rush_start: int, rush_end: int, offset: int, core: tuple[int, int]) -> list[dict]:
    """The rush's words inside one piece, on the assembly clock, as TranscriptSegment rows."""
    out = []
    for row in rows:
        words = [w for w in row['words'] if w[0] >= rush_start and w[1] <= rush_end and core[0] - 400 <= w[0] < core[1] + 400]
        if not words:
            continue
        mapped = [{'word': w[2], 'start_time_ms': offset + w[0] - rush_start, 'end_time_ms': offset + w[1] - rush_start} for w in words]
        out.append({'start_time_ms': mapped[0]['start_time_ms'], 'end_time_ms': mapped[-1]['end_time_ms'],
                    'text': ' '.join(w['word'] for w in mapped), 'words': mapped})
    return out


def source_time_after(ranges, output_ms: int) -> int:
    """Source (assembly) time reached after `output_ms` of the edited clip."""
    left = output_ms
    for a, b in ranges:
        if b - a >= left:
            return round(a + left)
        left -= b - a
    return ranges[-1][1]


def zoom_crop(crop, factor):
    x, y, w, h = crop
    nw, nh = w / factor, h / factor
    return [round(x + (w - nw) / 2, 5), round(y + (h - nh) / 2, 5), round(nw, 5), round(nh, 5)]


def punch_ins(scenes, ranges, limit=60):
    """Alternate a 1.25× zoom on every other cut of a static full-frame layout."""
    if len(scenes) != 1 or scenes[0]['layout'] != 'fill' or len(ranges) < 2:
        return scenes
    base = scenes[0]['crops'][0]
    out = [dict(scenes[0])]
    for i, (a, _) in enumerate(ranges[1:], start=1):
        if len(out) >= limit:
            break
        crops = [zoom_crop(base, 1.25)] if i % 2 else [base]
        if a > out[-1]['at_ms'] and crops != out[-1]['crops']:
            out.append({'at_ms': a, 'layout': 'fill', 'crops': crops})
    return out


async def framing(source: Path, span, canvas, aspect: str, smart: bool, mode: str) -> list[dict]:
    """Layouts for one candidate: full frame when the canvas already has the output shape, else reframed."""
    from clip_engine.services.reframe import follow_crop
    w, h = canvas
    target = 9 / 16 if aspect == '9:16' else 16 / 9
    if abs(w / h - target) < .02:
        return [{'at_ms': 0, 'layout': 'fill', 'crops': [[0, 0, 1, 1]]}]
    if w / h < target:
        # A vertical assembly in a horizontal output: the whole picture over its blurred fill.
        return [{'at_ms': 0, 'layout': 'fit', 'crops': [follow_crop(.5, .5, w, h, target)]}]
    if smart:
        try:
            from clip_engine.config import LayoutStyle
            from clip_engine.services.layout_analyzer import LayoutAnalyzer
            from clip_engine.services.reframe import reframe_scenes
            analyzer = LayoutAnalyzer()
            if analyzer.available:
                try:
                    plan = await analyzer.analyze(str(source), span[0], span[1] - span[0], w, h,
                                                  style=LayoutStyle.AUTO if mode == 'auto' else LayoutStyle.FILL, vision=False, precise=False)
                finally:
                    await analyzer.close()
                if plan is not None:
                    return reframe_scenes(plan, span[0], span[1], w, h, target)
        except Exception as error:
            logger.warning('Montage reframing failed: %s', type(error).__name__)
    return [{'at_ms': 0, 'layout': 'fill', 'crops': [follow_crop(.5, .5, w, h, target)]}]


def read_library(root: Path) -> dict[str, dict]:
    try:
        data = json.loads((root / 'library.json').read_text(encoding='utf8'))
        return {r['id']: r for r in data.get('rushes', []) if isinstance(r, dict) and isinstance(r.get('id'), str)}
    except (OSError, ValueError):
        return {}


async def generate(root: Path, run: Path, request: dict, music_input: str | None = None, progress=None) -> dict:
    """Plan, assemble and save one Auto Montage run as an editor project. Returns the plan summary."""
    from clip_engine.config import get_settings
    from clip_engine.montage.beats import music_beats, snap_cuts
    from clip_engine.services.effects import validate_effects
    from clip_engine.services.manual_editor import atomic_json, import_music, music_length, transcript_row, validate_candidate
    from clip_engine.services.reframe import MAX_SCENES
    from clip_engine.services.rendering_service import RenderingService
    began = time.monotonic()
    settings = get_settings()
    report = (lambda phase, percent: progress({'phase': phase, 'percent': round(percent)})) if progress else (lambda *_: None)
    request = planning.validate_request(request)
    library = read_library(root)
    ids = request['rush_ids'] or [i for i, r in library.items() if r.get('status') == 'ready']
    analyses, infos = [], {}
    for rush_id in ids:
        try:
            analysis = load_analysis(root, rush_id)
        except (OSError, ValueError, AnalysisError):
            continue
        name = str(library.get(rush_id, {}).get('name') or rush_id)[:120]
        analyses.append((rush_id, name, analysis))
        infos[rush_id] = {**analysis['info'], 'transcript': analysis['transcript'], 'name': name}
    if not analyses:
        raise planning.PlanError('invalid_edit', 'Analyze some rushes first')
    report('plan', 2)
    plan = await planning.plan(settings, request, analyses)
    videos = [v for v in plan['videos'] if v['segments']]
    if not videos:
        raise planning.PlanError('invalid_edit', 'No usable moments were found')

    music = None
    if music_input:
        report('music', 10)
        music_id = os.urandom(16).hex()
        await import_music(run, music_input, music_id)
        file = run / f'editor-music-{music_id}.mp4'
        music = {'file': file.name, 'name': Path(music_input).name[:200] or 'Music', 'ms': await asyncio.to_thread(music_length, file), 'beats': []}
        if request['beat_sync']:
            try:
                tempo, music['beats'] = await asyncio.to_thread(music_beats, file)
                music['tempo'] = tempo
            except Exception:
                plan['notes'].append('Could not find the beat of the music; cuts are not aligned to it.')
        if music['beats']:
            for v in videos:
                limits = [(p['start_ms'] + planning.MIN_PIECE_MS, infos[p['rush_id']]['duration_ms']) for p in v['segments']]
                v['segments'] = snap_cuts(v['segments'], music['beats'], 0, limits)

    canvas = choose_canvas([(infos[p['rush_id']]['width'], infos[p['rush_id']]['height'], p['end_ms'] - p['start_ms'])
                            for v in videos for p in v['segments']], request['aspect'])
    renderer = RenderingService()
    work = run / '.montage-pieces'
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    jobs = []
    for vi, v in enumerate(videos):
        for pi, p in enumerate(v['segments']):
            info = infos[p['rush_id']]
            rush_start, rush_end = max(0, p['start_ms'] - HANDLE_MS), min(info['duration_ms'], p['end_ms'] + HANDLE_MS)
            jobs.append({'video': vi, 'piece': p, 'rush_start': rush_start, 'rush_end': rush_end, 'file': work / f'v{vi:03d}_p{pi:02d}.mkv'})
    from clip_engine.montage.analyze import paths as rush_paths
    done = 0
    semaphore = asyncio.Semaphore(2)

    async def render(job):
        nonlocal done
        async with semaphore:
            info = infos[job['piece']['rush_id']]
            job['length'] = await render_piece(renderer, rush_paths(root, job['piece']['rush_id'])['media'], info,
                                               job['rush_start'], job['rush_end'], canvas, job['file'])
            done += 1
            report('pieces', 12 + 58 * done / len(jobs))
    await asyncio.gather(*(render(j) for j in jobs))

    report('concat', 72)
    (work / 'list.txt').write_text(''.join(f"file '{j['file'].name}'\n" for j in jobs), encoding='utf8')
    source = run / 'editor-source.mp4'
    await asyncio.to_thread(run_media, ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(work / 'list.txt'),
        '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', str(source)],
        timeout=60 * 60, check=True)
    shutil.rmtree(work, ignore_errors=True)
    duration = sum(j['length'] for j in jobs)

    # Cuts, words and layouts on the assembly clock.
    transcript, offset = [], 0
    for j in jobs:
        p = j['piece']
        j['offset'] = offset
        j['core'] = (offset + p['start_ms'] - j['rush_start'], min(offset + j['length'], offset + p['end_ms'] - j['rush_start']))
        transcript += map_transcript(infos[p['rush_id']]['transcript'], j['rush_start'], j['rush_end'], offset, (p['start_ms'], p['end_ms']))
        offset += j['length']
    transcript.sort(key=lambda r: r['start_time_ms'])
    atomic_json(run / 'transcript.json', {'segments': transcript})

    report('preview', 75)
    preview = run / 'editor-preview.mp4'
    await renderer.capture_framing_source(str(source), str(preview), duration_ms=duration,
                                          progress=lambda percent: report('preview', 75 + 10 * max(0, min(100, percent)) / 100))

    style = STYLE_SETTINGS[request['style']]
    candidates = []
    for vi, v in enumerate(videos):
        pieces = [j for j in jobs if j['video'] == vi]
        ranges = [[round(j['core'][0]), round(j['core'][1])] for j in pieces if j['core'][1] - j['core'][0] >= 100]
        span = (ranges[0][0], ranges[-1][1])
        report('framing', 85 + 13 * vi / len(videos))
        scenes = await framing(source, span, canvas, request['aspect'], request['smart_framing'], style.get('framing', 'face'))
        if style.get('punch_in'):
            scenes = punch_ins(scenes, ranges, MAX_SCENES)
        effects = {**style['effects']}
        if style.get('look'):
            effects['looks'] = [{'start_ms': span[0], 'end_ms': span[1], 'brightness': 0, 'contrast': 1.0, 'saturation': 1.0, 'sharpen': 0,
                                 'vignette': False, **style['look']}]
        effects = validate_effects(effects, duration)
        speech = any(r['start_time_ms'] < b and r['end_time_ms'] > a for r in transcript for a, b in ranges)
        candidate = {'id': f'montage-{vi + 1:02d}', 'title': v['title'][:200] or f'Clip {vi + 1}', 'ranges': ranges, 'scenes': scenes,
            'captions': request['captions'] and speech, 'caption_preset': style['caption_preset'], 'video_speed': 1,
            'status': 'ready' if request['auto_export'] else 'refining', 'caption_edits': [], 'caption_suppression_ranges': [],
            'score': max(0, min(100, round(sum(next((s['score'] for a in analyses if a[0] == p['rush_id'] for s in a[2]['segments'] if s['id'] == p['id']), 0)
                                            for p in v['segments']) / max(1, len(v['segments'])), 3))),
            'reason': ' '.join(plan['notes'])[:4000], 'requires_visual_context': False, 'review': None, 'exports': [], 'title_card': False}
        if any(effects[k] for k in ('fade_in_ms', 'fade_out_ms', 'looks')) or effects['transition'] != 'none':
            candidate['effects'] = effects
        if request['hook'] and v['hook_text']:
            candidate['text_overlays'] = [{'text': v['hook_text'][:120], 'start_ms': span[0], 'end_ms': max(span[0] + 100, source_time_after(ranges, HOOK_MS)),
                'x': .5, 'y': .18, 'size': 84, 'font': 'Montserrat Black', 'color': '#111111', 'outline_color': '#000000', 'outline': 0,
                'background': '#FFE234', 'background_opacity': 1, 'uppercase': True, 'animation': 'pop'}]
        if music:
            candidate['audio'] = {'volume_db': 0, 'mute': False, 'normalize': True, 'music': {'file': music['file'], 'name': music['name'],
                'volume_db': style.get('music_db', -18), 'offset_ms': 0, 'duck': True, 'duck_db': -12, 'fade_in_ms': 300, 'fade_out_ms': 1200}}
        validate_candidate(candidate, duration, len(transcript))
        candidates.append(candidate)

    report('save', 98)
    rows = [transcript_row(r['start_time_ms'], r['end_time_ms'], r['text'], [(w['start_time_ms'], w['end_time_ms']) for w in r['words']], duration) for r in transcript]
    title = videos[0]['title'] if len(videos) == 1 else f'Auto montage: {len(videos)} clips'
    project = {'version': 1, 'revision': 0, 'title': title[:1024], 'width': canvas[0], 'height': canvas[1], 'duration_ms': duration,
               'aspect_ratio': request['aspect'], 'candidates': candidates, 'transcript': rows, 'frame_preview': True}
    summary = {'planner': plan['planner'], 'notes': plan['notes'], 'videos': len(candidates), 'rushes': len({p['rush_id'] for v in videos for p in v['segments']}),
               'segments_considered': plan['segments_considered'], 'cost_usd': plan.get('cost_usd'), 'canvas': list(canvas),
               'tempo': music.get('tempo') if music else None, 'seconds': round(time.monotonic() - began, 1)}
    atomic_json(run / 'montage-plan.json', {**summary, 'request': request, 'plan': videos})
    atomic_json(run / 'editor-project.json', project)
    atomic_json(run / 'job_output.json', {'job_id': run.name, 'source_video_url': 'bridgeclip://auto-montage', 'source_video_title': title,
        'source_video_duration_seconds': duration / 1000, 'clips': [], 'total_clips': 0, 'editor_project': True,
        'processing_time_seconds': summary['seconds'],
        'metrics': {'planned_clip_count': len(candidates), 'captions_status': 'enabled' if request['captions'] else 'disabled_by_request',
                    'requested_settings': {'aspect_ratio': request['aspect'], 'caption_preset': style['caption_preset'], 'video_speed': 1}}})
    report('done', 100)
    return summary
