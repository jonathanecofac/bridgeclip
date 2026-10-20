"""Edit clip for Automatic runs: an editable project from the run, then a new export.

The original clip is never overwritten; edits render through the same manual
export path as review projects, including captions and the title card.
"""
import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from clip_engine.services.manual_editor import (AUTOMATIC_PADDING_MS, EditorError, _subtract, automatic_candidates,
    run_editor, validate_candidate)
from clip_engine.services.rendering_service import RenderingService


def automatic_output(**overrides):
    output = {
        'job_id': 'job-1', 'source_video_url': 'C:\\Users\\Me\\Downloads\\interview.mp4', 'source_video_title': 'Interview',
        'source_video_duration_seconds': 12.0, 'total_clips': 2,
        'clips': [
            {'clip_index': 0, 's3_url': 'file://clip_00.mp4', 'duration_ms': 4300, 'start_time_ms': 2000, 'end_time_ms': 6000,
             'virality_score': .8, 'layout_type': 'talking_head', 'summary': 'Why it matters', 'tags': []},
            {'clip_index': 1, 's3_url': 'file://clip_01.mp4', 'duration_ms': 3000, 'start_time_ms': 7000, 'end_time_ms': 10000,
             'virality_score': .55, 'layout_type': 'two_shot', 'summary': 'Second', 'tags': []},
        ],
        'metrics': {
            'requested_settings': {'aspect_ratio': '9:16', 'layout_style': 'auto', 'video_speed': 1, 'include_title': True},
            'captions_status': 'enabled',
            'clip_layouts': [
                {'clip_index': 0, 'shots': [
                    {'start_ms': 0, 'end_ms': 2000, 'layout': 'talking_head', 'people': [[.6, .2, .2, .3]]},
                    {'start_ms': 2000, 'end_ms': 4300, 'layout': 'screen', 'people': []}]},
                {'clip_index': 1, 'shots': [
                    {'start_ms': 0, 'end_ms': 3300, 'layout': 'two_shot', 'people': [[.7, .2, .1, .2], [.1, .2, .1, .2]]}]},
            ],
        },
    }
    output.update(overrides)
    return output


def automatic_plan():
    return {'segments': [
        {'start_time_ms': 2000, 'end_time_ms': 6000, 'skip_ranges_ms': [[3000, 3500]], 'reasoning': 'Strong hook'},
        {'start_time_ms': 7000, 'end_time_ms': 10000, 'skip_ranges_ms': []},
    ]}


def test_candidates_keep_the_rendered_interval_skips_framing_and_start_baked():
    aspect, candidates = automatic_candidates(automatic_output(), automatic_plan(), 1920, 1080, 12000)
    assert aspect == '9:16'
    first, second = candidates
    pad = AUTOMATIC_PADDING_MS
    assert first['ranges'] == [[2000 - pad, 3000], [3500, 6000 + pad]]
    assert first['id'] == 'clip-00' and first['source_clip'] == 0 and first['exports'] == [0]
    assert first['status'] == 'baked' and first['title_card'] is True and first['captions'] is True
    assert first['caption_preset'] == 'pop' and first['score'] == pytest.approx(.8) and first['reason'] == 'Strong hook'
    # Fill crop centered on the person, then the whole frame for the screen shot.
    assert [s['layout'] for s in first['scenes']] == ['fill', 'fit']
    assert first['scenes'][1]['at_ms'] == 2000 - pad + 2000
    x, _, w, _ = first['scenes'][0]['crops'][0]
    assert x + w / 2 == pytest.approx(.7)
    # Two people become a split, left speaker on top.
    assert second['scenes'][0]['layout'] == 'split'
    top, bottom = second['scenes'][0]['crops']
    assert top[0] < bottom[0]
    for c in candidates:
        validate_candidate(c, 12000)


def test_candidates_skip_editor_exports_and_ignore_a_changed_plan():
    output = automatic_output()
    output['clips'].append({**output['clips'][0], 'clip_index': 2, 'editor_candidate': 'clip-00', 'editor_revision': 1})
    plan = automatic_plan()
    plan['segments'][0]['start_time_ms'] = 2500
    output['metrics']['requested_settings'].update(caption_preset='neon', include_title=False, video_speed=1.25)
    _, candidates = automatic_candidates(output, plan, 1920, 1080, 12000)
    assert [c['id'] for c in candidates] == ['clip-00', 'clip-01']
    assert candidates[0]['ranges'] == [[2000 - AUTOMATIC_PADDING_MS, 6000 + AUTOMATIC_PADDING_MS]]
    assert candidates[0]['caption_preset'] == 'neon' and candidates[0]['title_card'] is False and candidates[0]['video_speed'] == 1.25


def test_candidates_for_landscape_and_disabled_captions():
    output = automatic_output()
    output['metrics']['requested_settings']['aspect_ratio'] = '16:9'
    output['metrics']['captions_status'] = 'disabled_by_request'
    aspect, candidates = automatic_candidates(output, automatic_plan(), 1920, 1080, 12000)
    assert aspect == '16:9'
    assert all(c['captions'] is False and len(c['scenes']) == 1 and c['scenes'][0]['crops'][0] == [0, 0, 1, 1] for c in candidates)


def test_subtract_keeps_order_and_drops_slivers():
    assert _subtract(0, 1000, [[100, 150], [500, 600], [950, 2000]]) == [[0, 100], [150, 500], [600, 950]]
    assert _subtract(0, 1000, [[50, 150]]) == [[150, 1000]]
    assert _subtract(0, 1000, [[400, 600]]) == [[0, 400], [600, 1000]]
    assert _subtract(0, 1000, [['x', 2]]) == [[0, 1000]]


# A folder name that breaks naive shell quoting and FFmpeg filter escaping on Windows and Linux.
TRAP = "Mes clips d'été [v2]; test,1"


def ffmpeg_ready():
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('FFmpeg and FFprobe are needed for the actual render check')


def make_source(path, seconds=12):
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', f'testsrc2=size=640x360:rate=30:duration={seconds}',
        '-f', 'lavfi', '-i', f'sine=frequency=440:duration={seconds}', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest', str(path)], check=True, capture_output=True, timeout=60)


def probe(path):
    result = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)],
        check=True, capture_output=True, timeout=30)
    return json.loads(result.stdout)


def transcript():
    words = [('Bonjour', 2100, 2500), ('tout', 2600, 2900), ('le', 3000, 3100), ('monde', 3600, 4000),
             ('voici', 4100, 4400), ("l'été", 4500, 5000)]
    return {'segments': [{'start_time_ms': 2100, 'end_time_ms': 5000, 'text': " ".join(w for w, _, _ in words),
        'words': [{'word': w, 'start_time_ms': a, 'end_time_ms': b} for w, a, b in words]}]}


def automatic_run(tmp_path):
    library = tmp_path / TRAP
    run = library / 'd56260a6-c485-4093-9fd0-8d150726792b'
    run.mkdir(parents=True)
    original = tmp_path / 'Vidéos source' / "l'interview [final].mp4"
    original.parent.mkdir()
    make_source(original)
    make_source(run / 'clip_00.mp4', seconds=4)  # Stands in for the original Automatic render.
    (run / 'job_output.json').write_text(json.dumps(automatic_output(source_video_url=str(original))), encoding='utf8')
    (run / 'plan.json').write_text(json.dumps(automatic_plan()), encoding='utf8')
    (run / 'transcript.json').write_text(json.dumps(transcript()), encoding='utf8')
    os.link(original, run / 'editor-source.mp4')  # Main links (or copies) the original before the worker runs.
    return library, run


def test_edit_clip_end_to_end_creates_project_then_exports_a_new_mp4(monkeypatch, tmp_path):
    ffmpeg_ready()
    library, run = automatic_run(tmp_path)
    renderer = RenderingService()
    monkeypatch.setattr(renderer.settings, 'local_mode', True)
    original_clip = (run / 'clip_00.mp4').read_bytes()

    asyncio.run(run_editor({'run': str(run), 'library': str(library), 'action': 'create-project'}))
    project = json.loads((run / 'editor-project.json').read_text(encoding='utf8'))
    assert json.loads((run / 'job_output.json').read_text(encoding='utf8'))['editor_project'] is True
    assert (run / 'editor-preview.mp4').is_file() and project['frame_preview'] is True
    assert (project['width'], project['height']) == (640, 360) and abs(project['duration_ms'] - 12000) < 100
    assert [c['status'] for c in project['candidates']] == ['baked', 'baked']
    assert project['transcript'][0]['text'].startswith('Bonjour')

    # Re-running is idempotent and never rebuilds a project the user may have edited.
    project['candidates'][0]['title'] = 'Edited title'
    (run / 'editor-project.json').write_text(json.dumps(project), encoding='utf8')
    asyncio.run(run_editor({'run': str(run), 'library': str(library), 'action': 'create-project'}))
    assert json.loads((run / 'editor-project.json').read_text(encoding='utf8'))['candidates'][0]['title'] == 'Edited title'

    # Trim and split: keep 2.0-3.0 s and 3.6-4.6 s of the source, with captions and the title card.
    c = project['candidates'][0]
    c.update(ranges=[[2000, 3000], [3600, 4600]], status='ready', captions=True, title_card=True)
    (run / 'editor-project.json').write_text(json.dumps(project), encoding='utf8')
    asyncio.run(run_editor({'run': str(run), 'library': str(library), 'revision': project['revision'],
                            'candidate_id': c['id'], 'action': 'export'}))

    output = json.loads((run / 'job_output.json').read_text(encoding='utf8'))
    edited = output['clips'][-1]
    assert edited['clip_index'] == 2 and edited['edited_from_clip'] == 0 and edited['editor_candidate'] == 'clip-00'
    assert (run / 'clip_00.mp4').read_bytes() == original_clip, 'The original clip must never be overwritten'
    assert edited['virality_score'] == output['clips'][0]['virality_score'] == .8
    info = probe(edited['s3_url'])
    streams = {s['codec_type']: s for s in info['streams']}
    assert streams['video']['codec_name'] in ('h264', 'hevc') and streams['audio']['codec_name'] == 'aac'
    assert (int(streams['video']['width']), int(streams['video']['height'])) == (1080, 1920)
    assert abs(float(info['format']['duration']) - 2.0) < .15
    saved = json.loads((run / 'editor-project.json').read_text(encoding='utf8'))
    assert saved['candidates'][0]['status'] == 'baked' and saved['candidates'][0]['exports'] == [0, 2]


def test_create_project_rejects_a_different_video(tmp_path):
    ffmpeg_ready()
    library, run = automatic_run(tmp_path)
    (run / 'editor-source.mp4').unlink()
    make_source(run / 'editor-source.mp4', seconds=5)
    with pytest.raises(EditorError) as error:
        asyncio.run(run_editor({'run': str(run), 'library': str(library), 'action': 'create-project'}))
    assert error.value.editor_code == 'duration'
    assert not (run / 'editor-project.json').exists() and not (run / 'editor-preview.mp4').exists()
    assert json.loads((run / 'job_output.json').read_text(encoding='utf8')).get('editor_project') is not True


def test_create_project_requires_the_linked_source(tmp_path):
    ffmpeg_ready()
    library, run = automatic_run(tmp_path)
    (run / 'editor-source.mp4').unlink()
    with pytest.raises(Exception) as error:
        asyncio.run(run_editor({'run': str(run), 'library': str(library), 'action': 'create-project'}))
    assert getattr(error.value, 'editor_code', None) == 'source_missing'


def frame(path, at=None):
    import numpy as np
    args = ['ffmpeg', '-v', 'error', *(['-ss', f'{at:.3f}'] if at is not None else []), '-i', str(path), '-frames:v', '1',
            '-vf', 'scale=540:960', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']
    return np.frombuffer(subprocess.run(args, capture_output=True, check=True, timeout=60).stdout, dtype=np.uint8).reshape(960, 540, 3).astype(int)


@pytest.mark.parametrize('preset, style, ranges, at_ms, offset_s', [
    # Future words of the on-screen group lie after the playhead ("MONDE" while "LE" is spoken).
    ('viral_bold', {}, [[2000, 5000]], 3200, 1.2),
    # Custom style, cut inside a caption group, retimed and inserted lines.
    ('hormozi', {'primary_color': '#FF00FF', 'font_size': 120, 'line_box_color': '#000000', 'x': .4}, [[2000, 3000], [3600, 4800]], 4200, 1.6),
    ('cinematic', {'max_words_per_line': 3}, [[2050, 4900]], 4450, 2.4),
])
def test_exact_preview_matches_the_exported_frame_and_changes_nothing(monkeypatch, tmp_path, preset, style, ranges, at_ms, offset_s):
    """The preview is rendered by the export path: same captions, style overrides, title card and framing."""
    ffmpeg_ready()
    library, run = automatic_run(tmp_path)
    asyncio.run(run_editor({'run': str(run), 'library': str(library), 'action': 'create-project'}))
    project = json.loads((run / 'editor-project.json').read_text(encoding='utf8'))
    c = project['candidates'][0]
    c.update(ranges=ranges, status='ready', title_card=True, caption_preset=preset, caption_style=style)
    if preset == 'hormozi':
        c.update(caption_edits=[{'segment': 0, 'text': 'Bonjour tout le monde voici été', 'start_ms': 2000, 'end_ms': 4800}],
                 caption_inserts=[{'start_ms': 4000, 'end_ms': 4700, 'text': 'Ajouté'}])
    (run / 'editor-project.json').write_text(json.dumps(project), encoding='utf8')
    before = (run / 'editor-project.json').read_bytes(), (run / 'job_output.json').read_bytes()
    frame_id = 'a' * 32
    asyncio.run(run_editor({'run': str(run), 'library': str(library), 'revision': 0, 'candidate_id': c['id'],
                            'action': 'preview-frame', 'at_ms': at_ms, 'frame_id': frame_id}))
    preview = run / f'editor-frame-{frame_id}.png'
    assert preview.is_file()
    assert ((run / 'editor-project.json').read_bytes(), (run / 'job_output.json').read_bytes()) == before
    asyncio.run(run_editor({'run': str(run), 'library': str(library), 'revision': 0, 'candidate_id': c['id'], 'action': 'export'}))
    exported = json.loads((run / 'job_output.json').read_text(encoding='utf8'))['clips'][-1]['s3_url']
    changed = int((abs(frame(preview) - frame(exported, offset_s)).max(axis=2) > 80).sum())
    assert changed < 150, f'{changed} pixels of the preview differ from the export'
    if preset == 'hormozi':
        pixels = frame(preview)
        assert ((pixels[:, :, 0] > 200) & (pixels[:, :, 1] < 80) & (pixels[:, :, 2] > 200)).sum() > 200, 'custom color drawn'
    with pytest.raises(EditorError):
        asyncio.run(run_editor({'run': str(run), 'library': str(library), 'revision': 1, 'candidate_id': c['id'],
                                'action': 'preview-frame', 'at_ms': 1000, 'frame_id': 'b' * 32}))
