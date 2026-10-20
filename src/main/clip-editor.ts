import { execFile, spawn, type ChildProcess } from 'child_process'
import { constants, closeSync, createWriteStream, existsSync, fstatSync, linkSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, type Dirent } from 'fs'
import { open, type FileHandle } from 'fs/promises'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { delimiter, dirname, isAbsolute, join, win32 } from 'path'
import { createHash, randomUUID } from 'crypto'
import { EDITOR_REVISION_CONFLICT, EDITOR_SOURCE_UNAVAILABLE, candidateEdit, editorFailureMessage, editorProgress, isEditorErrorCode, parseCandidateEdit, parseEditorProject, renderEditKey, type CandidateEdit, type EditorBatch, type EditorErrorCode, type EditorProgressSummary, type EditorScene, type EditorProject, type EditorSession } from '../shared/clip-editor'
import { loadSettings, getSettingsForBridge } from './settings-store'
import { assertAbsolutePath, assertMediaPath, isWithinDirectory, openAuthorizedMedia } from './security'
import { getJobOutput } from './file-manager'
import { getBridgeRunnerPath, getEnginePath, resolvePythonPath, runtimeEnvironment } from './pipeline-runner'
import { resolveBinary } from './tools'
import { logger } from './logger'

type WorkerAction = 'review' | 'export' | 'export-all' | 'scan-cameras' | 'replace-source' | 'create-project' | 'preview-frame' | 'import-music' | 'reframe'
interface EditorOperation { progress?: EditorSession['progress']; action: NonNullable<EditorSession['operation']>; child?: ChildProcess; cancelled?: boolean; abort?: AbortController; batch?: EditorBatch }
const operations = new Map<string, EditorOperation>()
export function editorBusy(path: string): boolean { return operations.has(realpathSync(path)) }
function runPath(path: unknown): string {
  assertAbsolutePath(path)
  const run = realpathSync(path as string), library = realpathSync(loadSettings().outputDirectory)
  if (dirname(run) !== library || lstatSync(path as string).isSymbolicLink()) throw new Error('Editor project is outside the library')
  return run
}
function readProject(run: string): ReturnType<typeof parseEditorProject> {
  const path = join(run, 'editor-project.json')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || !isWithinDirectory(path, run)) throw new Error('Invalid editor file')
    const data = Buffer.alloc(stat.size + 1)
    let used = 0, count = 0
    do { count = readSync(fd, data, used, data.length - used, null); used += count } while (count && used < data.length)
    if (used !== stat.size) throw new Error('Editor project changed while reading')
    return parseEditorProject(JSON.parse(data.subarray(0, used).toString('utf8')))
  } finally { closeSync(fd) }
}
function writeProject(run: string, project: EditorProject): void {
  const data = JSON.stringify(project)
  if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw new Error('This editor project has too many caption edits to save')
  if (runPath(run) !== run) throw new Error('Editor folder changed')
  const temporary = join(run, `.editor-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, join(run, 'editor-project.json'))
  } finally { try { unlinkSync(temporary) } catch { /* Already committed. */ } }
}
function mediaNames(project: EditorProject): { source: string; preview: string } {
  const suffix = project.source_id ? `-${project.source_id}` : ''
  return { source: `editor-source${suffix}.mp4`, preview: `editor-preview${project.preview_id ? `-${project.preview_id}` : suffix}.mp4` }
}

const EDITOR_MEDIA = /^editor-(?:source|preview)(?:-[a-f0-9]{32})?\.mp4(?:\.partial\.mp4)?$/
/** Exact-preview stills; only the latest is shown and none are needed once the editor reloads. */
const EDITOR_FRAME = /^editor-frame-[a-f0-9]{32}\.png$/
/** Imported background music. Kept while the project is editable (unsaved edits can refer to it); removed with editor media. */
const EDITOR_MUSIC = /^editor-music-[a-f0-9]{32}\.mp4$/
/** Smart reframing results, read once by main. */
const EDITOR_REFRAME = /^editor-reframe-[a-f0-9]{32}\.json$/
/**
 * Remove leftovers of killed or cancelled operations: `.editor-*` temp files and
 * folders, and editor media the project does not reference. Runs only while no
 * editor operation owns the run, so nothing here can be in use by a worker.
 */
function sweepEditorFiles(run: string, project?: EditorProject): void {
  if (operations.has(run)) return
  let keep: Set<string> | null = null, freed = false
  try {
    project ??= readProject(run)
    freed = project.media_freed === true
    keep = new Set(project.media_freed ? [] : Object.values(mediaNames(project)))
  } catch { /* Unreadable state: keep all media, still remove temporary entries. */ }
  let entries: Dirent[]
  try { entries = readdirSync(run, { withFileTypes: true }) } catch { return }
  let removed = 0
  for (const entry of entries) {
    const temporary = entry.name.startsWith('.editor-')
    const frame = (EDITOR_FRAME.test(entry.name) || EDITOR_REFRAME.test(entry.name) || (freed && EDITOR_MUSIC.test(entry.name))) && (entry.isFile() || entry.isSymbolicLink())
    if (!temporary && !frame && !(keep && EDITOR_MEDIA.test(entry.name) && !keep.has(entry.name) && (entry.isFile() || entry.isSymbolicLink()))) continue
    try { rmSync(join(run, entry.name), { recursive: temporary && entry.isDirectory(), force: true }); removed++ } catch { /* A playing preview can stay open on Windows; retry next time. */ }
  }
  if (removed) logger.info('editor.sweep', { removed })
}

function mediaSize(paths: string[]): number {
  return paths.reduce((total, file) => { try { return total + statSync(file).size } catch { return total } }, 0)
}
export async function openEditor(path: unknown): Promise<EditorSession> {
  const run = runPath(path)
  if (!(await getJobOutput(run, loadSettings().outputDirectory))?.editor_project) throw new Error('This run has no editor project')
  const project = readProject(run), names = mediaNames(project)
  sweepEditorFiles(run, project)
  const operation = operations.get(run)
  const state = { progress: operation?.progress ? { ...operation.progress } : undefined, operation: operation?.action ?? null, batch: operation?.batch ? { ...operation.batch } : undefined }
  if (project.media_freed) return { project, sourcePath: '', previewPath: '', mediaBytes: 0, ...state }
  const sourcePath = join(run, names.source), previewPath = join(run, names.preview)
  for (const file of [sourcePath, previewPath]) {
    if (lstatSync(file).isSymbolicLink() || !isWithinDirectory(file, run)) throw new Error('Editor source is missing')
    assertMediaPath(file, loadSettings().outputDirectory)
  }
  return { project, sourcePath, previewPath, mediaBytes: mediaSize([sourcePath, previewPath]), ...state }
}

type ProgressCounts = Omit<EditorProgressSummary, 'operation' | 'batch' | 'progress'>
const progressCache = new Map<string, { mtimeMs: number; size: number; ino: number; summary: ProgressCounts }>()
/**
 * Status counts for Library cards, Jobs rows and editor polling. Unlike
 * openEditor, it sends no project to the renderer and re-reads the project
 * only when its file changes.
 */
export async function readEditorProgress(path: unknown): Promise<EditorProgressSummary> {
  const run = runPath(path)
  const stat = lstatSync(join(run, 'editor-project.json'))
  if (!stat.isFile()) throw new Error('This run has no editor project')
  let summary = progressCache.get(run)
  if (!summary || summary.mtimeMs !== stat.mtimeMs || summary.size !== stat.size || summary.ino !== stat.ino) {
    const project = readProject(run)
    const { remaining, initialCandidate } = editorProgress(project.candidates)
    const counts = { refining: 0, ready: 0, baked: 0, discarded: 0 }
    for (const c of project.candidates) counts[c.status]++
    let previewPath: string | null = project.media_freed ? null : join(run, mediaNames(project).preview)
    try { if (previewPath && (lstatSync(previewPath).isSymbolicLink() || !isWithinDirectory(previewPath, run))) previewPath = null } catch { previewPath = null }
    summary = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, summary: {
      total: project.candidates.length, remaining, initialCandidate, counts, previewPath,
      thumbnailMs: project.candidates[initialCandidate].ranges[0][0], mediaFreed: project.media_freed === true } }
    progressCache.delete(run)
    progressCache.set(run, summary)
    if (progressCache.size > 1000) progressCache.delete(progressCache.keys().next().value!)
  }
  const operation = operations.get(run)
  return { ...summary.summary, counts: { ...summary.summary.counts }, operation: operation?.action ?? null,
    ...(operation?.batch ? { batch: { ...operation.batch } } : {}), ...(operation?.progress ? { progress: { ...operation.progress } } : {}) }
}

const bakedHash = (c: CandidateEdit): string => createHash('sha256').update(renderEditKey(c)).digest('hex')
export async function saveEditor(path: unknown, revision: unknown, edits: unknown): Promise<EditorSession> {
  const run = runPath(path)
  if (operations.has(run)) throw new Error('Wait for the current editor operation to finish')
  operations.set(run, { action: 'save' })
  try {
    const { project } = await openEditor(run)
    if (!Number.isSafeInteger(revision) || project.revision !== revision) throw new Error(EDITOR_REVISION_CONFLICT)
    if (project.media_freed) throw new Error('Editor media was freed. This project is read-only.')
    if (!Array.isArray(edits) || edits.length !== project.candidates.length) throw new Error('Invalid candidate edits')
    const clean = edits.map((c) => parseCandidateEdit(c, project.duration_ms, project.transcript.length))
    if (new Set(clean.map((c) => c.id)).size !== clean.length) throw new Error('Duplicate candidates')
    project.candidates = project.candidates.map((c) => {
      const edit = clean.find((e) => e.id === c.id)
      if (!edit) throw new Error('Candidate is missing')
      const next = { ...c, ...edit }
      // Optional edit fields that were cleared (no overrides, no added captions, title card off).
      for (const key of ['caption_style', 'caption_inserts', 'title_card', 'text_overlays', 'effects', 'audio', 'reframe'] as const) if (!(key in edit)) delete next[key]
      if (edit.status === 'baked') {
        // Unchanged since its render, or restored to the exact render "Refine again" left.
        const unchanged = c.status === 'baked' ? renderEditKey(edit) === renderEditKey(c) : !!c.baked_hash && c.exports.length > 0 && bakedHash(edit) === c.baked_hash
        if (!unchanged) throw new Error('Only a completed render can mark a clip as baked')
        delete next.baked_hash
      } else if (c.status === 'baked') next.baked_hash = bakedHash(c)
      return next
    })
    project.revision++
    writeProject(run, project)
  } finally { operations.delete(run) }
  return openEditor(run)
}
/** Delete the source and preview once every clip is baked or discarded. The project becomes read-only. */
export async function freeEditorMedia(path: unknown, revision: unknown): Promise<EditorSession> {
  const run = runPath(path)
  if (operations.has(run)) throw new Error('Wait for the current editor operation to finish')
  operations.set(run, { action: 'save' })
  try {
    const { project } = await openEditor(run)
    if (!Number.isSafeInteger(revision) || project.revision !== revision) throw new Error(EDITOR_REVISION_CONFLICT)
    if (editorProgress(project.candidates).remaining) throw new Error('Bake or discard every clip before freeing editor media.')
    if (!project.media_freed) {
      project.media_freed = true
      project.revision++
      writeProject(run, project)
    }
  } finally { operations.delete(run) }
  sweepEditorFiles(run)
  logger.info('editor.mediaFreed')
  return openEditor(run)
}
function stop(child?: ChildProcess, force = false): void {
  if (!child?.pid) return
  try { if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true }, () => {}); else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM') } catch { /* Already exited. */ }
}
export function stopEditorsForQuit(): void { for (const op of operations.values()) { op.abort?.abort(); stop(op.child, true) } }
export function cancelEditor(path: unknown): void {
  const operation = operations.get(runPath(path))
  if (operation) operation.cancelled = true
  operation?.abort?.abort()
  const child = operation?.child
  stop(child)
  if (child) { const timer = setTimeout(() => stop(child, true), 3000); timer.unref(); child.once('close', () => clearTimeout(timer)) }
}
export async function replaceEditorSource(path: unknown, revision: unknown, replacement: unknown): Promise<EditorSession> {
  assertAbsolutePath(replacement)
  return executeEditor(path, revision, undefined, 'replace-source', replacement)
}
export async function runEditor(path: unknown, revision: unknown, candidateId: unknown, action: unknown): Promise<EditorSession> {
  if (action !== 'review' && action !== 'export' && action !== 'export-all' && action !== 'scan-cameras') throw new Error('Invalid editor operation')
  return executeEditor(path, revision, candidateId, action)
}

/** Worker output can contain private paths and keys: log only a short, redacted tail. */
function safeTail(stderr: string): Record<string, string> {
  const lines = stderr.split(/\r?\n/).map((line) => line
    .replace(/^\d{4}-\d{2}-\d{2} [\d:,.]+ - [\w.]+ - [A-Z]+ - /, '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .replace(/\b(?:sk|pk|rk)-[\w-]{8,}/g, '[key]')
    .replace(/\b(?:authorization|api[_ -]?key|token|password|secret|bearer)\b\S*\s*[:=]?\s*\S+/gi, '[redacted]')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"]*/g, '[path]')
    .replace(/[^\x20-\x7e]/g, '?').replace(/\s+/g, ' ').trim().slice(0, 160))
    .filter(Boolean).slice(-8)
  return Object.fromEntries(lines.map((line, i) => [`line${i + 1}`, line]))
}
/** Generous for long sources on CPU encoders, yet bounded if a worker hangs. */
const workerLimitMs = (durationMs: number): number => 30 * 60 * 1000 + 3 * durationMs

function runWorker(run: string, operation: EditorOperation, action: WorkerAction, env: Record<string, string | undefined>, python: string, limitMs: number, request: Record<string, unknown>): Promise<void> {
  const engine = env.PYTHONPATH!
  return new Promise<void>((resolve, reject) => {
    const child = spawn(python, [join(dirname(getBridgeRunnerPath()), 'editor_runner.py')],
      { cwd: engine, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
    operation.child = child
    let stdout = '', stderr = '', settled = false, protocolFailed = false, timedOut = false
    let result: { ok: boolean; error?: unknown } | undefined
    const consume = (line: string): void => {
      if (!line.trim()) return
      if (line.length > 16384) { protocolFailed = true; stop(child); return }
      try {
        const value = JSON.parse(line)
        if (value?.type === 'progress') {
          if ((action === 'scan-cameras' || action === 'reframe' || (action === 'create-project' && value.phase === 'preview')) && (value.phase === 'scan' || value.phase === 'preview') &&
              typeof value.percent === 'number' && Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100) {
            const previous = operation.progress
            if (!previous || (previous.phase !== 'preview' && value.phase === 'preview') ||
                (previous.phase === value.phase && value.percent >= previous.percent)) {
              operation.progress = { phase: value.phase, percent: Math.floor(value.percent) }
            }
          }
        } else if (typeof value?.ok === 'boolean' && !result) result = value
        else protocolFailed = true
      } catch { protocolFailed = true }
    }
    const timer = setTimeout(() => { timedOut = true; stop(child, true) }, limitMs)
    const finish = (error?: Error): void => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve() }
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      let end: number
      while ((end = stdout.indexOf('\n')) >= 0) { consume(stdout.slice(0, end)); stdout = stdout.slice(end + 1) }
      if (stdout.length > 16384) { protocolFailed = true; stdout = ''; stop(child) }
    })
    // Keep a bounded tail for the log; it is redacted before it is written.
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8192) })
    child.on('error', (error) => {
      logger.error('editor.worker.spawnFailed', { action, errno: (error as NodeJS.ErrnoException).code ?? 'unknown' })
      finish(new Error('Could not start the editor engine. Open Settings and run System check.'))
    })
    child.on('close', (exitCode, signal) => {
      consume(stdout)
      if (exitCode === 0 && !protocolFailed && result?.ok === true) return finish()
      const code: EditorErrorCode | undefined = timedOut ? 'timeout' : operation.cancelled ? 'cancelled' : isEditorErrorCode(result?.error) ? result.error : undefined
      logger.warn('editor.worker.failed', { action, code: code ?? 'unknown', exitCode, signal, protocolFailed, ...safeTail(stderr) })
      finish(new Error(editorFailureMessage(action === 'export-all' ? 'export' : action, code)))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request))
  })
}

function workerSetup(settings: ReturnType<typeof loadSettings>): { env: Record<string, string | undefined>; python: string } {
  const engine = getEnginePath()
  const env: Record<string, string | undefined> = { ...runtimeEnvironment(), ...getSettingsForBridge({ ...settings, jevEnabled: 'on' }), PYTHONPATH: engine, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' }
  const ffmpeg = resolveBinary('ffmpeg')
  if (ffmpeg !== 'ffmpeg') env.PATH = `${dirname(ffmpeg)}${delimiter}${env.PATH ?? ''}`
  return { env, python: resolvePythonPath(engine, settings.pythonPath) }
}

const quote = (title: string): string => `“${title.length > 60 ? `${title.slice(0, 59)}…` : title}”`
class BatchError extends Error {}
/** Report a partial "Bake all": what finished, which clips failed and why, and what is still ready. */
function batchFailure(batch: EditorBatch, failed: { title: string; error: Error }[], cancelled: boolean, stoppedBy?: unknown): Error {
  const parts = [`Baked ${batch.completed} of ${batch.total} ready clips.`]
  if (failed.length) {
    const reasons = [...new Set(failed.map((f) => f.error.message))]
    parts.push(`Could not bake ${failed.slice(0, 3).map((f) => quote(f.title)).join(', ')}${failed.length > 3 ? ` and ${failed.length - 3} more` : ''}:`,
      reasons.length === 1 ? reasons[0] : `${reasons[0]} (and other errors)`)
  }
  if (cancelled) parts.push('Batch cancelled.')
  else if (stoppedBy !== undefined) parts.push(`Batch stopped: ${stoppedBy instanceof Error ? stoppedBy.message : 'Export failed.'}`)
  if (batch.completed < batch.total) parts.push('Clips that were not baked are still ready.')
  return new BatchError(parts.join(' '))
}
async function executeEditor(path: unknown, revision: unknown, candidateId: unknown, action: WorkerAction, replacement?: string): Promise<EditorSession> {
  const run = runPath(path)
  if (operations.has(run) || operations.size >= 2) throw new Error('An editor operation is already running. Try again when it finishes.')
  const operation: EditorOperation = { action, ...(action === 'scan-cameras' ? { progress: { phase: 'scan', percent: 0 } as const } : {}) }
  operations.set(run, operation)
  const sourceId = action === 'replace-source' ? randomUUID().replaceAll('-', '') : undefined
  const previewId = action === 'scan-cameras' ? randomUUID().replaceAll('-', '') : undefined
  let previousPreview: string | undefined
  let previousMedia: string[] = []
  const failed: { title: string; error: Error }[] = []
  try {
    const session = await openEditor(run)
    if (session.project.media_freed) throw new Error('Editor media was freed. This project is read-only.')
    previousPreview = session.previewPath
    if (revision !== session.project.revision || (action !== 'export-all' && action !== 'replace-source' && !session.project.candidates.some((c) => c.id === candidateId))) throw new Error('Project changed. Reopen it and retry.')
    if (sourceId) {
      const media = await openAuthorizedMedia(replacement!, loadSettings().outputDirectory)
      operation.abort = new AbortController()
      try {
        if (operation.cancelled) throw new Error('Source replacement cancelled.')
        await pipeline(media.handle.createReadStream({ autoClose: false }), createWriteStream(join(run, `editor-source-${sourceId}.mp4`), { flags: 'wx', mode: 0o600 }), { signal: operation.abort.signal })
      } finally { await media.handle.close() }
      previousMedia = [session.sourcePath, session.previewPath]
    }
    if (action === 'export' && session.project.candidates.find((c) => c.id === candidateId)!.status !== 'ready') throw new Error('Mark this clip ready before baking it')
    const candidates = action === 'replace-source' ? session.project.candidates.slice(0, 1) : action === 'export-all' ? session.project.candidates.filter((c) => c.status === 'ready') : session.project.candidates.filter((c) => c.id === candidateId)
    if (!candidates.length) throw new Error('Mark at least one clip ready before baking.')
    if (action === 'export-all') operation.batch = { completed: 0, total: candidates.length }
    const settings = loadSettings()
    if (action === 'review' && !settings.openrouterApiKey) throw new Error('Add your OpenRouter key in Settings to run this review.')
    const { env, python } = workerSetup(settings), limitMs = workerLimitMs(session.project.duration_ms)
    for (const candidate of candidates) {
      if (operation.cancelled) break
      try {
        await runWorker(run, operation, action, env, python, limitMs, { run, library: realpathSync(settings.outputDirectory), revision, candidate_id: candidate.id, action: action === 'export-all' ? 'export' : action, source_id: sourceId, preview_id: previewId })
        if (operation.batch) operation.batch.completed++
      } catch (error) {
        // One failed clip must not strand the rest of "Bake all".
        if (action !== 'export-all' || operation.cancelled) throw error
        failed.push({ title: candidate.title, error: error as Error })
        operation.batch!.failed = failed.length
      } finally { operation.child = undefined }
      revision = readProject(run).revision
    }
    if (operation.batch && (operation.cancelled || failed.length)) throw batchFailure(operation.batch, failed, !!operation.cancelled)
    if (operation.cancelled) throw new Error(editorFailureMessage(action, 'cancelled'))
  } catch (error) {
    if (operation.batch && !(error instanceof BatchError)) throw batchFailure(operation.batch, failed, !!operation.cancelled, error)
    throw error
  } finally {
    if (previewId) {
      let active: string | undefined, readable = false
      try { active = readProject(run).preview_id; readable = true } catch { /* Preserve media if state is unreadable. */ }
      const stale = !readable ? [] : active === previewId ? (previousPreview ? [previousPreview] : [])
        : [join(run, `editor-preview-${previewId}.mp4`), join(run, `editor-preview-${previewId}.mp4.partial.mp4`)]
      for (const file of stale) { try { unlinkSync(file) } catch { /* A playing preview can remain open on Windows. */ } }
    }
    if (sourceId) {
      // The JSON pointer switches both media files together. Never delete the active pair,
      // including when cancellation/worker exit races with the commit.
      let active: string | undefined, readable = false
      try { active = readProject(run).source_id; readable = true } catch { /* Preserve files if the project cannot be read. */ }
      const stale = !readable ? [] : active === sourceId ? previousMedia : [join(run, `editor-source-${sourceId}.mp4`), join(run, `editor-preview-${sourceId}.mp4`), join(run, `editor-preview-${sourceId}.mp4.partial.mp4`)]
      for (const file of stale) { try { unlinkSync(file) } catch { /* Open previews may remain until a later cleanup on Windows. */ } }
    }
    operations.delete(run)
    try { sweepEditorFiles(run) } catch { /* Cleanup is best effort. */ }
  }
  return openEditor(run)
}
// Keep IPC's editable surface narrow; no media paths, reviews or export records come from React.
export type { CandidateEdit }

let resumeAfterSave: (() => void) | null = null
/** Closing with unsaved edits: main asked the renderer to save, and resumes the close only after it succeeds. */
export function awaitEditorSaveBeforeClose(resume: () => void): void { resumeAfterSave = resume }
export function editorCloseReady(saved: unknown): void {
  const resume = resumeAfterSave
  resumeAfterSave = null
  if (saved === true && resume) setImmediate(resume)
}

// ---------------------------------------------------------------------------
// "Edit clip" on Automatic runs
// ---------------------------------------------------------------------------

const SOURCE_VIDEO = /\.(?:mp4|m4v|mkv|webm|avi|mov|flv)$/i
/** The local video an Automatic run recorded, while it is still a regular file there. Web sources return null. */
export function recordedSourcePath(url: string): string | null {
  const path = url.replace(/^file:\/\//i, '')
  if (!path || path !== path.trim() || path.includes('\0') || /^[a-z][a-z0-9+.-]*:\/\//i.test(path) || !isAbsolute(path) || !SOURCE_VIDEO.test(path)) return null
  try { return lstatSync(path).isFile() ? path : null } catch { return null }
}
function missingSourceMessage(url: string): string {
  if (/^https?:\/\//i.test(url)) return `${EDITOR_SOURCE_UNAVAILABLE} These clips came from a web video that BridgeClip did not keep. Choose the same video saved on this computer.`
  const name = url ? win32.basename(url.replace(/^file:\/\//i, '')) : ''
  return `${EDITOR_SOURCE_UNAVAILABLE}${name ? ` “${name.slice(0, 120)}” was moved, renamed or deleted.` : ''} Choose the video these clips came from.`
}

/**
 * Bring the original video into the run without duplicating it when possible:
 * a hard link on the same drive (instant, no extra space, survives the
 * original being moved or deleted), otherwise a full copy of the opened file.
 */
async function linkOrCopy(media: { handle: FileHandle; size: number; canonical: string }, destination: string, operation: EditorOperation): Promise<'link' | 'copy'> {
  const opened = await media.handle.stat()
  try {
    linkSync(media.canonical, destination)
    const linked = statSync(destination)
    if (linked.ino === opened.ino && linked.dev === opened.dev) { operation.progress = { phase: 'source', percent: 100 }; return 'link' }
    unlinkSync(destination)
  } catch { try { unlinkSync(destination) } catch { /* Nothing was linked. */ } }
  operation.abort = new AbortController()
  let copied = 0
  const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
    copied += chunk.length
    operation.progress = { phase: 'source', percent: Math.min(99, Math.floor(100 * copied / Math.max(1, media.size))) }
    done(null, chunk)
  } })
  await pipeline(media.handle.createReadStream({ autoClose: false, start: 0 }), meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal: operation.abort.signal })
  operation.progress = { phase: 'source', percent: 100 }
  return 'copy'
}

/**
 * Make an Automatic run editable: every clip becomes an editor candidate that
 * starts Baked (its existing file is the first export). `chosen` is a video
 * the user picked with the file dialog when the recorded original is missing.
 * Exports from the editor are new clips; the originals are never overwritten.
 */
export async function createEditorProject(path: unknown, chosen?: unknown): Promise<EditorSession> {
  const run = runPath(path)
  const settings = loadSettings()
  const output = await getJobOutput(run, settings.outputDirectory)
  if (!output) throw new Error('Could not read this run. Reopen it from the Library and try again.')
  const projectFile = join(run, 'editor-project.json')
  if (output.editor_project && existsSync(projectFile)) return openEditor(run)
  if (operations.has(run) || operations.size >= 2) throw new Error('An editor operation is already running. Try again when it finishes.')
  const operation: EditorOperation = { action: 'create-project', progress: { phase: 'source', percent: 0 } }
  operations.set(run, operation)
  const source = join(run, 'editor-source.mp4'), preview = join(run, 'editor-preview.mp4')
  const clean = (): void => { for (const file of [source, preview, `${preview}.partial.mp4`]) { try { rmSync(file, { force: true }) } catch { /* Retried by the next attempt. */ } } }
  let created = false
  try {
    if (!existsSync(projectFile)) {
      clean()
      let media: { handle: FileHandle; size: number; canonical: string }
      if (chosen !== undefined && chosen !== null) {
        assertAbsolutePath(chosen)
        media = await openAuthorizedMedia(chosen, settings.outputDirectory)
      } else {
        const recorded = recordedSourcePath(output.source_video_url)
        if (!recorded) throw new Error(missingSourceMessage(output.source_video_url))
        const handle = await open(recorded, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try {
          const stat = await handle.stat()
          if (!stat.isFile()) throw new Error(missingSourceMessage(output.source_video_url))
          media = { handle, size: stat.size, canonical: realpathSync(recorded) }
        } catch (error) { await handle.close(); throw error }
      }
      try {
        const mode = await linkOrCopy(media, source, operation)
        logger.info('editor.create.source', { mode, bytes: media.size })
      } finally { await media.handle.close() }
    }
    if (operation.cancelled) throw new Error(editorFailureMessage('create-project', 'cancelled'))
    operation.progress = { phase: 'preview', percent: 0 }
    const { env, python } = workerSetup(settings)
    const durationMs = Math.max(1000, output.source_video_duration_seconds * 1000)
    await runWorker(run, operation, 'create-project', env, python, workerLimitMs(durationMs),
      { run, library: realpathSync(settings.outputDirectory), action: 'create-project', revision: 0 })
    created = true
  } catch (error) {
    if (operation.cancelled && !(error instanceof Error && error.message.startsWith(EDITOR_SOURCE_UNAVAILABLE))) throw new Error(editorFailureMessage('create-project', 'cancelled'))
    throw error
  } finally {
    if (!created && !existsSync(projectFile)) clean()
    operation.child = undefined
    operations.delete(run)
  }
  logger.info('editor.create.done')
  return openEditor(run)
}

/** The running operation without reading the project: polled while "Edit clip" prepares a run. */
export function readEditorOperation(path: unknown): { operation: EditorOperation['action'] | null; progress?: EditorSession['progress'] } {
  const operation = operations.get(runPath(path))
  return { operation: operation?.action ?? null, ...(operation?.progress ? { progress: { ...operation.progress } } : {}) }
}

/**
 * Render the exported picture at source time `atMs` for one candidate (the
 * editor's "Exact preview"). It uses the saved project, through the same
 * render path as export, and changes nothing in the project or library.
 */
export async function previewEditorFrame(path: unknown, revision: unknown, candidateId: unknown, atMs: unknown): Promise<{ path: string }> {
  const run = runPath(path)
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) throw new Error('Invalid preview time')
  if (operations.has(run) || operations.size >= 2) throw new Error('An editor operation is already running. Try again when it finishes.')
  const operation: EditorOperation = { action: 'preview-frame' }
  operations.set(run, operation)
  const frameId = randomUUID().replaceAll('-', '')
  try {
    const session = await openEditor(run)
    if (session.project.media_freed) throw new Error('Editor media was freed. This project is read-only.')
    if (revision !== session.project.revision || !session.project.candidates.some((c) => c.id === candidateId)) throw new Error('Project changed. Reopen it and retry.')
    for (const entry of readdirSync(run)) if (EDITOR_FRAME.test(entry)) { try { unlinkSync(join(run, entry)) } catch { /* An open image can stay on Windows. */ } }
    const settings = loadSettings()
    const { env, python } = workerSetup(settings)
    await runWorker(run, operation, 'preview-frame', env, python, 10 * 60 * 1000,
      { run, library: realpathSync(settings.outputDirectory), revision, candidate_id: candidateId, action: 'preview-frame', at_ms: atMs, frame_id: frameId })
    const file = join(run, `editor-frame-${frameId}.png`)
    if (lstatSync(file).isSymbolicLink() || !isWithinDirectory(file, run)) throw new Error(editorFailureMessage('preview-frame'))
    return { path: file }
  } finally {
    operation.child = undefined
    operations.delete(run)
  }
}

/**
 * Import background music the user chose: the engine keeps its first audio
 * stream as AAC in the editor folder (editor-music-<id>.mp4). The project is
 * unchanged until the editor saves an edit that uses it.
 */
export async function importEditorMusic(path: unknown, chosen: unknown): Promise<{ file: string; name: string; path: string }> {
  const run = runPath(path)
  assertAbsolutePath(chosen)
  if (operations.has(run) || operations.size >= 2) throw new Error('An editor operation is already running. Try again when it finishes.')
  const operation: EditorOperation = { action: 'import-music' }
  operations.set(run, operation)
  const id = randomUUID().replaceAll('-', '')
  try {
    const session = await openEditor(run)
    if (session.project.media_freed) throw new Error('Editor media was freed. This project is read-only.')
    const settings = loadSettings()
    const { env, python } = workerSetup(settings)
    await runWorker(run, operation, 'import-music', env, python, 25 * 60 * 1000,
      { run, library: realpathSync(settings.outputDirectory), action: 'import-music', input: chosen, music_id: id })
    const file = `editor-music-${id}.mp4`, full = join(run, file)
    if (lstatSync(full).isSymbolicLink() || !isWithinDirectory(full, run)) throw new Error(editorFailureMessage('import-music'))
    const name = [...win32.basename(chosen as string)].filter((c) => c.charCodeAt(0) >= 32).join('').slice(0, 200) || 'Music'
    logger.info('editor.music.imported')
    return { file, name, path: full }
  } finally {
    operation.child = undefined
    operations.delete(run)
  }
}

/**
 * Smart reframing: analyze faces over the clip with the local detector and
 * return new layouts for the editor to apply as one undoable edit. Auto picks
 * each shot's layout; Face tracking follows the speaker full frame.
 */
export async function reframeEditor(path: unknown, revision: unknown, candidateId: unknown, mode: unknown): Promise<{ scenes: EditorScene[] }> {
  const run = runPath(path)
  if (mode !== 'auto' && mode !== 'face') throw new Error('Invalid reframing mode')
  if (operations.has(run) || operations.size >= 2) throw new Error('An editor operation is already running. Try again when it finishes.')
  const operation: EditorOperation = { action: 'reframe', progress: { phase: 'scan', percent: 0 } }
  operations.set(run, operation)
  const id = randomUUID().replaceAll('-', '')
  const file = join(run, `editor-reframe-${id}.json`)
  try {
    const session = await openEditor(run)
    if (session.project.media_freed) throw new Error('Editor media was freed. This project is read-only.')
    const candidate = session.project.candidates.find((c) => c.id === candidateId)
    if (revision !== session.project.revision || !candidate) throw new Error('Project changed. Reopen it and retry.')
    const settings = loadSettings()
    const { env, python } = workerSetup(settings)
    await runWorker(run, operation, 'reframe', env, python, workerLimitMs(candidate.ranges.at(-1)![1] - candidate.ranges[0][0]),
      { run, library: realpathSync(settings.outputDirectory), revision, candidate_id: candidate.id, action: 'reframe', mode, reframe_id: id })
    if (lstatSync(file).isSymbolicLink() || !isWithinDirectory(file, run) || statSync(file).size > 4 * 1024 * 1024) throw new Error(editorFailureMessage('reframe'))
    const result = JSON.parse(readFileSync(file, 'utf8')) as { scenes?: unknown }
    // The same validation as a save: the layouts must be a valid edit of this clip.
    const { scenes } = parseCandidateEdit({ ...candidateEdit(candidate), scenes: result.scenes }, session.project.duration_ms, session.project.transcript.length)
    logger.info('editor.reframe', { mode, scenes: scenes.length })
    return { scenes }
  } finally {
    try { unlinkSync(file) } catch { /* Not written. */ }
    operation.child = undefined
    operations.delete(run)
  }
}
