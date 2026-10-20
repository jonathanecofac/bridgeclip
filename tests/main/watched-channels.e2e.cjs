const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')

// Watched channels against a local stand-in for YouTube: the channel page, its feed and video details.
const CHANNEL = 'UC0123456789abcdefABCDEF'
const entry = (id, title, published, short = false) => `<entry><yt:videoId>${id}</yt:videoId><title>${title}</title>
  <link rel="alternate" href="https://www.youtube.com/${short ? `shorts/${id}` : `watch?v=${id}`}"/><published>${published}</published></entry>`

test('watched channels: add by @handle, leave earlier videos, clip a new upload, skip a Short, and change settings', { timeout: 180000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-watch-e2e-'))
  const fake = { entries: [entry('aaaaaaaaaaa', 'Earlier interview', '2026-10-01T10:00:00Z')], requests: [] }
  const server = http.createServer((req, res) => {
    fake.requests.push(req.url)
    if (req.url === '/@cafecode') { res.setHeader('Content-Type', 'text/html'); return res.end(`<html><head><meta property="og:title" content="Café Code"><meta itemprop="identifier" content="${CHANNEL}"></head></html>`) }
    if (req.url === `/feeds/videos.xml?channel_id=${CHANNEL}`) {
      res.setHeader('Content-Type', 'application/atom+xml')
      return res.end(`<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><yt:channelId>${CHANNEL}</yt:channelId><title>Café &amp; Code</title>${fake.entries.join('')}</feed>`)
    }
    const details = /^\/details\/([\w-]{11})$/.exec(req.url)
    if (details) return res.end(JSON.stringify({ duration: 1800, live_status: 'not_live' }))
    res.statusCode = 404; res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const userDataDir = path.join(root, 'user-data'), library = path.join(userDataDir, 'Library')
  fs.mkdirSync(library, { recursive: true })
  // No OpenRouter key: a new upload is found and shown as failed with the reason Create would give.
  fs.writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify({ version: 6, outputDirectory: library, openrouterApiKey: '', zernioApiKey: '' }))
  const session = await launchApp({ appDir: buildApp(path.join(root, 'app')), userDataDir, env: { BRIDGECLIP_E2E_YOUTUBE_URL: `http://127.0.0.1:${server.address().port}` } })
  t.after(async () => { await session.close(); server.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const { page } = session
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))
  page.setDefaultTimeout(20000)
  const saved = () => JSON.parse(fs.readFileSync(path.join(userDataDir, 'watched-channels.json'), 'utf8'))

  await page.getByRole('button', { name: /^Watch\b/ }).click()
  await page.getByRole('heading', { name: 'Watched channels', exact: true }).waitFor()
  await page.getByText('No channels yet', { exact: true }).waitFor()
  await page.getByLabel('Add a channel').fill('https://www.youtube.com/@cafecode')
  await page.getByRole('button', { name: 'Add channel', exact: true }).click()
  const card = page.getByRole('region', { name: 'Channel Café & Code' })
  await card.waitFor()
  await card.getByText('Earlier interview', { exact: true }).waitFor()
  await card.getByText('Before watching', { exact: true }).waitFor()
  await page.getByText(/Now watching Café & Code\. 1 earlier video left as they are/).waitFor()
  assert.equal(saved().channels[0].channelId, CHANNEL)
  await page.getByLabel('Add a channel').fill(CHANNEL)
  await page.getByRole('button', { name: 'Add channel', exact: true }).click()
  await page.getByText('This channel is already watched.', { exact: true }).waitFor()

  // Turn watching on; the channel posts a video and a Short.
  await page.getByRole('switch', { name: 'Watch channels' }).click()
  await page.getByText('Watching on', { exact: true }).waitFor()
  const later = new Date(Date.now() + 60_000).toISOString()
  fake.entries.unshift(entry('nnnnnnnnnnn', 'Big new episode', later), entry('sssssssssss', 'Tiny short', later, true))
  await card.getByRole('button', { name: 'Check', exact: true }).click()
  await card.getByText('Big new episode', { exact: true }).waitFor()
  await card.getByText(/A Short\./).waitFor()
  await card.getByRole('button', { name: 'Clip again', exact: true }).waitFor()
  // Without an OpenRouter key (or network in CI) the run cannot start; the reason is shown on the video.
  const failed = saved().channels[0].videos.find((v) => v.videoId === 'nnnnnnnnnnn')
  assert.ok(failed.note && failed.note.length > 10, failed.note)
  await card.getByText(failed.note, { exact: false }).waitFor()
  const videos = Object.fromEntries(saved().channels[0].videos.map((v) => [v.videoId, v.status]))
  assert.deepEqual(videos, { nnnnnnnnnnn: 'failed', sssssssssss: 'skipped', aaaaaaaaaaa: 'earlier' })
  assert.ok(fake.requests.includes('/details/nnnnnnnnnnn'), 'checks length and live state before clipping')
  assert.ok(!fake.requests.includes('/details/sssssssssss'), 'Shorts are skipped from the feed alone')

  // Per-channel settings.
  await card.getByRole('button', { name: 'Settings', exact: true }).click()
  await card.getByRole('combobox', { name: 'Number of clips' }).click()
  await page.getByRole('option', { name: 'Up to 3', exact: true }).click()
  await card.getByText(/Up to 3 clips/).waitFor()
  const settings = saved().channels[0].settings
  assert.deepEqual([settings.autoClipCount, settings.maxClips], [false, 3])
  if (process.env.BRIDGECLIP_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'watched-channels.png') })

  await card.getByRole('button', { name: 'Stop watching Café & Code' }).click()
  await page.getByRole('button', { name: 'Stop watching', exact: true }).click()
  await page.getByText('No channels yet', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
})
