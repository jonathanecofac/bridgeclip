"""Text overlays and hooks: validation, timing across cuts, and real renders."""
import asyncio
import json

import pytest

from clip_engine.services.clip_editor import TimeMap
from clip_engine.services.manual_editor import run_editor
from clip_engine.services.text_overlays import output_intervals, validate_text_overlays, write_text_overlays
from tests.test_automatic_edit import automatic_run, ffmpeg_ready, frame


def overlay(**extra):
    return {'text': 'Regarde ça !', 'start_ms': 2000, 'end_ms': 4000, 'x': .5, 'y': .2, 'size': 90, 'font': 'Montserrat Black',
            'color': '#FF0000', 'outline_color': '#000000', 'outline': 6, 'background': None, 'background_opacity': .7,
            'uppercase': True, 'animation': 'none', **extra}


def test_validation_is_strict():
    assert validate_text_overlays([overlay()], 12000)[0]['text'] == 'Regarde ça !'
    assert validate_text_overlays(None, 1000) == []
    for bad in [{'text': ''}, {'text': 'a' * 201}, {'text': 'a\nb\nc\nd\ne'}, {'text': 'bell\x07'}, {'end_ms': 2050},
                {'end_ms': 99999}, {'x': 1.2}, {'size': 10}, {'size': 90.5}, {'font': 'Comic Sans'}, {'color': 'red'},
                {'outline': 30}, {'background': 'black'}, {'background_opacity': 2}, {'uppercase': 'yes'}, {'animation': 'spin'}]:
        with pytest.raises(ValueError):
            validate_text_overlays([overlay(**bad)], 12000)
    with pytest.raises(ValueError):
        validate_text_overlays([overlay()] * 21, 12000)


def test_overlays_follow_cuts_and_animate_only_at_their_start():
    # Window starts at 1000; keeps 1000-3000 and 3500-6000 (source), i.e. output 0-2000 and 2000-4500.
    time_map = TimeMap([(0, 2000), (2500, 5000)], 5000)
    assert output_intervals(2000, 4000, 1000, time_map) == [(1000, 2500, True)], 'joined across the cut'
    assert output_intervals(3200, 3400, 1000, time_map) == [], 'entirely inside removed footage'
    assert output_intervals(500, 2000, 1000, time_map) == [(0, 1000, False)], 'starts before the window: no entrance'


def test_written_ass_positions_text_and_plate(tmp_path):
    time_map = TimeMap([(0, 5000)], 5000)
    path = write_text_overlays([overlay(background='#101010', animation='fade', text="Ligne 1\nl'été {x}")], 1000, time_map, 1080, 1920, str(tmp_path / 't.ass'))
    content = open(path, encoding='utf8').read()
    assert '\\pos(540,384)' in content and '\\fad(200,200)' in content
    assert "LIGNE 1\\NL'ÉTÉ X" in content, 'uppercase, line break, braces removed'
    assert content.count('Dialogue:') == 2, 'plate layer + text layer'
    assert 'Dialogue: 0,' in content and ',Plate,,' in content and '\\bord20' in content, 'per-line box with padding'
    assert write_text_overlays([overlay(start_ms=8000, end_ms=9000)], 1000, time_map, 1080, 1920, str(tmp_path / 'none.ass')) is None


def changed(a, b):
    return int((abs(a - b).max(axis=2) > 80).sum())


def test_overlay_is_burned_in_even_where_captions_are_suppressed_and_preview_matches(tmp_path):
    ffmpeg_ready()
    library, run = automatic_run(tmp_path)
    asyncio.run(run_editor({'run': str(run), 'library': str(library), 'action': 'create-project'}))
    project = json.loads((run / 'editor-project.json').read_text(encoding='utf8'))
    c = project['candidates'][0]
    c.update(ranges=[[2000, 5000]], status='ready', captions=True, caption_suppression_ranges=[[2000, 5000]])

    def export(revision):
        (run / 'editor-project.json').write_text(json.dumps(project), encoding='utf8')
        asyncio.run(run_editor({'run': str(run), 'library': str(library), 'revision': revision, 'candidate_id': c['id'], 'action': 'export'}))
        return json.loads((run / 'job_output.json').read_text(encoding='utf8'))['clips'][-1]['s3_url']
    plain = export(0)
    c.update(status='ready', text_overlays=[overlay(start_ms=2500, end_ms=4500, background='#FFFFFF', background_opacity=1.0, animation='pop')])
    project['revision'] = 1
    (run / 'editor-project.json').write_text(json.dumps(project), encoding='utf8')
    asyncio.run(run_editor({'run': str(run), 'library': str(library), 'revision': 1, 'candidate_id': c['id'],
                            'action': 'preview-frame', 'at_ms': 2700, 'frame_id': 'c' * 32}))
    texted = export(1)
    assert changed(frame(texted, 1.5), frame(plain, 1.5)) > 3000, 'overlay drawn while captions are suppressed'
    assert changed(frame(texted, .2), frame(plain, .2)) < 50, 'nothing before its start'
    assert changed(frame(run / f"editor-frame-{'c' * 32}.png"), frame(texted, .7)) < 150, 'preview matches the export during the pop'
