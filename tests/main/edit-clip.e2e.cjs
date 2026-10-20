const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { buildApp, launchApp } = require('../zernio/support/electron-app.cjs')
const { editorTools, linkEngine } = require('./editor-e2e-tools.cjs')

// "Edit clip" on an Automatic run: Library card → editor on that clip → shorter cut → valid MP4 as a new clip.
// Paths include spaces, accents, an apostrophe and brackets, as on real Windows libraries.

function automaticRun(tools, library, name, source, seconds = 12) {
  const run = path.join(library, name)
  fs.mkdirSync(run, { recursive: true })
  const clips = [['Why it matters', 2000, 6000, .8], ['Second moment', 7000, 10000, .6]].map(([summary, start, end, score], clip_index) => {
    const file = path.join(run, `clip_0${clip_index}.mp4`)
    execFileSync(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30', '-t', '2', ...tools.encoder,
      '-pix_fmt', 'yuv420p', file])
    return { clip_index, summary, s3_url: `file://${file}`, start_time_ms: start, end_time_ms: end, duration_ms: end - start,
      virality_score: score, layout_type: 'talking_head', tags: [] }
  })
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ job_id: name, source_video_url: source, source_video_title: `Interview ${name}`,
    source_video_duration_seconds: seconds, clips, total_clips: clips.length,
    metrics: { requested_settings: { aspect_ratio: '9:16', layout_style: 'auto', video_speed: 1, include_title: true }, captions_status: 'enabled',
      clip_layouts: [{ clip_index: 0, shots: [{ start_ms: 0, end_ms: 4300, layout: 'talking_head', people: [[.4, .2, .2, .3]] }] }] } }))
  fs.writeFileSync(path.join(run, 'plan.json'), JSON.stringify({ segments: clips.map((c) => ({ start_time_ms: c.start_time_ms, end_time_ms: c.end_time_ms, skip_ranges_ms: [] })) }))
  const words = ['Bonjour', 'tout', 'le', 'monde', 'voici', "l'été"].map((word, i) => ({ word, start_time_ms: 2100 + i * 500, end_time_ms: 2500 + i * 500 }))
  fs.writeFileSync(path.join(run, 'transcript.json'), JSON.stringify({ segments: [{ start_time_ms: 2100, end_time_ms: 5000, text: words.map((w) => w.word).join(' '), words }] }))
  return run
}

function video(tools, file, seconds) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    ...tools.encoder, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', file])
}

function probe(tools, file) {
  const ffprobe = path.join(path.dirname(tools.ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  return JSON.parse(execFileSync(fs.existsSync(ffprobe) ? ffprobe : 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString())
}

test('Edit clip opens an Automatic clip in the editor and exports a shorter, valid MP4 as a new clip', { timeout: 300000 }, async (t) => {
  const tools = editorTools(t, { python: true, captions: true })
  if (!tools) return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-edit-clip-'))
  const userDataDir = path.join(root, 'user-data'), library = path.join(userDataDir, "Mes clips d'été [v2]")
  const original = path.join(root, 'Vidéos source', "l'interview [final].mp4")
  video(tools, original, 12)
  const run = automaticRun(tools, library, 'automatic-run', original)
  const moved = path.join(root, 'Déplacé', 'interview moved.mp4'), wrong = path.join(root, 'Autre', 'other video.mp4')
  video(tools, wrong, 5)
  const missingRun = automaticRun(tools, library, 'missing-run', path.join(root, 'gone', 'deleted.mp4'))
  fs.mkdirSync(path.dirname(moved), { recursive: true }); fs.copyFileSync(original, moved)
  fs.writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify({ version: 6, outputDirectory: library, pythonPath: tools.python, openrouterApiKey: '', zernioApiKey: '' }))
  const originalClip = fs.readFileSync(path.join(run, 'clip_00.mp4'))
  const appDir = buildApp(path.join(root, 'app'))
  linkEngine(appDir)
  const session = await launchApp({ appDir, userDataDir, env: tools.appEnv })
  t.after(async () => {
    const stop = setTimeout(() => session.app.process().kill('SIGTERM'), 5000)
    try { await session.close() } finally { clearTimeout(stop); fs.rmSync(root, { recursive: true, force: true }) }
  })
  const { app, page } = session
  const shots = process.env.BRIDGECLIP_E2E_SHOTS
  if (shots) fs.mkdirSync(shots, { recursive: true })
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))
  page.setDefaultTimeout(15000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950))

  await page.getByRole('button', { name: /^Library/ }).click()
  await page.getByRole('button', { name: 'Open Interview automatic-run', exact: true }).click()
  const card = (title) => page.locator('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
  await card('Why it matters').getByRole('button', { name: 'Edit clip', exact: true }).waitFor()
  if (shots) await page.screenshot({ path: path.join(shots, 'edit-clip-cards.png') })
  await card('Why it matters').getByRole('button', { name: 'Edit clip', exact: true }).click()

  // One-time preparation links the original video, then the editor opens on the clip that was clicked.
  const editor = page.getByRole('region', { name: 'Clip editor' })
  await editor.waitFor({ timeout: 120000 })
  assert.equal(await page.locator('#editor-title').inputValue(), 'Why it matters')
  assert.equal(await page.locator('.editor-stagebar .editor-status').innerText(), 'Baked')
  const job = JSON.parse(fs.readFileSync(path.join(run, 'job_output.json'), 'utf8'))
  assert.equal(job.editor_project, true)
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(run, 'editor-source.mp4')).ino, fs.statSync(original).ino, 'Same-drive sources are hard-linked, not copied')
  assert.equal(await page.getByRole('button', { name: 'Export clip', exact: true }).isDisabled(), true)

  // Shorten the clip: the AI cut is 1.85 s – 6.15 s (with padding); end it at 4 s.
  const end = page.getByRole('textbox', { name: 'Cut 1 end', exact: true })
  await end.fill('0:04.000'); await end.press('Enter')
  await page.locator('.editor-stagebar .editor-status', { hasText: 'Refining' }).waitFor()
  if (shots) await page.screenshot({ path: path.join(shots, 'edit-clip-editor.png') })
  await page.getByRole('button', { name: 'Export clip', exact: true }).click()
  await page.getByRole('status').filter({ hasText: /Exported “Why it matters” as a new clip/ }).waitFor({ timeout: 180000 })
  assert.equal(await page.locator('.editor-stagebar .editor-status').innerText(), 'Baked')

  const output = JSON.parse(fs.readFileSync(path.join(run, 'job_output.json'), 'utf8'))
  const edited = output.clips.at(-1)
  assert.equal(output.clips.length, 3)
  assert.equal(edited.edited_from_clip, 0); assert.equal(edited.editor_candidate, 'clip-00')
  assert.deepEqual(fs.readFileSync(path.join(run, 'clip_00.mp4')), originalClip, 'The original clip is never overwritten')
  const info = probe(tools, edited.s3_url)
  assert.ok(Math.abs(Number(info.format.duration) - 2.15) < .15, `duration ${info.format.duration}`)
  assert.deepEqual(info.streams.map((s) => s.codec_type).sort(), ['audio', 'video'])
  assert.equal(edited.virality_score, .8)
  const projectFile = JSON.parse(fs.readFileSync(path.join(run, 'editor-project.json'), 'utf8'))
  assert.deepEqual(projectFile.candidates[0].ranges, [[1850, 4000]])

  // Back in the clip list, the edited export sits next to the original and is marked Edited.
  await page.getByRole('button', { name: 'View clips', exact: true }).click()
  await page.locator('article').filter({ hasText: 'Edited' }).first().waitFor()
  await page.locator('article').filter({ hasText: 'Edited' }).getByTitle('Virality score').filter({ hasText: '8.0' }).waitFor()
  assert.equal(await page.locator('article').filter({ has: page.getByRole('heading', { name: 'Why it matters', exact: true }) }).count(), 2)
  if (shots) await page.screenshot({ path: path.join(shots, 'edit-clip-after-export.png') })
  // Editing the edited export reopens the same timeline.
  await page.locator('article').filter({ hasText: 'Edited' }).first().getByRole('button', { name: 'Edit clip', exact: true }).click()
  await editor.waitFor()
  assert.equal(await page.locator('#editor-title').inputValue(), 'Why it matters')
  assert.equal(await page.getByRole('textbox', { name: 'Cut 1 end', exact: true }).inputValue(), '0:04.000')
  await page.getByRole('button', { name: 'Back to clips', exact: true }).click()

  // A moved original: Locate it. A different video is refused before anything is written.
  await page.getByRole('button', { name: /^Library/ }).click()
  await page.getByRole('button', { name: 'Open Interview missing-run', exact: true }).click()
  await card('Second moment').getByRole('button', { name: 'Edit clip', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit clip' })
  await dialog.getByText(/Original video not found\. “deleted\.mp4” was moved, renamed or deleted/).waitFor({ timeout: 60000 })
  const choose = (file) => app.evaluate(({ dialog: d }, selected) => { d.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }) }, file)
  await choose(wrong)
  await dialog.getByRole('button', { name: 'Locate original video…', exact: true }).click()
  await dialog.getByText(/different duration than the one these clips came from/).waitFor({ timeout: 120000 })
  assert.equal(fs.existsSync(path.join(missingRun, 'editor-project.json')), false)
  assert.equal(fs.existsSync(path.join(missingRun, 'editor-source.mp4')), false)
  await choose(moved)
  await dialog.getByRole('button', { name: 'Locate original video…', exact: true }).click()
  await editor.waitFor({ timeout: 120000 })
  assert.equal(await page.locator('#editor-title').inputValue(), 'Second moment')
  assert.deepEqual(errors, [])
})

test('captions: templates, custom style, saved presets, retimed and added lines, exact preview and export', { timeout: 420000 }, async (t) => {
  const tools = editorTools(t, { python: true, captions: true })
  if (!tools) return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-edit-captions-'))
  const userDataDir = path.join(root, 'user-data'), library = path.join(userDataDir, "Mes clips d'été [v2]")
  const original = path.join(root, 'Vidéos source', 'interview.mp4')
  video(tools, original, 12)
  const run = automaticRun(tools, library, 'caption-run', original)
  fs.writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify({ version: 6, outputDirectory: library, pythonPath: tools.python, openrouterApiKey: '', zernioApiKey: '' }))
  const appDir = buildApp(path.join(root, 'app'))
  linkEngine(appDir)
  const session = await launchApp({ appDir, userDataDir, env: tools.appEnv })
  t.after(async () => {
    const stop = setTimeout(() => session.app.process().kill('SIGTERM'), 5000)
    try { await session.close() } finally { clearTimeout(stop); fs.rmSync(root, { recursive: true, force: true }) }
  })
  const { app, page } = session
  const shots = process.env.BRIDGECLIP_E2E_SHOTS
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))
  page.setDefaultTimeout(20000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 1000))
  const saved = async () => {
    await page.getByText('All changes saved', { exact: true }).waitFor()
    return JSON.parse(fs.readFileSync(path.join(run, 'editor-project.json'), 'utf8')).candidates[0]
  }
  await page.getByRole('button', { name: /^Library/ }).click()
  await page.getByRole('button', { name: 'Open Interview caption-run', exact: true }).click()
  await page.locator('article').filter({ has: page.getByRole('heading', { name: 'Why it matters', exact: true }) }).getByRole('button', { name: 'Edit clip', exact: true }).click()
  await page.getByRole('region', { name: 'Clip editor' }).waitFor({ timeout: 120000 })
  // Edit clip opens on the Captions tab, with the editor templates first.
  assert.equal(await page.locator('.editor-tabs').getByRole('button', { name: 'Captions', exact: true }).getAttribute('aria-pressed'), 'true')
  const templates = page.getByRole('radiogroup', { name: 'Caption style' }).getByRole('radio')
  assert.deepEqual((await templates.allInnerTexts()).slice(0, 6).map((s) => s.trim().split('\n').pop()), ['Viral Bold', 'Hormozi Style', 'Karaoke', 'Minimal Clean', 'Gaming', 'Cinematic'])
  await page.getByRole('radio', { name: 'Hormozi Style', exact: true }).click()
  let candidate = await saved()
  assert.equal(candidate.caption_preset, 'hormozi'); assert.equal(candidate.caption_style, undefined)

  // Customize: one word at a time, magenta text, a background plate, fade in.
  const words = page.getByRole('slider', { name: 'Words on screen', exact: true })
  await words.focus(); await words.press('ArrowLeft'); await words.press('ArrowLeft')
  await page.getByLabel('Text', { exact: true }).fill('#ff00ff')
  await page.getByRole('switch', { name: 'Background', exact: true }).click()
  await page.getByRole('combobox', { name: 'Entrance animation' }).selectOption('fade')
  candidate = await saved()
  assert.deepEqual(candidate.caption_style, { max_words_per_line: 1, primary_color: '#FF00FF', line_box_color: '#000000', entrance: 'fade' })
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  assert.equal((await saved()).caption_style.entrance, undefined, 'each change is one undo step')
  await page.getByRole('button', { name: 'Redo', exact: true }).click()

  // Save the look, switch template, then re-apply the saved look.
  await page.getByRole('textbox', { name: 'Preset name', exact: true }).fill('Mon style')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: 'Mon style', exact: true }).waitFor()
  const stored = JSON.parse(fs.readFileSync(path.join(userDataDir, 'caption-presets.json'), 'utf8'))
  assert.equal(stored[0].name, 'Mon style'); assert.equal(stored[0].base, 'hormozi'); assert.equal(stored[0].style.primary_color, '#FF00FF')
  await page.getByRole('radio', { name: 'Cinematic', exact: true }).click()
  assert.equal((await saved()).caption_preset, 'cinematic')
  await page.getByRole('button', { name: 'Mon style', exact: true }).click()
  candidate = await saved()
  assert.equal(candidate.caption_preset, 'hormozi'); assert.equal(candidate.caption_style.primary_color, '#FF00FF')

  // Transcript: retime the spoken line and add a caption of our own.
  await page.locator('.editor-tabs').getByRole('button', { name: 'Transcript', exact: true }).click()
  await page.getByRole('button', { name: 'Edit caption at 0:02.100', exact: true }).click()
  const start = page.getByRole('textbox', { name: 'Caption start', exact: true })
  await start.fill('0:02.300'); await start.press('Enter')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Add at playhead', exact: true }).click()
  await page.getByRole('textbox', { name: 'Added caption 1', exact: true }).fill('Ajouté à la main')
  candidate = await saved()
  assert.deepEqual(candidate.caption_edits.map((e) => [e.segment, e.start_ms, e.end_ms]), [[0, 2300, 5000]])
  assert.equal(candidate.caption_inserts.length, 1); assert.equal(candidate.caption_inserts[0].text, 'Ajouté à la main')
  assert.ok(await page.locator('.editor-caption-block.added').count() >= 1, 'added captions show on the caption track')

  // Exact preview renders the export frame at the playhead.
  await page.getByRole('slider', { name: 'Source timeline', exact: true }).evaluate((el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '3200')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.getByRole('button', { name: 'Exact preview', exact: true }).click()
  const still = page.locator('.editor-exact-preview img')
  await still.waitFor({ timeout: 120000 })
  const frameFile = decodeURIComponent(new URL(await still.getAttribute('src')).pathname).replace(/^\/([A-Za-z]:)/, '$1')
  assert.match(path.basename(frameFile), /^editor-frame-[a-f0-9]{32}\.png$/)
  await page.waitForFunction(() => document.querySelector('.editor-exact-preview img')?.naturalWidth > 0)
  if (shots) await page.screenshot({ path: path.join(shots, 'edit-captions-exact.png') })
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  if (shots) await page.screenshot({ path: path.join(shots, 'edit-captions-live.png') })

  await page.getByRole('button', { name: 'Export clip', exact: true }).click()
  await page.getByRole('status').filter({ hasText: /Exported “Why it matters” as a new clip/ }).waitFor({ timeout: 180000 })
  const exported = JSON.parse(fs.readFileSync(path.join(run, 'job_output.json'), 'utf8')).clips.at(-1)
  // Magenta caption text is really burned into the export.
  const ffmpeg = tools.ffmpeg
  const magenta = (seconds) => {
    const raw = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(seconds), '-i', exported.s3_url, '-frames:v', '1', '-vf', 'scale=270:480', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
    let count = 0
    for (let i = 0; i < raw.length; i += 3) if (raw[i] > 200 && raw[i + 1] < 80 && raw[i + 2] > 200) count++
    return count
  }
  assert.ok(Math.max(magenta(1), magenta(1.6), magenta(2.2)) > 50, 'custom caption color in the exported MP4')
  assert.deepEqual(errors, [])
})
