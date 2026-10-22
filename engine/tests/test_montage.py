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


# ── Long videos ───────────────────────────────────────────────────────

from clip_engine.montage import long_planner


def make_dated(path, patterns, created, silent=None, seconds=6):
    """A rush with a recording date; `silent` = (start, end) seconds of silence in its tone."""
    inputs = [arg for p in patterns for arg in ('-f', 'lavfi', '-i', f'{p}=size=640x360:rate=30:duration={seconds}')]
    graph = ';'.join(f'[{i}:v]format=yuv420p,setsar=1[v{i}]' for i in range(len(patterns))) + ';' + ''.join(f'[v{i}]' for i in range(len(patterns))) + f'concat=n={len(patterns)}:v=1:a=0[v]'
    total = seconds * len(patterns)
    gate = f'*(1-between(t,{silent[0]},{silent[1]}))' if silent else ''
    cmd = ['ffmpeg', '-v', 'error', '-y', *inputs, '-f', 'lavfi', '-i', f"aevalsrc='0.3*sin(330*2*PI*t){gate}':s=48000:d={total}",
           '-filter_complex', graph + f';[{len(patterns)}:a]anull[a]', '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
           '-c:a', 'aac', '-metadata', f'creation_time={created}', str(path)]
    subprocess.run(cmd, check=True, capture_output=True, timeout=120)


def seg(i, rush, a, b, score=.5, text='', tags=(), filmed=None, hashes=()):
    return planner.Segment(f's{i}', rush, f'{rush}.mp4', a, b, score, text, list(tags), filmed_ms=filmed, hashes=list(hashes))


def test_long_requests_and_repeats():
    long = planner.validate_request({'mode': 'long', 'count': 1, 'duration_s': 600, 'aspect': '16:9', 'style': 'vlog', 'structure': 'story'})
    assert long['mode'] == 'long' and long['chapters'] and long['intro_outro'] and long['cut_silences'] and long['structure'] == 'story'
    for bad in [{'mode': 'long', 'count': 6}, {'mode': 'long', 'duration_s': 30}, {'mode': 'long', 'structure': 'novel'}, {'mode': 'long', 'chapters': 1}]:
        with pytest.raises(planner.PlanError):
            planner.validate_request({'count': 1, 'duration_s': 600, 'aspect': '16:9', 'style': 'vlog', **bad})
    words = 'nous voici enfin arrivés au sommet de la montagne'
    segments = [seg(1, 'a', 0, 5000, .9, words), seg(2, 'b', 0, 5000, .4, words + ' !'), seg(3, 'c', 0, 4000, .7, hashes=['00ff00ff00ff00ff', 'ffff0000ffff0000']),
                seg(4, 'd', 0, 4000, .3, hashes=['00ff00ff00ff00fe', 'ffff0000ffff0001']), seg(5, 'e', 0, 4000, .5, hashes=['0123456789abcdef', 'fedcba9876543210'])]
    ranked = {s.id: s.score for s in segments}
    assert long_planner.repeats(segments, ranked) == {'s2', 's4'}, 'the weaker copy of the same words or footage goes'


def test_silences_are_cut_inside_pieces():
    analysis = {'energy': {'step_ms': 250, 'db': [-20] * 20 + [-80] * 8 + [-20] * 12}, 'transcript': [{'words': [[1000, 1400, 'Bonjour']]}]}
    pieces = long_planner.cut_silences({'id': 'x', 'rush_id': 'r', 'start_ms': 0, 'end_ms': 10000}, analysis)
    assert [(p['start_ms'], p['end_ms']) for p in pieces] == [(0, 5150), (6850, 10000)], 'a 2 s silence becomes a 300 ms breath'
    talking = {'energy': {'step_ms': 250, 'db': [-20] * 20 + [-80] * 8 + [-20] * 12}, 'transcript': [{'words': [[5100, 6900, 'chut']]}]}
    assert len(long_planner.cut_silences({'id': 'x', 'rush_id': 'r', 'start_ms': 0, 'end_ms': 10000}, talking)) == 1, 'quiet words are not silence'


def test_long_heuristic_tells_a_story_or_compiles_by_theme():
    day = 86_400_000
    segments = [seg(1, 'beach', 0, 60000, .6, filmed=3 * day, tags=['beach']), seg(2, 'beach', 60000, 120000, .7, filmed=3 * day + 60000, tags=['beach']),
                seg(3, 'hotel', 0, 60000, .5, filmed=day, tags=['hotel']), seg(4, 'party', 0, 90000, .9, filmed=5 * day, tags=['party'])]
    request = planner.validate_request({'mode': 'long', 'count': 1, 'duration_s': 240, 'aspect': '16:9', 'style': 'vlog'})
    story = long_planner.heuristic_long(request, segments, set())
    assert story['structure'] == 'story'
    assert [c['title'] for c in story['chapters']] and [p['id'] for c in story['chapters'] for p in c['segments']] == ['s3', 's1', 's2', 's4'], 'in filming order'
    assert story['teaser'] and story['teaser'][0]['id'] == 's4' and story['teaser'][0]['end_ms'] - story['teaser'][0]['start_ms'] == long_planner.TEASER_MS
    undated = [planner.Segment(**{**s.__dict__, 'filmed_ms': None}) for s in segments]
    compilation = long_planner.heuristic_long({**request, 'style': 'gaming'}, undated, set())
    assert compilation['structure'] == 'compilation' and compilation['chapters'][0]['title'] == 'Party', 'strongest theme first'
    raw = {'title': 'Vacances', 'structure': 'story', 'intro_text': 'Nos vacances', 'outro_text': 'À bientôt', 'description': 'Une semaine.',
           'teaser': [{'id': 's4', 'start_ms': 0, 'end_ms': 60000}],
           'chapters': [{'title': 'Arrivée', 'segments': [{'id': 's3', 'start_ms': 0, 'end_ms': 60000}, {'id': 'zz', 'start_ms': 0, 'end_ms': 1}]},
                        {'title': 'Plage', 'segments': [{'id': 's2', 'start_ms': 60000, 'end_ms': 120000}, {'id': 's1', 'start_ms': 0, 'end_ms': 60000}, {'id': 's3', 'start_ms': 0, 'end_ms': 1000}]},
                        {'title': '', 'segments': []}]}
    video = long_planner.repair_long(raw, request, segments, set(), set())
    assert video['teaser'][0]['end_ms'] == 8000, 'a teaser is a few seconds'
    assert [c['title'] for c in video['chapters']] == ['Arrivée', 'Plage'], 'empty chapters dropped'
    assert [p['id'] for p in video['chapters'][1]['segments']][:2] == ['s1', 's2'], 'a story chapter plays in filming order; ids used once'
    assert 216000 <= sum(p['end_ms'] - p['start_ms'] for c in video['chapters'] for p in c['segments']) <= 264000, 'brought to the target length'


def test_long_video_is_assembled_with_chapters_and_exports(tmp_path, monkeypatch):
    ffmpeg_ready()
    monkeypatch.setattr(get_settings(), 'openrouter_api_key', None)
    lib = tmp_path / 'Bibliothèque longue'
    root = lib / '_rushes'
    (root / 'media').mkdir(parents=True)
    later, earlier = 'e' * 32, 'f' * 32
    make_dated(root / 'media' / f'{later}.mp4', ['testsrc2', 'smptebars'], '2026-07-02T10:00:00Z', silent=(4, 8))
    make_dated(root / 'media' / f'{earlier}.mp4', ['rgbtestsrc', 'pal75bars'], '2026-07-01T09:00:00Z')
    (root / 'library.json').write_text(json.dumps({'version': 1, 'rushes': [{'id': later, 'name': 'Jour 2.mp4', 'status': 'ready'},
                                                                            {'id': earlier, 'name': 'Jour 1.mp4', 'status': 'ready'}]}), encoding='utf8')
    for rush_id in (later, earlier):
        asyncio.run(analysis.analyze_rush(root, rush_id))
    assert analysis.load_analysis(root, earlier)['info']['created'] == '2026-07-01T09:00:00Z'
    run = lib / '11111111-2222-4333-8444-777777777777'
    run.mkdir()
    request = {'mode': 'long', 'count': 1, 'duration_s': 60, 'aspect': '16:9', 'style': 'vlog', 'instruction': ''}
    summary = asyncio.run(assemble.generate(root, run, request))
    assert summary['mode'] == 'long' and summary['planner'] == 'heuristic'
    assert any('shorter than asked' in n for n in summary['notes']), summary['notes']
    plan = json.loads((run / 'montage-plan.json').read_text(encoding='utf8'))['plan'][0]
    assert plan['structure'] == 'story'
    order = [p['rush_id'] for c in plan['chapters'] for p in c['segments']]
    assert order.index(earlier) < order.index(later) and order[-1] == later, 'day 1 before day 2'
    silent = [p for c in plan['chapters'] for p in c['segments'] if p['rush_id'] == later and p['start_ms'] < 8000 and p['end_ms'] > 4000]
    assert all(p['end_ms'] <= 4400 or p['start_ms'] >= 7600 for p in silent), f'the 4 s silence is cut: {silent}'
    project = json.loads((run / 'editor-project.json').read_text(encoding='utf8'))
    c = project['candidates'][0]
    marks = summary['chapters'][0]['chapters']
    assert marks[0] == {'title': 'Intro', 'start_ms': 0} and len(marks) == len(c['ranges']) >= 3
    assert all(b == c['ranges'][i + 1][0] for i, (a, b) in enumerate(c['ranges'][:-1])), 'chapters play back to back'
    titles = [o['text'] for o in c.get('text_overlays', [])]
    assert len(titles) == len(marks) - 1, 'a lower-third title for each chapter after the intro'
    total = sum(b - a for a, b in c['ranges'])
    # 24 s of footage, minus the 4 s silence (a short breath stays), plus a 4.5 s teaser.
    assert total == summary['chapters'][0]['duration_ms'] and 23000 <= total <= 27000, total
    c['status'] = 'ready'
    (run / 'editor-project.json').write_text(json.dumps(project), encoding='utf8')
    asyncio.run(run_editor({'run': str(run), 'library': str(lib), 'revision': 0, 'candidate_id': c['id'], 'action': 'export'}))
    clip = json.loads((run / 'job_output.json').read_text(encoding='utf8'))['clips'][0]
    info = probe(clip['s3_url'])
    durations = {s['codec_type']: float(s['duration']) for s in info['streams']}
    video = next(s for s in info['streams'] if s['codec_type'] == 'video')
    assert (video['width'], video['height']) == (1920, 1080) and abs(durations['video'] - total / 1000) < .1 and abs(durations['audio'] - durations['video']) < .08


def test_long_videos_even_out_the_sound_of_each_rush():
    analyses = [('a' * 32, 'loud', {'info': {'has_audio': True}, 'segments': [{'energy': -12}, {'energy': -14}, {'energy': -80}]}),
                ('b' * 32, 'quiet', {'info': {'has_audio': True}, 'segments': [{'energy': -34}, {'energy': -30}]}),
                ('c' * 32, 'normal', {'info': {'has_audio': True}, 'segments': [{'energy': -20}]}),
                ('d' * 32, 'mute', {'info': {'has_audio': False}, 'segments': [{'energy': -90}]})]
    levels = assemble.rush_levels(analyses)
    assert levels == {'a' * 32: -12, 'b' * 32: -30, 'c' * 32: -20}, 'median of the audible moments; silent rushes are left alone'
    assert assemble.level_gains(['a' * 32, 'b' * 32, 'c' * 32, 'd' * 32], levels) == {'a' * 32: -8.0, 'b' * 32: 10.0}
    assert assemble.level_gains(['a' * 32, 'd' * 32], levels) == {}, 'nothing to match with a single rush'


def test_long_plan_uses_the_model_answer_and_falls_back(monkeypatch):
    from types import SimpleNamespace
    def fake_analysis(rush, created):
        return {'info': {'duration_ms': 60000, 'created': created}, 'hashes': {'step_ms': 2000, 'values': []}, 'energy': {'step_ms': 250, 'db': [-20] * 240},
                'transcript': [], 'duplicate_of': None,
                'segments': [{'id': f'{rush}-{i}', 'start_ms': i * 10000, 'end_ms': (i + 1) * 10000, 'score': .5 + i / 20, 'text': '', 'tags': [rush]} for i in range(6)]}
    analyses = [('a' * 32, 'A.mp4', fake_analysis('a', None)), ('b' * 32, 'B.mp4', fake_analysis('b', None))]
    request = planner.validate_request({'mode': 'long', 'count': 1, 'duration_s': 60, 'aspect': '16:9', 'style': 'compilation', 'cut_silences': False})
    seen = {}

    async def fake(settings, req, lines, hint):
        seen['hint'], seen['lines'] = hint, len(lines)
        return {'videos': [{'title': 'Best of', 'structure': 'compilation', 'intro_text': 'Le meilleur', 'outro_text': 'Merci', 'description': 'Les temps forts.',
                            'teaser': [{'id': 'b-5', 'start_ms': 50000, 'end_ms': 54000}],
                            'chapters': [{'title': 'B', 'segments': [{'id': 'b-5', 'start_ms': 50000, 'end_ms': 60000}, {'id': 'b-4', 'start_ms': 40000, 'end_ms': 50000}]},
                                         {'title': 'A', 'segments': [{'id': 'a-5', 'start_ms': 50000, 'end_ms': 60000}]}]}], 'notes': 'ok', 'cost_usd': .05}
    monkeypatch.setattr(long_planner, 'llm_long', fake)
    result = asyncio.run(planner.plan(SimpleNamespace(openrouter_api_key='sk'), request, analyses))
    video = result['videos'][0]
    assert result['planner'] == 'ai' and 'thematic compilation' in seen['hint'] and seen['lines'] == 12
    assert [c['title'] for c in video['chapters']] == ['B', 'A'] and video['intro_text'] == 'Le meilleur' and video['teaser'][0]['id'] == 'b-5'
    assert 54000 <= sum(p['end_ms'] - p['start_ms'] for c in video['chapters'] for p in c['segments']) <= 66000, 'topped up to about a minute'
    assert video['segments'][0] == video['teaser'][0], 'the flat list starts with the teaser'

    async def broken(*args):
        raise TimeoutError()
    monkeypatch.setattr(long_planner, 'llm_long', broken)
    result = asyncio.run(planner.plan(SimpleNamespace(openrouter_api_key='sk'), request, analyses))
    assert result['planner'] == 'heuristic' and 'TimeoutError' in result['notes'][0] and result['videos'][0]['chapters']
