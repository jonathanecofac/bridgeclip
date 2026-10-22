const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir } = require('../zernio/support/load-main.cjs')

const { MontageService, parseMontageRequest, DEFAULT_MONTAGE_REQUEST } = loadMain("export * from './src/main/montage'; export * from './src/shared/montage'")
const until = async (check, ms = 5000) => {
  const end = Date.now() + ms
  while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) }
}
const summary = (extra = {}) => ({ duration_ms: 12000, width: 1920, height: 1080, fps: 30, has_audio: true, scenes: 3, segments: 4, speech: true,
  category: 'gaming', description: 'A match', tags: ['headshot'], duplicate_of: null, similarity: 0, notes: [], thumbnail: '00.jpg', vision_cost_usd: .001, ...extra })

function harness(dir, behaviour = {}) {
  const library = path.join(dir, "Bibliothèque d'été")
  fs.mkdirSync(library, { recursive: true })
  const calls = { worker: [], exported: [], records: [] }
  const deps = {
    libraryDir: () => library, templatesFile: path.join(dir, 'templates.json'),
    runWorker: async (config, onProgress, signal) => {
      calls.worker.push(config)
      onProgress({ phase: config.action === 'analyze' ? 'scenes' : 'pieces', percent: 40 })
      if (behaviour.hold) await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('cancelled'))); behaviour.release = resolve })
      if (config.action === 'analyze') {
        if (behaviour.failAnalysis?.(config)) throw new Error('invalid')
        return summary(behaviour.summary?.(config) ?? {})
      }
      if (behaviour.failGenerate) throw new Error('render_failed')
      fs.writeFileSync(path.join(config.run, 'editor-project.json'), '{}')
      return { planner: 'ai', notes: [], videos: config.request.count, rushes: 2, seconds: 12, cost_usd: .02 }
    },
    exportAll: async (runDir) => { calls.exported.push(runDir); return 3 },
    createRunRecord: (lib, id) => { fs.mkdirSync(path.join(lib, id), { recursive: true }); fs.writeFileSync(path.join(lib, id, 'run-history.json'), '{}'); calls.records.push(['create', id]) },
    finishRunRecord: (lib, id, status) => calls.records.push([status, id]),
    changed: () => {}, log: () => {}, now: () => Date.parse('2026-10-22T10:00:00Z')
  }
  const video = (name, content = name) => { const file = path.join(dir, name); fs.writeFileSync(file, content); return file }
  return { library, deps, calls, video }
}

test('requests are validated like the engine', () => {
  assert.deepEqual(parseMontageRequest({ count: 2, rush_ids: ['a'.repeat(32), 'a'.repeat(32)] }).rush_ids, ['a'.repeat(32)])
  for (const bad of [{ count: 0 }, { count: 51 }, { style: 'wild' }, { aspect: '1:1' }, { duration_s: 3 }, { mode: 'long' }, { rush_ids: ['../x'] },
    { instruction: 'a\u0000b' }, { captions: 'yes' }, null]) assert.throws(() => parseMontageRequest(bad), /Invalid montage settings/)
  assert.equal(parseMontageRequest({ duration_s: null }).duration_s, null, 'free length')
})

test('rushes are copied once, analyzed in the background, and duplicates or failures are shown', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-montage-')
  try {
    const h = harness(dir, { failAnalysis: (c) => c.name === 'broken.mov', summary: (c) => c.name === 'copy.mp4' ? { duplicate_of: 'x'.repeat(32) } : {} })
    const service = new MontageService(h.deps)
    service.start()
    assert.throws(() => service.importRushes([h.video('notes.txt')]), /Choose video files/)
    service.importRushes([h.video('partie 1.mp4', 'AAA'), h.video('même partie.MP4', 'AAA'), h.video('broken.mov', 'BBB'), h.video('copy.mp4', 'CCC')])
    await until(() => { const s = service.state(); return !s.importing && s.rushes.every((r) => r.status !== 'queued' && r.status !== 'analyzing') })
    const state = service.state()
    assert.equal(state.rushes.length, 3, 'an exact copy of an imported file is skipped')
    const by = Object.fromEntries(state.rushes.map((r) => [r.name, r]))
    assert.equal(by['partie 1.mp4'].status, 'ready')
    assert.equal(by['partie 1.mp4'].summary.category, 'gaming')
    assert.equal(fs.readFileSync(by['partie 1.mp4'].mediaPath, 'utf8'), 'AAA', 'the rush is a copy in the Library folder')
    assert.ok(by['partie 1.mp4'].mediaPath.startsWith(path.join(h.library, '_rushes', 'media')))
    assert.equal(by['partie 1.mp4'].thumbnailPath, path.join(h.library, '_rushes', 'thumbs', by['partie 1.mp4'].id, '00.jpg'))
    assert.equal(by['broken.mov'].status, 'failed'); assert.match(by['broken.mov'].error, /FFmpeg could not read this video/)
    assert.equal(h.calls.worker.filter((c) => c.action === 'analyze').length, 3)
    assert.equal(h.calls.worker[0].root, path.join(h.library, '_rushes'))

    // A montage needs usable rushes; the duplicate is not one.
    assert.throws(() => service.createJob({ ...DEFAULT_MONTAGE_REQUEST, rush_ids: [by['copy.mp4'].id] }), /Analyze at least one rush/)
    service.reanalyze(by['broken.mov'].id)
    await until(() => service.state().rushes.find((r) => r.name === 'broken.mov').status === 'failed' && h.calls.worker.length === 4)
    service.removeRush(by['broken.mov'].id)
    assert.ok(!fs.existsSync(by['broken.mov'].mediaPath))
    assert.equal(service.state().rushes.length, 2)
  } finally { cleanup() }
})

test('montage jobs run, export when asked, and fail or cancel cleanly', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-montage-')
  try {
    const h = harness(dir)
    const service = new MontageService(h.deps)
    service.start()
    service.importRushes([h.video('a.mp4', '1'), h.video('b.mp4', '2')])
    await until(() => service.state().rushes.filter((r) => r.status === 'ready').length === 2)
    const music = h.video('Beat.mp3', 'music')
    service.createJob({ ...DEFAULT_MONTAGE_REQUEST, count: 4, auto_export: true, instruction: 'Les meilleurs moments' }, music)
    await until(() => service.state().jobs[0].status === 'done')
    let job = service.state().jobs[0]
    assert.equal(job.exported, 3); assert.equal(job.summary.videos, 4)
    const generate = h.calls.worker.find((c) => c.action === 'generate')
    assert.equal(generate.request.instruction, 'Les meilleurs moments')
    assert.equal(path.dirname(generate.run), h.library, 'the montage is a run in the Library')
    assert.ok(generate.music.startsWith(path.join(h.library, '_rushes', 'music')) && fs.readFileSync(generate.music, 'utf8') === 'music')
    assert.deepEqual(h.calls.exported, [job.runDir])
    assert.deepEqual(h.calls.records.map((r) => r[0]), ['create', 'completed'])
    assert.equal(service.liveRuns().length, 0)

    // Failure: the unfinished run folder is removed; Retry starts a fresh run.
    h.deps.runWorker = async (config) => { if (config.action === 'generate') { fs.mkdirSync(config.run, { recursive: true }); throw new Error('render_failed') } }
    service.createJob({ ...DEFAULT_MONTAGE_REQUEST })
    await until(() => service.state().jobs[0].status === 'failed')
    job = service.state().jobs[0]
    assert.match(job.error, /FFmpeg could not cut one of the rushes/)
    assert.ok(!fs.existsSync(job.runDir))
    const failedRun = job.runDir
    service.retryJob(job.id)
    await until(() => service.state().jobs[0].status === 'failed' && service.state().jobs[0].runDir !== failedRun)

    // Cancel a running montage.
    let release
    h.deps.runWorker = (config, onProgress, signal) => new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(new Error('cancelled'))) })
    service.createJob({ ...DEFAULT_MONTAGE_REQUEST })
    await until(() => service.state().jobs[0].status === 'running')
    assert.equal(service.liveRuns().length, 1, 'the Library shows the run as in progress')
    service.cancelJob(service.state().jobs[0].id)
    await until(() => service.state().jobs[0].status === 'cancelled')
    assert.throws(() => service.dismissJob(service.state().jobs.find((j) => j.status === 'done').id + 'x'), /Wait for this montage/)
    service.dismissJob(service.state().jobs[0].id)
    void release
  } finally { cleanup() }
})

test('unfinished work survives a restart, and templates are saved', async () => {
  const { dir, cleanup } = tempDir('bridgeclip-montage-')
  try {
    const h = harness(dir)
    const service = new MontageService(h.deps)
    service.start()
    service.importRushes([h.video('a.mp4', '1')])
    await until(() => service.state().rushes[0]?.status === 'ready')
    h.deps.runWorker = (config, onProgress, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled'))))
    service.createJob({ ...DEFAULT_MONTAGE_REQUEST, count: 2 })
    await until(() => service.state().jobs[0].status === 'running')
    service.stopAll()
    await until(() => JSON.parse(fs.readFileSync(path.join(h.library, '_rushes', 'jobs.json'), 'utf8')).jobs[0].status === 'queued')

    const h2 = harness(dir)
    const reopened = new MontageService({ ...h2.deps, libraryDir: () => h.library })
    reopened.start()
    await until(() => reopened.state().jobs[0].status === 'done')
    assert.equal(h2.calls.worker.filter((c) => c.action === 'generate').length, 1, 'the interrupted montage ran again')

    let state = reopened.saveTemplate('  Gaming 45 s ', { ...DEFAULT_MONTAGE_REQUEST, style: 'gaming', duration_s: 45, rush_ids: ['a'.repeat(32)] })
    assert.deepEqual(state.templates.map((t) => [t.name, t.request.style, t.request.duration_s, 'rush_ids' in t.request]), [['Gaming 45 s', 'gaming', 45, false]])
    assert.throws(() => reopened.saveTemplate('', DEFAULT_MONTAGE_REQUEST), /Name the template/)
    state = reopened.deleteTemplate(state.templates[0].id)
    assert.deepEqual(state.templates, [])
  } finally { cleanup() }
})
