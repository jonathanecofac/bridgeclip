"""Review-first projects: suggestions and Jev advice, then exact human-directed exports."""
import asyncio
import json
import math
import os
import re
import tempfile
from contextlib import contextmanager
from uuid import uuid4
from datetime import datetime, timezone
from dataclasses import replace
from pathlib import Path
from clip_engine.error_policy import NoClipCandidatesError

from clip_engine.services.coherence_review import CLIP_QUESTIONS, CUT_QUESTIONS, CoherenceReviewer, check_threshold, dialogue
from clip_engine.services.jev_service import JevService
from clip_engine.services.layout_analyzer import ClipLayoutPlan, ShotLayout, LayoutType
from clip_engine.services.layout_renderer import shot_views
from clip_engine.services.rendering_service import RenderRequest, RenderingService
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord
from clip_engine.services.media_process import MEDIA_INPUT_OPTIONS, PROBE_TIMEOUT_SECONDS, run_media, validate_video_dimensions


# Fixed failure codes; the only failure detail that crosses the bridge.
EDITOR_ERROR_CODES = frozenset({'duration', 'geometry', 'audio', 'invalid', 'project_changed', 'invalid_edit', 'not_ready',
    'source_missing', 'source_incompatible', 'render_failed', 'scan_too_long', 'review_unavailable', 'engine_unavailable'})


class EditorError(ValueError):
    def __init__(self, code, message=None):
        self.editor_code = code
        super().__init__(message or code)


class SourceReplacementError(EditorError):
    def __init__(self, code):
        self.code = code
        super().__init__(code, 'Source replacement rejected')


@contextmanager
def failure_code(code):
    """Label failures without changing their type or message."""
    try:
        yield
    except Exception as error:
        if getattr(error, 'editor_code', None) not in EDITOR_ERROR_CODES:
            try:
                error.editor_code = code
            except AttributeError:
                pass
        raise


def utf16_prefix(text, limit):
    """At most `limit` UTF-16 units (the editor UI's string length), never half a surrogate pair."""
    units = 0
    for i, char in enumerate(text):
        units += 2 if ord(char) > 0xFFFF else 1
        if units > limit:
            return text[:i]
    return text


def media_name(kind, source_id=None):
    if source_id is not None and (not isinstance(source_id, str) or not re.fullmatch(r'[a-f0-9]{32}', source_id)):
        raise ValueError('Invalid source generation')
    return f'editor-{kind}{"-" + source_id if source_id else ""}.mp4'


def source_info(path):
    try:
        result = run_media(['ffprobe', '-v', 'error', *MEDIA_INPUT_OPTIONS, '-show_streams', '-show_format',
                            '-of', 'json', str(path)], timeout=PROBE_TIMEOUT_SECONDS, check=True)
        data = json.loads(result.stdout)
        video = next(s for s in data['streams'] if s['codec_type'] == 'video')
        width, height = int(video['width']), int(video['height'])
        validate_video_dimensions(width, height)
        if min(width, height) < 2:
            raise ValueError('Invalid editor dimensions')
        duration = float(video.get('duration', data['format'].get('duration', 0))) * 1000
        if not math.isfinite(duration) or duration < 100:
            raise ValueError('Invalid duration')
        rotation = next((s['rotation'] for s in video.get('side_data_list', []) if 'rotation' in s), 0)
        return {'width': width, 'height': height, 'duration': duration, 'rotation': rotation,
                'sar': video.get('sample_aspect_ratio') if video.get('sample_aspect_ratio') not in (None, 'N/A', '0:1') else '1:1',
                'audio': any(s['codec_type'] == 'audio' for s in data['streams'])}
    except Exception as error:
        raise SourceReplacementError('invalid') from error


async def replace_source(run, project, source_id):
    """Prepare immutable media, then switch the project's pointer in one atomic write."""
    source = local_file(run, media_name('source', source_id))
    original = local_file(run, media_name('source', project.get('source_id')))
    old, new = await asyncio.gather(asyncio.to_thread(source_info, original), asyncio.to_thread(source_info, source))
    if abs(old['duration'] - new['duration']) > 100:
        raise SourceReplacementError('duration')
    if (abs((new['width'] / new['height']) / (project['width'] / project['height']) - 1) > .005
            or old['rotation'] != new['rotation'] or old['sar'] != new['sar']):
        raise SourceReplacementError('geometry')
    if old['audio'] != new['audio']:
        raise SourceReplacementError('audio')
    preview = run / media_name('preview', source_id)
    if preview.exists() or preview.is_symlink():
        raise ValueError('Replacement preview already exists')
    with failure_code('render_failed'):
        await RenderingService().capture_framing_source(str(source), str(preview))
    # Recheck immediately before committing. Failed/cancelled generation never touches the project.
    if read_json(run, 'editor-project.json')['revision'] != project['revision']:
        raise EditorError('project_changed', 'Editor project changed')
    project.pop('preview_id', None)
    project['frame_preview'] = True
    project.update(source_id=source_id, width=new['width'], height=new['height'], revision=project['revision'] + 1)
    for candidate in project['candidates']:
        candidate.pop('camera_scan', None)
        candidate.pop('dismissed_camera_markers', None)
        candidate.pop('baked_hash', None)  # Earlier bakes used the previous source.
        if candidate.get('status') == 'baked':
            candidate['status'] = 'ready'
    atomic_json(run / 'editor-project.json', project)


def signature(c):
    # Canonical comparison is parsed JSON in the UI (Python keeps .0 floats).
    return json.dumps([c['title'], c['ranges'], [[s['at_ms'], s['layout'], s['crops']] +
        ([s['transition_ms']] if s.get('transition_ms') else []) for s in c['scenes']]], separators=(',', ':'), ensure_ascii=False)


def questions(schema, judgments, threshold=None, policy=None):
    result = []
    for name, question in schema.items():
        judgment = next((j for j in judgments if j and name in j.get('questions', {})), None) or {}
        answer = judgment.get('answers', {}).get(name, {})
        probability = answer.get('noul') if question['type'] == 'noul' else answer.get('probabilities', {}).get('sufficient')
        criteria = question['criteria']
        result.append({'id': name, 'prompt': question['instructions'], 'yes': criteria.get('true', criteria.get('sufficient', '')),
            'no': criteria.get('false', criteria.get('insufficient', '')), 'probability': probability,
            'threshold': check_threshold(name, threshold if threshold is not None else (policy['threshold'] if policy else .75), policy), 'status': judgment.get('status', 'unavailable')})
    return result


async def review_candidate(c, reviewer):
    report = {'moment': {'requires_visual_context': c.get('requires_visual_context', False)}}
    accepted = await reviewer.judge(c['title'], c['ranges'], report, 'candidate')
    attempt = report['coherence']['attempts'][-1]
    cuts = []
    for (_, a), (b, _) in zip(c['ranges'], c['ranges'][1:]):
        if a == b:
            continue
        state = {'title': c['title'], 'interval': [a, b], 'removed_text': dialogue(reviewer.segments, [(a, b)]),
            'before': dialogue(reviewer.segments, [(max(0, a - 15000), a)]),
            'after': dialogue(reviewer.segments, [(b, min(reviewer.duration_ms, b + 15000))]),
            'source_context': reviewer.source_context}
        judgment = await reviewer.service.evaluate(state, CUT_QUESTIONS)
        cuts.append({'interval': [a, b], 'questions': questions(CUT_QUESTIONS, [judgment], reviewer.policy['cut_threshold'], reviewer.policy)})
    accepted = accepted and all(q['probability'] is not None and q['probability'] >= q['threshold'] for cut in cuts for q in cut['questions'])
    c['review'] = {'signature': signature(c), 'reviewed_at': datetime.now(timezone.utc).isoformat(),
        'decision': 'passes' if accepted else 'needs_attention',
        'questions': questions(CLIP_QUESTIONS, [attempt.get('judgment'), attempt.get('policy_judgment')], policy=reviewer.policy), 'cuts': cuts}


def default_crop(w, h, aspect, cx=.5):
    cw, ch = min(1, h * aspect / w), min(1, w / aspect / h)
    return [max(0, min(1 - cw, cx - cw / 2)), (1 - ch) / 2, cw, ch]


async def prepare_project(request, segments, transcript, download, renderer, reviewer, output_dir, progress):
    if not segments:
        raise NoClipCandidatesError()
    w, h = await renderer._get_video_dimensions(download.video_path)
    duration = round(download.metadata.duration_seconds * 1000)
    aspect = 9 / 16 if request.aspect_ratio == '9:16' else 16 / 9
    project = {'version': 1, 'revision': 0, 'title': utf16_prefix(download.metadata.title or '', 1024), 'width': w, 'height': h,
        'duration_ms': duration, 'aspect_ratio': request.aspect_ratio, 'candidates': [],
        'transcript': [transcript_row(s.start_time_ms, s.end_time_ms, s.text, [(w.start_time_ms, w.end_time_ms) for w in s.words], duration)
                       for s in transcript]}
    loop = asyncio.get_running_loop()
    from .run_diagnostics import CURRENT
    diagnostics = CURRENT.get()
    import threading
    progress_thread = threading.get_ident()
    total = min(100, len(segments))
    for i, segment in enumerate(segments[:100]):
        progress(f'Analyzing framing for candidate {i + 1} of {total}…', 100 * i / total)
        a, b = max(0, segment.start_time_ms), min(duration, segment.end_time_ms)
        if b - a < 100:
            continue
        if diagnostics:
            diagnostics.candidate(i + 1, total, b - a)
        def layout_progress(detail, percent):
            if diagnostics:
                phase = {'Sampling faces': 'sampling', 'Scanning camera changes': 'camera_scan',
                         'Refining face tracking': 'face_tracking', 'Checking shot layouts': 'vision'}.get(detail, 'sampling')
                diagnostics.phase(phase, percent)
            progress(f'Candidate {i + 1} of {total}: {detail}', 100 * i / total)
        def report_layout(detail, percent):
            if threading.get_ident() == progress_thread:
                layout_progress(detail, percent)
            else:
                loop.call_soon_threadsafe(layout_progress, detail, percent)
        plan = None
        scenes = [{'at_ms': 0, 'layout': 'fit' if request.layout_style == 'fit' else 'fill', 'crops': [default_crop(w, h, aspect)]}]
        # Suggested shot layouts stay editable; no pacing cuts or captions are baked.
        if request.aspect_ratio == '9:16' and request.layout_style != 'fit':
            try:
                plan = await renderer.layout_analyzer.analyze(download.video_path, a, b - a, w, h, request.layout_style,
                    progress=report_layout)
                scenes = []
                for j, shot in enumerate(plan.shots[:60]):
                    views = shot_views(shot, (shot.start_ms + shot.end_ms) // 2, w, h, 1080, 1920)
                    normalized = []
                    for ((x, y, cw, ch), _) in views[:2]:
                        target = aspect * len(views)
                        zoom = max(1, min(4, min(1, h * target / w) / max(.01, cw / w)))
                        base_w, base_h = min(1, h * target / w) / zoom, min(1, w / target / h) / zoom
                        normalized.append([max(0, min(1 - base_w, (x + cw / 2) / w - base_w / 2)), max(0, min(1 - base_h, (y + ch / 2) / h - base_h / 2)), base_w, base_h])
                    scenes.append({'at_ms': 0 if j == 0 else a + shot.start_ms,
                        'layout': 'split' if len(views) == 2 else 'fit' if shot.layout == LayoutType.SCREEN else 'fill',
                        'crops': normalized})
                if not scenes:
                    scenes = [{'at_ms': 0, 'layout': 'fill', 'crops': [default_crop(w, h, aspect)]}]
            except asyncio.CancelledError:
                raise
            except Exception:
                pass  # Centered framing is editable if detection isn't available.
        c = {'id': f'candidate-{i + 1}', 'title': utf16_prefix(segment.summary or f'Clip {i + 1}', 200),
            'ranges': [[a, b]], 'scenes': scenes, 'score': max(0, min(100, segment.virality_score)),
            'requires_visual_context': bool((getattr(segment, 'moment', None) or {}).get('requires_visual_context')),
            'reason': utf16_prefix(getattr(segment, 'reasoning', '') or '', 4000), 'captions': request.include_captions,
            'caption_preset': request.caption_preset, 'video_speed': request.video_speed, 'exports': [], 'review': None,
            'status': 'refining', 'caption_edits': [], 'caption_suppression_ranges': []}
        if plan is not None and getattr(plan, 'camera_scan', None):
            c['camera_scan'] = plan.camera_scan
            c['dismissed_camera_markers'] = []
        if diagnostics:
            diagnostics.phase('jev')
        progress(f'Reviewing candidate {i + 1} of {total} with Jev…', 100 * i / total)
        await review_candidate(c, reviewer)
        project['candidates'].append(c)
        if diagnostics:
            diagnostics.phase(None)
    if not project['candidates']:
        raise NoClipCandidatesError()
    progress('Saving source video…', 0, 'saving')
    destination = os.path.join(output_dir, 'editor-source.mp4')
    def move_download():
        # A download in the pipeline's temporary folder is discarded after this
        # run: rename it on the same volume instead of storing a second copy.
        if getattr(download, 'source_type', 'local') == 'local':
            return False
        try:
            if os.stat(download.video_path).st_dev != os.stat(output_dir).st_dev:
                return False
            os.rename(download.video_path, destination)
        except OSError:
            return False
        return True
    # Local inputs are copied: a real copy isolates the project from later
    # changes to (or removal of) the original file.
    def copy_source():
        size, copied = os.path.getsize(download.video_path), 0
        with open(download.video_path, 'rb') as source, open(destination, 'wb') as target:
            while chunk := source.read(8 * 1024 * 1024):
                target.write(chunk)
                copied += len(chunk)
                percent = 100 * copied / max(1, size)
                loop.call_soon_threadsafe(progress, f'Saving source video: {percent:.0f}%', percent, 'saving')
    if not await asyncio.to_thread(move_download):
        await asyncio.to_thread(copy_source)
    os.chmod(destination, 0o600)
    loop = asyncio.get_running_loop()
    await renderer.capture_framing_source(destination, os.path.join(output_dir, 'editor-preview.mp4'),
        progress=lambda percent: loop.call_soon_threadsafe(progress, 'Preparing editor preview…', percent, 'preview'),
        duration_ms=duration)
    project['frame_preview'] = True
    atomic_json(Path(output_dir) / 'editor-project.json', project)
    return project


# ---------------------------------------------------------------------------
# Editable projects for Automatic runs ("Edit clip" on a generated clip)
# ---------------------------------------------------------------------------

# Automatic renders pad each AI interval by the engine's audio padding unless
# Jev reviewed exact source intervals (see ai_clipping_pipeline.render_clip_locked).
AUTOMATIC_PADDING_MS = 150
CAPTION_PRESET_ID = re.compile(r'^[a-z0-9_-]{1,64}$')


def _finite(value, lo=None, hi=None):
    if type(value) not in (int, float) or not math.isfinite(value):
        return False
    return (lo is None or value >= lo) and (hi is None or value <= hi)


def _subtract(a, b, holes):
    """[a, b] minus each hole, keeping pieces of at least 100 ms, in order."""
    pieces = [[a, b]]
    for hole in holes or []:
        if not isinstance(hole, (list, tuple)) or len(hole) != 2 or not all(_finite(n) for n in hole):
            continue
        h0, h1 = round(hole[0]), round(hole[1])
        if h1 <= h0:
            continue
        next_pieces = []
        for p0, p1 in pieces:
            if h1 <= p0 or h0 >= p1:
                next_pieces.append([p0, p1])
                continue
            if h0 - p0 >= 100:
                next_pieces.append([p0, h0])
            if p1 - h1 >= 100:
                next_pieces.append([h1, p1])
        pieces = next_pieces
    return pieces


def _box(value):
    if isinstance(value, (list, tuple)) and len(value) == 4 and all(_finite(n, 0, 1) for n in value):
        return [float(n) for n in value]
    return None


def _centered_crop(w, h, aspect, box):
    """A crop of the output aspect centered on a normalized [x, y, w, h] box."""
    cw, ch = min(1, h * aspect / w), min(1, w / aspect / h)
    cx, cy = (box[0] + box[2] / 2, box[1] + box[3] / 2) if box else (.5, .5)
    return [max(0, min(1 - cw, cx - cw / 2)), max(0, min(1 - ch, cy - ch / 2)), cw, ch]


def _shot_scene(shot, w, h, aspect, layout_style):
    """Translate an Automatic render's dominant framing into an editable layout.

    The editor draws crops, not the renderer's motion paths, so each shot uses
    a fixed crop centered on what the renderer followed. Users refine it.
    """
    if layout_style == 'fit':
        return 'fit', [_centered_crop(w, h, aspect, None)]
    kind = shot.get('layout') if isinstance(shot, dict) else None
    people = [p for p in (_box(p) for p in (shot.get('people') or [])) if p] if isinstance(shot, dict) else []
    if kind == 'screen':
        return 'fit', [_centered_crop(w, h, aspect, None)]
    if kind == 'two_shot' and len(people) >= 2:
        left, right = sorted(people[:2], key=lambda b: b[0] + b[2] / 2)
        return 'split', [_centered_crop(w, h, aspect * 2, left), _centered_crop(w, h, aspect * 2, right)]
    if kind == 'screen_cam' and _box(shot.get('cam_box')):
        screen = _box(shot.get('screen_focus')) or _box(shot.get('screen_box'))
        return 'split', [_centered_crop(w, h, aspect * 2, screen), _centered_crop(w, h, aspect * 2, _box(shot.get('cam_box')))]
    return 'fill', [_centered_crop(w, h, aspect, people[0] if people else _box(shot.get('content_box')) if isinstance(shot, dict) else None)]


def transcript_row(start, end, text, words, duration):
    """An editor transcript line. Word times ride along when they match the
    line's words one to one, so the editor's live captions use real timing."""
    row = {'start_ms': max(0, min(duration, round(start))), 'end_ms': max(0, min(duration, round(end))), 'text': utf16_prefix(text, 20000)}
    if (words and len(words) == len(text.split()) and len(words) <= 2000
            and all(_finite(a, 0) and _finite(b, a) for a, b in words)):
        row['words'] = [[max(0, min(duration, round(a))), max(0, min(duration, round(b)))] for a, b in words]
    return row


def automatic_candidates(output, plan, width, height, duration_ms):
    """Editable candidates for every clip an Automatic run rendered.

    Each candidate keeps the clip's AI interval (with the same padding and
    planner skips the render used), its framing, captions and title card, and
    starts Baked: the existing clip file is its first export. Editing creates a
    new export and never overwrites the original.
    """
    metrics = output.get('metrics') if isinstance(output.get('metrics'), dict) else {}
    requested = metrics.get('requested_settings') if isinstance(metrics.get('requested_settings'), dict) else {}
    aspect_ratio = requested.get('aspect_ratio') if requested.get('aspect_ratio') in ('9:16', '16:9') else '9:16'
    aspect = 9 / 16 if aspect_ratio == '9:16' else 16 / 9
    layout_style = requested.get('layout_style')
    preset = requested.get('caption_preset')
    preset = preset if isinstance(preset, str) and CAPTION_PRESET_ID.match(preset) else 'pop'
    speed = requested.get('video_speed')
    speed = float(speed) if _finite(speed, 1, 2) else 1
    captions = metrics.get('captions_status', 'enabled') == 'enabled'
    title_card = requested.get('include_title', True) is not False
    layouts = {item.get('clip_index'): item for item in (metrics.get('clip_layouts') or []) if isinstance(item, dict)}
    segments = plan.get('segments') if isinstance(plan, dict) and isinstance(plan.get('segments'), list) else []
    candidates = []
    clips = sorted((c for c in output.get('clips', []) if isinstance(c, dict) and type(c.get('clip_index')) is int),
                   key=lambda c: c['clip_index'])
    for clip in clips[:100]:
        index = clip['clip_index']
        if clip.get('editor_candidate') or not 0 <= index <= 999:
            continue  # Exports of an existing editor project are not new candidates.
        start, end = clip.get('start_time_ms'), clip.get('end_time_ms')
        if not _finite(start, 0) or not _finite(end, start + 100):
            continue
        segment = segments[index] if index < len(segments) and isinstance(segments[index], dict) else {}
        if segment and (segment.get('start_time_ms') != start or segment.get('end_time_ms') != end):
            segment = {}  # The plan changed after rendering; keep only the clip's own interval.
        pad = 0 if clip.get('editorial') else AUTOMATIC_PADDING_MS
        a, b = max(0, round(start) - pad), min(duration_ms, round(end) + pad)
        if b - a < 100:
            continue
        ranges = _subtract(a, b, segment.get('skip_ranges_ms'))
        if not ranges or len(ranges) > 24:
            ranges = [[a, b]]
        scenes = []
        if aspect_ratio == '9:16':
            for shot in (layouts.get(index) or {}).get('shots') or []:
                if not isinstance(shot, dict) or not _finite(shot.get('start_ms'), 0):
                    continue
                at = 0 if not scenes else a + round(shot['start_ms'])
                if scenes and (at <= scenes[-1]['at_ms'] or at >= b):
                    continue
                layout, crops = _shot_scene(shot, width, height, aspect, layout_style)
                if scenes and scenes[-1]['layout'] == layout and scenes[-1]['crops'] == crops:
                    continue
                scenes.append({'at_ms': at, 'layout': layout, 'crops': crops})
                if len(scenes) >= 60:
                    break
        if not scenes:
            layout = 'fit' if layout_style == 'fit' or (aspect_ratio == '16:9' and width < height) else 'fill'
            scenes = [{'at_ms': 0, 'layout': layout, 'crops': [_centered_crop(width, height, aspect, None)]}]
        # Same scale as the clip (Automatic and review runs both store the planner's 0-1 score).
        score = clip.get('virality_score') if _finite(clip.get('virality_score'), 0) else 0
        reason = segment.get('reasoning') if isinstance(segment.get('reasoning'), str) else ''
        candidate = {'id': f'clip-{index:02d}', 'title': utf16_prefix((clip.get('summary') or '').strip() or f'Clip {index + 1}', 200),
            'ranges': ranges, 'scenes': scenes, 'score': max(0, min(100, score)), 'reason': utf16_prefix(reason, 4000),
            'requires_visual_context': False, 'captions': captions, 'caption_preset': preset, 'video_speed': speed,
            'exports': [index], 'review': None, 'status': 'baked', 'caption_edits': [], 'caption_suppression_ranges': [],
            'source_clip': index, 'title_card': title_card}
        try:
            validate_candidate(candidate, duration_ms)
        except (ValueError, KeyError, TypeError):
            candidate['scenes'] = [{'at_ms': 0, 'layout': 'fill', 'crops': [_centered_crop(width, height, aspect, None)]}]
            candidate['ranges'] = [[a, b]]
            validate_candidate(candidate, duration_ms)
        candidates.append(candidate)
    return aspect_ratio, candidates


async def create_project(run, progress=None):
    """Turn an Automatic run into an editor project around `editor-source.mp4`.

    Main links or copies the original video into the run first. This checks
    that it is the same video, prepares the frame-accurate preview, then
    commits editor-project.json and flags job_output.json, in that order.
    """
    output = read_json(run, 'job_output.json')
    if (run / 'editor-project.json').exists():
        project = read_json(run, 'editor-project.json')
        if not output.get('editor_project'):
            output['editor_project'] = True
            atomic_json(run / 'job_output.json', output)
        return project
    with failure_code('source_missing'):
        source = local_file(run, media_name('source'))
    try:
        info = await asyncio.to_thread(source_info, source)
    except SourceReplacementError as error:
        raise EditorError('invalid', 'The source video could not be read') from error
    expected = output.get('source_video_duration_seconds')
    if _finite(expected, .1) and abs(info['duration'] - expected * 1000) > max(1000, expected * 10):
        raise EditorError('duration', 'This is not the video these clips came from')
    with failure_code('engine_unavailable'):
        renderer = RenderingService()
    with failure_code('source_incompatible'):
        width, height = await renderer._get_video_dimensions(str(source))
    duration = round(info['duration'])
    plan = {}
    try:
        plan = read_json(run, 'plan.json')
    except (ValueError, OSError):
        pass
    aspect_ratio, candidates = automatic_candidates(output, plan, width, height, duration)
    if not candidates:
        raise EditorError('invalid_edit', 'This run has no clips to edit')
    transcript = []
    try:
        rows = read_json(run, 'transcript.json').get('segments') or []
        for row in rows[:100000]:
            if isinstance(row, dict) and _finite(row.get('start_time_ms'), 0) and _finite(row.get('end_time_ms'), 0):
                words = [(w.get('start_time_ms'), w.get('end_time_ms')) for w in row.get('words') or [] if isinstance(w, dict)]
                transcript.append(transcript_row(row['start_time_ms'], row['end_time_ms'], str(row.get('text') or ''), words, duration))
    except (ValueError, OSError, AttributeError):
        transcript = []
    preview = run / media_name('preview')
    preview.unlink(missing_ok=True)
    try:
        with failure_code('render_failed'):
            await renderer.capture_framing_source(str(source), str(preview), duration_ms=duration,
                progress=(lambda percent: progress({'phase': 'preview', 'percent': max(0, min(100, percent))})) if progress else None)
        project = {'version': 1, 'revision': 0, 'title': utf16_prefix(output.get('source_video_title') or '', 1024),
            'width': width, 'height': height, 'duration_ms': duration, 'aspect_ratio': aspect_ratio,
            'candidates': candidates, 'transcript': transcript, 'frame_preview': True}
        atomic_json(run / 'editor-project.json', project)
    except BaseException:
        preview.unlink(missing_ok=True)
        raise
    output['editor_project'] = True
    atomic_json(run / 'job_output.json', output)
    return project


def atomic_json(path, value):
    temp = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf8', dir=path.parent, prefix='.editor-', suffix='.tmp', delete=False) as f:
            temp = f.name
            json.dump(value, f, ensure_ascii=False, allow_nan=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        if temp and os.path.exists(temp):
            os.unlink(temp)


def local_file(run, name):
    path = run / name
    if path.is_symlink() or not path.is_file() or path.resolve().parent != run:
        raise ValueError('Editor file is unavailable')
    return path


def read_json(run, name, limit=32 * 1024 * 1024):
    path = local_file(run, name)
    with path.open('rb') as f:
        data = f.read(limit + 1)
    if len(data) > limit:
        raise ValueError('Editor file is too large')
    return json.loads(data)


def validate_candidate(c, duration, transcript_count=100000):
    def number(n, lo, hi):
        return type(n) in (float, int) and math.isfinite(n) and lo <= n <= hi
    if not isinstance(c.get('title'), str) or not 1 <= len(c['title']) <= 200:
        raise ValueError('Invalid title')
    ranges = c['ranges']
    if not 1 <= len(ranges) <= 24:
        raise ValueError('Invalid cuts')
    previous = 0
    for a, b in ranges:
        if not number(a, previous, duration) or not number(b, a + 100, duration):
            raise ValueError('Invalid cut interval')
        previous = b
    if not 1 <= len(c['scenes']) <= 60 or c['scenes'][0]['at_ms'] != 0:
        raise ValueError('Invalid layouts')
    previous = -1
    for i, s in enumerate(c['scenes']):
        if not number(s['at_ms'], previous + .001, duration) or s['layout'] not in ('fill', 'split', 'fit'):
            raise ValueError('Invalid layout')
        previous = s['at_ms']
        transition = s.get('transition_ms', 0)
        if not number(transition, 0, 5000) or (transition and (transition < 100 or transition != int(transition)
                or i == 0 or s['layout'] == 'fit' or c['scenes'][i - 1]['layout'] != s['layout'])):
            raise ValueError('Invalid layout movement')
        if len(s['crops']) != (2 if s['layout'] == 'split' else 1):
            raise ValueError('Invalid crops')
        for x, y, w, h in s['crops']:
            if not all(number(n, 0, 1) for n in (x, y, w, h)) or min(w, h) < .01 or x + w > 1.000001 or y + h > 1.000001:
                raise ValueError('Invalid crop')
    if not number(c['video_speed'], .5, 2) or type(c['captions']) is not bool:
        raise ValueError('Invalid export settings')
    if c.get('caption_y') is not None and not number(c['caption_y'], .1, .9):
        raise ValueError('Invalid caption position')
    if c.get('status', 'refining') not in ('refining', 'ready', 'baked', 'discarded'):
        raise ValueError('Invalid clip status')
    if 'title_card' in c and type(c['title_card']) is not bool:
        raise ValueError('Invalid title card setting')
    if 'source_clip' in c and (type(c['source_clip']) is not int or not 0 <= c['source_clip'] <= 999):
        raise ValueError('Invalid source clip')
    suppressed = c.get('caption_suppression_ranges', [])
    if not isinstance(suppressed, list) or len(suppressed) > 200:
        raise ValueError('Invalid caption suppression ranges')
    previous = 0
    for interval in suppressed:
        if not isinstance(interval, list) or len(interval) != 2:
            raise ValueError('Invalid caption suppression range')
        a, b = interval
        if not number(a, previous, duration) or not number(b, a + 100, duration):
            raise ValueError('Invalid caption suppression range')
        previous = b
    edits = c.get('caption_edits', [])
    if not isinstance(edits, list) or len(edits) > 2000:
        raise ValueError('Invalid caption edits')
    seen = set()
    for edit in edits:
        if not isinstance(edit, dict):
            raise ValueError('Invalid caption edit')
        index, text = edit.get('segment'), edit.get('text')
        if type(index) is not int or not 0 <= index < transcript_count or index in seen or not isinstance(text, str) or len(text) > 2000:
            raise ValueError('Invalid caption edit')
        if any(ord(char) < 32 and char not in '\t\n\r' for char in text):
            raise ValueError('Invalid caption text')
        if ('start_ms' in edit) != ('end_ms' in edit) or ('start_ms' in edit and (
                not number(edit['start_ms'], 0, duration) or not number(edit['end_ms'], edit['start_ms'] + 100, duration))):
            raise ValueError('Invalid caption timing')
        seen.add(index)
    inserts = c.get('caption_inserts', [])
    if not isinstance(inserts, list) or len(inserts) > 200:
        raise ValueError('Invalid added captions')
    for item in inserts:
        if (not isinstance(item, dict) or not isinstance(item.get('text'), str) or not 0 < len(item['text']) <= 500
                or any(ord(char) < 32 and char not in '\t\n\r' for char in item['text'])
                or not number(item.get('start_ms'), 0, duration) or not number(item.get('end_ms'), item['start_ms'] + 100, duration)):
            raise ValueError('Invalid added caption')
    from clip_engine.config import validate_caption_overrides
    validate_caption_overrides(c.get('caption_style'))
    from clip_engine.services.text_overlays import validate_text_overlays
    validate_text_overlays(c.get('text_overlays'), duration)
    from clip_engine.services.effects import validate_effects
    validate_effects(c.get('effects'), duration)


def _spread(tokens, start, end):
    span = max(1, end - start)
    return [TranscriptWord(word, round(start + i * span / len(tokens)), round(start + (i + 1) * span / len(tokens))) for i, word in enumerate(tokens)]


def caption_transcript(transcript, edits, inserts=()):
    """A per-clip copy for rendering; original evidence and word timing stay intact.

    Corrections with the same word count retain the original word timestamps.
    Added/removed words are spread over the original line's spoken interval.
    A retimed line moves its words proportionally into the new interval, and
    added lines spread their words evenly over their own interval.
    """
    overrides = {edit['segment']: edit for edit in edits}
    result = []
    for index, segment in enumerate(transcript):
        edit = overrides.get(index)
        if edit is None:
            result.append(replace(segment, words=[replace(w) for w in segment.words]))
            continue
        text = ' '.join(edit['text'].split())
        tokens = text.split()
        if not tokens:
            continue  # An empty correction hides this caption without cutting audio.
        start = segment.words[0].start_time_ms if segment.words else segment.start_time_ms
        end = segment.words[-1].end_time_ms if segment.words else segment.end_time_ms
        if segment.words and len(tokens) == len(segment.words):
            words = [replace(word, word=text) for word, text in zip(segment.words, tokens)]
        else:
            words = _spread(tokens, start, end)
        if 'start_ms' in edit:
            new_start, new_end = round(edit['start_ms']), round(edit['end_ms'])
            scale = (new_end - new_start) / max(1, end - start)
            at = lambda t: max(new_start, min(new_end, round(new_start + (t - start) * scale)))
            words = [replace(w, start_time_ms=at(w.start_time_ms), end_time_ms=max(at(w.start_time_ms) + 1, at(w.end_time_ms))) for w in words]
            result.append(replace(segment, text=text, words=words, start_time_ms=new_start, end_time_ms=new_end))
        else:
            result.append(replace(segment, text=text, words=words))
    for item in inserts or ():
        tokens = ' '.join(item['text'].split()).split()
        if tokens:
            a, b = round(item['start_ms']), round(item['end_ms'])
            result.append(TranscriptSegment(a, b, ' '.join(tokens), words=_spread(tokens, a, b)))
    result.sort(key=lambda s: s.start_time_ms)
    return result


def scene_motion(c):
    """Resolve incoming crops before trimming the source window or skipping cuts."""
    previous = None
    origin = None
    for scene in c['scenes']:
        duration = scene.get('transition_ms', 0)
        if duration and previous and previous['layout'] == scene['layout'] and scene['layout'] != 'fit':
            p = min(1, (scene['at_ms'] - previous['at_ms']) / previous['transition_ms']) if previous.get('transition_ms') else 1
            ease = p * p * (3 - 2 * p)
            origin = [[a + (b - a) * ease for a, b in zip(start, end)] for start, end in zip(origin, previous['crops'])]
        else:
            origin = scene['crops']
        yield scene, origin
        previous = scene


def manual_plan(project, c):
    a, b = c['ranges'][0][0], c['ranges'][-1][1]
    shots = []
    for i, (scene, origin) in enumerate(scene_motion(c)):
        start, end = max(a, scene['at_ms']), min(b, c['scenes'][i + 1]['at_ms'] if i + 1 < len(c['scenes']) else b)
        if start >= end:
            continue
        layout = {'split': LayoutType.TWO_SHOT, 'fit': LayoutType.SCREEN, 'fill': LayoutType.TALKING_HEAD}[scene['layout']]
        crops = [] if scene['layout'] == 'fit' else scene['crops']
        duration = scene.get('transition_ms', 0)
        motion_end = min(end, scene['at_ms'] + duration)
        if duration and start < motion_end:
            shots.append(ShotLayout(start - a, motion_end - a, layout, source='manual', manual_crops=crops,
                manual_from_crops=origin, manual_transition_start_ms=scene['at_ms'] - a, manual_transition_ms=duration))
            start = motion_end
        if start < end:
            shots.append(ShotLayout(start - a, end - a, layout, source='manual', manual_crops=crops))
    return ClipLayoutPlan(shots, project['width'], project['height'])


async def run_editor(config, progress=None):
    from clip_engine.config import get_settings
    from clip_engine.services.editorial_vision import EditorialVision
    settings = get_settings()
    raw_run = Path(config['run'])
    run = raw_run.resolve(strict=True)
    if raw_run.is_symlink() or ('library' in config and run.parent != Path(config['library']).resolve(strict=True)):
        raise ValueError('Editor project is outside the library')
    if config['action'] == 'create-project':
        await create_project(run, progress)
        return
    project = read_json(run, 'editor-project.json')
    if project['version'] != 1 or project['revision'] != config['revision']:
        raise EditorError('project_changed', 'The editor project changed. Reopen it and retry.')
    if project.get('media_freed'):
        raise EditorError('source_missing', 'Editor media was freed')
    if config['action'] == 'replace-source':
        source_id = config['source_id']
        if not source_id or source_id == project.get('source_id'):
            raise ValueError('Invalid source generation')
        await replace_source(run, project, source_id)
        return
    c = next((c for c in project['candidates'] if c['id'] == config['candidate_id']), None)
    if c is None:
        raise EditorError('project_changed', 'Candidate is missing')
    with failure_code('invalid_edit'):
        validate_candidate(c, project['duration_ms'], len(project['transcript']))
    with failure_code('source_missing'):
        source = str(local_file(run, media_name('source', project.get('source_id'))))
    if config['action'] == 'scan-cameras':
        from clip_engine.services.camera_scan import scan_camera_changes
        def report(phase, percent):
            if progress:
                progress({'phase': phase, 'percent': percent})
        try:
            scan = await asyncio.to_thread(scan_camera_changes, source, c['ranges'][0][0], c['ranges'][-1][1],
                                           lambda percent: report('scan', percent))
        except ValueError as error:
            error.editor_code = 'scan_too_long' if 'too long' in str(error) else 'source_incompatible'
            raise
        preview = None
        try:
            # Upgrade old 30-fps proxies once. A new name avoids browser caching
            # and leaves an open preview untouched until the atomic commit.
            if not project.get('frame_preview'):
                preview_id = config.get('preview_id') or uuid4().hex
                preview = run / media_name('preview', preview_id)
                with failure_code('render_failed'):
                    await RenderingService().capture_framing_source(source, str(preview),
                        progress=lambda percent: report('preview', percent), duration_ms=project['duration_ms'])
                project.update(preview_id=preview_id, frame_preview=True)
            if read_json(run, 'editor-project.json')['revision'] != project['revision']:
                raise EditorError('project_changed', 'Editor project changed')
            c['camera_scan'] = scan
            c['dismissed_camera_markers'] = [t for t in c.get('dismissed_camera_markers', [])
                                             if any(abs(t - m['at_ms']) < .01 for m in scan['markers'])]
            project['revision'] += 1
            if len(json.dumps(project).encode('utf8')) > 32 * 1024 * 1024:
                raise ValueError('Editor project is too large')
            atomic_json(run / 'editor-project.json', project)
            preview = None
        finally:
            if preview is not None:
                preview.unlink(missing_ok=True)
        return
    with failure_code('invalid_edit'):
        rows = read_json(run, 'transcript.json')['segments']
        def timing(item):
            return {**item, 'start_time_ms': round(item['start_time_ms']), 'end_time_ms': round(item['end_time_ms'])}
        transcript = [TranscriptSegment(**{**timing(s), 'words': [TranscriptWord(**timing(w)) for w in s.get('words', [])]}) for s in rows]
    action = config['action']
    if action == 'preview-frame':
        await preview_frame(run, project, c, source, transcript, config.get('at_ms'), config.get('frame_id'))
        return  # A preview never changes the project.
    if action == 'review':
        with failure_code('review_unavailable'):
            reviewer = CoherenceReviewer(JevService.from_settings(settings, required=True), settings, transcript, project['duration_ms'])
            context = run / 'source_context.json'
            if context.exists():
                from clip_engine.services.source_context import context_for_prompt
                # Read the same bounded brief used in discovery; no new web research.
                reviewer.source_context = context_for_prompt(read_json(run, 'source_context.json'))
            with tempfile.TemporaryDirectory(prefix='.editor-review-', dir=run) as work:
                vision = EditorialVision(settings, source, work, project['duration_ms'])
                reviewer.visual_observer = vision.observe if settings.jev_visual_context else None
                await review_candidate(c, reviewer)
    elif action == 'export':
        if c.get('status', 'refining') != 'ready':
            raise EditorError('not_ready', 'Mark this clip ready before baking it')
        if any(edit['segment'] >= len(transcript) for edit in c.get('caption_edits', [])):
            raise EditorError('invalid_edit', 'Caption source changed')
        output = read_json(run, 'job_output.json')
        # job_output.json is committed before editor-project.json. If the worker
        # was killed in between, this exact edit (same revision) is already in
        # the library: finish that commit instead of rendering a duplicate.
        done = next((x for x in output['clips'] if x.get('editor_candidate') == c['id'] and x.get('editor_revision') == project['revision']
                     and x['clip_index'] not in c['exports'] and (run / f"clip_{x['clip_index']:02d}.mp4").is_file()), None)
        c['exports'].append(done['clip_index'] if done else await export_clip(run, project, c, output, source, transcript))
        c['status'] = 'baked'
        c.pop('baked_hash', None)
    else:
        raise ValueError('Unknown editor action')
    project['revision'] += 1
    atomic_json(run / 'editor-project.json', project)


def effects_for(c, project):
    from clip_engine.services.effects import describe, validate_effects
    effects = validate_effects(c.get('effects'), project['duration_ms'])
    return effects if describe(effects) else None


def text_overlays_for(c, project):
    from clip_engine.services.text_overlays import validate_text_overlays
    return validate_text_overlays(c.get('text_overlays'), project['duration_ms'])


async def export_clip(run, project, c, output, source, transcript):
    """Render one ready candidate and append it to the library's job output."""
    from clip_engine.config import caption_style_for
    render_transcript = caption_transcript(transcript, c.get('caption_edits', []), c.get('caption_inserts', []))
    next_index = output.get('next_clip_index', 0)
    if type(next_index) is not int or not 0 <= next_index <= 1000:
        raise EditorError('invalid_edit', 'Invalid export sequence')
    index = max(next_index, max((x['clip_index'] for x in output['clips']), default=-1) + 1)
    while (run / f'clip_{index:02d}.mp4').exists() or (run / f'clip_{index:02d}.mp4').is_symlink():
        index += 1
    if index > 999:
        raise EditorError('invalid_edit', 'Too many exports in this project')
    with failure_code('engine_unavailable'):
        renderer = RenderingService()
    a, b = c['ranges'][0][0], c['ranges'][-1][1]
    path = run / f'clip_{index:02d}.mp4'
    if path.exists() or path.is_symlink():
        raise ValueError('Export file already exists')
    # Commit complete renders only; failed/cancelled exports do not change the library.
    with tempfile.TemporaryDirectory(prefix='.editor-export-', dir=run) as work, failure_code('render_failed'):
        result = await renderer.render_clip(RenderRequest(video_path=source, output_path=str(Path(work) / 'clip.mp4'),
            start_time_ms=a, end_time_ms=b, source_width=project['width'], source_height=project['height'],
            transcript_segments=render_transcript, include_captions=c['captions'], caption_style=caption_style_for(c['caption_preset'], c.get('caption_style')),
            title_text=c['title'], include_title=c.get('title_card') is True,
            caption_suppression_ranges_ms=[tuple(interval) for interval in c.get('caption_suppression_ranges', [])],
            caption_y=c.get('caption_y'), text_overlays=text_overlays_for(c, project), effects=effects_for(c, project),
            apply_padding=False, aspect_ratio=project['aspect_ratio'], pacing='natural', video_speed=c['video_speed'],
            manual_ranges_ms=[tuple(interval) for interval in c['ranges']], manual_plan=manual_plan(project, c)))
        os.replace(result.output_path, path)
    output['clips'].append({'clip_index': index, 's3_url': str(path), 'duration_ms': result.duration_ms,
        'start_time_ms': a, 'end_time_ms': b, 'virality_score': c['score'], 'layout_type': result.layout_type,
        'summary': c['title'], 'tags': [], 'render_fallback': None,
        'editor_candidate': c['id'], 'editor_revision': project['revision'],
        **({'edited_from_clip': c['source_clip']} if type(c.get('source_clip')) is int else {})})
    output['total_clips'] = len(output['clips'])
    atomic_json(run / 'job_output.json', output)
    return index


PREVIEW_BEFORE_MS, PREVIEW_AFTER_MS = 1200, 300


def preview_ranges(c, render_transcript, style, at_ms, bounds=None):
    """The cuts to render so the frame at `at_ms` matches the full export.

    Captions are grouped from the start of the clip, so the window starts at
    the first word of the caption group on screen at `at_ms` (in the export's
    own grouping, across cuts) and ends after that group's last word, which
    keeps unspoken words, the group's layout and its animation identical.
    """
    from clip_engine.services.clip_editor import TimeMap, remap_segments
    from clip_engine.services.caption_generator import MAX_LINGER_MS, CaptionGeneratorService
    ranges = c['ranges']
    origin = ranges[0][0]
    start, end = at_ms - PREVIEW_BEFORE_MS, at_ms + PREVIEW_AFTER_MS
    floor, ceiling = None, at_ms - 100
    if c['captions'] and style.word_by_word_highlight:
        keeps = [(a - origin, b - origin) for a, b in ranges]
        time_map = TimeMap(keeps, ranges[-1][1] - origin)
        words = [w for seg in remap_segments(render_transcript, origin, time_map) for w in seg.words]
        words = [w for w in words if w.end_time_ms > origin and w.start_time_ms < origin + time_map.output_ms]
        groups = CaptionGeneratorService()._group_words(words, style.max_words_per_line)
        now = time_map.to_output(at_ms - origin)

        def source(output_ms):
            for (a, b), (ka, kb) in zip(ranges, keeps):
                offset = time_map.to_output(ka)
                if offset is not None and output_ms <= offset + (kb - ka):
                    return a + max(0, output_ms - offset)
            return ranges[-1][1]

        def visible(index):
            """Whether any of the group's caption events covers `now` (CaptionGeneratorService rules)."""
            group = groups[index].words
            following = groups[index + 1].words[0].start_time_ms if index + 1 < len(groups) else None
            last = group[-1].end_time_ms + MAX_LINGER_MS
            group_end = min(following, last) if following is not None else last
            for i, word in enumerate(group):
                word_end = group[i + 1].start_time_ms if i + 1 < len(group) else group_end
                if word.start_time_ms <= now + origin < word_end:
                    return True
            return False
        shown = [i for i in range(len(groups)) if now is not None and visible(i)]
        if shown:
            first_group = groups[shown[0]].words
            first = next(i for i, w in enumerate(words) if w is first_group[0])
            group_start = source(first_group[0].start_time_ms - origin)
            start = min(start, group_start - 50)
            end = max(end, max(source(groups[i].words[-1].end_time_ms - origin) for i in shown) + 50)
            # Every word of the groups on screen must be in the window (it ends
            # after the window start) and every earlier word must not, or the
            # grouping would shift.
            needed = min(source(w.end_time_ms - origin) for i in shown for w in groups[i].words)
            ceiling = min(ceiling, group_start - 1, needed - 1)
            floor = max((source(w.end_time_ms - origin) for w in words[:first]), default=None)
            if floor is not None:
                start = max(start, floor)
    # Fades and cut transitions depend on the clip's edges and joins.
    effects = c.get('effects') or {}
    speed = c['video_speed']
    if effects.get('fade_in_ms') and at_ms - ranges[0][0] <= effects['fade_in_ms'] * speed + 50:
        start = ceiling = ranges[0][0]
    if effects.get('fade_out_ms') and ranges[-1][1] - at_ms <= effects['fade_out_ms'] * speed + 50:
        end = ranges[-1][1]
    if effects.get('transition', 'none') != 'none':
        start, end = min(start, at_ms - 1100), max(end, at_ms + 1100)
    # A text overlay that appeared just before keeps its entrance animation.
    for overlay in c.get('text_overlays') or []:
        if overlay['start_ms'] <= at_ms < overlay['end_ms'] and at_ms - overlay['start_ms'] < 1000:
            start = min(start, overlay['start_ms'] - 10)
            ceiling = min(ceiling, overlay['start_ms'])
    if floor is not None and (start < floor or floor > ceiling):
        # No window both includes what decides this frame and leaves out what
        # must not be there: render from the clip start, which is the export.
        start, floor, ceiling = ranges[0][0], None, ranges[0][0]
    if bounds is not None:
        bounds.update(floor=floor, ceiling=max(ceiling, start))
    window = [[max(a, round(start)), min(b, round(end))] for a, b in ranges if b > start and a < end]
    window = [r for r in window if r[1] - r[0] >= 100 or r[0] <= at_ms < r[1]]
    piece = next((r for r in window if r[0] <= at_ms < r[1]), None)
    if piece is not None and piece[1] - piece[0] < 100:
        piece[1] = min(next(b for a, b in ranges if a <= at_ms < b), piece[0] + 100)
        piece[0] = min(piece[0], piece[1] - 100)
    return window


def align_window(ranges, window, fps, speed, floor=None, ceiling=None):
    """Start the window on the export's frame grid, so its frames are the export's frames.

    The window start's offset in the edit must be a whole number of frames
    before speed (layout composition) and after it (output), and a whole
    number of milliseconds, since cut points are in ms: otherwise a clip that
    starts between two source frames would pick the neighboring frame.
    """
    from fractions import Fraction
    try:
        frame_ms = Fraction(1000) / Fraction(str(fps))
        pace = Fraction(str(speed)).limit_denominator(1000)
    except (ValueError, ZeroDivisionError):
        return window
    frames = next((n for n in range(1, 241) if (n * frame_ms).denominator == 1 and (n / pace).denominator == 1), None)
    if frames is None:
        return window
    grid = int(frames * frame_ms)
    edited, offset = 0, None
    for a, b in ranges:
        if a <= window[0][0] <= b:
            offset = edited + window[0][0] - a
            break
        edited += b - a
    if offset is None:
        return window

    def source(edited_ms):
        edited = 0
        for a, b in ranges:
            if edited_ms <= edited + (b - a):
                return a + edited_ms - edited
            edited += b - a
        return None
    # The grid point at or before the window start, unless that reaches back
    # past `floor`: then the next one, if it is still no later than `ceiling`.
    snapped = offset // grid * grid
    start = source(snapped)
    if start is not None and floor is not None and start < floor:
        later = source(snapped + grid)
        if later is not None and (ceiling is None or later <= ceiling):
            start = later
    if start is None:
        return window
    end = window[-1][1]
    return [[max(a, start), min(b, end)] for a, b in ranges if b > start and a < end]


async def preview_frame(run, project, c, source, transcript, at_ms, frame_id):
    """Render the export's exact picture at source time `at_ms` to editor-frame-<id>.png.

    Renders only the part of the clip that decides that picture, through the
    same manual export as "Export clip" (layouts, captions, title card), then
    keeps the frame at that time. Nothing in the project or library changes.
    """
    if not isinstance(frame_id, str) or not re.fullmatch(r'[a-f0-9]{32}', frame_id):
        raise ValueError('Invalid preview id')
    if type(at_ms) not in (int, float) or not math.isfinite(at_ms):
        raise EditorError('invalid_edit', 'Invalid preview time')
    if not any(a <= at_ms < b for a, b in c['ranges']):
        raise EditorError('invalid_edit', 'Move the playhead inside the clip to preview it')
    from clip_engine.config import caption_style_for
    style = caption_style_for(c['caption_preset'], c.get('caption_style'))
    render_transcript = caption_transcript(transcript, c.get('caption_edits', []), c.get('caption_inserts', []))
    bounds = {}
    window_ranges = preview_ranges(c, render_transcript, style, at_ms, bounds)
    with failure_code('engine_unavailable'):
        renderer = RenderingService()
    with failure_code('source_incompatible'):
        fps = await renderer._probe_fps(source)
    window_ranges = align_window(c['ranges'], window_ranges, fps, c['video_speed'], bounds.get('floor'), bounds.get('ceiling'))
    a, b = window_ranges[0][0], window_ranges[-1][1]
    window = {**c, 'ranges': window_ranges}
    target = run / f'editor-frame-{frame_id}.png'
    with tempfile.TemporaryDirectory(prefix='.editor-preview-', dir=run) as work, failure_code('render_failed'):
        result = await renderer.render_clip(RenderRequest(video_path=source, output_path=str(Path(work) / 'window.mp4'),
            start_time_ms=a, end_time_ms=b, source_width=project['width'], source_height=project['height'],
            transcript_segments=render_transcript, include_captions=c['captions'], caption_style=style,
            caption_suppression_ranges_ms=[tuple(interval) for interval in c.get('caption_suppression_ranges', [])],
            caption_y=c.get('caption_y'), title_text=c['title'], include_title=c.get('title_card') is True,
            text_overlays=text_overlays_for(c, project), effects=effects_for(c, project),
            effects_fade_in=window_ranges[0][0] == c['ranges'][0][0], effects_fade_out=window_ranges[-1][1] == c['ranges'][-1][1],
            apply_padding=False, aspect_ratio=project['aspect_ratio'], pacing='natural', video_speed=c['video_speed'],
            manual_ranges_ms=[tuple(r) for r in window_ranges], manual_plan=manual_plan(project, window)))
        before = sum(min(r[1], at_ms) - r[0] for r in window_ranges if r[0] < at_ms)
        offset = max(0, before / c['video_speed'] / 1000)
        # The frame on screen at the playhead: the last one that starts at or before it.
        from fractions import Fraction
        index = math.floor(offset * Fraction(str(fps)) + Fraction(1, 1000))
        partial = Path(work) / 'frame.png'
        await asyncio.to_thread(run_media, ['ffmpeg', '-v', 'error', '-y', '-i', result.output_path,
            '-vf', f'select=eq(n\\,{index}),scale=-2:960', '-frames:v', '1', str(partial)], timeout=120, check=True)
        if not partial.is_file():
            # The playhead is on the clip's last frame: seeking lands just past it.
            await asyncio.to_thread(run_media, ['ffmpeg', '-v', 'error', '-y', '-sseof', '-0.5', '-i', result.output_path,
                '-vf', 'scale=-2:960', '-update', '1', str(partial)], timeout=120, check=True)
        os.replace(partial, target)
