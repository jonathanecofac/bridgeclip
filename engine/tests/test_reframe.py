"""Smart reframing: face analysis turned into editable layouts, and the editor worker action."""
import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest

from clip_engine.services.layout_analyzer import Box, ClipLayoutPlan, LayoutAnalyzer, ShotLayout
from clip_engine.services.manual_editor import manual_plan, run_editor, validate_candidate
from clip_engine.services.reframe import MAX_SCENES, follow_crop, reframe_scenes
from tests.test_automatic_edit import ffmpeg_ready
from tests.test_effects import export, project_with

W, H, ASPECT = 1920, 1080, 9 / 16


def test_follow_crop_matches_the_export_fill_crop():
    crop = follow_crop(.5, .3, W, H, ASPECT)
    assert crop[2] == pytest.approx(1080 * ASPECT / 1920, abs=1e-4) and crop[3] == 1
    assert crop[0] + crop[2] / 2 == pytest.approx(.5, abs=1e-4)
    assert follow_crop(.02, .3, W, H, ASPECT)[0] == 0, 'kept inside the frame'
    assert follow_crop(.99, .3, W, H, ASPECT)[0] == pytest.approx(1 - crop[2], abs=1e-4)
    inset = follow_crop(.5, .5, W, H, ASPECT, Box(.25, .1, .5, .8))
    assert inset[1] >= .1 and inset[1] + inset[3] <= .9 + 1e-4 and inset[0] >= .25


def test_scenes_follow_faces_and_switch_layouts_per_shot():
    plan = ClipLayoutPlan(shots=[
        ShotLayout(0, 4000, 'talking_head', focus_path=[(0, .3, .4), (1500, .3, .4), (3000, .6, .4)]),
        ShotLayout(4000, 7000, 'two_shot', people=[Box(.6, .2, .1, .2), Box(.15, .2, .1, .2)]),
        ShotLayout(7000, 9000, 'screen'),
    ], source_width=W, source_height=H)
    scenes = reframe_scenes(plan, 10000, 19000, W, H, ASPECT)
    assert [s['layout'] for s in scenes] == ['fill', 'fill', 'split', 'fit']
    assert scenes[0]['at_ms'] == 0 and 'transition_ms' not in scenes[0]
    # Holds still, then an eased move that lands on the face at 13.0 s.
    assert scenes[1]['at_ms'] == 11500 and scenes[1]['transition_ms'] == 1500
    assert scenes[1]['crops'][0][0] + scenes[1]['crops'][0][2] / 2 == pytest.approx(.6, abs=1e-3)
    assert scenes[2]['at_ms'] == 14000 and scenes[3]['at_ms'] == 17000
    left, right = scenes[2]['crops']
    assert left[0] < right[0], 'people stacked left to right'
    candidate = {'id': 'c', 'title': 'T', 'ranges': [[10000, 19000]], 'scenes': scenes, 'captions': True, 'caption_preset': 'pop', 'video_speed': 1}
    validate_candidate(candidate, 30000)


def test_long_moves_and_scene_budget():
    path = [(0, .2, .4), (12000, .8, .4)]
    plan = ClipLayoutPlan(shots=[ShotLayout(0, 14000, 'talking_head', focus_path=path)], source_width=W, source_height=H)
    scenes = reframe_scenes(plan, 0, 14000, W, H, ASPECT)
    assert scenes[1]['at_ms'] == 7000 and scenes[1]['transition_ms'] == 5000, 'moves are at most 5 s, ending on the keyframe'
    zigzag = [(i * 300, .3 + .4 * (i % 2), .4) for i in range(200)]
    plan = ClipLayoutPlan(shots=[ShotLayout(0, 61000, 'talking_head', focus_path=zigzag)], source_width=W, source_height=H)
    scenes = reframe_scenes(plan, 0, 61000, W, H, ASPECT)
    assert len(scenes) == MAX_SCENES
    assert all(b['at_ms'] > a['at_ms'] for a, b in zip(scenes, scenes[1:]))
    assert all(100 <= s['transition_ms'] <= 5000 for s in scenes[1:])
    validate_candidate({'id': 'c', 'title': 'T', 'ranges': [[0, 61000]], 'scenes': scenes, 'captions': True, 'caption_preset': 'pop', 'video_speed': 1}, 61000)


def test_worker_writes_layouts_without_changing_the_project(tmp_path):
    ffmpeg_ready()
    library, run, project = project_with(tmp_path)
    (run / 'editor-project.json').write_text(json.dumps(project), encoding='utf8')
    c = project['candidates'][0]
    a = c['ranges'][0][0]
    plan = ClipLayoutPlan(shots=[ShotLayout(0, 1000, 'talking_head', focus_path=[(0, .3, .5)]), ShotLayout(1000, 3000, 'screen')],
                          source_width=project['width'], source_height=project['height'])
    analyze = AsyncMock(return_value=plan)
    with patch.object(LayoutAnalyzer, 'available', new_callable=lambda: property(lambda _: True)), patch.object(LayoutAnalyzer, 'analyze', analyze):
        asyncio.run(run_editor({'run': str(run), 'library': str(library), 'revision': project['revision'], 'candidate_id': c['id'],
                                'action': 'reframe', 'mode': 'auto', 'reframe_id': 'e' * 32}))
    assert analyze.call_args.kwargs['vision'] is False, 'local detection only, no paid vision model'
    result = json.loads((run / f"editor-reframe-{'e' * 32}.json").read_text(encoding='utf8'))
    assert [s['layout'] for s in result['scenes']] == ['fill', 'fit'] and result['scenes'][1]['at_ms'] == a + 1000
    assert json.loads((run / 'editor-project.json').read_text(encoding='utf8'))['revision'] == project['revision']
    with pytest.raises(ValueError):
        asyncio.run(run_editor({'run': str(run), 'library': str(library), 'revision': project['revision'], 'candidate_id': c['id'],
                                'action': 'reframe', 'mode': 'zoom', 'reframe_id': 'f' * 32}))
    with patch.object(LayoutAnalyzer, 'available', new_callable=lambda: property(lambda _: False)), pytest.raises(Exception) as failure:
        asyncio.run(run_editor({'run': str(run), 'library': str(library), 'revision': project['revision'], 'candidate_id': c['id'],
                                'action': 'reframe', 'mode': 'face', 'reframe_id': 'f' * 32}))
    assert failure.value.editor_code == 'reframe_unavailable'


def test_real_analysis_reframes_and_exports(tmp_path):
    ffmpeg_ready()
    if not LayoutAnalyzer().available:
        pytest.skip('OpenCV face detection is not installed')
    library, run, project = project_with(tmp_path)
    (run / 'editor-project.json').write_text(json.dumps(project), encoding='utf8')
    c = project['candidates'][0]
    for mode, layout in (('face', 'fill'), ('auto', 'fit')):
        asyncio.run(run_editor({'run': str(run), 'library': str(library), 'revision': project['revision'], 'candidate_id': c['id'],
                                'action': 'reframe', 'mode': mode, 'reframe_id': ('a' if mode == 'face' else 'b') * 32}))
        scenes = json.loads((run / f"editor-reframe-{('a' if mode == 'face' else 'b') * 32}.json").read_text(encoding='utf8'))['scenes']
        # The test pattern has no people: face mode keeps the speaker crop centered, Auto shows the whole frame.
        assert scenes[0]['layout'] == layout, (mode, scenes)
    c.update(scenes=scenes, reframe='auto')
    manual_plan(project, c)
    clip = export(library, run, project)
    assert clip.endswith('.mp4')
