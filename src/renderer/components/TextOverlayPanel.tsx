import type { ReactNode } from 'react'
import { Plus, Sparkles, Trash2 } from 'lucide-react'
import { CAPTION_FONTS } from '../../shared/caption-style'
import { MAX_TEXT_OVERLAYS, newHook, newTextOverlay, type TextOverlay } from '../../shared/text-overlays'
import { cn } from '../lib/utils'
import { Button } from './ui/Button'
import { Group, Range } from './EditorControls'
import { Switch } from './ui/Switch'

/**
 * Text tab: text overlays and hooks on top of the video, each with its own
 * time range (source time), position, font and plate. Exported by the engine.
 */
export function TextOverlayPanel({ overlays, selected, time, clipStart, duration, title, disabled, timeInput, onSelect, onChange, seek }: {
  overlays: TextOverlay[]; selected: number | null; time: number; clipStart: number; duration: number; title: string; disabled: boolean
  /** The editor's time field, for consistent timecode entry. */
  timeInput: (label: string, value: number, onChange: (t: number) => void) => ReactNode
  onSelect: (index: number | null) => void
  onChange: (overlays: TextOverlay[], remember?: boolean) => void
  seek: (t: number) => void
}): React.JSX.Element {
  const current = selected !== null ? overlays[selected] : undefined
  const update = (patch: Partial<TextOverlay>, remember = true): void => {
    if (selected === null) return
    onChange(overlays.map((o, i) => i === selected ? { ...o, ...patch } : o), remember)
  }
  const add = (overlay: TextOverlay): void => {
    if (overlays.length >= MAX_TEXT_OVERLAYS) return
    onChange([...overlays, overlay]); onSelect(overlays.length); seek(overlay.start_ms)
  }
  return <fieldset disabled={disabled} className="space-y-4 mt-4">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" icon={<Plus size={12} />} disabled={overlays.length >= MAX_TEXT_OVERLAYS} tooltip="Add a text on top of the video at the playhead." onClick={() => add(newTextOverlay(time, duration))}>Add text</Button>
      <Button size="sm" icon={<Sparkles size={12} />} disabled={overlays.length >= MAX_TEXT_OVERLAYS} tooltip="Add a bold hook for the first seconds of the clip." onClick={() => add(newHook(title, clipStart, duration))}>Add hook</Button>
    </div>
    {!overlays.length && <p className="text-2xs text-ink-subtle">Texts and hooks appear over the video for the time you choose. Drag them on the output preview to place them.</p>}
    <div className="flex flex-col gap-1">{overlays.map((o, i) => <button key={i} className={cn('editor-overlay-row', i === selected && 'selected')} onClick={() => { onSelect(i); seek(o.start_ms) }}>
      <span className="truncate">{o.text.split('\n')[0]}</span><span className="font-mono text-2xs text-ink-subtle">{((o.end_ms - o.start_ms) / 1000).toFixed(1)}s</span></button>)}</div>
    {current && <>
      <Group title="Text">
        <textarea aria-label="Overlay text" rows={2} maxLength={200} value={current.text} onChange={(e) => { if (e.target.value.trim() && e.target.value.split('\n').length <= 4) update({ text: e.target.value }) }} />
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-2xs text-ink-subtle">Start{timeInput('Overlay start', current.start_ms, (t) => update({ start_ms: Math.max(0, Math.min(current.end_ms - 100, Math.round(t))) }))}</label>
          <label className="text-2xs text-ink-subtle">End{timeInput('Overlay end', current.end_ms, (t) => update({ end_ms: Math.min(duration, Math.max(current.start_ms + 100, Math.round(t))) }))}</label>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" disabled={time >= current.end_ms - 100} onClick={() => update({ start_ms: Math.max(0, Math.round(time)) })}>Start here</Button>
          <Button size="sm" variant="ghost" disabled={time <= current.start_ms + 100} onClick={() => update({ end_ms: Math.min(duration, Math.round(time)) })}>End here</Button>
          <Button size="sm" variant="ghost" onClick={() => seek(current.start_ms)}>Go to</Button>
        </div>
      </Group>
      <Group title="Style">
        <label className="editor-label">Font<select aria-label="Overlay font" value={current.font} onChange={(e) => update({ font: e.target.value as TextOverlay['font'] })}>{CAPTION_FONTS.map((f) => <option key={f}>{f}</option>)}</select></label>
        <Range label="Overlay size" value={current.size} min={20} max={240} onChange={(size, r) => update({ size }, r)} />
        <div className="flex items-center justify-between text-xs"><span>All caps</span><Switch label="Overlay all caps" checked={current.uppercase} onChange={(uppercase) => update({ uppercase })} /></div>
        <div className="grid grid-cols-2 gap-2">
          <label className="editor-color"><input type="color" aria-label="Overlay color" value={current.color.toLowerCase()} onChange={(e) => update({ color: e.target.value.toUpperCase() })} /><span>Text</span></label>
          <label className="editor-color"><input type="color" aria-label="Overlay outline color" value={current.outline_color.toLowerCase()} onChange={(e) => update({ outline_color: e.target.value.toUpperCase() })} /><span>Outline</span></label>
        </div>
        <Range label="Overlay outline" value={current.outline} min={0} max={20} onChange={(outline, r) => update({ outline }, r)} />
        <div className="flex items-center justify-between gap-2 text-xs"><span>Background</span><div className="flex items-center gap-2">
          {current.background && <input type="color" aria-label="Overlay background color" value={current.background.toLowerCase()} onChange={(e) => update({ background: e.target.value.toUpperCase() })} />}
          <Switch label="Overlay background" checked={current.background !== null} onChange={(on) => update({ background: on ? '#000000' : null })} /></div></div>
        {current.background && <Range label="Background opacity" value={Math.round(current.background_opacity * 100)} min={0} max={100} format={(v) => `${v}%`} onChange={(v, r) => update({ background_opacity: v / 100 }, r)} />}
        <label className="editor-label">Animation<select aria-label="Overlay animation" value={current.animation} onChange={(e) => update({ animation: e.target.value as TextOverlay['animation'] })}><option value="none">None</option><option value="fade">Fade in and out</option><option value="pop">Pop in</option></select></label>
      </Group>
      <Group title="Position">
        <Range label="Overlay horizontal" value={Math.round(current.x * 100)} min={5} max={95} format={(v) => `${v}%`} onChange={(v, r) => update({ x: v / 100 }, r)} />
        <Range label="Overlay vertical" value={Math.round(current.y * 100)} min={5} max={95} format={(v) => `${v}%`} onChange={(v, r) => update({ y: v / 100 }, r)} />
      </Group>
      <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => { onChange(overlays.filter((_, i) => i !== selected)); onSelect(null) }}>Delete text</Button>
    </>}
  </fieldset>
}
