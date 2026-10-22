import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Clapperboard, Download, Film, Music, Play, RefreshCw, RotateCcw, Save, Sparkles, Trash2, Upload, Wand2, X } from 'lucide-react'
import {
  ANALYSIS_PHASES, DEFAULT_MONTAGE_REQUEST, MONTAGE_DURATIONS, MONTAGE_PHASES, MONTAGE_STYLES, styleName,
  type MontageJob, type MontageRequest, type MontageState, type Rush
} from '../../shared/montage'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Callout } from '../components/ui/Callout'
import { ConfirmDialog, type ConfirmRequest } from '../components/ui/ConfirmDialog'
import { Field, TextArea, TextInput } from '../components/ui/Field'
import { Page } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { Panel } from '../components/ui/Panel'
import { ProgressBar } from '../components/ui/ProgressBar'
import { Segmented } from '../components/ui/Segmented'
import { Select } from '../components/ui/Select'
import { Switch } from '../components/ui/Switch'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatDuration, formatRelativeDate, localFileUrl } from '../lib/utils'
import { useSettingsStore } from '../store/use-settings-store'
import type { Page as PageName } from '../components/Sidebar'

const JOB_STATUS: Record<MontageJob['status'], { label: string; tone: 'neutral' | 'accent' | 'success' | 'danger' | 'warning' }> = {
  queued: { label: 'Queued', tone: 'neutral' }, running: { label: 'Working', tone: 'accent' }, exporting: { label: 'Exporting', tone: 'accent' },
  done: { label: 'Ready', tone: 'success' }, failed: { label: 'Failed', tone: 'danger' }, cancelled: { label: 'Cancelled', tone: 'neutral' }
}
const EXAMPLES = [
  'Generate 10 clips of 45 seconds with the best gaming moments.',
  'A 30-second compilation of the most spectacular shots.',
  'Make 5 different versions with different hooks.'
]

function rushStatus(rush: Rush, analyzing?: { phase: string; percent: number }): { label: string; tone: 'neutral' | 'accent' | 'success' | 'danger' | 'warning' } {
  if (rush.status === 'analyzing') return { label: analyzing ? `${ANALYSIS_PHASES[analyzing.phase] ?? 'Analyzing'} ${analyzing.percent}%` : 'Analyzing', tone: 'accent' }
  if (rush.status === 'queued') return { label: 'Waiting', tone: 'neutral' }
  if (rush.status === 'failed') return { label: 'Failed', tone: 'danger' }
  if (rush.summary?.duplicate_of) return { label: 'Duplicate', tone: 'warning' }
  return { label: 'Ready', tone: 'success' }
}

/**
 * AI Video Editor — Auto Montage. Rushes are imported once into a permanent
 * library and analyzed (shots, sound, dialogue, AI vision); a montage turns
 * an instruction into planned edits that FFmpeg assembles into an editor
 * project, ready to fine-tune in the editor or export straight away.
 */
export function AutoMontagePage({ onNavigate, onViewLibrary }: { onNavigate: (page: PageName) => void; onViewLibrary: (outputDir: string) => void }): React.JSX.Element {
  const [state, setState] = useState<MontageState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [request, setRequest] = useState<MontageRequest>({ ...DEFAULT_MONTAGE_REQUEST })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<string | null>(null)
  const [music, setMusic] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const openrouter = useSettingsStore((s) => s.openrouterConfigured)
  const dragDepth = useRef(0)

  useEffect(() => {
    void getApi().montage.state().then(setState).catch((e) => setError(errorMessage(e)))
    return getApi().montage.onUpdate(setState)
  }, [])
  const act = useCallback(async (key: string, action: () => Promise<MontageState>): Promise<boolean> => {
    setBusy(key); setError(null)
    try { setState(await action()); return true } catch (e) { setError(errorMessage(e)); return false } finally { setBusy(null) }
  }, [])
  const set = (patch: Partial<MontageRequest>): void => setRequest((r) => ({ ...r, ...patch }))

  const rushes = state?.rushes ?? []
  const ready = rushes.filter((r) => r.status === 'ready' && !r.summary?.duplicate_of)
  const counts = useMemo(() => ({
    ready: ready.length, working: rushes.filter((r) => r.status === 'queued' || r.status === 'analyzing').length,
    failed: rushes.filter((r) => r.status === 'failed').length, duplicates: rushes.filter((r) => r.summary?.duplicate_of).length
  }), [rushes, ready.length])
  const chosen = [...selected].filter((id) => ready.some((r) => r.id === id))
  const previewRush = rushes.find((r) => r.id === preview)

  const drop = (files: FileList): void => {
    const paths = [...files].map((f) => { try { return getApi().montage.pathForFile(f) } catch { return '' } }).filter(Boolean)
    if (paths.length) void act('import', () => getApi().montage.importPaths(paths))
  }
  const generate = (): void => { void act('generate', () => getApi().montage.create({ ...request, rush_ids: chosen }, music)) }

  if (!state) return <Page><PageHeader title="Auto Montage" />{error ? <Callout tone="danger">{error}</Callout> : <p className="mt-6 text-sm text-ink-muted">Loading…</p>}</Page>
  return <Page width="wide">
    <PageHeader title="AI Video Editor — Auto Montage"
      description="Import your rushes once. BridgeClip analyzes them (shots, sound, dialogue and AI vision), then turns an instruction into finished edits you can fine-tune in the editor or export straight away." />
    <div className="mt-4 space-y-3">
      {!openrouter && <Callout tone="warning" title="Add your OpenRouter key for AI analysis and planning"
        action={<Button size="sm" onClick={() => onNavigate('settings')}>Open Settings</Button>}>
        Without it, rushes are analyzed locally only (shots and sound, no dialogue or AI vision) and moments are chosen from those scores.</Callout>}
      {error && <Callout tone="danger" onDismiss={() => setError(null)}>{error}</Callout>}
    </div>

    <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="space-y-4">
        <Panel role="region" aria-label="Rush library"
          className={cn('relative', dragging && 'ring-2 ring-accent/60')}
          onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); dragDepth.current++; setDragging(true) } }}
          onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
          onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false) }}
          onDrop={(e) => { e.preventDefault(); dragDepth.current = 0; setDragging(false); drop(e.dataTransfer.files) }}>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-ink">Rush library</h2>
              <p className="text-2xs text-ink-subtle">{rushes.length} rush{rushes.length === 1 ? '' : 'es'} · {counts.ready} ready{counts.working ? ` · ${counts.working} analyzing` : ''}{counts.failed ? ` · ${counts.failed} failed` : ''}{counts.duplicates ? ` · ${counts.duplicates} duplicate${counts.duplicates === 1 ? '' : 's'} left out` : ''}. Copied into your Library folder, analyzed once.</p>
            </div>
            {ready.length > 0 && <Button size="sm" variant="ghost" onClick={() => setSelected(chosen.length === ready.length ? new Set() : new Set(ready.map((r) => r.id)))}>
              {chosen.length === ready.length ? 'Select none' : 'Select all'}</Button>}
            <Button size="sm" icon={<Upload size={13} />} loading={busy === 'choose'} onClick={() => { void act('choose', () => getApi().montage.chooseRushes()) }}>Import rushes…</Button>
          </div>
          {state.importing && <div className="mt-3 space-y-1" role="status"><p className="text-2xs text-ink-muted">Copying {state.importing.current} · {state.importing.done} of {state.importing.total}{state.importing.skipped ? ` · ${state.importing.skipped} already in the library` : ''}</p>
            <ProgressBar value={100 * state.importing.done / Math.max(1, state.importing.total)} /></div>}

          {previewRush && <div className="mt-3 grid gap-3 rounded-2xl border border-white/[0.06] p-3 md:grid-cols-[minmax(0,1fr)_260px]" aria-label="Rush preview">
            <video key={previewRush.id} src={localFileUrl(previewRush.mediaPath!)} controls className="max-h-[360px] w-full rounded-xl bg-black" />
            <div className="min-w-0 space-y-2 text-xs">
              <div className="flex items-start justify-between gap-2"><p className="break-all font-medium text-ink">{previewRush.name}</p><Button size="sm" variant="ghost" iconOnly icon={<X size={13} />} aria-label="Close preview" onClick={() => setPreview(null)} /></div>
              {previewRush.summary && <>
                <p className="text-ink-muted">{formatDuration(previewRush.summary.duration_ms)} · {previewRush.summary.width}×{previewRush.summary.height} · {previewRush.summary.scenes} shot{previewRush.summary.scenes === 1 ? '' : 's'}{previewRush.summary.speech ? ' · dialogue' : ''}</p>
                {previewRush.summary.description && <p className="text-ink">{previewRush.summary.description}</p>}
                {previewRush.summary.tags.length > 0 && <div className="flex flex-wrap gap-1">{previewRush.summary.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>}
                {previewRush.summary.notes.map((n) => <p key={n} className="text-2xs text-warning">{n}</p>)}
              </>}
              {previewRush.error && <p className="text-danger">{previewRush.error}</p>}
            </div>
          </div>}

          {!rushes.length ? <div className={cn('mt-3 flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/15 px-6 py-12 text-center', dragging && 'border-accent/70 bg-accent/5')}>
            <Clapperboard size={22} className="text-ink-subtle" />
            <p className="mt-2 text-sm font-medium text-ink">Drop your rushes here</p>
            <p className="mt-1 max-w-md text-xs text-ink-subtle">Dozens or hundreds of videos, any length, resolution or order (MP4, MOV, MKV, WebM, AVI). Each one is analyzed once and reused for every montage.</p>
          </div> : <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5" aria-label="Rushes">
            {rushes.map((rush) => {
              const status = rushStatus(rush, state.analyzing[rush.id])
              const usable = rush.status === 'ready' && !rush.summary?.duplicate_of
              const isSelected = selected.has(rush.id)
              return <li key={rush.id} className={cn('group relative overflow-hidden rounded-xl border bg-white/[0.02]', isSelected ? 'border-accent/70' : 'border-white/[0.06]')}>
                <button type="button" className="block w-full text-left" onClick={() => setPreview(rush.id)} aria-label={`Preview ${rush.name}`}>
                  <div className="relative aspect-video bg-black/40">
                    {rush.thumbnailPath ? <img src={localFileUrl(rush.thumbnailPath)} alt="" className="h-full w-full object-cover" loading="lazy" /> : <Film size={18} className="absolute inset-0 m-auto text-ink-subtle" />}
                    {rush.summary && <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 font-mono text-2xs text-white">{formatDuration(rush.summary.duration_ms)}</span>}
                    <Play size={18} className="absolute inset-0 m-auto text-white opacity-0 drop-shadow group-hover:opacity-90" />
                  </div>
                  <div className="space-y-1 p-2">
                    <p className="truncate text-xs text-ink" title={rush.name}>{rush.name}</p>
                    <div className="flex flex-wrap items-center gap-1"><Badge tone={status.tone}>{status.label}</Badge>{rush.summary?.category && <Badge>{rush.summary.category}</Badge>}</div>
                  </div>
                </button>
                {rush.status === 'analyzing' && state.analyzing[rush.id] && <ProgressBar value={state.analyzing[rush.id].percent} className="absolute left-0 right-0 top-0 rounded-none" />}
                <div className="absolute right-1 top-1 flex gap-1">
                  {usable && <button type="button" role="checkbox" aria-checked={isSelected} aria-label={`Use ${rush.name}`}
                    className={cn('flex h-6 w-6 items-center justify-center rounded-md border', isSelected ? 'border-accent bg-accent text-white' : 'border-white/30 bg-black/50 text-transparent group-hover:text-white/70')}
                    onClick={() => setSelected((s) => { const next = new Set(s); if (next.has(rush.id)) next.delete(rush.id); else next.add(rush.id); return next })}><Check size={13} /></button>}
                  {rush.status === 'failed' && <button type="button" aria-label={`Analyze ${rush.name} again`} className="flex h-6 w-6 items-center justify-center rounded-md bg-black/60 text-white"
                    onClick={() => { void act(`re:${rush.id}`, () => getApi().montage.reanalyze(rush.id)) }}><RefreshCw size={12} /></button>}
                  <button type="button" aria-label={`Remove ${rush.name}`} className="flex h-6 w-6 items-center justify-center rounded-md bg-black/60 text-white opacity-0 group-hover:opacity-100 focus:opacity-100"
                    onClick={() => setConfirm({ title: `Remove ${rush.name}?`, body: 'Its copy and analysis are deleted from the rush library. Montages already made are not affected.', confirmLabel: 'Remove',
                      onConfirm: () => { void act(`rm:${rush.id}`, () => getApi().montage.removeRush(rush.id)); if (preview === rush.id) setPreview(null) } })}><Trash2 size={12} /></button>
                </div>
              </li>
            })}
          </ul>}
        </Panel>

        <Panel role="region" aria-label="Montage queue">
          <h2 className="text-sm font-semibold text-ink">Montages</h2>
          {!state.jobs.length && <p className="mt-1 text-xs text-ink-subtle">Generated montages appear here. Several can run at once; unfinished ones start again when BridgeClip reopens.</p>}
          <ul className="mt-2 divide-y divide-white/[0.05]">{state.jobs.map((job) => <JobRow key={job.id} job={job} busy={busy} act={act} onViewLibrary={onViewLibrary} />)}</ul>
        </Panel>
      </div>

      <Panel role="region" aria-label="Generate a montage" className="self-start space-y-4">
        <div className="flex items-center gap-2"><Wand2 size={15} className="text-accent" /><h2 className="text-sm font-semibold text-ink">Generate a montage</h2></div>
        {state.templates.length > 0 && <Select aria-label="Template" size="sm" value="" placeholder="Apply a saved template…"
          options={state.templates.map((t) => ({ value: t.id, label: t.name }))}
          onChange={(id) => { const t = state.templates.find((x) => x.id === id); if (t) setRequest((r) => ({ ...r, ...t.request })) }} />}
        <Field label="Instructions for the AI" hint={`For example: “${EXAMPLES[0]}”`}>
          <TextArea aria-label="Instructions for the AI" rows={4} maxLength={2000} value={request.instruction} onChange={(e) => set({ instruction: e.target.value })}
            placeholder="Describe what you want: the moments, the tone, the number of versions…" />
        </Field>
        <Segmented label="Montage type" size="sm" value={request.mode} onChange={() => {}}
          options={[{ value: 'short', label: 'Short clips' }, { value: 'long' as 'short', label: 'Long video', disabled: 'Long videos come in the next version' }]} />
        <Segmented label="Format" size="sm" value={request.aspect} onChange={(aspect) => set({ aspect })}
          options={[{ value: '9:16', label: '9:16 TikTok · Shorts · Reels' }, { value: '16:9', label: '16:9' }, { value: '1:1' as '16:9', label: '1:1', disabled: 'Square comes in a next version' }]} />
        <div>
          <p className="mb-1.5 text-xs text-ink-muted">Length of each video</p>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Length of each video">
            {[...MONTAGE_DURATIONS, null].map((d) => <button key={String(d)} type="button" role="radio" aria-checked={request.duration_s === d}
              className={cn('rounded-full border px-3 py-1 text-xs', request.duration_s === d ? 'border-accent/60 bg-accent/15 text-ink' : 'border-white/10 text-ink-muted')}
              onClick={() => set({ duration_s: d })}>{d === null ? 'Free' : `${d}s`}</button>)}
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-xs text-ink-muted">Style</p>
          <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Style">{MONTAGE_STYLES.map((s) =>
            <button key={s.id} type="button" role="radio" aria-checked={request.style === s.id} title={s.description}
              className={cn('rounded-xl border px-2.5 py-2 text-left text-xs', request.style === s.id ? 'border-accent/60 bg-accent/10 text-ink' : 'border-white/10 text-ink-muted')}
              onClick={() => set({ style: s.id })}><span className="block font-medium">{s.name}</span><span className="block text-2xs text-ink-subtle">{s.description}</span></button>)}</div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Number of videos"><Select aria-label="Number of videos" size="sm" value={String(request.count)}
            options={[1, 2, 3, 5, 8, 10, 15, 20, 30, 50].map((n) => ({ value: String(n), label: String(n) }))} onChange={(v) => set({ count: Number(v) })} /></Field>
          <Field label="From"><p className="pt-1.5 text-xs text-ink">{chosen.length ? `${chosen.length} selected rush${chosen.length === 1 ? '' : 'es'}` : `All ${ready.length} ready rushes`}</p></Field>
        </div>
        <div className="space-y-2">
          {([['captions', 'Captions from the dialogue'], ['smart_framing', 'Smart framing on people'], ['hook', 'Hook text in the first seconds'], ['auto_export', 'Export automatically to the Library']] as const).map(([key, label]) =>
            <label key={key} className="flex items-center justify-between gap-2 text-xs text-ink">{label}<Switch label={label} checked={request[key]} onChange={(on) => set({ [key]: on })} /></label>)}
        </div>
        <div className="space-y-2 rounded-xl border border-white/[0.06] p-2.5">
          <div className="flex items-center justify-between gap-2"><span className="flex min-w-0 items-center gap-2 text-xs text-ink"><Music size={13} />{music ? <span className="truncate" title={music}>{music.split(/[\\/]/).pop()}</span> : 'No music'}</span>
            <div className="flex gap-1">{music && <Button size="sm" variant="ghost" iconOnly icon={<X size={12} />} aria-label="Remove music" onClick={() => setMusic(null)} />}
              <Button size="sm" variant="ghost" onClick={() => { void getApi().montage.chooseMusic().then((p) => { if (p) setMusic(p) }).catch((e) => setError(errorMessage(e))) }}>{music ? 'Change' : 'Add music…'}</Button></div></div>
          {music && <label className="flex items-center justify-between gap-2 text-xs text-ink">Cut on the beat<Switch label="Cut on the beat" checked={request.beat_sync} onChange={(beat_sync) => set({ beat_sync })} /></label>}
        </div>
        <Button className="w-full" icon={<Sparkles size={14} />} loading={busy === 'generate'} disabled={!ready.length} onClick={generate}>Generate the montage</Button>
        {!ready.length && <p className="text-2xs text-ink-subtle">Import rushes and wait for their analysis first.</p>}
        <div className="flex gap-2 border-t border-white/[0.06] pt-3">
          <TextInput aria-label="Template name" inputSize="sm" value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="Template name" />
          <Button size="sm" variant="ghost" icon={<Save size={12} />} disabled={!templateName.trim()}
            onClick={() => { void act('template', () => getApi().montage.saveTemplate(templateName, request)).then((ok) => { if (ok) setTemplateName('') }) }}>Save</Button>
        </div>
        {state.templates.length > 0 && <ul className="flex flex-wrap gap-1">{state.templates.map((t) => <li key={t.id}><Badge>{t.name}
          <button type="button" aria-label={`Delete template ${t.name}`} className="ml-1" onClick={() => { void act('tpl', () => getApi().montage.deleteTemplate(t.id)) }}><X size={10} /></button></Badge></li>)}</ul>}
      </Panel>
    </div>
    {confirm && <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />}
  </Page>
}

function JobRow({ job, busy, act, onViewLibrary }: { job: MontageJob; busy: string | null; act: (key: string, action: () => Promise<MontageState>) => Promise<boolean>; onViewLibrary: (dir: string) => void }): React.JSX.Element {
  const r = job.request
  const status = JOB_STATUS[job.status]
  const active = job.status === 'queued' || job.status === 'running' || job.status === 'exporting'
  return <li className="space-y-2 py-3" aria-label={`Montage ${styleName(r.style)} ${r.count}`}>
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={status.tone}>{status.label}</Badge>
      <p className="min-w-0 flex-1 truncate text-sm text-ink" title={r.instruction}>{r.count} × {r.duration_s ? `${r.duration_s}s` : 'free length'} · {styleName(r.style)} · {r.aspect}{r.instruction ? ` · “${r.instruction}”` : ''}</p>
      <span className="text-2xs text-ink-subtle">{formatRelativeDate(job.createdAt)}</span>
    </div>
    {active && job.progress && <div className="space-y-1"><p className="text-2xs text-ink-muted">{MONTAGE_PHASES[job.progress.phase] ?? job.progress.phase}… {job.progress.percent}%</p><ProgressBar value={job.progress.percent} /></div>}
    {job.summary && <p className="text-2xs text-ink-subtle">{job.summary.videos} video{job.summary.videos === 1 ? '' : 's'} from {job.summary.rushes} rush{job.summary.rushes === 1 ? '' : 'es'} · planned by {job.summary.planner === 'ai' ? 'AI' : 'analysis scores'} · {Math.round(job.summary.seconds)}s{job.exported !== undefined ? ` · ${job.exported} exported` : ''}{job.music ? ` · music: ${job.music.name}` : ''}</p>}
    {job.summary?.notes.map((n) => <p key={n} className="text-2xs text-warning">{n}</p>)}
    {job.error && <p className="text-xs text-danger">{job.error}</p>}
    <div className="flex flex-wrap gap-1.5">
      {job.status === 'done' && <Button size="sm" icon={<Film size={12} />} onClick={() => onViewLibrary(job.runDir)}>Open in editor</Button>}
      {job.status === 'done' && <Button size="sm" variant="ghost" icon={<Download size={12} />} loading={busy === `export:${job.id}`} onClick={() => { void act(`export:${job.id}`, () => getApi().montage.exportAll(job.id)) }}>Export all</Button>}
      {active && <Button size="sm" variant="ghost" icon={<X size={12} />} onClick={() => { void act(`cancel:${job.id}`, () => getApi().montage.cancel(job.id)) }}>Cancel</Button>}
      {(job.status === 'failed' || job.status === 'cancelled') && <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} onClick={() => { void act(`retry:${job.id}`, () => getApi().montage.retry(job.id)) }}>Retry</Button>}
      {!active && <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => { void act(`dismiss:${job.id}`, () => getApi().montage.dismiss(job.id)) }}>Remove from list</Button>}
    </div>
  </li>
}

