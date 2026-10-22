import { createHash, randomUUID } from 'crypto'
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { basename, dirname, extname, join } from 'path'
import {
  MAX_RUSHES, MUSIC_EXTENSIONS, RUSH_EXTENSIONS, parseMontageRequest, youtubeDescription,
  type MontageJob, type MontageRequest, type MontageState, type MontageTemplate, type Rush, type RushSummary
} from '../shared/montage'

/** What the montage service needs from the app; tests pass fakes. */
export interface MontageDeps {
  /** The Library folder (Settings → output folder). Rushes live in its `_rushes` folder. */
  libraryDir: () => string
  templatesFile: string
  /** Run montage_runner.py with `config`; resolves its result, rejects with Error(code). */
  runWorker: (config: Record<string, unknown>, onProgress: (progress: { phase: string; percent: number }) => void, signal: AbortSignal) => Promise<unknown>
  /** Bake every ready clip of a montage run; resolves how many clips it exported. */
  exportAll: (runDir: string) => Promise<number>
  createRunRecord: (library: string, runId: string, label: string) => void
  finishRunRecord: (library: string, runId: string, status: 'completed' | 'failed' | 'cancelled', error?: string | null) => void
  changed: (state: MontageState) => void
  log: (event: string, data?: Record<string, unknown>) => void
  now: () => number
  /** Rushes analyzed at once, and montages generated at once. */
  analysisSlots?: number
  jobSlots?: number
}

const ID = /^[a-f0-9]{32}$/
const MAX_FILE_BYTES = 200 * 1024 * 1024 * 1024
const ANALYSIS_ERRORS: Record<string, string> = {
  invalid: 'FFmpeg could not read this video. Re-export it as MP4 and import it again.',
  duration: 'This video is too short to use.',
  source_missing: 'The copied file is missing from the rush library. Remove it and import it again.',
  engine_unavailable: 'The video engine could not start. Open Settings and run System check.',
  cancelled: 'Analysis was stopped.'
}
const JOB_ERRORS: Record<string, string> = {
  invalid_edit: 'No usable moments: analyze some rushes first, or choose other rushes.',
  render_failed: 'FFmpeg could not cut one of the rushes. Details are in Help → Show Logs.',
  music_invalid: 'The music file can’t be used. Choose an MP3, WAV, M4A, AAC, OGG or FLAC file.',
  source_missing: 'A rush file is missing from the library. Re-import it.',
  engine_unavailable: 'The video engine could not start. Open Settings and run System check.',
  cancelled: 'Cancelled.'
}

interface Store { version: 1; rushes: Rush[] }

/**
 * The Auto Montage library and job queue. Rushes are copied into the Library
 * folder once (exact copies are recognized by their SHA-256) and analyzed in
 * the background; montage jobs plan, assemble and optionally export. Both
 * queues survive a restart: unfinished work starts again.
 */
export class MontageService {
  private root = ''
  private store: Store = { version: 1, rushes: [] }
  private jobs: MontageJob[] = []
  private importing: MontageState['importing'] = null
  private importQueue: string[] = []
  private analyzing = new Map<string, { phase: string; percent: number; abort: AbortController }>()
  private running = new Map<string, AbortController>()
  private started = false
  /** Quitting: unfinished work is left queued for the next start, not cancelled. */
  private quitting = false

  constructor(private deps: MontageDeps) {}

  // ── State ────────────────────────────────────────────────────────────

  private ensureRoot(): string {
    const root = join(this.deps.libraryDir(), '_rushes')
    if (root !== this.root) {
      for (const run of this.analyzing.values()) run.abort.abort()
      this.root = root
      mkdirSync(join(root, 'media'), { recursive: true })
      this.store = this.readJson<Store>('library.json', { version: 1, rushes: [] })
      this.store.rushes = this.store.rushes.filter((r) => r && ID.test(r.id) && RUSH_EXTENSIONS.includes(r.ext as typeof RUSH_EXTENSIONS[number]))
      this.jobs = this.readJson<{ jobs: MontageJob[] }>('jobs.json', { jobs: [] }).jobs.filter((j) => j && ID.test(j.id))
      // Work that was cut short by a restart starts again.
      for (const rush of this.store.rushes) if (rush.status === 'analyzing') rush.status = 'queued'
      for (const job of this.jobs) {
        if (job.status === 'running') { job.status = 'queued'; job.progress = undefined }
        if (job.status === 'exporting') { job.status = 'done'; job.progress = undefined; job.error = 'Exporting was interrupted. Use Export all to finish.' }
      }
      this.persist()
    }
    return root
  }
  private readJson<T>(name: string, fallback: T): T {
    try { return JSON.parse(readFileSync(join(this.root, name), 'utf8')) as T } catch { return fallback }
  }
  private writeJson(name: string, value: unknown): void {
    const file = join(this.root, name), temp = `${file}.${randomUUID()}.tmp`
    try { writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); renameSync(temp, file) } catch (error) {
      try { unlinkSync(temp) } catch { /* Not written. */ }
      this.deps.log('montage.save.failed', { error: error instanceof Error ? error.message : 'unknown' })
    }
  }
  private persist(): void {
    this.writeJson('library.json', this.store)
    this.writeJson('jobs.json', { jobs: this.jobs.slice(0, 200) })
    this.notify()
  }
  private notify(): void { this.deps.changed(this.state()) }

  state(): MontageState {
    const root = this.ensureRoot()
    return structuredClone({
      rushes: this.store.rushes.map((r) => ({ ...r, mediaPath: join(root, 'media', `${r.id}.${r.ext}`),
        thumbnailPath: r.summary?.thumbnail ? join(root, 'thumbs', r.id, r.summary.thumbnail) : null })),
      jobs: this.jobs, importing: this.importing,
      analyzing: Object.fromEntries([...this.analyzing].map(([id, a]) => [id, { phase: a.phase, percent: a.percent }])),
      templates: this.templates(), libraryDir: this.deps.libraryDir()
    })
  }
  /** Montage runs still being written, for the Library's run list. */
  liveRuns(): string[] { return this.jobs.filter((j) => j.status === 'queued' || j.status === 'running').map((j) => basename(j.runDir)) }

  start(): void {
    if (this.started) return
    this.started = true
    this.ensureRoot()
    this.pump()
  }

  // ── Import ───────────────────────────────────────────────────────────

  /** Copy videos into the rush library in the background; exact copies of an existing rush are skipped. */
  importRushes(paths: unknown): MontageState {
    this.ensureRoot()
    if (!Array.isArray(paths) || !paths.length || paths.length > 2000 || paths.some((p) => typeof p !== 'string' || !p || p.includes('\0'))) throw new Error('Choose video files to import.')
    const files = (paths as string[]).filter((p) => RUSH_EXTENSIONS.includes(extname(p).slice(1).toLowerCase() as typeof RUSH_EXTENSIONS[number]))
    if (!files.length) throw new Error(`Choose video files (${RUSH_EXTENSIONS.join(', ')}).`)
    if (this.store.rushes.length + this.importQueue.length + files.length > MAX_RUSHES) throw new Error(`The rush library holds up to ${MAX_RUSHES} videos.`)
    this.importQueue.push(...files)
    if (!this.importing) {
      this.importing = { done: 0, total: this.importQueue.length, current: '', skipped: 0 }
      void this.drainImports()
    } else this.importing.total += files.length
    this.notify()
    return this.state()
  }
  private async drainImports(): Promise<void> {
    while (this.importQueue.length) {
      const source = this.importQueue.shift()!
      this.importing!.current = basename(source)
      this.notify()
      try {
        const rush = await this.copyRush(source)
        if (rush) { this.store.rushes.unshift(rush); this.persist(); this.pump() } else this.importing!.skipped++
      } catch (error) {
        this.importing!.skipped++
        this.deps.log('montage.import.failed', { error: error instanceof Error ? error.message : 'unknown' })
      }
      this.importing!.done++
    }
    this.importing = null
    this.notify()
  }
  private async copyRush(source: string): Promise<Rush | null> {
    const stat = lstatSync(source)
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) throw new Error('Not a usable video file')
    const id = randomUUID().replaceAll('-', '')
    const ext = extname(source).slice(1).toLowerCase()
    const media = join(this.root, 'media'), temp = join(media, `.${id}.partial`)
    const hash = createHash('sha256')
    try {
      await pipeline(createReadStream(source), new Transform({ transform(chunk, _e, done) { hash.update(chunk); done(null, chunk) } }),
        createWriteStream(temp, { flags: 'wx', mode: 0o600 }))
      const sha256 = hash.digest('hex')
      if (this.store.rushes.some((r) => r.sha256 === sha256)) { unlinkSync(temp); return null }
      renameSync(temp, join(media, `${id}.${ext}`))
      return { id, name: basename(source).slice(0, 200), ext, size: stat.size, sha256, importedAt: new Date(this.deps.now()).toISOString(), status: 'queued' }
    } catch (error) {
      try { unlinkSync(temp) } catch { /* Nothing written. */ }
      throw error
    }
  }

  removeRush(id: unknown): MontageState {
    this.ensureRoot()
    const rush = this.store.rushes.find((r) => r.id === id)
    if (!rush) throw new Error('This rush is no longer in the library.')
    this.analyzing.get(rush.id)?.abort.abort()
    this.store.rushes = this.store.rushes.filter((r) => r !== rush)
    for (const file of [join(this.root, 'media', `${rush.id}.${rush.ext}`), join(this.root, 'analysis', `${rush.id}.json`), join(this.root, 'analysis', `${rush.id}.summary.json`)]) {
      try { rmSync(file, { force: true }) } catch { /* Open on Windows; removed next time. */ }
    }
    rmSync(join(this.root, 'thumbs', rush.id), { recursive: true, force: true })
    this.persist()
    return this.state()
  }
  reanalyze(id: unknown): MontageState {
    this.ensureRoot()
    const rush = this.store.rushes.find((r) => r.id === id)
    if (!rush || rush.status === 'analyzing') throw new Error('This rush can’t be analyzed again now.')
    rush.status = 'queued'; delete rush.error
    this.persist(); this.pump()
    return this.state()
  }

  // ── Montage jobs ─────────────────────────────────────────────────────

  createJob(request: unknown, music?: unknown): MontageState {
    const root = this.ensureRoot()
    const clean: MontageRequest = parseMontageRequest(request)
    const known = new Set(this.store.rushes.map((r) => r.id))
    clean.rush_ids = clean.rush_ids.filter((id) => known.has(id))
    const usable = this.store.rushes.filter((r) => r.status === 'ready' && !r.summary?.duplicate_of && (!clean.rush_ids.length || clean.rush_ids.includes(r.id)))
    if (!usable.length) throw new Error('Analyze at least one rush first (or select analyzed rushes).')
    let copied: MontageJob['music'] = null
    if (music !== undefined && music !== null) {
      if (typeof music !== 'string' || !MUSIC_EXTENSIONS.includes(extname(music).slice(1).toLowerCase() as typeof MUSIC_EXTENSIONS[number]) || !statSync(music).isFile()) {
        throw new Error('Choose an MP3, WAV, M4A, AAC, OGG or FLAC file for the music.')
      }
      const name = `${randomUUID().replaceAll('-', '')}${extname(music).toLowerCase()}`
      mkdirSync(join(root, 'music'), { recursive: true })
      writeFileSync(join(root, 'music', name), readFileSync(music), { flag: 'wx', mode: 0o600 })
      copied = { file: name, name: basename(music).slice(0, 200) }
    }
    const id = randomUUID().replaceAll('-', '')
    this.jobs.unshift({ id, createdAt: new Date(this.deps.now()).toISOString(), request: clean, music: copied, status: 'queued',
      runDir: join(this.deps.libraryDir(), randomUUID()) })
    this.persist(); this.pump()
    return this.state()
  }
  cancelJob(id: unknown): MontageState {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) throw new Error('This montage is no longer listed.')
    if (job.status === 'queued') { job.status = 'cancelled'; job.error = JOB_ERRORS.cancelled }
    else if (job.status === 'running' || job.status === 'exporting') this.running.get(job.id)?.abort()
    this.persist()
    return this.state()
  }
  retryJob(id: unknown): MontageState {
    const job = this.jobs.find((j) => j.id === id)
    if (!job || (job.status !== 'failed' && job.status !== 'cancelled')) throw new Error('Only failed or cancelled montages can be retried.')
    Object.assign(job, { status: 'queued', error: undefined, progress: undefined, summary: undefined, runDir: join(this.deps.libraryDir(), randomUUID()) })
    this.persist(); this.pump()
    return this.state()
  }
  /** A long video's description and chapter list, for the clipboard. */
  chaptersText(id: unknown, video: unknown): string {
    const found = this.jobs.find((j) => j.id === id)?.summary?.chapters?.find((v) => v.video === video)
    if (!found) throw new Error('This video has no chapters.')
    return youtubeDescription(found)
  }
  dismissJob(id: unknown): MontageState {
    const job = this.jobs.find((j) => j.id === id)
    if (!job || ['queued', 'running', 'exporting'].includes(job.status)) throw new Error('Wait for this montage to finish.')
    this.jobs = this.jobs.filter((j) => j !== job)
    if (job.music && !this.jobs.some((j) => j.music?.file === job.music!.file)) rmSync(join(this.root, 'music', job.music.file), { force: true })
    this.persist()
    return this.state()
  }
  /** Bake every clip of a finished montage now (when it was generated without automatic export). */
  async exportJob(id: unknown): Promise<MontageState> {
    const job = this.jobs.find((j) => j.id === id)
    if (!job || job.status !== 'done') throw new Error('This montage is not ready to export.')
    job.status = 'exporting'; job.progress = { phase: 'export', percent: 0 }
    this.persist()
    try { job.exported = await this.deps.exportAll(job.runDir); job.status = 'done' } catch (error) {
      job.status = 'done'; job.error = error instanceof Error ? error.message : 'Export failed.'
    }
    job.progress = undefined
    this.persist()
    return this.state()
  }

  // ── Templates ────────────────────────────────────────────────────────

  templates(): MontageTemplate[] {
    try { return (JSON.parse(readFileSync(this.deps.templatesFile, 'utf8')) as { templates: MontageTemplate[] }).templates.slice(0, 100) } catch { return [] }
  }
  saveTemplate(name: unknown, request: unknown): MontageState {
    const label = typeof name === 'string' ? [...name.trim()].filter((c) => c.charCodeAt(0) >= 32).join('').slice(0, 60) : ''
    if (!label) throw new Error('Name the template.')
    const settings: Partial<MontageRequest> = parseMontageRequest(request)
    delete settings.rush_ids
    const list = [{ id: randomUUID().replaceAll('-', ''), name: label, request: settings as MontageTemplate['request'] }, ...this.templates().filter((t) => t.name !== label)].slice(0, 100)
    mkdirSync(dirname(this.deps.templatesFile), { recursive: true })
    writeFileSync(this.deps.templatesFile, JSON.stringify({ templates: list }), { mode: 0o600 })
    this.notify()
    return this.state()
  }
  deleteTemplate(id: unknown): MontageState {
    writeFileSync(this.deps.templatesFile, JSON.stringify({ templates: this.templates().filter((t) => t.id !== id) }), { mode: 0o600 })
    this.notify()
    return this.state()
  }

  // ── Workers ──────────────────────────────────────────────────────────

  private pump(): void {
    const root = this.ensureRoot()
    while (this.analyzing.size < (this.deps.analysisSlots ?? 2)) {
      const rush = [...this.store.rushes].reverse().find((r) => r.status === 'queued')
      if (!rush) break
      void this.analyze(root, rush)
    }
    while (this.running.size < (this.deps.jobSlots ?? 2)) {
      const job = [...this.jobs].reverse().find((j) => j.status === 'queued')
      if (!job) break
      void this.run(root, job)
    }
  }

  private async analyze(root: string, rush: Rush): Promise<void> {
    const abort = new AbortController()
    this.analyzing.set(rush.id, { phase: 'probe', percent: 0, abort })
    rush.status = 'analyzing'
    this.persist()
    try {
      const summary = await this.deps.runWorker({ action: 'analyze', root, library: this.deps.libraryDir(), rush_id: rush.id, name: rush.name },
        (p) => { const a = this.analyzing.get(rush.id); if (a) { a.phase = p.phase; a.percent = p.percent; this.notify() } }, abort.signal) as RushSummary
      if (this.store.rushes.includes(rush)) { rush.summary = summary; rush.status = 'ready'; delete rush.error }
    } catch (error) {
      if (this.quitting) rush.status = 'queued'
      else if (this.store.rushes.includes(rush)) { rush.status = 'failed'; rush.error = ANALYSIS_ERRORS[(error as Error).message] ?? 'Analysis failed. Details are in Help → Show Logs.' }
    } finally {
      this.analyzing.delete(rush.id)
      if (this.root === root) { this.persist(); if (!this.quitting) this.pump() }
    }
  }

  private async run(root: string, job: MontageJob): Promise<void> {
    const abort = new AbortController()
    this.running.set(job.id, abort)
    const library = this.deps.libraryDir(), runId = basename(job.runDir)
    job.status = 'running'; job.progress = { phase: 'plan', percent: 0 }; job.error = undefined
    this.persist()
    try {
      if (!existsSync(join(job.runDir, 'run-history.json'))) this.deps.createRunRecord(library, runId, 'Auto montage')
      const summary = await this.deps.runWorker({ action: 'generate', root, library, run: job.runDir, request: job.request,
        music: job.music ? join(root, 'music', job.music.file) : null },
        (p) => { job.progress = p; this.notify() }, abort.signal) as MontageJob['summary']
      job.summary = summary
      this.deps.finishRunRecord(library, runId, 'completed')
      if (job.request.auto_export) {
        job.status = 'exporting'; job.progress = { phase: 'export', percent: 0 }
        this.persist()
        try { job.exported = await this.deps.exportAll(job.runDir) } catch (error) {
          job.error = `Assembled, but exporting stopped: ${error instanceof Error ? error.message : 'unknown error'}`
        }
      }
      job.status = 'done'
    } catch (error) {
      if (this.quitting) { job.status = 'queued'; return }
      const code = (error as Error).message
      job.status = abort.signal.aborted || code === 'cancelled' ? 'cancelled' : 'failed'
      job.error = JOB_ERRORS[code] ?? 'The montage failed. Details are in Help → Show Logs.'
      this.deps.finishRunRecord(library, runId, job.status === 'cancelled' ? 'cancelled' : 'failed', job.error)
      // Nothing usable was made: remove the unfinished run so the Library stays clean.
      if (!existsSync(join(job.runDir, 'editor-project.json'))) rmSync(job.runDir, { recursive: true, force: true })
    } finally {
      job.progress = undefined
      job.finishedAt = new Date(this.deps.now()).toISOString()
      this.running.delete(job.id)
      if (this.root === root && !this.quitting) { this.persist(); this.pump() } else if (this.quitting) this.writeJson('jobs.json', { jobs: this.jobs.slice(0, 200) })
    }
  }

  stopAll(): void {
    this.quitting = true
    for (const a of this.analyzing.values()) a.abort.abort()
    for (const a of this.running.values()) a.abort()
  }
}
