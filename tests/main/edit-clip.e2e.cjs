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

test('text overlays: add a hook and a text, edit, move by drag, and burn them into the export', { timeout: 420000 }, async (t) => {
  const tools = editorTools(t, { python: true, captions: true })
  if (!tools) return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-edit-text-'))
  const userDataDir = path.join(root, 'user-data'), library = path.join(userDataDir, 'Library')
  const original = path.join(root, 'source.mp4')
  video(tools, original, 12)
  const run = automaticRun(tools, library, 'text-run', original)
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
  await page.getByRole('button', { name: 'Open Interview text-run', exact: true }).click()
  await page.locator('article').filter({ has: page.getByRole('heading', { name: 'Why it matters', exact: true }) }).getByRole('button', { name: 'Edit clip', exact: true }).click()
  await page.getByRole('region', { name: 'Clip editor' }).waitFor({ timeout: 120000 })
  await page.locator('.editor-tabs').getByRole('button', { name: 'Text', exact: true }).click()

  await page.getByRole('button', { name: 'Add hook', exact: true }).click()
  let candidate = await saved()
  assert.equal(candidate.text_overlays.length, 1)
  const hook = candidate.text_overlays[0]
  assert.equal(hook.text, 'Why it matters'); assert.equal(hook.start_ms, candidate.ranges[0][0]); assert.equal(hook.background, '#FFE234')
  await page.getByRole('textbox', { name: 'Overlay text', exact: true }).fill('Attends la fin')
  await page.getByRole('combobox', { name: 'Overlay animation' }).selectOption('none')
  // Drag the hook on the output preview: it moves down.
  const onScreen = page.getByRole('button', { name: 'Text overlay: Attends la fin', exact: true })
  const box = await onScreen.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, { steps: 5 }); await page.mouse.up()
  candidate = await saved()
  assert.ok(candidate.text_overlays[0].y > .2, `moved down to ${candidate.text_overlays[0].y}`)
  assert.equal(candidate.text_overlays[0].text, 'Attends la fin'); assert.equal(candidate.text_overlays[0].animation, 'none')
  // A second, plain text later in the clip.
  await page.getByRole('slider', { name: 'Source timeline', exact: true }).evaluate((el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '4000')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.getByRole('button', { name: 'Add text', exact: true }).click()
  candidate = await saved()
  assert.equal(candidate.text_overlays.length, 2); assert.equal(candidate.text_overlays[1].start_ms, 4000)
  assert.equal(await page.locator('.editor-overlay-block').count(), 2, 'both on the text track')
  if (shots) await page.screenshot({ path: path.join(shots, 'edit-text.png') })

  await page.getByRole('button', { name: 'Export clip', exact: true }).click()
  await page.getByRole('status').filter({ hasText: /Exported “Why it matters” as a new clip/ }).waitFor({ timeout: 180000 })
  const exported = JSON.parse(fs.readFileSync(path.join(run, 'job_output.json'), 'utf8')).clips.at(-1)
  const yellow = (seconds) => {
    const raw = execFileSync(tools.ffmpeg, ['-v', 'error', '-ss', String(seconds), '-i', exported.s3_url, '-frames:v', '1', '-vf', 'scale=270:480', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
    let count = 0
    for (let i = 0; i < raw.length; i += 3) if (Math.abs(raw[i] - 0xFF) < 20 && Math.abs(raw[i + 1] - 0xE2) < 20 && Math.abs(raw[i + 2] - 0x34) < 25) count++
    return count
  }
  assert.ok(yellow(.5) > 400, 'hook plate burned in at the start')
  assert.ok(yellow(3.5) < yellow(.5) / 4, 'hook gone after its 3 seconds')
  assert.deepEqual(errors, [])
})

test('effects: edit styles with undo, punch-in zoom, a look, fades, slow motion, and a matching export', { timeout: 420000 }, async (t) => {
  const tools = editorTools(t, { python: true, captions: true })
  if (!tools) return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-edit-effects-'))
  const userDataDir = path.join(root, 'user-data'), library = path.join(userDataDir, 'Library')
  const original = path.join(root, 'source.mp4')
  video(tools, original, 12)
  const run = automaticRun(tools, library, 'effects-run', original)
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
  const seekTo = (ms) => page.getByRole('slider', { name: 'Source timeline', exact: true }).evaluate((el, ms) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(ms))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, ms)
  await page.getByRole('button', { name: /^Library/ }).click()
  await page.getByRole('button', { name: 'Open Interview effects-run', exact: true }).click()
  await page.locator('article').filter({ has: page.getByRole('heading', { name: 'Why it matters', exact: true }) }).getByRole('button', { name: 'Edit clip', exact: true }).click()
  await page.getByRole('region', { name: 'Clip editor' }).waitFor({ timeout: 120000 })
  await page.locator('.editor-tabs').getByRole('button', { name: 'Effects', exact: true }).click()
  const before = await saved()

  // A one-click style, fully undoable.
  await page.getByRole('button', { name: /^Viral Edit/ }).click()
  let candidate = await saved()
  assert.equal(candidate.caption_preset, 'hormozi'); assert.equal(candidate.effects.transition, 'flash'); assert.equal(candidate.video_speed, 1.1)
  assert.ok(candidate.scenes.length > before.scenes.length, 'punch-in zooms added as layout changes')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  candidate = await saved()
  assert.equal(candidate.effects, undefined); assert.equal(candidate.caption_preset, before.caption_preset); assert.deepEqual(candidate.scenes, before.scenes)

  // Build effects by hand: a punch-in zoom, a look on part of the clip, a fade in, slow motion.
  await seekTo(2500)
  await page.getByRole('button', { name: 'Punch-in zoom at playhead', exact: true }).click()
  candidate = await saved()
  assert.equal(candidate.scenes.length, before.scenes.length + 2)
  await seekTo(3000)
  await page.getByRole('button', { name: 'Look at playhead', exact: true }).click()
  const brightness = page.getByRole('slider', { name: 'Brightness', exact: true })
  await brightness.focus(); for (let i = 0; i < 20; i++) await brightness.press('ArrowRight')
  const fadeIn = page.getByRole('slider', { name: 'Fade in', exact: true })
  await fadeIn.focus(); for (let i = 0; i < 5; i++) await fadeIn.press('ArrowRight')
  await page.getByRole('combobox', { name: 'Clip speed' }).selectOption('0.5')
  candidate = await saved()
  assert.equal(candidate.effects.fade_in_ms, 500); assert.equal(candidate.video_speed, .5)
  assert.equal(candidate.effects.looks.length, 1); assert.equal(candidate.effects.looks[0].start_ms, 3000); assert.equal(candidate.effects.looks[0].brightness, .2)
  if (shots) await page.screenshot({ path: path.join(shots, 'edit-effects.png') })

  await page.getByRole('button', { name: 'Export clip', exact: true }).click()
  await page.getByRole('status').filter({ hasText: /Exported “Why it matters” as a new clip/ }).waitFor({ timeout: 240000 })
  const exported = JSON.parse(fs.readFileSync(path.join(run, 'job_output.json'), 'utf8')).clips.at(-1)
  const info = probe(tools, exported.s3_url)
  const kept = candidate.ranges.reduce((n, [a, b]) => n + b - a, 0) / 1000
  assert.ok(Math.abs(Number(info.format.duration) - kept / .5) < .2, `slow motion doubles ${kept}s to ${info.format.duration}s`)
  assert.deepEqual(errors, [])
})

test('audio: import music, mute, volume, ducking and fades, preview playback, and a mixed export', { timeout: 420000 }, async (t) => {
  const tools = editorTools(t, { python: true, captions: true })
  if (!tools) return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-edit-audio-'))
  const userDataDir = path.join(root, 'user-data'), library = path.join(userDataDir, 'Library')
  const original = path.join(root, 'source.mp4')
  video(tools, original, 12)
  const music = path.join(root, 'Musique d’été [mix] 1.wav')
  execFileSync(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3', music])
  const run = automaticRun(tools, library, 'audio-run', original)
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
  const nudge = async (name, presses, key = 'ArrowRight') => {
    const slider = page.getByRole('slider', { name, exact: true })
    await slider.focus(); for (let i = 0; i < presses; i++) await slider.press(key)
  }
  await page.getByRole('button', { name: /^Library/ }).click()
  await page.getByRole('button', { name: 'Open Interview audio-run', exact: true }).click()
  await page.locator('article').filter({ has: page.getByRole('heading', { name: 'Why it matters', exact: true }) }).getByRole('button', { name: 'Edit clip', exact: true }).click()
  await page.getByRole('region', { name: 'Clip editor' }).waitFor({ timeout: 120000 })
  await page.locator('.editor-tabs').getByRole('button', { name: 'Audio', exact: true }).click()

  // Import: the chosen file is copied into the project as AAC; the original is untouched.
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, music)
  await page.getByRole('button', { name: 'Add music…', exact: true }).click()
  await page.getByRole('button', { name: 'Remove music', exact: true }).waitFor({ timeout: 60000 })
  let candidate = await saved()
  assert.match(candidate.audio.music.file, /^editor-music-[a-f0-9]{32}\.mp4$/)
  assert.equal(candidate.audio.music.name, 'Musique d’été [mix] 1.wav')
  assert.ok(fs.statSync(path.join(run, candidate.audio.music.file)).size > 1000)
  assert.equal(candidate.audio.music.duck, true)
  await page.getByLabel('Music track').waitFor()
  await page.getByText('0:03', { exact: true }).waitFor()

  // Clip sound and music settings.
  await nudge('Volume', 3)
  await page.getByText(/The preview can't play louder than the original/).waitFor()
  await nudge('Music volume', 6)
  await nudge('Lower by', 3, 'ArrowLeft')
  await nudge('Music fade out', 5)
  candidate = await saved()
  assert.equal(candidate.audio.volume_db, 3); assert.equal(candidate.audio.music.volume_db, -12)
  assert.equal(candidate.audio.music.duck_db, -15); assert.equal(candidate.audio.music.fade_out_ms, 2000)
  await page.getByRole('button', { name: 'Remove music', exact: true }).click()
  await page.getByRole('button', { name: 'Add music…', exact: true }).waitFor()
  candidate = await saved()
  assert.equal(candidate.audio.music, null)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await page.getByRole('button', { name: 'Remove music', exact: true }).waitFor()
  candidate = await saved()
  assert.ok(candidate.audio.music, 'Undo brings the music back')

  // The preview plays the music with the video, and pauses it with the video.
  await page.locator('.editor-monitor-hint').click().catch(() => {})
  await page.keyboard.press('Space')
  await page.waitForFunction(() => { const a = document.querySelector('audio'); return a && !a.paused && a.currentTime > .2 }, null, { timeout: 15000 })
  await page.keyboard.press('Space')
  await page.waitForFunction(() => document.querySelector('audio')?.paused === true)
  if (shots) await page.screenshot({ path: path.join(shots, 'edit-audio.png') })

  // Mute the clip's own sound so the export carries only the music.
  await page.getByRole('switch', { name: 'Mute clip sound' }).click()
  candidate = await saved()
  assert.equal(candidate.audio.mute, true)
  await page.getByRole('button', { name: 'Export clip', exact: true }).click()
  await page.getByRole('status').filter({ hasText: /Exported “Why it matters” as a new clip/ }).waitFor({ timeout: 240000 })
  const exported = JSON.parse(fs.readFileSync(path.join(run, 'job_output.json'), 'utf8')).clips.at(-1)
  const info = probe(tools, exported.s3_url)
  const streams = Object.fromEntries(info.streams.map((s) => [s.codec_type, Number(s.duration)]))
  const kept = candidate.ranges.reduce((n, [a, b]) => n + b - a, 0) / 1000
  assert.ok(Math.abs(streams.audio - kept) < .1 && Math.abs(streams.video - kept) < .1, JSON.stringify(streams))
  const stats = require('node:child_process').spawnSync(tools.ffmpeg, ['-v', 'info', '-i', exported.s3_url, '-vn', '-af', 'atrim=start=0.2:end=1,astats=measure_overall=RMS_level:measure_perchannel=none', '-f', 'null', '-'], { encoding: 'utf8' })
  const level = Number(/RMS level dB: (-?[\d.]+)/.exec(stats.stderr)?.[1])
  // Muted voice, music at -12 dB lowered by 15 dB under speech: quiet but clearly not silence (about -91 dB).
  assert.ok(level > -60, `music is in the export (${level} dB)`)
  assert.ok(fs.existsSync(music), 'the chosen music file is left where it was')
  assert.deepEqual(errors, [])
})

test('smart reframing: face tracking, auto, center and off as undoable edits, and manual crops', { timeout: 420000 }, async (t) => {
  const tools = editorTools(t, { python: true, captions: true })
  if (!tools) return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-edit-reframe-'))
  const userDataDir = path.join(root, 'user-data'), library = path.join(userDataDir, 'Library')
  const original = path.join(root, 'source.mp4')
  video(tools, original, 12)
  const run = automaticRun(tools, library, 'reframe-run', original)
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
  const reframing = page.getByRole('region', { name: 'Smart reframing' })
  await page.getByRole('button', { name: /^Library/ }).click()
  await page.getByRole('button', { name: 'Open Interview reframe-run', exact: true }).click()
  await page.locator('article').filter({ has: page.getByRole('heading', { name: 'Why it matters', exact: true }) }).getByRole('button', { name: 'Edit clip', exact: true }).click()
  await page.getByRole('region', { name: 'Clip editor' }).waitFor({ timeout: 120000 })
  await page.locator('.editor-tabs').getByRole('button', { name: 'Framing', exact: true }).click()
  await reframing.getByText('Manual', { exact: true }).waitFor()
  const before = await saved()

  // Face tracking runs the local detector; the test pattern has no people, so the crop stays centered full frame.
  await reframing.getByRole('button', { name: 'Face tracking', exact: true }).click()
  await page.getByRole('status').filter({ hasText: /^Face tracking: / }).waitFor({ timeout: 180000 })
  let candidate = await saved()
  assert.equal(candidate.reframe, 'face'); assert.equal(candidate.scenes[0].layout, 'fill'); assert.equal(candidate.scenes[0].at_ms, 0)
  assert.ok(Math.abs(candidate.scenes[0].crops[0][0] + candidate.scenes[0].crops[0][2] / 2 - .5) < .01)
  assert.deepEqual(fs.readdirSync(run).filter((f) => f.startsWith('editor-reframe-')), [], 'the analysis result is not left behind')
  await reframing.getByText('Face tracking', { exact: true }).last().waitFor()

  await reframing.getByRole('button', { name: 'Auto', exact: true }).click()
  await page.getByRole('status').filter({ hasText: /^Auto: / }).waitFor({ timeout: 180000 })
  candidate = await saved()
  assert.equal(candidate.reframe, 'auto'); assert.equal(candidate.scenes[0].layout, 'fit', 'a screen without people is shown whole')

  await reframing.getByRole('button', { name: 'Off', exact: true }).click()
  candidate = await saved()
  assert.equal(candidate.reframe, 'off'); assert.deepEqual(candidate.scenes.map((s) => s.layout), ['fit'])
  await reframing.getByRole('button', { name: 'Center', exact: true }).click()
  candidate = await saved()
  assert.equal(candidate.reframe, 'center'); assert.deepEqual(candidate.scenes.map((s) => s.layout), ['fill'])
  if (shots) await page.screenshot({ path: path.join(shots, 'edit-reframe.png') })

  // Undo walks back through the modes to the original layouts.
  for (const mode of ['off', 'auto', 'face']) {
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    candidate = await saved()
    assert.equal(candidate.reframe, mode)
  }
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  candidate = await saved()
  assert.equal(candidate.reframe, undefined); assert.deepEqual(candidate.scenes, before.scenes)

  // Moving a crop by hand after a mode switches to Manual.
  await reframing.getByRole('button', { name: 'Center', exact: true }).click()
  await saved()
  const horizontal = page.getByRole('slider', { name: 'Horizontal crop position', exact: true })
  await horizontal.focus(); await horizontal.press('ArrowRight')
  candidate = await saved()
  assert.equal(candidate.reframe, undefined)
  await reframing.getByText('Manual', { exact: true }).waitFor()
  assert.deepEqual(errors, [])
})
