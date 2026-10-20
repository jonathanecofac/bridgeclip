/**
 * Editor caption styling: per-clip overrides on top of a preset, mirroring
 * CAPTION_OVERRIDE_FIELDS and caption_style_for in engine/clip_engine/config.py.
 * Preset values come from caption-style-presets.json, generated from the
 * engine (scripts/export_caption_presets.py) and checked by an engine test.
 */
import table from './caption-style-presets.json'

export const CAPTION_FONTS = ['Montserrat Black', 'Montserrat ExtraBold', 'Poppins Black', 'Poppins ExtraBold',
  'Anton', 'Archivo Black', 'Instrument Serif Italic'] as const
export type CaptionFont = typeof CAPTION_FONTS[number]

export interface CaptionStyleValues {
  font_name: CaptionFont
  font_size: number
  uppercase: boolean
  letter_spacing: number
  /** Words shown together; 1 is word by word. */
  max_words_per_line: number
  word_by_word_highlight: boolean
  primary_color: string
  highlight_color: string
  outline_color: string
  outline_width: number
  shadow_opacity: number
  shadow_blur: number
  shadow_offset: number
  future_words: 'show' | 'dim' | 'hide'
  karaoke_fill: boolean
  entrance: 'pop' | 'fade' | 'none'
  exit: 'fade' | 'none'
  highlight_box_color: string | null
  glow_color: string | null
  /** Background plate behind the whole caption. */
  line_box_color: string | null
  line_box_opacity: number
  emphasis_color: string | null
  /** Horizontal center, as a fraction of output width. */
  x: number
}
export type CaptionStyleOverrides = Partial<CaptionStyleValues>

type Spec = readonly ['int' | 'float', number, number] | readonly ['bool'] | readonly ['color'] | readonly ['color?'] | readonly ['choice', readonly string[]]
export const CAPTION_STYLE_FIELDS: Record<keyof CaptionStyleValues, Spec> = {
  font_name: ['choice', CAPTION_FONTS],
  font_size: ['int', 30, 220],
  uppercase: ['bool'],
  letter_spacing: ['int', -5, 20],
  max_words_per_line: ['int', 1, 8],
  word_by_word_highlight: ['bool'],
  primary_color: ['color'],
  highlight_color: ['color'],
  outline_color: ['color'],
  outline_width: ['int', 0, 20],
  shadow_opacity: ['float', 0, 1],
  shadow_blur: ['int', 0, 40],
  shadow_offset: ['int', 0, 30],
  future_words: ['choice', ['show', 'dim', 'hide']],
  karaoke_fill: ['bool'],
  entrance: ['choice', ['pop', 'fade', 'none']],
  exit: ['choice', ['fade', 'none']],
  highlight_box_color: ['color?'],
  glow_color: ['color?'],
  line_box_color: ['color?'],
  line_box_opacity: ['float', 0, 1],
  emphasis_color: ['color?'],
  x: ['float', .1, .9]
}

const HEX = /^#[0-9A-Fa-f]{6}$/
function valid(spec: Spec, value: unknown): boolean {
  switch (spec[0]) {
    case 'bool': return typeof value === 'boolean'
    case 'int': return Number.isInteger(value) && (value as number) >= spec[1] && (value as number) <= spec[2]
    case 'float': return typeof value === 'number' && Number.isFinite(value) && value >= spec[1] && value <= spec[2]
    case 'color': return typeof value === 'string' && HEX.test(value)
    case 'color?': return value === null || (typeof value === 'string' && HEX.test(value))
    case 'choice': return typeof value === 'string' && spec[1].includes(value)
  }
}

/** Validated overrides; throws on unknown fields or out-of-range values, like the engine. */
export function parseCaptionStyle(value: unknown): CaptionStyleOverrides {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid caption style')
  const clean: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const spec = (CAPTION_STYLE_FIELDS as Record<string, Spec | undefined>)[key]
    if (!spec || !valid(spec, item)) throw new Error(`Invalid caption style value for ${key}`)
    clean[key] = item
  }
  return clean as CaptionStyleOverrides
}

export interface CaptionPresetValues { id: string; name: string; description: string; values: CaptionStyleValues }
export const CAPTION_STYLE_PRESETS = table.presets as CaptionPresetValues[]
/** The six editor templates, shown first in the editor. */
export const EDITOR_TEMPLATE_IDS = ['viral_bold', 'hormozi', 'karaoke', 'minimal_clean', 'gaming', 'cinematic'] as const

export function presetValues(id: string): CaptionStyleValues {
  return (CAPTION_STYLE_PRESETS.find((p) => p.id === id) ?? CAPTION_STYLE_PRESETS.find((p) => p.id === 'pop')!).values
}
/** What the export draws: the preset with the clip's overrides applied. */
export function effectiveCaptionStyle(presetId: string, overrides?: CaptionStyleOverrides | null): CaptionStyleValues {
  return { ...presetValues(presetId), ...(overrides ?? {}) }
}
/** Overrides that differ from the preset, so presets stay small and readable. */
export function minimalOverrides(presetId: string, style: CaptionStyleValues): CaptionStyleOverrides {
  const base = presetValues(presetId)
  return Object.fromEntries(Object.entries(style).filter(([key, value]) => base[key as keyof CaptionStyleValues] !== value)) as CaptionStyleOverrides
}

/** A saved caption look: a base preset plus overrides. */
export interface UserCaptionPreset { id: string; name: string; base: string; style: CaptionStyleOverrides }
export const USER_PRESET_LIMIT = 100
export function parseUserCaptionPreset(value: unknown, knownPresets: readonly string[]): UserCaptionPreset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid caption preset')
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !/^[a-f0-9]{32}$/.test(v.id)) throw new Error('Invalid caption preset id')
  const name = typeof v.name === 'string' ? v.name.trim().slice(0, 60) : ''
  if (!name || [...name].some((c) => c.charCodeAt(0) < 32)) throw new Error('Name the caption preset')
  if (typeof v.base !== 'string' || !knownPresets.includes(v.base)) throw new Error('Invalid base caption preset')
  return { id: v.id, name, base: v.base, style: parseCaptionStyle(v.style) }
}
