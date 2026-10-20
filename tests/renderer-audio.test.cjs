const test = require('node:test')
const assert = require('node:assert/strict')
const { loadMain } = require('./zernio/support/load-main.cjs')

const { parseAudio, hasAudio, speechIntervals, duckGain, musicGainAt, musicPosition, newMusic } = loadMain("export * from './src/shared/audio'")
const rows = (words) => words.map(([a, b]) => ({ start_ms: a, end_ms: b, text: 'w', words: [[a, b]] }))

test('speech intervals match the engine (audio_mix.speech_intervals)', () => {
  const words = rows([[1000, 1400], [1500, 1900], [3000, 3400], [6000, 6500]])
  const ranges = [[1000, 1500], [2000, 5000]]
  assert.deepEqual(speechIntervals(words, { ranges, video_speed: 1 }), [[0, 400], [1500, 1900]])
  assert.deepEqual(speechIntervals(words, { ranges, video_speed: 2 }), [[0, 950]])
  assert.deepEqual(speechIntervals(words, { ranges, video_speed: 1.5 }), [[0, 267], [1000, 1267]])
  assert.deepEqual(speechIntervals(rows([[0, 1000], [1400, 2000]]), { ranges: [[0, 3000]], video_speed: 1 }), [[0, 2000]])
  // Lines without matching word timing count as speech for their whole span.
  assert.deepEqual(speechIntervals([{ start_ms: 100, end_ms: 900, text: 'two words' }], { ranges: [[0, 3000]], video_speed: 1 }), [[100, 900]])
})

test('ducking ramps and music position follow the export', () => {
  const speech = [[1000, 2000]]
  assert.equal(duckGain(speech, -12, 0), 1)
  assert.ok(Math.abs(duckGain(speech, -12, 1500) - 10 ** (-12 / 20)) < 1e-9)
  assert.ok(Math.abs(duckGain(speech, -12, 900) - (1 - (1 - 10 ** (-12 / 20)) * .5)) < 1e-9, 'halfway down 100 ms before speech')
  assert.equal(duckGain(speech, -12, 2300), 1)
  const music = { ...newMusic('editor-music-' + 'a'.repeat(32) + '.mp4', 'Song.mp3'), offset_ms: 500, fade_in_ms: 0, fade_out_ms: 1000, duck: false, volume_db: 0 }
  assert.equal(musicPosition(music, 1500, 0), .5)
  assert.equal(musicPosition(music, 1500, 1200), .2, 'loops back to the start of the track')
  assert.equal(musicGainAt(music, [], 5500, 6000), .5, 'fades out over the last second')
})

test('audio settings validate like the engine and drop defaults', () => {
  assert.equal(hasAudio(parseAudio(undefined)), false)
  assert.equal(hasAudio(parseAudio({ volume_db: 3 })), true)
  const music = newMusic('editor-music-' + 'b'.repeat(32) + '.mp4', 'Track.wav')
  assert.deepEqual(parseAudio({ music }).music, music)
  for (const bad of [{ volume_db: 13 }, { mute: 'yes' }, { extra: 1 }, { music: { ...music, file: '../x.mp4' } }, { music: { ...music, offset_ms: 1.5 } },
    { music: { ...music, duck_db: -31 } }, { music: { ...music, name: '' } }, { music: { ...music, path: '/x' } }]) {
    assert.throws(() => parseAudio(bad))
  }
})
