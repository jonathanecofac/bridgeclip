"""Auto Montage: rush analysis, planning, beat sync and assembly into an editor project, with real FFmpeg renders."""
import asyncio
import json
import shutil
import subprocess

import numpy as np
import pytest

from clip_engine.config import get_settings
from clip_engine.montage import analyze as analysis
from clip_engine.montage import assemble, planner
from clip_engine.montage.beats import beat_times, snap_cuts
from clip_engine.services.manual_editor import run_editor
from tests.test_automatic_edit import ffmpeg_ready, probe

IDS = {'talk': 'a' * 32, 'game': 'b' * 32, 'copy': 'c' * 32, 'tall': 'd' * 32}


def make(path, sources, size='640x360', audio=True):
    """A rush made of distinct shots (hard cuts between test patterns) with a tone that gets louder in the 2nd shot."""
    inputs, filters = [], []
    for i, (pattern, seconds) in enumerate(sources):
        inputs += ['-f', 'lavfi', '-i', f'{pattern}=size={size}:rate=30:duration={seconds}']
        filters.append(f'[{i}:v]format=yuv420p,setsar=1[v{i}]')
    graph = ';'.join(filters) + ';' + ''.join(f'[v{i}]' for i in range(len(sources))) + f'concat=n={len(sources)}:v=1:a=0[v]'
    total = sum(s for _, s in sources)
    cmd = ['ffmpeg', '-v', 'error', '-y', *inputs]
    if audio:
        cmd += ['-f', 'lavfi', '-i', f"aevalsrc='0.05*sin(440*2*PI*t)*(1+8*between(t,{sources[0][1]},{sources[0][1] + sources[1][1]}))':s=48000:d={total}"]
        graph += f';[{len(sources)}:a]anull[a]'
    cmd += ['-filter_complex', graph, '-map', '[v]', *(['-map', '[a]', '-c:a', 'aac'] if audio else []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(path)]
    subprocess.run(cmd, check=True, capture_output=True, timeout=120)


@pytest.fixture
def library(tmp_path):
    ffmpeg_ready()
    lib = tmp_path / "Mes rushs d'été [v2]"
    root = lib / '_rushes'
    (root / 'media').mkdir(parents=True)
    make(root / 'media' / f"{IDS['talk']}.mp4", [('testsrc2', 6), ('smptebars', 6), ('rgbtestsrc', 6)])
    make(root / 'media' / f"{IDS['game']}.mp4", [('pal75bars', 5), ('testsrc', 5), ('smptehdbars', 5)])
    make(root / 'media' / f"{IDS['tall']}.mp4", [('testsrc2', 4), ('smptebars', 4)], size='360x640')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(root / 'media' / f"{IDS['talk']}.mp4"), '-vf', 'scale=480:270',
                    '-c:v', 'libx264', '-crf', '30', '-c:a', 'aac', str(root / 'media' / f"{IDS['copy']}.mov")], check=True, capture_output=True, timeout=120)
    (root / 'library.json').write_text(json.dumps({'version': 1, 'rushes': [
        {'id': IDS['talk'], 'name': 'Interview.mp4', 'status': 'ready'}, {'id': IDS['game'], 'name': 'Partie ranked.mp4', 'status': 'ready'},
        {'id': IDS['copy'], 'name': 'Interview (copie).mov', 'status': 'ready'}, {'id': IDS['tall'], 'name': 'Story.mp4', 'status': 'ready'}]}), encoding='utf8')
    return lib, root


def fake_transcript(monkeypatch):
    from clip_engine.services import transcription_service as ts

    async def transcribe(self, video_path, work_dir, *args, **kwargs):
        first = [('Bonjour', 1000, 1500), ('tout', 1600, 1900), ('le', 2000, 2100), ('monde.', 2200, 2700)]
        second = [('Incroyable', 6200, 6900), ('regardez', 7000, 7600), ('ça.', 7700, 8300)]
        segs = [ts.TranscriptSegment(1000, 2700, 'Bonjour tout le monde.', words=[ts.TranscriptWord(w, a, b) for w, a, b in first]),
                ts.TranscriptSegment(6200, 8300, 'Incroyable regardez ça.', words=[ts.TranscriptWord(w, a, b) for w, a, b in second])]
        return ts.TranscriptionResult(segments=segs, full_text='', language='fr', duration_seconds=15)
    monkeypatch.setattr(ts.TranscriptionService, 'transcribe', transcribe)


def analyze_all(root, ids=IDS.values()):
    for rush_id in ids:
        asyncio.run(analysis.analyze_rush(root, rush_id, 'name'))


def test_analysis_finds_shots_loudness_keyframes_and_duplicates(library, monkeypatch):
    lib, root = library
    monkeypatch.setattr(get_settings(), 'openrouter_api_key', None)
    analyze_all(root, [IDS['talk'], IDS['copy']])
    talk = analysis.load_analysis(root, IDS['talk'])
    assert talk['info']['duration_ms'] == pytest.approx(18000, abs=100) and talk['info']['has_audio']
    assert [round(c / 1000) for c in talk['cuts']] == [6, 12], talk['cuts']
    loud = np.array(talk['energy']['db'])
    assert loud[6000 // 250:12000 // 250].mean() > loud[:6000 // 250].mean() + 10, 'the second shot is louder'
    assert len(talk['hashes']['values']) == 9 and all(len(h) == 16 for h in talk['hashes']['values'])
    assert all((root / 'thumbs' / IDS['talk'] / k['file']).is_file() for k in talk['keyframes'])
    assert [(s['start_ms'], s['end_ms']) for s in talk['segments']] == [(0, talk['cuts'][0]), (talk['cuts'][0], talk['cuts'][1]), (talk['cuts'][1], talk['info']['duration_ms'])]
    loudest = max(talk['segments'], key=lambda s: s['score'])
    assert loudest['start_ms'] == talk['cuts'][0], 'the loud shot scores highest without vision'
    assert any('No OpenRouter key' in n for n in talk['notes'])
    copy = json.loads((root / 'analysis' / f"{IDS['copy']}.summary.json").read_text(encoding='utf8'))
    assert copy['duplicate_of'] == IDS['talk'] and copy['similarity'] >= .75, 'a re-encoded copy is recognized'
    with pytest.raises(analysis.AnalysisError):
        asyncio.run(analysis.analyze_rush(root, 'e' * 32))


def test_vision_and_transcript_feed_the_segments(library, monkeypatch):
    lib, root = library
    monkeypatch.setattr(get_settings(), 'openrouter_api_key', 'sk-test')
    fake_transcript(monkeypatch)
    seen = {}

    async def describe(settings, frames, folder, name):
        seen['frames'] = len(frames)
        return analysis.clean_vision({'summary': 'A tense ranked match.', 'category': 'gaming', 'frames': [
            {'index': i, 'description': f'frame {i}', 'tags': ['Headshot'] if f['at_ms'] == 7500 else ['menu'], 'people': 0,
             'action': 9 if f['at_ms'] == 7500 else 2, 'interest': 10 if f['at_ms'] == 7500 else 3, 'shot': 'gameplay'} for i, f in enumerate(frames)] + [{'index': 99}]}, len(frames), .0021)
    monkeypatch.setattr(analysis, 'describe_frames', describe)
    summary = asyncio.run(analysis.analyze_rush(root, IDS['game'], 'Partie ranked.mp4'))
    assert summary['category'] == 'gaming' and summary['speech'] and summary['vision_cost_usd'] == .0021 and seen['frames'] == 7
    game = analysis.load_analysis(root, IDS['game'])
    best = max(game['segments'], key=lambda s: s['score'])
    assert best['tags'] == ['headshot'] and best['interest'] == 10
    assert 'Incroyable regardez ça.' in ' '.join(s['text'] for s in game['segments'])


def test_requests_and_plans_are_validated_and_repaired():
    base = {'count': 2, 'duration_s': 15, 'aspect': '9:16', 'style': 'viral', 'instruction': 'Les meilleurs headshots'}
    assert planner.validate_request(base)['captions'] is True
    for bad in [{**base, 'count': 0}, {**base, 'style': 'wild'}, {**base, 'aspect': '1:1'}, {**base, 'duration_s': 2}, {**base, 'mode': 'long'},
                {**base, 'rush_ids': ['../x']}, {**base, 'instruction': 'a\x00b'}, {**base, 'hook': 'yes'}]:
        with pytest.raises(planner.PlanError):
            planner.validate_request(bad)
    seg = lambda i, rush, a, b, score=.5, tags=(): planner.Segment(f's{i}', rush, rush, a, b, score, tags=list(tags))
    segments = [seg(1, 'r1', 0, 6000, .9, ['headshot']), seg(2, 'r1', 6000, 12000, .4), seg(3, 'r2', 0, 5000, .7),
                seg(4, 'r2', 5000, 9000, .3), seg(5, 'r3', 0, 8000, .6), seg(6, 'r3', 8000, 14000, .2)]
    request = planner.validate_request(base)
    answer = {'videos': [
        {'title': 'Un', 'hook_text': 'Regarde ça', 'segments': [{'id': 's1', 'start_ms': -50, 'end_ms': 99999}, {'id': 'zz', 'start_ms': 0, 'end_ms': 1},
                                                                 {'id': 's1', 'start_ms': 0, 'end_ms': 10}, {'id': 's3', 'start_ms': 1000, 'end_ms': 1200}]},
        {'title': 'Deux', 'hook_text': '', 'segments': [{'id': 's1', 'start_ms': 0, 'end_ms': 6000}, {'id': 's3', 'start_ms': 0, 'end_ms': 5000}]}]}
    videos = planner.repair(answer, request, segments)
    first, second = videos
    assert [p['id'] for p in first['segments']][:2] == ['s1', 's3'], 'unknown and repeated ids are dropped'
    assert first['segments'][0]['start_ms'] == 0 and first['segments'][0]['end_ms'] == 6000, 'trims stay inside the segment'
    assert first['segments'][1]['end_ms'] - first['segments'][1]['start_ms'] >= planner.MIN_PIECE_MS
    for video in videos:
        assert 13500 <= planner.video_length(video) <= 16500, planner.video_length(video)
    assert planner.overlap(first['segments'], second['segments']) <= planner.MAX_OVERLAP, 'variants are not near-copies'
    heuristic = planner.heuristic_videos({**request, 'count': 3}, segments)
    assert heuristic[0]['segments'][0]['id'] == 's1', 'the instruction ("headshots") and the score pick the hook'
    assert all(13500 <= planner.video_length(v) <= 16500 for v in heuristic), 'reuses material rather than making a short video'
    assert len({v['segments'][0]['id'] for v in heuristic}) == 3, 'each variant has its own hook'


def test_beats_are_found_and_cuts_land_on_them():
    rate = 11025
    t = np.arange(rate * 12) / rate
    clicks = np.zeros_like(t)
    for k in range(24):  # 120 BPM, starting at 0.25 s
        i = int((0.25 + k * 0.5) * rate)
        clicks[i:i + 200] = np.hanning(200)
    tempo, beats = beat_times(clicks.astype(np.float32))
    assert tempo == pytest.approx(120, abs=3)
    assert abs(beats[0] - 250) <= 30 and all(abs((b - a) - 500) <= 30 for a, b in zip(beats, beats[1:]))
    pieces = [{'id': 'a', 'start_ms': 1000, 'end_ms': 2900}, {'id': 'b', 'start_ms': 0, 'end_ms': 1650}, {'id': 'c', 'start_ms': 0, 'end_ms': 900}]
    snapped = snap_cuts(pieces, [250 + 500 * k for k in range(30)], 0, [(1800, 10000), (1250, 1700), (800, 5000)])
    assert snapped[0]['end_ms'] == 2750, 'cut at 1.75 s on the final clock'
    assert snapped[1]['end_ms'] == 1500, 'the nearest beat (3.25 s) is reachable by shortening'
    stuck = snap_cuts(pieces, [250 + 500 * k for k in range(30)], 0, [(1800, 10000), (1600, 1700), (800, 5000)])
    assert stuck[1]['end_ms'] == 1650, 'a cut that cannot reach any beat inside its limits stays put'


def test_generate_builds_an_editable_project_that_exports(library, monkeypatch):
    lib, root = library
    monkeypatch.setattr(get_settings(), 'openrouter_api_key', None)
    analyze_all(root)
    monkeypatch.setattr(get_settings(), 'openrouter_api_key', 'sk-test')
    captured = {}

    async def fake_llm(settings, request, lines):
        captured['ids'] = [s.id for s in lines]
        talk = [s for s in lines if s.rush_id == IDS['talk']]
        game = [s for s in lines if s.rush_id == IDS['game']]
        tall = [s for s in lines if s.rush_id == IDS['tall']]
        return {'videos': [
            {'title': 'Le meilleur moment', 'hook_text': 'Tu vas halluciner', 'segments': [
                {'id': talk[1].id, 'start_ms': talk[1].start_ms + 500, 'end_ms': talk[1].start_ms + 4500},
                {'id': game[0].id, 'start_ms': game[0].start_ms, 'end_ms': game[0].start_ms + 3000},
                {'id': tall[0].id, 'start_ms': tall[0].start_ms, 'end_ms': tall[0].start_ms + 3000},
                {'id': talk[0].id, 'start_ms': talk[0].start_ms + 1000, 'end_ms': talk[0].start_ms + 6000}]},
            {'title': 'Variante', 'hook_text': '', 'segments': [{'id': game[2].id, 'start_ms': game[2].start_ms, 'end_ms': game[2].end_ms}]}],
            'notes': 'ok', 'cost_usd': .01, 'model': 'test'}
    monkeypatch.setattr(planner, 'llm_plan', fake_llm)
    run = lib / '11111111-2222-4333-8444-555555555555'
    run.mkdir()
    request = {'count': 2, 'duration_s': 15, 'aspect': '9:16', 'style': 'viral', 'instruction': 'Le plus fou', 'smart_framing': False}
    summary = asyncio.run(assemble.generate(root, run, request))
    assert summary['planner'] == 'ai' and summary['videos'] == 2 and summary['rushes'] >= 3
    assert not any(i.startswith(IDS['copy'][:8]) for i in captured['ids']), 'the duplicate rush is left out'
    project = json.loads((run / 'editor-project.json').read_text(encoding='utf8'))
    assert (project['width'], project['height']) == (640, 360), 'mostly horizontal footage: a horizontal canvas, scaled to the sources'
    first = project['candidates'][0]
    lengths = [b - a for a, b in first['ranges']]
    assert len(first['ranges']) == 4 and lengths[:3] == pytest.approx([4000, 3000, 3000], abs=40) and 13500 <= sum(lengths) <= 16500
    assert first['text_overlays'][0]['text'] == 'Tu vas halluciner' and first['caption_preset'] == 'viral_bold'
    assert first['effects']['transition'] == 'flash'
    assert len(first['scenes']) > 1 and first['scenes'][1]['crops'][0][2] < first['scenes'][0]['crops'][0][2], 'punch-in zoom on alternate cuts'
    assert project['candidates'][1]['status'] == 'refining'
    out = json.loads((run / 'job_output.json').read_text(encoding='utf8'))
    assert out['editor_project'] is True and out['clips'] == [] and out['metrics']['planned_clip_count'] == 2
    source = probe(run / 'editor-source.mp4')
    assert abs(float(source['format']['duration']) * 1000 - project['duration_ms']) < 80
    assert (run / 'editor-preview.mp4').is_file() and not (run / '.montage-pieces').exists()

    # The ordinary editor exports it: 9:16, the planned length, audio in sync.
    first['status'] = 'ready'
    (run / 'editor-project.json').write_text(json.dumps(project), encoding='utf8')
    asyncio.run(run_editor({'run': str(run), 'library': str(lib), 'revision': 0, 'candidate_id': first['id'], 'action': 'export'}))
    clip = json.loads((run / 'job_output.json').read_text(encoding='utf8'))['clips'][0]
    info = probe(clip['s3_url'])
    video = next(s for s in info['streams'] if s['codec_type'] == 'video')
    durations = {s['codec_type']: float(s['duration']) for s in info['streams']}
    assert (video['width'], video['height']) == (1080, 1920)
    assert abs(durations['video'] - sum(lengths) / 1000) < .1 and abs(durations['audio'] - durations['video']) < .08


def test_vertical_footage_and_music_with_beat_sync(library, monkeypatch, tmp_path):
    lib, root = library
    monkeypatch.setattr(get_settings(), 'openrouter_api_key', None)
    analyze_all(root, [IDS['tall'], IDS['game']])
    music = tmp_path / 'Musique (beat).wav'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', "aevalsrc='sin(2*PI*880*t)*lt(mod(t-0.1,0.5),0.04)':s=44100:d=20", str(music)],
                   check=True, capture_output=True, timeout=60)
    run = lib / '11111111-2222-4333-8444-666666666666'
    run.mkdir()
    request = {'count': 1, 'duration_s': 10, 'aspect': '9:16', 'style': 'cinematic', 'rush_ids': [IDS['tall']], 'instruction': ''}
    summary = asyncio.run(assemble.generate(root, run, request, str(music)))
    assert summary['planner'] == 'heuristic' and summary['tempo'] == pytest.approx(120, abs=4)
    project = json.loads((run / 'editor-project.json').read_text(encoding='utf8'))
    assert (project['width'], project['height']) == (360, 640), 'vertical footage keeps a vertical canvas'
    c = project['candidates'][0]
    assert c['scenes'] == [{'at_ms': 0, 'layout': 'fill', 'crops': [[0, 0, 1, 1]]}]
    assert c['audio']['music']['file'].startswith('editor-music-') and c['effects']['transition'] == 'dip' and c['effects']['looks'][0]['vignette']
    # Each cut between pieces falls on the beat grid (100 ms + k × 500 ms) when its rush allows it.
    assert len(c['ranges']) >= 2
    clock, on_beat = 0, 0
    for a, b in c['ranges'][:-1]:
        clock += b - a
        on_beat += min(abs(clock - (100 + 500 * k)) for k in range(40)) <= 45
    assert on_beat == len(c['ranges']) - 1, c['ranges']
