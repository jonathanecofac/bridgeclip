const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir } = require('../zernio/support/load-main.cjs')

const { ChannelWatcher, parseChannelInput, parseChannelFeed, parseUploads, chooseNewVideos, DEFAULT_WATCH_SETTINGS } =
  loadMain("export * from './src/main/watched-channels'; export * from './src/shared/watched-channels'")

const CHANNEL = 'UC0123456789abcdefABCDEF'
const entry = (id, title, published, short = false) => `<entry><id>yt:video:${id}</id><yt:videoId>${id}</yt:videoId><yt:channelId>${CHANNEL}</yt:channelId>
  <title>${title}</title><link rel="alternate" href="https://www.youtube.com/${short ? `shorts/${id}` : `watch?v=${id}`}"/><published>${published}</published></entry>`
const feed = (entries, name = 'Café &amp; Code') => `<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <link rel="self" href="https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}"/><id>yt:channel:${CHANNEL}</id><yt:channelId>${CHANNEL}</yt:channelId>
  <title>${name}</title><author><name>${name}</name></author>${entries.join('')}</feed>`

test('channel input accepts links, handles and ids, and explains video links', () => {
  assert.deepEqual(parseChannelInput('@LinusTechTips'), { pageUrl: 'https://www.youtube.com/@LinusTechTips' })
  assert.deepEqual(parseChannelInput('https://www.youtube.com/@LinusTechTips/videos'), { pageUrl: 'https://www.youtube.com/@LinusTechTips' })
  assert.deepEqual(parseChannelInput('youtube.com/channel/' + CHANNEL), { channelId: CHANNEL })
  assert.deepEqual(parseChannelInput(CHANNEL), { channelId: CHANNEL })
  assert.deepEqual(parseChannelInput('https://m.youtube.com/c/SomeName'), { pageUrl: 'https://www.youtube.com/c/SomeName' })
  assert.throws(() => parseChannelInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), /video link/)
  assert.throws(() => parseChannelInput('https://vimeo.com/someone'), /YouTube channel link/)
  assert.throws(() => parseChannelInput(''), /YouTube channel link/)
})

test('feeds are parsed newest first, with entities, Shorts and broken entries handled', () => {
  const parsed = parseChannelFeed(feed([entry('aaaaaaaaaaa', 'Old &lt;one&gt;', '2026-10-01T10:00:00+00:00'),
    entry('bbbbbbbbbbb', 'Short', '2026-10-03T10:00:00+00:00', true), '<entry><title>broken</title></entry>',
    entry('ccccccccccc', 'Newest &#233;t&#xE9;', '2026-10-05T10:00:00+00:00')]))
  assert.equal(parsed.name, 'Café & Code'); assert.equal(parsed.channelId, CHANNEL)
  assert.deepEqual(parsed.entries.map((e) => [e.videoId, e.title, e.short]),
    [['ccccccccccc', 'Newest été', false], ['bbbbbbbbbbb', 'Short', true], ['aaaaaaaaaaa', 'Old <one>', false]])
  assert.throws(() => parseChannelFeed('<html>consent</html>'))
})

test('backlog choice applies only to videos missed while BridgeClip was not watching', () => {
  const now = Date.parse('2026-10-20T12:00:00Z'), lastOk = '2026-10-20T11:45:00Z'
  const e = (id, iso) => ({ videoId: id, title: id, publishedAt: iso, short: false })
  const fresh = [e('new', '2026-10-20T11:50:00Z'), e('missed1', '2026-10-20T08:00:00Z'), e('missed2', '2026-10-18T08:00:00Z')]
  assert.deepEqual(chooseNewVideos(fresh, lastOk, 'none', now).take, ['new'])
  assert.deepEqual(chooseNewVideos(fresh, lastOk, 'newest', now).take, ['new'], 'a fresh upload counts as the newest')
  assert.deepEqual(chooseNewVideos(fresh.slice(1), lastOk, 'newest', now), { take: ['missed1'], skip: ['missed2'] })
  assert.deepEqual(chooseNewVideos(fresh, lastOk, 'day', now).take, ['missed1', 'new'])
  assert.deepEqual(chooseNewVideos(fresh, lastOk, 'all', now).take, ['missed2', 'missed1', 'new'])
  // Closed for two days: only what appeared in the last interval counts as new; the rest is backlog.
  const reopened = [e('justNow', '2026-10-22T11:55:00Z'), e('yesterday', '2026-10-21T20:00:00Z'), e('twoDays', '2026-10-20T20:00:00Z')]
  assert.deepEqual(chooseNewVideos(reopened, '2026-10-20T12:00:00Z', 'none', Date.parse('2026-10-22T12:00:00Z')).take, ['justNow'])
  assert.deepEqual(chooseNewVideos(reopened, '2026-10-20T12:00:00Z', 'day', Date.parse('2026-10-22T12:00:00Z')).take, ['yesterday', 'justNow'])
})

function harness(dir, { feeds, details = {}, startError = null, automations = { auto1: 'Daily TikTok' } }) {
  let now = Date.parse('2026-10-20T12:00:00Z')
  const calls = { started: [], sent: [], changed: 0 }
  let listener = null, jobs = 0
  const deps = {
    file: path.join(dir, 'watched-channels.json'),
    fetchText: async (url) => {
      const id = /channel_id=(UC[\w-]{22})/.exec(url)?.[1]
      if (!id || !feeds[id]) throw new Error('404')
      return typeof feeds[id] === 'function' ? feeds[id]() : feeds[id]
    },
    resolveChannelPage: async (page) => { if (page.endsWith('@cafe')) return { channelId: CHANNEL, name: 'Cafe' }; throw new Error('nope') },
    videoDetails: async (id) => details[id] ?? { durationSeconds: 1200, live: null },
    validateSettings: (s) => { if (!s || typeof s !== 'object' || s.aspectRatio === 'bad') throw new Error('Invalid aspectRatio'); return { ...s } },
    startJob: async (request) => {
      calls.started.push(request)
      if (startError) return { error: startError }
      jobs++
      return { jobId: `job-${jobs}`, outputDir: path.join(dir, `run-${jobs}`) }
    },
    onJobUpdate: (l) => { listener = l; return () => { listener = null } },
    sendToAutomation: async (id, outputDir, indices) => { calls.sent.push({ id, outputDir, indices }) },
    automationName: (id) => automations[id] ?? null,
    now: () => now,
    changed: () => { calls.changed++ },
    log: () => {}
  }
  return { deps, calls, advance: (ms) => { now += ms }, finish: (job) => listener?.(job) }
}

test('a watched channel clips new uploads once and hands the best clips to its automation', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-watch-')
  try {
    let entries = [entry('aaaaaaaaaaa', 'Earlier video', '2026-10-19T10:00:00Z')]
    const h = harness(dir, { feeds: { [CHANNEL]: () => feed(entries) }, details: { lllllllllll: { durationSeconds: null, live: 'live' }, sssssssssss: { durationSeconds: 90, live: null } } })
    const watcher = new ChannelWatcher(h.deps)
    let state = await watcher.addChannel('https://www.youtube.com/@cafe', DEFAULT_WATCH_SETTINGS)
    let channel = state.channels[0]
    assert.equal(channel.name, 'Café & Code'); assert.equal(channel.channelId, CHANNEL)
    assert.deepEqual(channel.videos.map((v) => [v.videoId, v.status]), [['aaaaaaaaaaa', 'earlier']], 'the back catalogue is never queued')
    await assert.rejects(() => watcher.addChannel(CHANNEL), /already watched/)
    await assert.rejects(() => watcher.addChannel('@unknown'), /Could not find that channel/)

    h.advance(10 * 60_000)
    entries = [entry('nnnnnnnnnnn', 'Big interview', '2026-10-20T12:05:00Z'), entry('ttttttttttt', 'A short', '2026-10-20T12:06:00Z', true),
      entry('lllllllllll', 'Live Q&amp;A', '2026-10-20T12:07:00Z'), entry('sssssssssss', 'Quick update', '2026-10-20T12:08:00Z'), ...entries]
    state = await watcher.checkNow(channel.id)
    channel = state.channels[0]
    const status = Object.fromEntries(channel.videos.map((v) => [v.videoId, [v.status, v.note ?? '']]))
    assert.deepEqual(status.nnnnnnnnnnn, ['clipping', ''])
    assert.deepEqual(status.ttttttttttt, ['skipped', 'A Short.'])
    assert.equal(status.lllllllllll[0], 'waiting')
    assert.deepEqual(status.sssssssssss, ['skipped', 'Shorter than 3 minutes.'])
    assert.equal(h.calls.started.length, 1)
    assert.deepEqual(h.calls.started[0], { ...DEFAULT_WATCH_SETTINGS, videoUrl: 'https://www.youtube.com/watch?v=nnnnnnnnnnn', startTimeSeconds: null, endTimeSeconds: null, bannerPlatform: null, bannerChannelUrl: null })

    // A second look does not queue it again; the live video is clipped once it has ended.
    await watcher.checkNow(channel.id)
    assert.equal(h.calls.started.length, 1)
    h.deps.videoDetails = async () => ({ durationSeconds: 3600, live: null })
    state = await watcher.checkNow(channel.id)
    assert.equal(h.calls.started.length, 2)
    assert.equal(state.channels[0].videos.find((v) => v.videoId === 'lllllllllll').status, 'clipping')

    state = watcher.updateChannel(channel.id, { automationId: 'auto1', sendClips: 2 })
    assert.throws(() => watcher.updateChannel(channel.id, { automationId: 'missing' }), /Choose one of your automations/)
    assert.throws(() => watcher.updateChannel(channel.id, { settings: { ...DEFAULT_WATCH_SETTINGS, workflow: 'review' } }), /can’t go to an automation/)
    assert.throws(() => watcher.updateChannel(channel.id, { backlog: 'some' }), /Invalid update/)
    watcher.start()
    const clips = [0.4, 0.9, 0.7].map((score, clip_index) => ({ clip_index, virality_score: score }))
    await h.finish({ id: 'job-1', status: 'completed', outputDir: path.join(dir, 'run-1'), output: { clips } })
    await h.finish({ id: 'job-2', status: 'failed', error: 'Download failed', outputDir: path.join(dir, 'run-2'), output: null })
    watcher.stop()
    state = watcher.state()
    const done = state.channels[0].videos.find((v) => v.videoId === 'nnnnnnnnnnn')
    assert.deepEqual([done.status, done.clips, done.sent], ['sent', 3, 2])
    assert.deepEqual(h.calls.sent, [{ id: 'auto1', outputDir: path.join(dir, 'run-1'), indices: [1, 2] }], 'best-scoring clips first')
    const failed = state.channels[0].videos.find((v) => v.videoId === 'lllllllllll')
    assert.deepEqual([failed.status, failed.note], ['failed', 'Download failed'])
    assert.match(state.activity[0].text, /Clipping failed for “Live Q&A”: Download failed/)
    assert.match(state.activity[1].text, /“Big interview”: 3 clips, 2 sent to Daily TikTok/)

    // Clip again by hand, and an earlier video too.
    state = await watcher.clipVideo(channel.id, 'aaaaaaaaaaa')
    assert.equal(state.channels[0].videos.find((v) => v.videoId === 'aaaaaaaaaaa').status, 'clipping')
    await assert.rejects(() => watcher.clipVideo(channel.id, 'aaaaaaaaaaa'), /already being clipped/)

    // Restarting BridgeClip: runs that were clipping can't resume, and say so.
    const reopened = new ChannelWatcher(h.deps)
    const after = reopened.state().channels[0].videos.find((v) => v.videoId === 'aaaaaaaaaaa')
    assert.deepEqual([after.status, after.note], ['failed', 'BridgeClip closed before this video finished. Use Clip again.'])
    assert.equal(JSON.parse(fs.readFileSync(h.deps.file, 'utf8')).version, 1)
  } finally { cleanup() }
})

test('missed uploads follow the backlog choice, and start errors are shown on the video', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-watch-')
  try {
    let entries = []
    const h = harness(dir, { feeds: { [CHANNEL]: () => feed(entries) }, startError: 'OpenRouter API key is required for AI clip planning. Go to Settings to add it.' })
    const watcher = new ChannelWatcher(h.deps)
    let state = await watcher.addChannel(CHANNEL)
    const id = state.channels[0].id
    // BridgeClip was closed for two days: three uploads appeared before this look.
    h.advance(48 * 3600_000)
    entries = ['2026-10-20T20:00:00Z', '2026-10-21T20:00:00Z', '2026-10-22T11:00:00Z'].map((t, i) => entry(`v${i}xxxxxxxxx`, `Video ${i}`, t))
    state = await watcher.checkNow(id)
    const videos = state.channels[0].videos
    assert.deepEqual(videos.map((v) => [v.videoId, v.status]), [['v2xxxxxxxxx', 'failed'], ['v1xxxxxxxxx', 'skipped'], ['v0xxxxxxxxx', 'skipped']])
    assert.match(videos[0].note, /OpenRouter API key is required/)
    assert.match(videos[1].note, /backlog choice/)
    assert.match(state.activity[0].text, /Could not clip “Video 2”: OpenRouter API key/)
    assert.throws(() => watcher.setInterval('soon'), /Invalid interval/)
    assert.equal(watcher.setInterval(1).intervalMinutes, 5, 'at least 5 minutes between looks')
    assert.equal(watcher.setEnabled(true).enabled, true)
    h.deps.startJob = async () => ({ error: 'getaddrinfo ENOTFOUND www.youtube.com' })
    state = await watcher.clipVideo(id, 'v1xxxxxxxxx')
    assert.equal(state.channels[0].videos.find((v) => v.videoId === 'v1xxxxxxxxx').note, 'Could not reach YouTube. Check your internet connection, then use Clip again.')
    assert.deepEqual(watcher.removeChannel(id).channels, [])
  } finally { cleanup() }
})

test('a channel that stops answering keeps its videos and shows the error', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-watch-')
  try {
    const feeds = { [CHANNEL]: feed([entry('aaaaaaaaaaa', 'One', '2026-10-19T10:00:00Z')]) }
    const h = harness(dir, { feeds })
    const watcher = new ChannelWatcher(h.deps)
    const id = (await watcher.addChannel(CHANNEL)).channels[0].id
    delete feeds[CHANNEL]
    const state = await watcher.checkNow(id)
    assert.match(state.channels[0].lastError, /YouTube did not answer/)
    assert.equal(state.channels[0].videos.length, 1)
    await assert.rejects(() => watcher.addChannel('UCzzzzzzzzzzzzzzzzzzzzzz'), /did not return this channel/)
  } finally { cleanup() }
})

test('when YouTube’s feed is down, the channel’s uploads come from yt-dlp instead', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-watch-')
  try {
    const now = Date.parse('2026-10-20T12:00:00Z')
    const listing = { channel: 'Domingo Replay', title: 'Domingo Replay - Videos', entries: [
      { id: 'aaaaaaaaaaa', title: 'Épisode 12 & bonus', timestamp: now / 1000 - 3600 },
      { id: 'bbbbbbbbbbb', title: 'Épisode 11', upload_date: '20261015' },
      { id: 'not-an-id', title: 'ignored' }, { id: 'ccccccccccc', title: 'No date' }] }
    const parsed = parseUploads(listing, now)
    assert.equal(parsed.name, 'Domingo Replay')
    assert.deepEqual(parsed.entries.map((e) => [e.videoId, e.title, e.publishedAt]), [
      ['ccccccccccc', 'No date', '2026-10-20T11:59:57.000Z'], ['aaaaaaaaaaa', 'Épisode 12 & bonus', '2026-10-20T11:00:00.000Z'], ['bbbbbbbbbbb', 'Épisode 11', '2026-10-15T12:00:00.000Z']])
    assert.throws(() => parseUploads({ title: 'x' }, now))

    const h = harness(dir, { feeds: {} })
    const logs = []
    h.deps.log = (event, data) => logs.push([event, data])
    let uploads = parsed
    h.deps.listUploads = async (id) => { if (id !== CHANNEL) throw new Error('unknown'); return uploads }
    const watcher = new ChannelWatcher(h.deps)
    let state = await watcher.addChannel(CHANNEL)
    assert.equal(state.channels[0].name, 'Domingo Replay')
    assert.equal(state.channels[0].videos.length, 3)
    assert.deepEqual(logs[0], ['watch.feed.fallback', { channel: CHANNEL, reason: '404' }])
    h.advance(10 * 60_000)
    uploads = { name: 'Domingo Replay', entries: [{ videoId: 'nnnnnnnnnnn', title: 'Épisode 13', publishedAt: '2026-10-20T12:05:00.000Z', short: false }, ...parsed.entries] }
    state = await watcher.checkNow(state.channels[0].id)
    assert.equal(state.channels[0].videos.find((v) => v.videoId === 'nnnnnnnnnnn').status, 'clipping')
    h.deps.listUploads = async () => { throw new Error('yt-dlp failed') }
    await assert.rejects(() => watcher.addChannel('UCzzzzzzzzzzzzzzzzzzzzzz'), /through its feed or yt-dlp/)
  } finally { cleanup() }
})
