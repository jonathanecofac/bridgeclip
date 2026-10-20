/** Editor text overlays and hooks; mirrors engine/clip_engine/services/text_overlays.py validation. */
import { CAPTION_FONTS, type CaptionFont } from './caption-style'

export interface TextOverlay {
  text: string
  /** Source time, like cuts and captions. */
  start_ms: number
  end_ms: number
  /** Center of the text, as fractions of the output frame. */
  x: number
  y: number
  /** Font size in output pixels (1080-wide vertical frame). */
  size: number
  font: CaptionFont
  color: string
  outline_color: string
  outline: number
  /** Plate behind the text, or null for none. */
  background: string | null
  background_opacity: number
  uppercase: boolean
  animation: 'none' | 'fade' | 'pop'
}
export const MAX_TEXT_OVERLAYS = 20
const HEX = /^#[0-9A-Fa-f]{6}$/
const finite = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi

export function parseTextOverlays(value: unknown, duration: number): TextOverlay[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_TEXT_OVERLAYS) throw new Error('Invalid text overlays')
  return value.map((item): TextOverlay => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid text overlay')
    const v = item as Record<string, unknown>
    const text = v.text
    if (typeof text !== 'string' || !text.trim() || text.length > 200 || text.split('\n').length > 4 || [...text].some((c) => c.charCodeAt(0) < 32 && c !== '\n')) throw new Error('Invalid text overlay text')
    const ok = finite(v.start_ms, 0, duration) && finite(v.end_ms, 0, duration) && v.end_ms - v.start_ms >= 100 &&
      finite(v.x, .05, .95) && finite(v.y, .05, .95) && Number.isInteger(v.size) && finite(v.size, 20, 240) &&
      (CAPTION_FONTS as readonly unknown[]).includes(v.font) && typeof v.color === 'string' && HEX.test(v.color) &&
      typeof v.outline_color === 'string' && HEX.test(v.outline_color) && Number.isInteger(v.outline) && finite(v.outline, 0, 20) &&
      (v.background === null || (typeof v.background === 'string' && HEX.test(v.background))) && finite(v.background_opacity, 0, 1) &&
      typeof v.uppercase === 'boolean' && ['none', 'fade', 'pop'].includes(v.animation as string)
    if (!ok) throw new Error('Invalid text overlay settings')
    return { text, start_ms: v.start_ms as number, end_ms: v.end_ms as number, x: v.x as number, y: v.y as number, size: v.size as number,
      font: v.font as CaptionFont, color: v.color as string, outline_color: v.outline_color as string, outline: v.outline as number,
      background: v.background as string | null, background_opacity: v.background_opacity as number, uppercase: v.uppercase as boolean,
      animation: v.animation as TextOverlay['animation'] }
  })
}

/** A plain title-style text at the playhead. */
export function newTextOverlay(start: number, duration: number): TextOverlay {
  return { text: 'Your text', start_ms: Math.round(start), end_ms: Math.round(Math.min(duration, start + 3000)), x: .5, y: .45, size: 72,
    font: 'Montserrat Black', color: '#FFFFFF', outline_color: '#000000', outline: 6, background: null, background_opacity: .7,
    uppercase: true, animation: 'fade' }
}
/** A hook: big text on a bright plate for the first seconds of the clip. */
export function newHook(text: string, clipStart: number, duration: number): TextOverlay {
  return { text: text.slice(0, 120) || 'Wait for it…', start_ms: Math.round(clipStart), end_ms: Math.round(Math.min(duration, clipStart + 3000)),
    x: .5, y: .18, size: 84, font: 'Montserrat Black', color: '#111111', outline_color: '#000000', outline: 0, background: '#FFE234',
    background_opacity: 1, uppercase: true, animation: 'pop' }
}
