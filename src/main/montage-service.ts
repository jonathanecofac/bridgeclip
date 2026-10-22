import { spawn } from 'child_process'
import { dirname, join } from 'path'
import { app, clipboard, dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { MontageService } from './montage'
import { getBridgeRunnerPath } from './pipeline-runner'
import { loadSettings } from './settings-store'
import { openEditor, runEditor, saveEditor, stopWorker, workerSetup } from './clip-editor'
import { candidateEdit } from '../shared/clip-editor'
import { createRunRecord, finishRunRecord } from './run-history'
import { registerLiveRuns } from './job-manager'
import { logger } from './logger'
import { MUSIC_EXTENSIONS, RUSH_EXTENSIONS } from '../shared/montage'

const MAX_LINE = 256 * 1024

/** Run bridge/montage_runner.py: JSON-lines progress, then one {ok, result | error} line. */
function runWorker(config: Record<string, unknown>, onProgress: (p: { phase: string; percent: number }) => void, signal: AbortSignal): Promise<unknown> {
  const settings = loadSettings()
  const { env, python } = workerSetup(settings)
  return new Promise((resolve, reject) => {
    const child = spawn(python, [join(dirname(getBridgeRunnerPath()), 'montage_runner.py')],
      { cwd: env.PYTHONPATH, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
    let stdout = '', stderr = '', result: { ok: boolean; result?: unknown; error?: unknown } | undefined, broken = false
    const limit = setTimeout(() => stopWorker(child, true), (config.action === 'generate' ? 6 : 2) * 3600_000)
    const abort = (): void => { stopWorker(child); setTimeout(() => stopWorker(child, true), 3000).unref() }
    signal.addEventListener('abort', abort, { once: true })
    const consume = (line: string): void => {
      if (!line.trim()) return
      try {
        const value = JSON.parse(line)
        if (value?.type === 'progress' && typeof value.phase === 'string' && typeof value.percent === 'number' && Number.isFinite(value.percent)) {
          onProgress({ phase: value.phase.slice(0, 32), percent: Math.max(0, Math.min(100, Math.round(value.percent))) })
        } else if (typeof value?.ok === 'boolean' && !result) result = value
        else broken = true
      } catch { broken = true }
    }
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      let end: number
      while ((end = stdout.indexOf('\n')) >= 0) { consume(stdout.slice(0, end)); stdout = stdout.slice(end + 1) }
      if (stdout.length > MAX_LINE) { broken = true; stdout = ''; stopWorker(child) }
    })
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4096) })
    child.on('error', () => { clearTimeout(limit); reject(new Error('engine_unavailable')) })
    child.on('close', (code) => {
      clearTimeout(limit)
      signal.removeEventListener('abort', abort)
      consume(stdout)
      if (code === 0 && !broken && result?.ok) return resolve(result.result)
      const reason = signal.aborted ? 'cancelled' : typeof result?.error === 'string' ? result.error : 'unknown'
      logger.warn('montage.worker.failed', { action: String(config.action), code: reason, exitCode: code, broken, tail: stderr.slice(-300).replace(/(?:[A-Za-z]:)?[\\/][^\s'"]*/g, '[path]') })
      reject(new Error(reason))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(config))
  })
}

/** Bake every ready clip of a montage run with the editor's own export. */
async function exportAll(runDir: string): Promise<number> {
  let session = await openEditor(runDir)
  // Clips still being refined are marked ready first: "Export all" means every clip that isn't discarded or already baked.
  if (session.project.candidates.some((c) => c.status === 'refining')) {
    session = await saveEditor(runDir, session.project.revision, session.project.candidates.map((c) => ({ ...candidateEdit(c), status: c.status === 'refining' ? 'ready' : c.status })))
  }
  if (!session.project.candidates.some((c) => c.status === 'ready')) return 0
  const after = await runEditor(runDir, session.project.revision, session.project.candidates[0].id, 'export-all')
  return after.project.candidates.filter((c) => c.status === 'baked').length
}

let service: MontageService | null = null
export function montageService(): MontageService | null { return service }

export function initMontage(getWindow: () => BrowserWindow | null, handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void): void {
  const s = service = new MontageService({
    libraryDir: () => loadSettings().outputDirectory,
    templatesFile: join(app.getPath('userData'), 'montage-templates.json'),
    runWorker, exportAll,
    createRunRecord: (library, runId, label) => createRunRecord(library, runId, label),
    finishRunRecord: (library, runId, status, error) => { try { finishRunRecord(library, runId, status, error ?? null) } catch { /* The run folder may be gone. */ } },
    changed: (state) => {
      const window = getWindow()
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('montage:update', state)
    },
    log: (event, data) => logger.info(event, data),
    now: () => Date.now()
  })
  registerLiveRuns(() => s.liveRuns())
  const choose = async (title: string, name: string, extensions: readonly string[], multi: boolean): Promise<string[]> => {
    const window = getWindow()
    if (!window) return []
    const result = await dialog.showOpenDialog(window, { title, properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], filters: [{ name, extensions: [...extensions] }] })
    return result.canceled ? [] : result.filePaths
  }
  handle('montage:state', () => s.state())
  handle('montage:import', (_e, paths) => s.importRushes(paths))
  handle('montage:chooseRushes', async () => {
    const paths = await choose('Import rushes', 'Videos', RUSH_EXTENSIONS, true)
    return paths.length ? s.importRushes(paths) : s.state()
  })
  handle('montage:chooseMusic', async () => (await choose('Choose music', 'Audio', MUSIC_EXTENSIONS, false))[0] ?? null)
  handle('montage:removeRush', (_e, id) => s.removeRush(id))
  handle('montage:reanalyze', (_e, id) => s.reanalyze(id))
  handle('montage:create', (_e, request, music) => s.createJob(request, music ?? undefined))
  handle('montage:cancel', (_e, id) => s.cancelJob(id))
  handle('montage:retry', (_e, id) => s.retryJob(id))
  handle('montage:dismiss', (_e, id) => s.dismissJob(id))
  handle('montage:copyChapters', (_e, id, video) => { clipboard.writeText(s.chaptersText(id, video)) })
  handle('montage:export', (_e, id) => s.exportJob(id))
  handle('montage:saveTemplate', (_e, name, request) => s.saveTemplate(name, request))
  handle('montage:deleteTemplate', (_e, id) => s.deleteTemplate(id))
  s.start()
  app.on('before-quit', () => s.stopAll())
}
