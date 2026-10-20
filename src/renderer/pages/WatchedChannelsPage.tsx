import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, Film, Plus, RefreshCw, Scissors, Settings2, Trash2, Tv } from 'lucide-react'
import type { Automation } from '../../shared/automations'
import { DURATION_OPTIONS } from '../../shared/job-contract'
import { BACKLOG_LABELS, videoUrl, type WatchBacklog, type WatchChannelUpdate, type WatchClipSettings, type WatchState, type WatchedChannel, type WatchedVideo, type WatchedVideoStatus } from '../../shared/watched-channels'
import { CAPTION_PRESET_NAMES } from '../components/CaptionPresetPicker'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Callout } from '../components/ui/Callout'
import { ConfirmDialog, type ConfirmRequest } from '../components/ui/ConfirmDialog'
import { EmptyState } from '../components/ui/EmptyState'
import { Field, TextArea, TextInput } from '../components/ui/Field'
import { Page } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { Panel } from '../components/ui/Panel'
import { Segmented } from '../components/ui/Segmented'
import { Select } from '../components/ui/Select'
import { Switch } from '../components/ui/Switch'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatRelativeDate } from '../lib/utils'
import { useDraftStore, type ClipDraft } from '../store/use-draft-store'
import { useSetupState } from '../store/use-settings-store'
import type { Page as PageName } from '../components/Sidebar'

const STATUS: Record<WatchedVideoStatus, { label: string; tone: 'neutral' | 'accent' | 'success' | 'danger' | 'warning' }> = {
  earlier: { label: 'Before watching', tone: 'neutral' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  waiting: { label: 'Waiting', tone: 'warning' },
  clipping: { label: 'Clipping', tone: 'accent' },
  done: { label: 'Clips ready', tone: 'success' },
  sent: { label: 'Sent', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' }
}
const INTERVALS = [5, 10, 15, 30, 60, 180, 360]
const minutes = (n: number): string => n < 60 ? `${n} min` : `${n / 60} h`

/** The Create page's current output choices, as a watch's clip settings. */
export function settingsFromDraft(draft: ClipDraft): WatchClipSettings {
  return {
    workflow: draft.workflow ?? 'automatic', clippingMode: draft.clippingMode,
    ...(draft.clippingMode === 'advanced' ? { plannerModel: draft.plannerModel, transcriptionModel: draft.transcriptionModel } : {}),
    ...(draft.clipRequest.trim() ? { clipRequest: draft.clipRequest.trim() } : {}),
    maxClips: draft.autoClipCount ? null : draft.maxClips, autoClipCount: draft.autoClipCount,
    durationRanges: draft.durations.length ? draft.durations : null, aspectRatio: draft.aspectRatio, layoutStyle: draft.layoutStyle,
    layoutVision: draft.clippingMode !== 'economy' && draft.aspectRatio === '9:16' && draft.layoutStyle === 'auto' && draft.layoutVision,
    pacing: draft.pacing, videoSpeed: draft.videoSpeed ?? 1, includeCaptions: draft.includeCaptions, captionPreset: draft.captionPreset, includeTitle: draft.includeTitle
  }
}

function until(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (ms <= 30_000) return 'now'
  const m = Math.round(ms / 60_000)
  return m < 60 ? `in ${m} min` : `in ${Math.round(m / 6) / 10} h`
}

/**
 * Watched channels: YouTube channels BridgeClip checks while it is open. Each
 * new video is clipped once with the channel's settings; the clips stay in the
 * Library or go to one of the user's Automations, which posts them.
 */
export function WatchedChannelsPage({ onNavigate, onViewLibrary }: { onNavigate: (page: PageName) => void; onViewLibrary: (outputDir: string) => void }): React.JSX.Element {
  const [state, setState] = useState<WatchState | null>(null)
  const [automations, setAutomations] = useState<Automation[]>([])
  const [channelInput, setChannelInput] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [, setClock] = useState(0)
  const draft = useDraftStore()
  const setup = useSetupState()

  useEffect(() => {
    void getApi().watch.state().then(setState).catch((e) => setError(errorMessage(e)))
    void getApi().automations.list().then(setAutomations).catch(() => setAutomations([]))
    const off = getApi().watch.onUpdate(setState)
    const timer = window.setInterval(() => setClock((n) => n + 1), 30_000)
    return () => { off(); window.clearInterval(timer) }
  }, [])

  const act = useCallback(async (key: string, action: () => Promise<WatchState>): Promise<boolean> => {
    setBusy(key); setError(null)
    try { setState(await action()); return true } catch (e) { setError(errorMessage(e)); return false } finally { setBusy(null) }
  }, [])
  const add = async (): Promise<void> => {
    if (!channelInput.trim()) return
    if (await act('add', () => getApi().watch.add(channelInput.trim(), settingsFromDraft(draft)))) setChannelInput('')
  }
  const update = (channel: WatchedChannel, patch: WatchChannelUpdate): void => { void act(`update:${channel.id}`, () => getApi().watch.update(channel.id, patch)) }

  if (!state) return <Page><PageHeader title="Watched channels" />{error ? <Callout tone="danger">{error}</Callout> : <p className="mt-6 text-sm text-ink-muted">Loading…</p>}</Page>
  const watching = state.enabled && state.channels.some((c) => c.enabled)
  return <Page width="wide">
    <PageHeader title="Watched channels" eyebrow="YouTube"
      description="BridgeClip checks these channels while it is open. Each new video is clipped once with the channel’s settings, then kept in the Library or sent to one of your automations."
      actions={<div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-ink"><Switch label="Watch channels" checked={state.enabled} onChange={(on) => { void act('enabled', () => getApi().watch.setEnabled(on)) }} />Watching {state.enabled ? 'on' : 'off'}</label>
        <Select aria-label="Check every" size="sm" className="w-36" value={String(state.intervalMinutes)}
          options={INTERVALS.map((n) => ({ value: String(n), label: `Every ${minutes(n)}` }))} onChange={(v) => { void act('interval', () => getApi().watch.setInterval(Number(v))) }} />
        <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} loading={busy === 'check'} disabled={!state.channels.length || !!state.checking}
          onClick={() => { void act('check', () => getApi().watch.check()) }}>Check now</Button>
      </div>} />

    <div className="mt-5 space-y-3">
      {!setup.missingKeys.length ? null : <Callout tone="warning" title="Add your OpenRouter key to clip new videos"
        action={<Button size="sm" onClick={() => onNavigate('settings')}>Open Settings</Button>}>New uploads are found, but clipping needs your OpenRouter key, like Create.</Callout>}
      {!state.enabled && state.channels.length > 0 && <Callout tone="info" title="Watching is off">Turn it on to check your channels every {minutes(state.intervalMinutes)}. Check now still works.</Callout>}
      {error && <Callout tone="danger" onDismiss={() => setError(null)}>{error}</Callout>}
    </div>

    <Panel className="mt-4">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void add() }}>
        <Field label="Add a channel" htmlFor="watch-channel" className="min-w-[260px] flex-1"
          hint="A channel link or @handle. Videos already on the channel are left alone; only new uploads are clipped, with your current Create settings (you can change them per channel).">
          <TextInput id="watch-channel" value={channelInput} onChange={(e) => setChannelInput(e.target.value)} placeholder="https://www.youtube.com/@channel" leading={<Tv size={14} />} />
        </Field>
        <Button type="submit" icon={<Plus size={14} />} loading={busy === 'add'} disabled={!channelInput.trim()}>Add channel</Button>
      </form>
    </Panel>

    <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-3">
        {!state.channels.length && <EmptyState icon={<Tv size={18} />} title="No channels yet" description="Add a YouTube channel above. When it posts a video, BridgeClip clips it for you." />}
        {state.channels.map((channel) => <ChannelCard key={channel.id} channel={channel} state={state} automations={automations} open={open === channel.id} busy={busy}
          onToggle={() => setOpen(open === channel.id ? null : channel.id)} onUpdate={(patch) => update(channel, patch)}
          onCheck={() => { void act(`check:${channel.id}`, () => getApi().watch.check(channel.id)) }}
          onClip={(video) => { void act(`clip:${video.videoId}`, () => getApi().watch.clip(channel.id, video.videoId)) }}
          onCopyCreate={() => update(channel, { settings: settingsFromDraft(draft) })}
          onRemove={() => setConfirm({ title: `Stop watching ${channel.name}?`, body: 'Clips already made stay in the Library.', confirmLabel: 'Stop watching', tone: 'danger',
            onConfirm: () => { void act(`remove:${channel.id}`, () => getApi().watch.remove(channel.id)) } })}
          onViewLibrary={onViewLibrary} />)}
      </div>
      <Panel role="region" aria-label="Activity" className="self-start">
        <h2 className="text-sm font-semibold text-ink">Activity</h2>
        <p className="mt-1 text-2xs text-ink-subtle">{state.checking ? `Checking ${state.channels.find((c) => c.id === state.checking)?.name ?? 'a channel'}…`
          : watching ? `Next check ${until(state.nextCheckAt)}.` : 'Not watching.'} Watching happens only while BridgeClip is open; uploads made while it was closed are found at the next check.</p>
        <ol className="mt-3 space-y-2">{state.activity.slice(0, 25).map((a, i) => <li key={i} className="text-xs leading-snug">
          <span className={cn('block', a.kind === 'error' ? 'text-danger' : a.kind === 'done' ? 'text-success' : 'text-ink')}>{a.text}</span>
          <span className="text-2xs text-ink-subtle">{formatRelativeDate(a.at)}</span></li>)}
          {!state.activity.length && <li className="text-xs text-ink-subtle">Nothing yet.</li>}</ol>
      </Panel>
    </div>
    {confirm && <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />}
  </Page>
}

function ChannelCard({ channel, state, automations, open, busy, onToggle, onUpdate, onCheck, onClip, onCopyCreate, onRemove, onViewLibrary }: {
  channel: WatchedChannel; state: WatchState; automations: Automation[]; open: boolean; busy: string | null
  onToggle: () => void; onUpdate: (patch: WatchChannelUpdate) => void; onCheck: () => void; onClip: (video: WatchedVideo) => void
  onCopyCreate: () => void; onRemove: () => void; onViewLibrary: (outputDir: string) => void
}): React.JSX.Element {
  const s = channel.settings
  const setSettings = (patch: Partial<WatchClipSettings>): void => onUpdate({ settings: { ...s, ...patch } })
  const recent = channel.videos.filter((v) => v.status !== 'earlier').slice(0, 8)
  const earlier = channel.videos.filter((v) => v.status === 'earlier').slice(0, 3)
  const counts = useMemo(() => channel.videos.reduce((n, v) => ({ ...n, [v.status]: (n[v.status] ?? 0) + 1 }), {} as Record<string, number>), [channel.videos])
  const destination = channel.automationId ? automations.find((a) => a.id === channel.automationId)?.name ?? 'a deleted automation' : null
  return <Panel role="region" aria-label={`Channel ${channel.name}`}>
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><h2 className="truncate text-base font-semibold text-ink">{channel.name}</h2>
          <a href={`https://www.youtube.com/channel/${channel.channelId}`} target="_blank" rel="noreferrer" className="text-ink-subtle hover:text-ink" aria-label={`Open ${channel.name} on YouTube`}><ExternalLink size={13} /></a></div>
        <p className="mt-0.5 text-2xs text-ink-subtle">
          {state.checking === channel.id ? 'Checking now…' : channel.lastCheckAt ? `Checked ${formatRelativeDate(channel.lastCheckAt)}` : 'Not checked yet'}
          {' · '}{s.workflow === 'review' ? 'Review runs' : `${s.autoClipCount ? 'AI picks the number of clips' : `Up to ${s.maxClips} clips`}`}
          {' · '}{destination ? `Sends ${channel.sendClips ? `the best ${channel.sendClips}` : 'every clip'} to ${destination}` : 'Clips stay in the Library'}
          {counts.clipping ? ` · ${counts.clipping} clipping` : ''}
        </p>
        {channel.lastError && <p className="mt-1 text-xs text-danger">{channel.lastError}</p>}
      </div>
      <Switch label={`Watch ${channel.name}`} checked={channel.enabled} onChange={(enabled) => onUpdate({ enabled })} />
      <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} loading={busy === `check:${channel.id}`} disabled={!!state.checking} onClick={onCheck}>Check</Button>
      <Button size="sm" variant="ghost" icon={<Settings2 size={12} />} aria-expanded={open} onClick={onToggle}>Settings</Button>
      <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={13} />} aria-label={`Stop watching ${channel.name}`} onClick={onRemove} />
    </div>

    {open && <div className="mt-4 grid gap-4 border-t border-white/[0.06] pt-4 md:grid-cols-2" aria-label={`${channel.name} settings`}>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">Clips</h3>
          <Button size="sm" variant="ghost" onClick={onCopyCreate} tooltip="Use the format, framing, captions, clip length and count currently chosen in Create.">Use Create settings</Button></div>
        <Segmented label="Workflow" size="sm" value={s.workflow ?? 'automatic'} onChange={(workflow) => setSettings({ workflow })}
          options={[{ value: 'automatic', label: 'Automatic' }, { value: 'review', label: 'Review first', disabled: channel.automationId ? 'Review runs can’t go to an automation' : undefined }]} />
        <Field label="What to clip" hint="Optional. Blank finds the strongest moments.">
          <TextArea aria-label="What to clip" rows={2} maxLength={1000} defaultValue={s.clipRequest ?? ''} key={`${channel.id}:${s.clipRequest ?? ''}`}
            onBlur={(e) => { const v = e.target.value.trim(); if (v !== (s.clipRequest ?? '')) setSettings({ clipRequest: v || undefined }) }} />
        </Field>
        <div>
          <p className="mb-1.5 text-xs text-ink-muted">Clip length</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Clip length">{DURATION_OPTIONS.map((d) => {
            const on = s.durationRanges?.includes(d.id) ?? false
            return <button key={d.id} type="button" aria-pressed={on} className={cn('rounded-full border px-2.5 py-1 text-2xs', on ? 'border-accent/60 bg-accent/15 text-ink' : 'border-white/10 text-ink-muted')}
              onClick={() => { const next = on ? (s.durationRanges ?? []).filter((x) => x !== d.id) : [...(s.durationRanges ?? []), d.id]; setSettings({ durationRanges: next.length ? next : null }) }}>{d.label} <span className="text-ink-subtle">{d.range}</span></button>
          })}</div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Number of clips"><Select aria-label="Number of clips" size="sm" value={s.autoClipCount ? 'auto' : String(s.maxClips)}
            options={[{ value: 'auto', label: 'AI decides' }, ...[1, 2, 3, 5, 8, 10, 15, 20].map((n) => ({ value: String(n), label: `Up to ${n}` }))]}
            onChange={(v) => setSettings(v === 'auto' ? { autoClipCount: true, maxClips: null } : { autoClipCount: false, maxClips: Number(v) })} /></Field>
          <Field label="Format"><Select aria-label="Format" size="sm" value={s.aspectRatio} options={[{ value: '9:16', label: 'Vertical 9:16' }, { value: '16:9', label: 'Horizontal 16:9' }]}
            onChange={(aspectRatio) => setSettings({ aspectRatio, layoutVision: aspectRatio === '9:16' && s.layoutStyle === 'auto' && s.clippingMode !== 'economy' && s.layoutVision })} /></Field>
          <Field label="Captions"><Select aria-label="Caption style" size="sm" value={s.includeCaptions ? s.captionPreset : 'off'}
            options={[{ value: 'off', label: 'No captions' }, ...Object.entries(CAPTION_PRESET_NAMES).map(([value, label]) => ({ value, label }))]}
            onChange={(v) => setSettings(v === 'off' ? { includeCaptions: false } : { includeCaptions: true, captionPreset: v })} /></Field>
          <Field label="Clipping mode"><Select aria-label="Clipping mode" size="sm" value={s.clippingMode ?? 'quality'}
            options={[{ value: 'quality', label: 'Quality' }, { value: 'economy', label: 'Economy' }, ...(s.clippingMode === 'advanced' ? [{ value: 'advanced', label: 'Advanced (from Create)' }] : [])]}
            onChange={(v) => setSettings(v === 'advanced' ? {} : { clippingMode: v as 'quality' | 'economy', plannerModel: undefined, transcriptionModel: undefined, layoutVision: v !== 'economy' && s.aspectRatio === '9:16' && s.layoutStyle === 'auto' })} /></Field>
        </div>
        <label className="flex items-center justify-between text-xs text-ink">Title at the top<Switch label="Title at the top" checked={s.includeTitle !== false} onChange={(includeTitle) => setSettings({ includeTitle })} /></label>
      </div>
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">After clipping</h3>
        <Field label="Clips go to" hint={automations.length ? 'An automation posts them on its own schedule, with its accounts and captions.' : 'Create an automation to post clips automatically.'}>
          <Select aria-label="Clips go to" size="sm" value={channel.automationId ?? 'library'} emptyText="No automations"
            options={[{ value: 'library', label: 'The Library only' }, ...automations.map((a) => ({ value: a.id, label: a.name, disabled: s.workflow === 'review', detail: s.workflow === 'review' ? 'Review runs stay in the Library' : undefined }))]}
            onChange={(v) => onUpdate({ automationId: v === 'library' ? null : v })} />
        </Field>
        {channel.automationId && <Field label="Clips sent per video" hint="The best-scoring ones; the rest stay in the Library.">
          <Select aria-label="Clips sent per video" size="sm" value={String(channel.sendClips)}
            options={[{ value: '0', label: 'All of them' }, ...[1, 2, 3, 5, 10].map((n) => ({ value: String(n), label: `The best ${n}` }))]}
            onChange={(v) => onUpdate({ sendClips: Number(v) })} /></Field>}
        <h3 className="pt-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">Which videos</h3>
        <Field label="Skip videos shorter than"><Select aria-label="Skip videos shorter than" size="sm" value={String(channel.minMinutes)}
          options={[0, 1, 3, 5, 10, 20, 30].map((n) => ({ value: String(n), label: n ? `${n} minutes` : 'Clip any length (Shorts are always skipped)' }))}
          onChange={(v) => onUpdate({ minMinutes: Number(v) })} /></Field>
        <Field label="Several uploads while BridgeClip was closed" hint="Uploads found on time are always clipped. Others are listed as Skipped; you can clip them by hand.">
          <Select aria-label="Uploads while closed" size="sm" value={channel.backlog}
            options={(Object.keys(BACKLOG_LABELS) as WatchBacklog[]).map((b) => ({ value: b, label: BACKLOG_LABELS[b] }))}
            onChange={(v) => onUpdate({ backlog: v as WatchBacklog })} /></Field>
      </div>
    </div>}

    <ul className="mt-3 divide-y divide-white/[0.05]" aria-label={`${channel.name} videos`}>
      {[...recent, ...earlier].map((v) => <li key={v.videoId} className="flex flex-wrap items-center gap-2 py-2">
        <Badge tone={STATUS[v.status].tone}>{STATUS[v.status].label}</Badge>
        <div className="min-w-0 flex-1">
          <a href={videoUrl(v.videoId)} target="_blank" rel="noreferrer" className="block truncate text-sm text-ink hover:underline" title={v.title}>{v.title}</a>
          <p className="truncate text-2xs text-ink-subtle">{formatRelativeDate(v.publishedAt)}
            {v.clips !== undefined ? ` · ${v.clips} clip${v.clips === 1 ? '' : 's'}${v.sent ? `, ${v.sent} sent` : ''}` : ''}{v.note ? ` · ${v.note}` : ''}</p>
        </div>
        {v.outputDir && (v.status === 'done' || v.status === 'sent') && <Button size="sm" variant="ghost" icon={<Film size={12} />} onClick={() => onViewLibrary(v.outputDir!)}>View clips</Button>}
        {['earlier', 'skipped', 'failed', 'cancelled'].includes(v.status) && <Button size="sm" variant="ghost" icon={<Scissors size={12} />} loading={busy === `clip:${v.videoId}`}
          onClick={() => onClip(v)}>{v.status === 'failed' || v.status === 'cancelled' ? 'Clip again' : 'Clip this'}</Button>}
      </li>)}
      {!channel.videos.length && <li className="py-2 text-xs text-ink-subtle">No videos found on this channel yet.</li>}
    </ul>
  </Panel>
}

