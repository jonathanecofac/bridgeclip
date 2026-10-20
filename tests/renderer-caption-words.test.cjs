const test = require('node:test')
const assert = require('node:assert/strict')
const { loadMain } = require('./zernio/support/load-main.cjs')

const { captionLines, captionWordsAt } = loadMain("export * from './src/renderer/lib/caption-words'")
const project = { transcript: [
  { start_ms: 2100, end_ms: 5000, text: 'Bonjour tout le monde voici été', words: [[2100, 2500], [2600, 3000], [3100, 3500], [3600, 4000], [4100, 4500], [4600, 5000]] },
  { start_ms: 6000, end_ms: 7000, text: 'Fin, merci.' }
] }
const candidate = (extra = {}) => ({ ranges: [[2000, 8000]], caption_edits: [], caption_inserts: [], ...extra })
const at = (c, time, words = 2) => {
  const now = captionWordsAt(captionLines(project, c), c.ranges, words, time)
  return now && now.words.map((w, i) => i === now.active ? w.text.toUpperCase() : w.text).join(' ')
}

test('live captions use real word timing and the engine grouping', () => {
  assert.equal(at(candidate(), 2700), 'Bonjour TOUT')
  assert.equal(at(candidate(), 3200), 'LE monde')
  assert.equal(at(candidate(), 3700, 3), 'MONDE voici été')
  assert.equal(at(candidate(), 6100), 'FIN, merci.', 'a comma closes a group only after two words')
  assert.equal(at(candidate(), 1500), null, 'outside the cuts')
})

test('retimed lines move their words proportionally, like caption_transcript', () => {
  const c = candidate({ caption_edits: [{ segment: 0, text: 'Bonjour tout le monde voici été', start_ms: 2300, end_ms: 5000 }] })
  const words = captionLines(project, c)[0].words
  assert.deepEqual(words[1], [2766, 3138])
  // 'le' now starts at 3231, so at 3.2 s the first group is still on screen.
  assert.equal(at(c, 3200), 'Bonjour TOUT')
  assert.equal(at(c, 3300), 'LE monde')
  // Corrected text with a different word count spreads over the spoken interval.
  const respread = captionLines(project, candidate({ caption_edits: [{ segment: 0, text: 'Salut' }] }))[0]
  assert.deepEqual(respread.words, [[2100, 5000]])
})

test('an added caption that overlaps a line follows the engine: words cut short by the next group are not shown', () => {
  const c = candidate({ caption_inserts: [{ start_ms: 1850, end_ms: 3350, text: 'Ajouté à la main' }],
    caption_edits: [{ segment: 0, text: 'Bonjour tout le monde voici été', start_ms: 2300, end_ms: 5000 }] })
  assert.equal(at(c, 3200, 1), 'TOUT')
  assert.equal(at(c, 2100, 1), 'AJOUTÉ')
})
