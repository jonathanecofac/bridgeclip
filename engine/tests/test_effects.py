"""Editor effects: looks on part of a clip, fades, cut transitions and slow motion, rendered for real."""
import asyncio
import json
import subprocess

import pytest

from clip_engine.services.clip_editor import TimeMap
from clip_engine.services.effects import audio_fade_filters, look_filters, picture_filters, validate_effects
from clip_engine.services.manual_editor import run_editor
from tests.test_automatic_edit import automatic_run, ffmpeg_ready, frame, probe


def look(**extra):
    return {'start_ms': 3000, 'end_ms': 4000, 'brightness': .3, 'contrast': 1.0, 'saturation': 1.0, 'sharpen': 0, 'vignette': False, **extra}


def test_validation_is_strict_and_fills_defaults():
    assert validate_effects(None, 1000) == {'fade_in_ms': 0, 'fade_out_ms': 0, 'transition': 'none', 'transition_ms': 300, 'looks': []}
    assert validate_effects({'looks': [look()]}, 9000)['looks'][0]['brightness'] == .3
    for bad in [{'fade_in_ms': 5000}, {'fade_out_ms': 1.5}, {'transition': 'wipe'}, {'transition_ms': 50}, {'other': 1},
                {'looks': [look(brightness=.9)]}, {'looks': [look(contrast=3)]}, {'looks': [look(saturation=-1)]},
                {'looks': [look(end_ms=3050)]}, {'looks': [look(vignette='yes')]}, {'looks': [{**look(), 'extra': 1}]},
                {'looks': [look()] * 21}, []]:
        with pytest.raises(ValueError):
            validate_effects(bad, 9000)


def test_filters_use_lgpl_timeline_filters_on_the_edited_clock():
    time_map = TimeMap([(0, 2000), (2500, 5000)], 5000)
    chain = look_filters([look(sharpen=.8, vignette=True, saturation=1.3)], 1000, time_map)
    assert chain.startswith("lutyuv=y='clip((val-maxval/2)*1+maxval/2+0.3*maxval,minval,maxval)'")
    # Source 3.0-4.0 s; 3.0-3.5 s was cut, 3.5-4.0 s plays at 2.0-2.5 s on the edited clock.
    assert "enable='between(t,2.000,2.500)'" in chain
    assert 'unsharp=lx=5:ly=5:la=0.8' in chain and 'vignette=angle=PI/5' in chain
    assert not any(name in chain for name in ('eq=', 'hue=', 'colorbalance')), 'GPL-only filters are not in the Windows build'
    effects = validate_effects({'fade_in_ms': 500, 'fade_out_ms': 1000, 'transition': 'flash', 'transition_ms': 400}, 9000)
    picture = picture_filters(effects, time_map.keeps, 2, time_map.output_ms)
    assert picture.startswith('fade=t=in:st=0:d=0.500,fade=t=out:st=1.250:d=1.000')
    assert "color=white:enable='between(t,0.800,1.000)'" in picture, 'cut at 2.0 s edited = 1.0 s at 2x'
    assert picture_filters(effects, time_map.keeps, 2, time_map.output_ms, fade_in=False).startswith('fade=t=out')
    assert audio_fade_filters(effects, 2, 4500) == 'afade=t=in:st=0:d=1.000,afade=t=out:st=2.500:d=2.000'


def luma(pixels):
    return float(pixels.mean())


def project_with(tmp_path, **candidate):
    library, run = automatic_run(tmp_path)
    asyncio.run(run_editor({'run': str(run), 'library': str(library), 'action': 'create-project'}))
    project = json.loads((run / 'editor-project.json').read_text(encoding='utf8'))
    project['candidates'][0].update({'status': 'ready', 'captions': False, 'title_card': False, **candidate})
    return library, run, project


def export(library, run, project):
    c = project['candidates'][0]
    c['status'] = 'ready'
    (run / 'editor-project.json').write_text(json.dumps(project), encoding='utf8')
    asyncio.run(run_editor({'run': str(run), 'library': str(library), 'revision': project['revision'], 'candidate_id': c['id'], 'action': 'export'}))
    project['revision'] += 1
    return json.loads((run / 'job_output.json').read_text(encoding='utf8'))['clips'][-1]['s3_url']


def test_look_fades_and_transitions_render_where_asked(tmp_path):
    ffmpeg_ready()
    library, run, project = project_with(tmp_path, ranges=[[2000, 3500], [4000, 6000]])
    plain = export(library, run, project)
    project['candidates'][0]['effects'] = {'fade_in_ms': 400, 'fade_out_ms': 400, 'transition': 'flash', 'transition_ms': 400,
                                           'looks': [look(start_ms=4500, end_ms=5500, brightness=.25)]}
    styled = export(library, run, project)
    # Output: 0-1.5 s first cut, join at 1.5 s, 1.5-3.5 s second cut; the look covers 2.0-3.0 s.
    assert luma(frame(styled, .02)) < 25, 'fade from black'
    assert abs(luma(frame(styled, .8)) - luma(frame(plain, .8))) < 2, 'untouched between effects'
    assert luma(frame(styled, 1.5)) > luma(frame(plain, 1.5)) + 60, 'white flash at the cut'
    assert luma(frame(styled, 2.5)) > luma(frame(plain, 2.5)) + 30, 'brighter look on its interval'
    assert abs(luma(frame(styled, 3.1)) - luma(frame(plain, 3.1))) < 2, 'look ends with its interval'
    assert luma(frame(styled, 3.45)) < 60, 'fade to black at the end'
    # The exact preview reproduces each of them.
    c = project['candidates'][0]
    for at_ms, offset in [(2050, .05), (3450, 1.45), (5000, 2.5), (5950, 3.45)]:
        frame_id = f'{at_ms:032x}'
        asyncio.run(run_editor({'run': str(run), 'library': str(library), 'revision': project['revision'], 'candidate_id': c['id'],
                                'action': 'preview-frame', 'at_ms': at_ms, 'frame_id': frame_id}))
        changed = int((abs(frame(run / f'editor-frame-{frame_id}.png') - frame(styled, offset)).max(axis=2) > 80).sum())
        assert changed < 150, f'preview at {at_ms} differs by {changed} pixels'


@pytest.mark.parametrize('speed, ranges', [(.5, [[2000, 4000]]), (.5, [[1850, 5650]]), (.75, [[2000, 3500], [4000, 6100]])])
def test_slow_motion_lengthens_the_clip_with_audio_in_sync(tmp_path, speed, ranges):
    ffmpeg_ready()
    library, run, project = project_with(tmp_path, ranges=ranges, video_speed=speed)
    slow = export(library, run, project)
    expected = sum(b - a for a, b in ranges) / speed / 1000
    info = probe(slow)
    durations = {s['codec_type']: float(s['duration']) for s in info['streams'] if s['codec_type'] in ('audio', 'video')}
    assert abs(durations['video'] - expected) < .05 and abs(durations['audio'] - expected) < .06, (durations, expected)


def test_exact_preview_matches_export_everywhere_with_every_feature_combined(tmp_path):
    """Cuts starting between source frames, 1.25x speed, captions with an added line, an animated text,
    a look, fades and a dip transition: the exact preview equals the export at many playhead positions."""
    ffmpeg_ready()
    library, run, project = project_with(tmp_path, ranges=[[2050, 3300], [3700, 5900]], video_speed=1.25, captions=True,
        title_card=True, caption_preset='karaoke', caption_inserts=[{'start_ms': 3800, 'end_ms': 4400, 'text': 'En plus'}],
        text_overlays=[{'text': 'Hook', 'start_ms': 2050, 'end_ms': 3000, 'x': .5, 'y': .2, 'size': 90, 'font': 'Anton',
                        'color': '#FFFFFF', 'outline_color': '#000000', 'outline': 4, 'background': '#E5202E', 'background_opacity': 1.0,
                        'uppercase': True, 'animation': 'pop'}],
        effects={'fade_in_ms': 300, 'fade_out_ms': 300, 'transition': 'dip', 'transition_ms': 400,
                 'looks': [look(start_ms=4600, end_ms=5900, brightness=-.1, contrast=1.3, saturation=1.6, sharpen=.6, vignette=True)]})
    exported = export(library, run, project)
    c = project['candidates'][0]

    def edited(at_ms):
        before = sum(min(b, at_ms) - a for a, b in c['ranges'] if a < at_ms)
        return before / 1.25 / 1000
    failures = []
    for at_ms in (2060, 2300, 3150, 3290, 3720, 4100, 4700, 5850):
        frame_id = f'{at_ms:032x}'
        asyncio.run(run_editor({'run': str(run), 'library': str(library), 'revision': project['revision'], 'candidate_id': c['id'],
                                'action': 'preview-frame', 'at_ms': at_ms, 'frame_id': frame_id}))
        changed = int((abs(frame(run / f'editor-frame-{frame_id}.png') - frame(exported, edited(at_ms))).max(axis=2) > 80).sum())
        if changed >= 150:
            failures.append((at_ms, changed))
    assert not failures, f'preview differs from the export at {failures}'
