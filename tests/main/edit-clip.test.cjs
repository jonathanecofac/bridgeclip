const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')
const fixture = require('../fixtures/editor/project.json')

const schema = loadMain("export * from './src/shared/clip-editor'")
const jobs = loadMain("export * from './src/shared/job-output'")

/** An Automatic run (clips, no editor project) whose original video lives outside the library. */
function setup({ source = 'inside' } = {}) {
  const temp = tempDir("bridgeclip-edit-clip d'été ")
  const library = path.join(temp.dir, 'Ma bibliothèque [1]'), run = path.join(library, 'automatic-run')
  fs.mkdirSync(run, { recursive: true })
  const original = path.join(temp.dir, 'Vidéos', "l'interview final.mp4")
  fs.mkdirSync(path.dirname(original), { recursive: true }); fs.writeFileSync(original, 'original video bytes')
  fs.writeFileSync(path.join(run, 'clip_00.mp4'), 'rendered clip')
  const url = source === 'inside' ? original : source === 'web' ? 'https://www.youtube.com/watch?v=abcdefghijk' : path.join(temp.dir, 'gone', 'deleted.mp4')
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ job_id: 'automatic-run', source_video_url: url, source_video_title: 'Interview',
    source_video_duration_seconds: 45, total_clips: 1, clips: [{ clip_index: 0, s3_url: path.join(run, 'clip_00.mp4'), start_time_ms: 2000, end_time_ms: 6000,
      duration_ms: 4000, virality_score: .8, summary: 'Why it matters', tags: [] }] }))
  const workers = []
  const mocks = { electron: fakeElectron(temp.dir).electron, child_process: { ...require('node:child_process'), spawn: () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
    child.stdin.end = (data) => {
      const config = JSON.parse(data)
      workers.push({ config, child, finish(result = { ok: true }) {
        if (result.ok) {
          // What the engine commits: the project first, then the job output flag.
          const project = structuredClone(fixture)
          project.candidates = [{ ...project.candidates[0], id: 'clip-00', status: 'baked', exports: [0], source_clip: 0, title_card: true }]
          fs.writeFileSync(path.join(run, 'editor-preview.mp4'), 'preview')
          fs.writeFileSync(path.join(run, 'editor-project.json'), JSON.stringify(project))
          const output = JSON.parse(fs.readFileSync(path.join(run, 'job_output.json')))
          fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ ...output, editor_project: true }))
        }
        child.stdout.write(`${JSON.stringify({ type: 'progress', phase: 'preview', percent: 50 })}\n`)
        child.stdout.write(JSON.stringify(result)); child.emit('close', result.ok ? 0 : 1)
      } })
    }
    return child
  } } }
  const main = loadMain("export * from './src/main/clip-editor'; export * as settings from './src/main/settings-store'; export { authorizeMedia } from './src/main/security'", mocks)
  main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
  return { ...temp, run, library, original, main, workers }
}
async function nextWorker(workers) {
  for (let i = 0; i < 200 && !workers.length; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(workers.length, 'worker started')
  return workers.shift()
}

test('Edit clip links the recorded original video, runs create-project once and opens the editor', async () => {
  const f = setup()
  try {
    const pending = f.main.createEditorProject(f.run)
    const worker = await nextWorker(f.workers)
    assert.deepEqual({ ...worker.config, library: undefined }, { run: f.run, library: undefined, action: 'create-project', revision: 0 })
    assert.equal(f.main.readEditorOperation(f.run).operation, 'create-project')
    const source = path.join(f.run, 'editor-source.mp4')
    assert.equal(fs.readFileSync(source, 'utf8'), 'original video bytes')
    if (process.platform !== 'win32') assert.equal(fs.statSync(source).ino, fs.statSync(f.original).ino, 'same-drive originals are hard-linked')
    worker.finish()
    const session = await pending
    assert.equal(session.project.candidates[0].source_clip, 0)
    assert.equal(session.project.candidates[0].title_card, true)
    assert.equal(f.main.readEditorOperation(f.run).operation, null)
    // Already editable: no second worker, no new copy.
    const again = await f.main.createEditorProject(f.run)
    assert.equal(again.project.revision, session.project.revision)
    assert.equal(f.workers.length, 0)
  } finally { f.cleanup() }
})

for (const [kind, pattern] of [['missing', /Original video not found\. “deleted\.mp4” was moved, renamed or deleted/], ['web', /Original video not found\. These clips came from a web video/]]) {
  test(`a ${kind} original asks the user to locate the video and leaves the run untouched`, async () => {
    const f = setup({ source: kind })
    try {
      const before = fs.readdirSync(f.run).sort()
      await assert.rejects(f.main.createEditorProject(f.run), pattern)
      assert.deepEqual(fs.readdirSync(f.run).sort(), before)
      assert.equal(f.workers.length, 0)
      // A located video must come from the file dialog (authorized), not an arbitrary path from the renderer.
      await assert.rejects(f.main.createEditorProject(f.run, f.original), /outside the library/)
      const chosen = f.main.authorizeMedia(f.original)
      const pending = f.main.createEditorProject(f.run, chosen)
      ;(await nextWorker(f.workers)).finish()
      assert.equal((await pending).project.candidates[0].id, 'clip-00')
    } finally { f.cleanup() }
  })
}

test('a rejected video (different duration) maps to a locate message and removes the linked copy', async () => {
  const f = setup()
  try {
    const pending = f.main.createEditorProject(f.run)
    ;(await nextWorker(f.workers)).finish({ ok: false, error: 'duration' })
    await assert.rejects(pending, /Original video not found\. The selected video has a different duration/)
    for (const file of ['editor-source.mp4', 'editor-preview.mp4', 'editor-project.json']) assert.equal(fs.existsSync(path.join(f.run, file)), false, file)
    assert.equal(fs.readFileSync(f.original, 'utf8'), 'original video bytes', 'the original is never touched')
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.run, 'job_output.json'))).editor_project, undefined)
  } finally { f.cleanup() }
})

test('cancelling preparation stops the worker and keeps the clips unchanged', async () => {
  const f = setup()
  try {
    const pending = f.main.createEditorProject(f.run)
    const worker = await nextWorker(f.workers)
    f.main.cancelEditor(f.run)
    worker.child.emit('close', null, 'SIGTERM')
    await assert.rejects(pending, /Preparing the editor was cancelled\. Your clips are unchanged\./)
    assert.equal(fs.existsSync(path.join(f.run, 'editor-source.mp4')), false)
    assert.equal(fs.readFileSync(path.join(f.run, 'clip_00.mp4'), 'utf8'), 'rendered clip')
  } finally { f.cleanup() }
})

test('candidate fields for Edit clip survive parsing; the title card is part of the render identity', () => {
  const p = structuredClone(fixture)
  p.candidates[0] = { ...p.candidates[0], source_clip: 3, title_card: true }
  const parsed = schema.parseEditorProject(p)
  assert.equal(parsed.candidates[0].source_clip, 3)
  assert.equal(parsed.candidates[0].title_card, true)
  assert.equal(schema.candidateEdit(parsed.candidates[0]).source_clip, undefined, 'source_clip is main-owned')
  assert.notEqual(schema.renderEditKey(parsed.candidates[0]), schema.renderEditKey({ ...parsed.candidates[0], title_card: false }))
  // Older projects without the field keep their exact render identity.
  assert.equal(JSON.stringify(schema.candidateEdit(schema.parseEditorProject(fixture).candidates[0])).includes('title_card'), false)
  for (const bad of [{ title_card: 'yes' }]) assert.throws(() => schema.parseEditorProject({ ...p, candidates: [{ ...p.candidates[0], ...bad }] }))
  assert.equal(schema.parseEditorProject({ ...p, candidates: [{ ...p.candidates[0], source_clip: -1 }] }).candidates[0].source_clip, undefined)
})

test('Edit clip on a library clip resolves the right candidate', () => {
  const candidates = [{ id: 'clip-00', source_clip: 0, exports: [0, 2] }, { id: 'clip-01', source_clip: 1, exports: [1] }, { id: 'candidate-1', exports: [5] }]
  assert.equal(schema.candidateForClip(candidates, { clip_index: 1 }), 'clip-01')
  assert.equal(schema.candidateForClip(candidates, { clip_index: 2, editor_candidate: 'clip-00' }), 'clip-00')
  assert.equal(schema.candidateForClip(candidates, { clip_index: 5 }), 'candidate-1')
  assert.equal(schema.candidateForClip(candidates, { clip_index: 9 }), null)
})

test('library clips keep their editor origin; malformed values are dropped', () => {
  const clip = { clip_index: 2, s3_url: '/x/clip_02.mp4', duration_ms: 1, start_time_ms: 0, end_time_ms: 1, virality_score: .5 }
  const parsed = jobs.parseJobOutput({ clips: [{ ...clip, editor_candidate: 'clip-00', edited_from_clip: 0 }] })
  assert.equal(parsed.clips[0].editor_candidate, 'clip-00')
  assert.equal(parsed.clips[0].edited_from_clip, 0)
  const bad = jobs.parseJobOutput({ clips: [{ ...clip, editor_candidate: '../x', edited_from_clip: -1 }] })
  assert.equal(bad.clips[0].editor_candidate, undefined)
  assert.equal(bad.clips[0].edited_from_clip, undefined)
})

test('the recorded source must be a local regular video file', () => {
  const f = setup()
  try {
    assert.equal(f.main.recordedSourcePath(f.original), f.original)
    assert.equal(f.main.recordedSourcePath(`file://${f.original}`), f.original)
    for (const value of ['', 'relative.mp4', 'https://example.com/a.mp4', `${f.original}.txt`, path.join(f.library), `${f.original}\0`]) {
      assert.equal(f.main.recordedSourcePath(value), null, value)
    }
    if (process.platform !== 'win32') {
      const link = path.join(path.dirname(f.original), 'link.mp4'); fs.symlinkSync(f.original, link)
      assert.equal(f.main.recordedSourcePath(link), null, 'symlinks are not followed')
    }
  } finally { f.cleanup() }
})

test('clearing caption overrides, added captions or the title card removes them from the saved project', async () => {
  const f = setup()
  try {
    const pending = f.main.createEditorProject(f.run)
    ;(await nextWorker(f.workers)).finish()
    const session = await pending
    const edits = session.project.candidates
    Object.assign(edits[0], { status: 'refining', caption_style: { font_size: 120, x: .3 }, caption_inserts: [{ start_ms: 1000, end_ms: 2000, text: 'Hello' }], title_card: true,
      caption_edits: [{ segment: 0, text: 'Retimed', start_ms: 500, end_ms: 1500 }] })
    let saved = await f.main.saveEditor(f.run, session.project.revision, edits)
    assert.deepEqual(saved.project.candidates[0].caption_style, { font_size: 120, x: .3 })
    assert.deepEqual(saved.project.candidates[0].caption_edits, [{ segment: 0, text: 'Retimed', start_ms: 500, end_ms: 1500 }])
    for (const key of ['caption_style', 'caption_inserts', 'title_card']) delete edits[0][key]
    edits[0].caption_style = {}; edits[0].caption_inserts = []
    saved = await f.main.saveEditor(f.run, saved.project.revision, edits)
    for (const key of ['caption_style', 'caption_inserts', 'title_card']) assert.equal(key in saved.project.candidates[0], false, key)
    edits[0].caption_style = { font_name: 'Comic Sans' }
    await assert.rejects(f.main.saveEditor(f.run, saved.project.revision, edits), /Invalid/)
  } finally { f.cleanup() }
})
