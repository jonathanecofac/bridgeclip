"""Editor audio: voice level, mute, normalization, imported background music and ducking, rendered for real."""
import asyncio
import json
import re
import subprocess

import pytest

from clip_engine.services.audio_mix import duck_expression, speech_intervals, validate_audio
from clip_engine.services.manual_editor import run_editor
from tests.test_automatic_edit import ffmpeg_ready, probe
from tests.test_effects import export, project_with


def music(**extra):
    return {'file': 'editor-music-' + 'a' * 32 + '.mp4', 'name': 'Track.mp3', 'volume_db': -12, 'offset_ms': 0,
            'duck': True, 'duck_db': -12, 'fade_in_ms': 0, 'fade_out_ms': 0, **extra}


def test_validation_is_strict_and_fills_defaults():
    assert validate_audio(None) == {'volume_db': 0, 'mute': False, 'normalize': True, 'music': None}
    assert validate_audio({'volume_db': 6.5, 'music': music()})['music']['duck_db'] == -12
    for bad in [{'volume_db': 20}, {'volume_db': float('nan')}, {'mute': 1}, {'normalize': 'no'}, {'other': 1}, [],
                {'music': music(file='../clip_00.mp4')}, {'music': music(file='editor-music-x.mp4')},
                {'music': music(volume_db=10)}, {'music': music(offset_ms=-1)}, {'music': music(offset_ms=1.5)},
                {'music': music(duck='yes')}, {'music': music(duck_db=-40)}, {'music': music(fade_in_ms=6000)},
                {'music': music(name='')}, {'music': music(name='a\nb')}, {'music': {**music(), 'path': '/x'}}]:
        with pytest.raises(ValueError):
            validate_audio(bad)


def test_speech_follows_cuts_and_speed_and_bridges_short_pauses():
    words = [(1000, 1400), (1500, 1900), (3000, 3400), (6000, 6500)]
    # 1.5-2.0 s and 5-7 s are cut; the 1.0 s pause (1.9-3.0) is kept as a gap.
    assert speech_intervals(words, [(1000, 1500), (2000, 5000)], 1) == [(0, 400), (1500, 1900)]
    # At 2x the pause lasts 0.55 s on the final clock, short enough to keep the music down.
    assert speech_intervals(words, [(1000, 1500), (2000, 5000)], 2) == [(0, 950)]
    assert speech_intervals(words, [(1000, 1500), (2000, 5000)], 1.5) == [(0, 267), (1000, 1267)]
    # A pause shorter than SPEECH_GAP_MS keeps the music down.
    assert speech_intervals([(0, 1000), (1400, 2000)], [(0, 3000)], 1) == [(0, 2000)]
    expression = duck_expression([(1000, 2000)], -12)
    assert expression.startswith('1-0.74881*clip(') and '(t-0.800)/0.2' in expression and '(2.200-t)/0.2' in expression


def tone(path, frequency, seconds, extra=()):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency={frequency}:duration={seconds}',
                    *extra, str(path)], check=True, capture_output=True, timeout=60)


def rms(path, start, end):
    """RMS level (dB) of the exported audio between two times in seconds."""
    result = subprocess.run(['ffmpeg', '-v', 'info', '-i', str(path), '-vn', '-af',
                             f'atrim=start={start}:end={end},astats=measure_overall=RMS_level:measure_perchannel=none',
                             '-f', 'null', '-'], capture_output=True, timeout=60, text=True)
    levels = re.findall(r'RMS level dB: (-?[\d.]+|-inf)', result.stderr)
    assert levels, result.stderr[-500:]
    return float('-inf') if levels[-1] == '-inf' else float(levels[-1])


def import_track(tmp_path, library, run, frequency=1000, seconds=1.5):
    source = tmp_path / 'Musique dé fond [v2].mp3'
    tone(source, frequency, seconds, ['-c:a', 'libmp3lame'] if b'libmp3lame' in subprocess.run(
        ['ffmpeg', '-v', 'error', '-encoders'], capture_output=True).stdout else [])
    music_id = 'b' * 32
    asyncio.run(run_editor({'run': str(run), 'library': str(library), 'action': 'import-music', 'input': str(source), 'music_id': music_id}))
    return f'editor-music-{music_id}.mp4'


def test_import_keeps_only_the_audio_as_aac_in_the_editor_folder(tmp_path):
    ffmpeg_ready()
    library, run, _ = project_with(tmp_path)
    name = import_track(tmp_path, library, run)
    info = probe(run / name)
    assert [s['codec_type'] for s in info['streams']] == ['audio']
    assert info['streams'][0]['codec_name'] == 'aac' and info['streams'][0]['sample_rate'] == '48000' and info['streams'][0]['channels'] == 2
    assert abs(float(info['format']['duration']) - 1.5) < .1
    bogus = tmp_path / 'not audio.mp3'
    bogus.write_text('hello', encoding='utf8')
    with pytest.raises(Exception) as failure:
        asyncio.run(run_editor({'run': str(run), 'library': str(library), 'action': 'import-music', 'input': str(bogus), 'music_id': 'c' * 32}))
    assert failure.value.editor_code == 'music_invalid'
    assert not (run / f"editor-music-{'c' * 32}.mp4").exists()
    with pytest.raises(Exception) as failure:
        asyncio.run(run_editor({'run': str(run), 'library': str(library), 'action': 'import-music', 'input': str(tmp_path / 'missing.mp3'), 'music_id': 'd' * 32}))
    assert failure.value.editor_code == 'music_invalid'


def test_volume_mute_and_normalization_change_the_voice(tmp_path):
    ffmpeg_ready()
    library, run, project = project_with(tmp_path, ranges=[[1000, 4000]])
    plain = export(library, run, project)
    project['candidates'][0]['audio'] = {'normalize': False, 'volume_db': -10}
    quiet = export(library, run, project)
    project['candidates'][0]['audio'] = {'normalize': False, 'volume_db': 0}
    raw = export(library, run, project)
    project['candidates'][0]['audio'] = {'mute': True}
    muted = export(library, run, project)
    assert abs(rms(quiet, .5, 2.5) - (rms(raw, .5, 2.5) - 10)) < 1, 'gain in dB without normalization'
    assert rms(plain, .5, 2.5) != pytest.approx(rms(raw, .5, 2.5), abs=.5), 'normalization is on by default'
    assert rms(muted, .2, 2.8) < -80
    durations = {s['codec_type']: float(s['duration']) for s in probe(muted)['streams']}
    assert abs(durations['audio'] - 3) < .06 and abs(durations['video'] - 3) < .05


def test_music_loops_under_the_clip_and_ducks_while_people_speak(tmp_path):
    ffmpeg_ready()
    library, run, project = project_with(tmp_path, ranges=[[1000, 7000]], video_speed=1)
    name = import_track(tmp_path, library, run)
    # Voice muted so only the music is measured. Speech is 2.1-5.0 s in the source: 1.1-4.0 s in the clip.
    project['candidates'][0]['audio'] = {'mute': True, 'music': {**music(file=name, volume_db=-6, duck_db=-18), 'offset_ms': 500}}
    clip = export(library, run, project)
    durations = {s['codec_type']: float(s['duration']) for s in probe(clip)['streams']}
    assert abs(durations['audio'] - 6) < .06 and abs(durations['video'] - 6) < .05
    loud, ducked, after = rms(clip, .1, .8), rms(clip, 1.5, 3.5), rms(clip, 4.4, 5.9)
    assert loud > -36 and after > -36, "music plays, looped past its 1.5 s length"
    assert abs(after - loud) < 1.5
    assert loud - ducked == pytest.approx(18, abs=1.5), 'lowered by the duck level while people speak'
    # Without ducking, and at half speed (music keeps its own tempo; speech moves on the final clock).
    project['candidates'][0].update(video_speed=.5, audio={'mute': True, 'music': music(file=name, duck=True, duck_db=-18, fade_out_ms=1000)})
    slow = export(library, run, project)
    durations = {s['codec_type']: float(s['duration']) for s in probe(slow)['streams']}
    assert abs(durations['audio'] - 12) < .08 and abs(durations['video'] - 12) < .05
    # Words at 2.2-4.2 and 5.2-8.0 s at half speed: the 1 s pause between them lets the music back up.
    assert rms(slow, 2.6, 3.8) < rms(slow, .5, 1.8) - 15 and rms(slow, 5.6, 7.4) < rms(slow, .5, 1.8) - 15
    assert rms(slow, 4.45, 4.95) > rms(slow, .5, 1.8) - 2
    assert rms(slow, 11.85, 12) < rms(slow, 9, 10) - 10, 'music fades out at the end'


def test_music_with_the_voice_stays_in_sync_and_validates_the_file(tmp_path):
    ffmpeg_ready()
    library, run, project = project_with(tmp_path, ranges=[[1000, 3000], [4000, 6000]])
    name = import_track(tmp_path, library, run)
    project['candidates'][0]['audio'] = {'music': music(file=name, duck=False)}
    project['candidates'][0]['effects'] = {'fade_in_ms': 300, 'transition': 'dip'}
    mixed = export(library, run, project)
    durations = {s['codec_type']: float(s['duration']) for s in probe(mixed)['streams']}
    assert abs(durations['audio'] - 4) < .06 and abs(durations['video'] - 4) < .05
    (run / name).unlink()
    project['candidates'][0]['status'] = 'ready'
    (run / 'editor-project.json').write_text(json.dumps(project), encoding='utf8')
    with pytest.raises(Exception) as failure:
        asyncio.run(run_editor({'run': str(run), 'library': str(library), 'revision': project['revision'],
                                'candidate_id': project['candidates'][0]['id'], 'action': 'export'}))
    assert getattr(failure.value, 'editor_code', None) == 'music_invalid'
