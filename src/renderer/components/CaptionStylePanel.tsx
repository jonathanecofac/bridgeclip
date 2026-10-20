import { useEffect, useRef, useState, type ReactNode } from 'react'
import { RotateCcw, Save, Trash2 } from 'lucide-react'
import { CAPTION_FONTS, CAPTION_STYLE_PRESETS, EDITOR_TEMPLATE_IDS, effectiveCaptionStyle, minimalOverrides,
  type CaptionStyleOverrides, type CaptionStyleValues, type UserCaptionPreset } from '../../shared/caption-style'
import { getApi } from '../lib/ipc'
import { cn, errorMessage } from '../lib/utils'
import { CaptionPresetPicker } from './CaptionPresetPicker'
import { Button } from './ui/Button'
import { Switch } from './ui/Switch'

const ORDER = [...EDITOR_TEMPLATE_IDS, ...CAPTION_STYLE_PRESETS.map((p) => p.id).filter((id) => !(EDITOR_TEMPLATE_IDS as readonly string[]).includes(id))]
const presetName = (id: string): string => CAPTION_STYLE_PRESETS.find((p) => p.id === id)?.name ?? id

/** A slider that records one undo step per drag, not one per pixel. */
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
function Color({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }): React.JSX.Element {
  return <label className="editor-color"><input type="color" aria-label={label} value={value.toLowerCase()} onChange={(e) => onChange(e.target.value.toUpperCase())} /><span>{label}</span></label>
}
/** An optional color: a switch, then its color. */
function OptionalColor({ label, value, fallback, onChange }: { label: string; value: string | null; fallback: string; onChange: (value: string | null) => void }): React.JSX.Element {
  return <div className="flex items-center justify-between gap-2 text-xs"><span>{label}</span><div className="flex items-center gap-2">
    {value && <input type="color" aria-label={`${label} color`} value={value.toLowerCase()} onChange={(e) => onChange(e.target.value.toUpperCase())} />}
    <Switch label={label} checked={value !== null} onChange={(on) => onChange(on ? fallback : null)} /></div></div>
}
function Group({ title, children }: { title: string; children: ReactNode }): React.JSX.Element {
  return <section className="editor-style-group"><h4>{title}</h4>{children}</section>
}

/**
 * Captions tab styling: templates, saved looks, and every override the engine
 * accepts (CAPTION_OVERRIDE_FIELDS). Changes are per clip; "Save as preset"
 * keeps a look for other clips.
 */
export function CaptionStylePanel({ preset, overrides, captionY, onChange, onCaptionY }: {
  preset: string; overrides?: CaptionStyleOverrides; captionY: number | null
  onChange: (patch: { caption_preset?: string; caption_style?: CaptionStyleOverrides }, remember?: boolean) => void
  onCaptionY: (y: number | null, remember: boolean) => void
}): React.JSX.Element {
  const style = effectiveCaptionStyle(preset, overrides)
  const customized = !!overrides && Object.keys(minimalOverrides(preset, style)).length > 0
  const [saved, setSaved] = useState<UserCaptionPreset[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { void getApi().captionPresets.list().then(setSaved).catch((e) => setError(errorMessage(e))) }, [])
  const set = <K extends keyof CaptionStyleValues>(key: K, value: CaptionStyleValues[K], remember = true): void =>
    onChange({ caption_style: minimalOverrides(preset, { ...style, [key]: value }) }, remember)
  const save = async (): Promise<void> => {
    setError(null)
    try { setSaved(await getApi().captionPresets.save(name, preset, minimalOverrides(preset, style))); setName('') } catch (e) { setError(errorMessage(e)) }
  }
  return <div className="space-y-4">
    <Group title="Templates">
      <CaptionPresetPicker value={customized ? '' : preset} ids={ORDER} onChange={(caption_preset) => onChange({ caption_preset, caption_style: {} })} />
      {customized && <p className="text-2xs text-ink-subtle mt-2">Based on {presetName(preset)}, customized. <button className="underline" onClick={() => onChange({ caption_style: {} })}>Reset to template</button></p>}
    </Group>
    <Group title="My presets">
      {saved.length === 0 && <p className="text-2xs text-ink-subtle">Save a look to reuse it on other clips.</p>}
      <div className="flex flex-wrap gap-1.5">{saved.map((p) => <span key={p.id} className={cn('editor-user-preset', p.base === preset && JSON.stringify(p.style) === JSON.stringify(minimalOverrides(preset, style)) && 'selected')}>
        <button onClick={() => onChange({ caption_preset: p.base, caption_style: p.style })} title={`${presetName(p.base)} with your changes`}>{p.name}</button>
        <button aria-label={`Delete preset ${p.name}`} title="Delete this preset" onClick={() => { void getApi().captionPresets.delete(p.id).then(setSaved).catch((e) => setError(errorMessage(e))) }}><Trash2 size={11} /></button>
      </span>)}</div>
      <div className="flex gap-1.5 mt-2"><input className="editor-text-input flex-1" aria-label="Preset name" placeholder="Name this look" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void save() }} />
        <Button size="sm" icon={<Save size={13} />} disabled={!name.trim()} onClick={() => { void save() }}>Save</Button></div>
      {error && <p role="alert" className="text-2xs text-danger mt-1">{error}</p>}
    </Group>
    <Group title="Text">
      <label className="editor-label">Font<select aria-label="Caption font" value={style.font_name} onChange={(e) => set('font_name', e.target.value as CaptionStyleValues['font_name'])}>{CAPTION_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}</select></label>
      <Range label="Size" value={style.font_size} min={30} max={220} onChange={(v, r) => set('font_size', v, r)} />
      <Range label="Letter spacing" value={style.letter_spacing} min={-5} max={20} onChange={(v, r) => set('letter_spacing', v, r)} />
      <div className="flex items-center justify-between text-xs"><span>All caps</span><Switch label="All caps" checked={style.uppercase} onChange={(v) => set('uppercase', v)} /></div>
      <Range label="Words on screen" value={style.max_words_per_line} min={1} max={8} format={(v) => v === 1 ? 'Word by word' : `${v} words`} onChange={(v, r) => set('max_words_per_line', v, r)} />
    </Group>
    <Group title="Colors">
      <div className="grid grid-cols-3 gap-2"><Color label="Text" value={style.primary_color} onChange={(v) => set('primary_color', v)} /><Color label="Spoken word" value={style.highlight_color} onChange={(v) => set('highlight_color', v)} /><Color label="Outline" value={style.outline_color} onChange={(v) => set('outline_color', v)} /></div>
      <Range label="Outline" value={style.outline_width} min={0} max={20} onChange={(v, r) => set('outline_width', v, r)} />
      <OptionalColor label="Key words" value={style.emphasis_color} fallback="#3DFF8B" onChange={(v) => set('emphasis_color', v)} />
    </Group>
    <Group title="Highlight">
      <div className="flex items-center justify-between text-xs"><span>Highlight the spoken word</span><Switch label="Highlight the spoken word" checked={style.word_by_word_highlight} onChange={(v) => set('word_by_word_highlight', v)} /></div>
      <div className="flex items-center justify-between text-xs"><span>Karaoke fill</span><Switch label="Karaoke fill" checked={style.karaoke_fill} onChange={(v) => set('karaoke_fill', v)} /></div>
      <OptionalColor label="Block behind spoken word" value={style.highlight_box_color} fallback="#FFE234" onChange={(v) => set('highlight_box_color', v)} />
      <OptionalColor label="Glow" value={style.glow_color} fallback="#00C8FF" onChange={(v) => set('glow_color', v)} />
      <label className="editor-label">Upcoming words<select aria-label="Upcoming words" value={style.future_words} onChange={(e) => set('future_words', e.target.value as CaptionStyleValues['future_words'])}><option value="show">Show</option><option value="dim">Dim</option><option value="hide">Hide until spoken</option></select></label>
    </Group>
    <Group title="Shadow & background">
      <Range label="Shadow" value={Math.round(style.shadow_opacity * 100)} min={0} max={100} format={(v) => `${v}%`} onChange={(v, r) => set('shadow_opacity', v / 100, r)} />
      {style.shadow_opacity > 0 && <><Range label="Shadow blur" value={style.shadow_blur} min={0} max={40} onChange={(v, r) => set('shadow_blur', v, r)} /><Range label="Shadow offset" value={style.shadow_offset} min={0} max={30} onChange={(v, r) => set('shadow_offset', v, r)} /></>}
      <OptionalColor label="Background" value={style.line_box_color} fallback="#000000" onChange={(v) => set('line_box_color', v)} />
      {style.line_box_color && <Range label="Background opacity" value={Math.round(style.line_box_opacity * 100)} min={0} max={100} format={(v) => `${v}%`} onChange={(v, r) => set('line_box_opacity', v / 100, r)} />}
    </Group>
    <Group title="Animation">
      <div className="grid grid-cols-2 gap-2">
        <label className="editor-label">In<select aria-label="Entrance animation" value={style.entrance} onChange={(e) => set('entrance', e.target.value as CaptionStyleValues['entrance'])}><option value="pop">Pop</option><option value="fade">Fade</option><option value="none">None</option></select></label>
        <label className="editor-label">Out<select aria-label="Exit animation" value={style.exit} onChange={(e) => set('exit', e.target.value as CaptionStyleValues['exit'])}><option value="none">None</option><option value="fade">Fade</option></select></label>
      </div>
    </Group>
    <Group title="Position">
      <Range label="Horizontal" value={Math.round(style.x * 100)} min={10} max={90} format={(v) => v === 50 ? 'Center' : `${v}%`} onChange={(v, r) => set('x', v / 100, r)} />
      <Range label="Vertical" value={Math.round((captionY ?? .7) * 100)} min={10} max={90} format={(v) => captionY == null ? 'Automatic' : `${v}% from top`} onChange={(v, r) => onCaptionY(v / 100, r)} />
      <div className="flex gap-1 flex-wrap">{([['Top', .2], ['Middle', .5], ['Bottom', .8]] as const).map(([label, y]) => <Button key={label} variant="ghost" size="sm" onClick={() => onCaptionY(y, true)}>{label}</Button>)}
        <Button variant="ghost" size="sm" disabled={captionY == null} onClick={() => onCaptionY(null, true)}>Automatic</Button>
        <Button variant="ghost" size="sm" icon={<RotateCcw size={12} />} disabled={style.x === .5} onClick={() => set('x', .5)}>Center</Button></div>
      <p className="text-2xs text-ink-subtle">You can also drag the captions on the output preview.</p>
    </Group>
  </div>
}
