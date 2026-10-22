const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')
const { editorTools, linkEngine } = require('./editor-e2e-tools.cjs')

// Auto Montage end to end with the real engine: import rushes, local analysis (no key), plan, assemble, export, open in the editor.
function rush(tools, file, patterns, size = '640x360') {
  const inputs = patterns.flatMap((p) => ['-f', 'lavfi', '-i', `${p}=size=${size}:rate=30:duration=4`])
  const graph = patterns.map((_, i) => `[${i}:v]format=yuv420p,setsar=1[v${i}]`).join(';') + ';' + patterns.map((_, i) => `[v${i}]`).join('') + `concat=n=${patterns.length}:v=1:a=0[v]`
  execFileSync(tools.ffmpeg, ['-v', 'error', '-y', ...inputs, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${4 * patterns.length}`,
    '-filter_complex', graph, '-map', '[v]', '-map', `${patterns.length}:a`, ...tools.encoder, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file])
}

test('auto montage: import rushes, analyze, generate two 15-second clips, export them and open the montage in the editor', { timeout: 600000 }, async (t) => {
  const tools = editorTools(t, { python: true, captions: true })
  if (!tools) return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-montage-e2e-'))
  const userDataDir = path.join(root, 'user-data'), library = path.join(userDataDir, 'Library')
  fs.mkdirSync(library, { recursive: true })
  const sources = path.join(root, "Rushs d'été [brut]")
  fs.mkdirSync(sources)
  const files = [path.join(sources, 'Partie 1.mp4'), path.join(sources, 'Partie 2.mp4')]
  rush(tools, files[0], ['testsrc2', 'smptebars', 'rgbtestsrc'])
  rush(tools, files[1], ['testsrc', 'pal75bars', 'smptehdbars'])
  fs.writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify({ version: 6, outputDirectory: library, pythonPath: tools.python, openrouterApiKey: '', zernioApiKey: '' }))
  const appDir = buildApp(path.join(root, 'app'))
  linkEngine(appDir)
  const session = await launchApp({ appDir, userDataDir, env: tools.appEnv })
  t.after(async () => {
    const stop = setTimeout(() => session.app.process().kill('SIGTERM'), 5000)
    try { await session.close() } finally { clearTimeout(stop); fs.rmSync(root, { recursive: true, force: true }) }
  })
  const { app, page } = session
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))
  page.setDefaultTimeout(20000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))

  await page.getByRole('button', { name: /^Auto Montage/ }).click()
  await page.getByText('Drop your rushes here', { exact: true }).waitFor()
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: selected }) }, files)
  await page.getByRole('button', { name: 'Import rushes…', exact: true }).click()
  const rushes = page.getByRole('list', { name: 'Rushes' })
  await rushes.getByText('Partie 1.mp4', { exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Rushes"] li').length === 2 &&
    [...document.querySelectorAll('[aria-label="Rushes"] li')].every((li) => li.textContent.includes('Ready')), null, { timeout: 180000 })
  // Importing the same files again adds nothing.
  await page.getByRole('button', { name: 'Import rushes…', exact: true }).click()
  await page.waitForFunction(() => !document.body.textContent.includes('Copying'), null, { timeout: 30000 })
  assert.equal(await rushes.locator('li').count(), 2)
  assert.equal(fs.readdirSync(path.join(library, '_rushes', 'media')).length, 2, 'rushes are copied into the Library folder')

  await rushes.getByRole('button', { name: 'Preview Partie 2.mp4' }).click()
  await page.getByRole('group', { name: 'Rush preview' }).or(page.getByLabel('Rush preview')).first().locator('video').waitFor()

  const panel = page.getByRole('region', { name: 'Generate a montage' })
  await panel.getByLabel('Instructions for the AI').fill('Deux clips rapides avec les plans les plus colorés.')
  await panel.getByRole('radio', { name: 'Free' }).click()
  await panel.getByRole('radio', { name: '15s' }).click()
  await panel.getByRole('radio', { name: /^Compilation/ }).click()
  await panel.getByRole('combobox', { name: 'Number of videos' }).click()
  await page.getByRole('option', { name: '2', exact: true }).click()
  await panel.getByRole('switch', { name: 'Export automatically to the Library' }).click()
  await panel.getByRole('button', { name: 'Generate the montage', exact: true }).click()
  const queue = page.getByRole('region', { name: 'Montage queue' })
  await queue.getByText('Ready', { exact: true }).waitFor({ timeout: 300000 })
  await queue.getByText(/2 videos from 2 rushes · planned by analysis scores/).waitFor()
  await queue.getByText(/2 exported/).waitFor()
  await page.getByRole('button', { name: 'Close preview', exact: true }).click()
  if (process.env.BRIDGECLIP_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'auto-montage.png'), timeout: 60000 }).catch(() => { /* Screenshots are best effort under xvfb. */ })

  const run = fs.readdirSync(library).find((d) => /^[0-9a-f-]{36}$/.test(d))
  const output = JSON.parse(fs.readFileSync(path.join(library, run, 'job_output.json'), 'utf8'))
  assert.equal(output.clips.length, 2)
  for (const clip of output.clips) {
    const ffprobe = path.isAbsolute(tools.ffmpeg) ? path.join(path.dirname(tools.ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe'
    const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', clip.s3_url]).toString())
    const video = info.streams.find((s) => s.codec_type === 'video')
    assert.deepEqual([video.width, video.height], [1080, 1920])
    assert.ok(Math.abs(Number(info.format.duration) - 15) < 1.8, `about 15 s: ${info.format.duration}`)
  }
  await queue.getByRole('button', { name: 'Open in editor', exact: true }).click()
  await page.getByText('Auto montage: 2 clips').first().waitFor()

  // A long video from the same rushes: chapters per rush, chapter list to copy for YouTube, exported in 16:9.
  await page.getByRole('button', { name: /^Auto Montage/ }).click()
  await panel.getByRole('radio', { name: 'Long video' }).click()
  await panel.getByRole('radio', { name: '10 min' }).waitFor()
  assert.equal(await panel.getByRole('switch', { name: 'Hook text in the first seconds' }).count(), 0, 'no hook option for long videos')
  await panel.getByLabel('Custom length in minutes').fill('1')
  await panel.getByRole('radio', { name: 'Compilation', exact: true }).click()
  await panel.getByRole('button', { name: 'Generate the montage', exact: true }).click()
  const long = queue.getByRole('listitem', { name: 'Montage Vlog 1' })
  await long.getByText('Ready', { exact: true }).waitFor({ timeout: 300000 })
  await long.getByText(/1 video from 2 rushes/).waitFor()
  await long.getByText(/shorter than asked/).waitFor()
  await long.getByText(/1 exported/).waitFor()
  const chapters = long.getByRole('group', { name: /^Chapters of / }).or(long.getByLabel(/^Chapters of /)).first()
  await chapters.locator('summary').click()
  assert.match(await chapters.locator('pre').textContent(), /^0:00 .+\n0:\d\d .+/)
  await app.evaluate(({ clipboard }) => clipboard.writeText(''))
  await chapters.getByRole('button', { name: 'Copy for YouTube', exact: true }).click()
  await chapters.getByRole('button', { name: 'Copied', exact: true }).waitFor()
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
  assert.match(copied, /0:00 /)
  if (process.env.BRIDGECLIP_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.BRIDGECLIP_E2E_SHOTS, 'auto-montage-long.png'), timeout: 60000 }).catch(() => { /* Best effort under xvfb. */ })
  const longRun = fs.readdirSync(library).filter((d) => /^[0-9a-f-]{36}$/.test(d) && d !== run)
  assert.equal(longRun.length, 1)
  const longOutput = JSON.parse(fs.readFileSync(path.join(library, longRun[0], 'job_output.json'), 'utf8'))
  assert.equal(longOutput.clips.length, 1)
  const plan = JSON.parse(fs.readFileSync(path.join(library, longRun[0], 'montage-plan.json'), 'utf8'))
  assert.equal(plan.mode, 'long')
  assert.ok(plan.chapters[0].chapters.length >= 2, 'one chapter per theme at least')
  assert.deepEqual(errors, [])
})
