import { useRef, useState, type ReactNode } from 'react'
import { Plus, Trash2, Wand2, ZoomIn } from 'lucide-react'
import type { CandidateEdit } from '../../shared/clip-editor'
import { MAX_LOOKS, NO_EFFECTS, type Effects, type Look } from '../../shared/effects'
import { EDIT_PRESETS, applyEditPreset } from '../lib/edit-presets'
import { punchInScenes } from '../lib/punch-in'
import { cn } from '../lib/utils'
import { Button } from './ui/Button'
import { Switch } from './ui/Switch'

function Range({ label, value, min, max, step = 1, format, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; format?: (v: number) => string
  onChange: (value: number, remember: boolean) => void
}): React.JSX.Element {
  const first = useRef(true)
  return <label className="editor-label">{label}<span className="float-right font-mono">{format ? format(value) : value}</span>
    <input type="range" aria-label={label} min={min} max={max} step={step} value={value}
      onPointerDown={() => { first.current = true }} onKeyDown={() => { first.current = true }}
      onChange={(e) => { onChange(Number(e.target.value), first.current); first.current = false }} />
  </label>
}
const Group = ({ title, children }: { title: string; children: ReactNode }): React.JSX.Element => <section className="editor-style-group"><h4>{title}</h4>{children}</section>
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

/**
 * Effects tab: speed (slow motion to 2×), fades, transitions at cuts, punch-in
 * zooms, color looks on any part of the clip, and three one-click edit styles.
 * Nothing is applied until chosen, and Undo reverts each change.
 */
export function EffectsPanel({ candidate, time, disabled, timeInput, onChange, seek }: {
  candidate: CandidateEdit; time: number; disabled: boolean
  timeInput: (label: string, value: number, onChange: (t: number) => void) => ReactNode
  onChange: (patch: Partial<CandidateEdit>, remember?: boolean) => void
  seek: (t: number) => void
}): React.JSX.Element {
  const effects = candidate.effects ?? NO_EFFECTS
  const [selected, setSelected] = useState<number | null>(null)
  const [zoom, setZoom] = useState(1.3)
  const [zoomLength, setZoomLength] = useState(2000)
  const [notice, setNotice] = useState<string | null>(null)
  const set = (patch: Partial<Effects>, remember = true): void => onChange({ effects: { ...effects, looks: [...effects.looks], ...patch } }, remember)
  const looks = effects.looks
  const look = selected !== null ? looks[selected] : undefined
  const setLook = (patch: Partial<Look>, remember = true): void => {
    if (selected === null) return
    set({ looks: looks.map((l, i) => i === selected ? { ...l, ...patch } : l) }, remember)
  }
  const clipStart = candidate.ranges[0][0], clipEnd = candidate.ranges[candidate.ranges.length - 1][1]
  const addLook = (whole: boolean): void => {
    const start = whole ? clipStart : Math.round(Math.max(clipStart, Math.min(time, clipEnd - 100)))
    const item: Look = { start_ms: start, end_ms: whole ? clipEnd : Math.min(clipEnd, start + 3000), brightness: 0, contrast: 1.1, saturation: 1.15, sharpen: 0, vignette: false }
    set({ looks: [...looks, item] }); setSelected(looks.length)
  }
  const inClip = candidate.ranges.some(([a, b]) => a <= time && time < b)
  return <fieldset disabled={disabled} className="space-y-4 mt-4">
    <Group title="Edit style">
      <div className="grid gap-1.5">{EDIT_PRESETS.map((p) => <button key={p.id} className="editor-overlay-row" title={p.description}
        onClick={() => { onChange(applyEditPreset(candidate, p.id)); setNotice(`${p.name} applied. Undo reverts it; every part stays editable below and in Captions.`) }}>
        <span className="flex items-center gap-2"><Wand2 size={12} />{p.name}</span><span className="text-2xs text-ink-subtle truncate">{p.description}</span></button>)}</div>
      {notice && <p role="status" className="text-2xs text-ink-subtle">{notice}</p>}
    </Group>
    <Group title="Speed">
      <label className="editor-label">Clip speed<select aria-label="Clip speed" value={candidate.video_speed} onChange={(e) => onChange({ video_speed: Number(e.target.value) })}>
        {[.5, .75, 1, 1.1, 1.25, 1.5, 1.75, 2].map((n) => <option key={n} value={n}>{n < 1 ? `${n}× (slow motion)` : `${n}×`}</option>)}</select></label>
    </Group>
    <Group title="Fades">
      <Range label="Fade in" value={effects.fade_in_ms} min={0} max={3000} step={100} format={(v) => v ? seconds(v) : 'Off'} onChange={(v, r) => set({ fade_in_ms: v }, r)} />
      <Range label="Fade out" value={effects.fade_out_ms} min={0} max={3000} step={100} format={(v) => v ? seconds(v) : 'Off'} onChange={(v, r) => set({ fade_out_ms: v }, r)} />
    </Group>
    <Group title="Transitions at cuts">
      <label className="editor-label">Between kept parts<select aria-label="Transition" value={effects.transition} onChange={(e) => set({ transition: e.target.value as Effects['transition'] })}>
        <option value="none">Cut</option><option value="dip">Dip to black</option><option value="flash">White flash</option></select></label>
      {effects.transition !== 'none' && <Range label="Transition length" value={effects.transition_ms} min={100} max={1000} step={50} format={seconds} onChange={(v, r) => set({ transition_ms: v }, r)} />}
      {candidate.ranges.length < 2 && <p className="text-2xs text-ink-subtle">This clip has no cuts yet. Split it to add transitions.</p>}
    </Group>
    <Group title="Zoom">
      <Range label="Zoom amount" value={Math.round(zoom * 100)} min={110} max={200} step={5} format={(v) => `${(v / 100).toFixed(2)}×`} onChange={(v) => setZoom(v / 100)} />
      <Range label="Zoom length" value={zoomLength} min={500} max={6000} step={100} format={seconds} onChange={(v) => setZoomLength(v)} />
      <Button size="sm" icon={<ZoomIn size={12} />} disabled={!inClip} tooltip="Smoothly zoom in on the current framing at the playhead, then back out. It appears as two layout changes on the timeline."
        onClick={() => {
          const scenes = punchInScenes(candidate, time, zoomLength, zoom)
          if (scenes) { onChange({ scenes }); setNotice(null) } else setNotice('No room for a zoom here: move away from a layout change, or use a framed layout (not Fit).')
        }}>Punch-in zoom at playhead</Button>
    </Group>
    <Group title="Looks">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={<Plus size={12} />} disabled={looks.length >= MAX_LOOKS || !inClip} onClick={() => addLook(false)}>Look at playhead</Button>
        <Button size="sm" variant="ghost" disabled={looks.length >= MAX_LOOKS} onClick={() => addLook(true)}>Whole clip</Button>
      </div>
      <div className="flex flex-col gap-1">{looks.map((l, i) => <button key={i} className={cn('editor-overlay-row', i === selected && 'selected')} onClick={() => { setSelected(i); seek(l.start_ms) }}>
        <span>Look {i + 1}</span><span className="font-mono text-2xs text-ink-subtle">{seconds(l.end_ms - l.start_ms)}</span></button>)}</div>
      {look && <div className="editor-caption-range space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-2xs text-ink-subtle">Start{timeInput('Look start', look.start_ms, (t) => setLook({ start_ms: Math.max(0, Math.min(look.end_ms - 100, Math.round(t))) }))}</label>
          <label className="text-2xs text-ink-subtle">End{timeInput('Look end', look.end_ms, (t) => setLook({ end_ms: Math.max(look.start_ms + 100, Math.round(t)) }))}</label>
        </div>
        <Range label="Brightness" value={Math.round(look.brightness * 100)} min={-30} max={30} format={(v) => `${v > 0 ? '+' : ''}${v}`} onChange={(v, r) => setLook({ brightness: v / 100 }, r)} />
        <Range label="Contrast" value={Math.round(look.contrast * 100)} min={50} max={180} format={(v) => `${v}%`} onChange={(v, r) => setLook({ contrast: v / 100 }, r)} />
        <Range label="Saturation" value={Math.round(look.saturation * 100)} min={0} max={200} format={(v) => `${v}%`} onChange={(v, r) => setLook({ saturation: v / 100 }, r)} />
        <Range label="Sharpness" value={Math.round(look.sharpen * 100)} min={0} max={200} format={(v) => v ? `${v}%` : 'Off'} onChange={(v, r) => setLook({ sharpen: v / 100 }, r)} />
        <div className="flex items-center justify-between text-xs"><span>Vignette</span><Switch label="Vignette" checked={look.vignette} onChange={(vignette) => setLook({ vignette })} /></div>
        <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => { set({ looks: looks.filter((_, i) => i !== selected) }); setSelected(null) }}>Delete look</Button>
      </div>}
    </Group>
    <Button size="sm" variant="ghost" disabled={!candidate.effects} onClick={() => { onChange({ effects: undefined }); setSelected(null) }}>Remove fades, transitions and looks</Button>
  </fieldset>
}
