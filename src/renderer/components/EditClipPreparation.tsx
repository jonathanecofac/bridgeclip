import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { FolderSearch, Loader2, Scissors } from 'lucide-react'
import { EDITOR_SOURCE_UNAVAILABLE, type EditorSession } from '../../shared/clip-editor'
import { getApi } from '../lib/ipc'
import { errorMessage } from '../lib/utils'
import { Button } from './ui/Button'
import { Dialog, DialogFooter } from './ui/Dialog'
import { ProgressBar } from './ui/ProgressBar'

type Stage = { kind: 'working'; progress?: EditorSession['progress'] } | { kind: 'missing'; message: string } | { kind: 'failed'; message: string }

function progressLabel(progress?: EditorSession['progress']): string {
  if (!progress) return 'Opening the original video…'
  if (progress.phase === 'source') return progress.percent >= 100 ? 'Original video ready' : `Bringing the original video into this project… ${progress.percent}%`
  return `Preparing a frame-accurate preview (one-time)… ${progress.percent}%`
}

/**
 * "Edit clip" on an Automatic run: makes the run editable once, then hands
 * over to the editor. Automatic runs keep only their rendered clips, so this
 * links (or copies) the original video back in. If it was moved or deleted,
 * the user locates it; the engine checks that it is the same video.
 */
export function EditClipPreparation({ outputDir, clipTitle, onReady, onClose }: {
  outputDir: string
  clipTitle: string
  onReady: (session: EditorSession) => void
  onClose: () => void
}): React.JSX.Element {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState<Stage>({ kind: 'working' })
  const active = useRef(true)
  const running = useRef(false)

  const start = useCallback(async (source?: string): Promise<void> => {
    if (running.current) return
    running.current = true
    setStage({ kind: 'working' })
    const timer = window.setInterval(() => {
      void getApi().editor.operation(outputDir).then((state) => {
        if (active.current && state.operation === 'create-project') setStage({ kind: 'working', progress: state.progress })
      }).catch(() => {})
    }, 500)
    try {
      const session = await getApi().editor.create(outputDir, source ?? null)
      if (active.current) onReady(session)
    } catch (cause) {
      const message = errorMessage(cause, 'Could not prepare this clip for editing.')
      if (active.current) setStage(message.includes(EDITOR_SOURCE_UNAVAILABLE) ? { kind: 'missing', message } : { kind: 'failed', message })
    } finally {
      window.clearInterval(timer)
      running.current = false
    }
  }, [outputDir, onReady])

  useEffect(() => {
    active.current = true
    void start()
    return () => { active.current = false }
  }, [start])
  useEffect(() => { panel.current?.focus() }, [stage.kind])

  const locate = async (): Promise<void> => {
    try {
      const path = await getApi().dialog.selectVideo()
      if (path) await start(path)
    } catch (cause) { setStage({ kind: 'failed', message: errorMessage(cause) }) }
  }
  const close = (): void => {
    if (stage.kind === 'working') void getApi().editor.cancel(outputDir).catch(() => {})
    else onClose()
  }

  return <Dialog ref={panel} aria-labelledby={titleId} panelClassName="max-w-[460px]"
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); close() } }}>
    <div className="px-5 pb-5 pt-5">
      <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold text-ink"><Scissors className="h-4 w-4" />Edit clip</h2>
      <p className="mt-1 truncate text-sm text-ink-muted" title={clipTitle}>{clipTitle}</p>
      {stage.kind === 'working' && <div className="mt-4 space-y-2" role="status">
        <p className="flex items-center gap-2 text-sm text-ink"><Loader2 className="h-3.5 w-3.5 animate-spin" />{progressLabel(stage.progress)}</p>
        <ProgressBar value={stage.progress?.phase === 'preview' ? stage.progress.percent : stage.progress?.percent ?? 0} />
        <p className="text-2xs text-ink-subtle">Done once per run. Your current clips stay exactly as they are; edits are exported as new clips.</p>
      </div>}
      {stage.kind === 'missing' && <div className="mt-4 space-y-2">
        <p role="alert" className="text-sm text-ink" data-selectable>{stage.message}</p>
        <p className="text-2xs text-ink-subtle">BridgeClip checks that it is the same video before using it. On the same drive it is linked, not copied, so it takes no extra space.</p>
      </div>}
      {stage.kind === 'failed' && <p role="alert" className="mt-4 text-sm text-danger" data-selectable>{stage.message}</p>}
    </div>
    <DialogFooter>
      {stage.kind === 'working'
        ? <Button onClick={close}>Cancel</Button>
        : <>
          <Button onClick={onClose}>Close</Button>
          {stage.kind === 'failed' && <Button onClick={() => { void start() }}>Try again</Button>}
          <Button variant="primary" icon={<FolderSearch className="h-3.5 w-3.5" />} onClick={() => { void locate() }}>Locate original video…</Button>
        </>}
    </DialogFooter>
  </Dialog>
}
