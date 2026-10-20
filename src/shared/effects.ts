/** Editor effects; mirrors engine/clip_engine/services/effects.py validation. */
import type { CandidateEdit } from './clip-editor'

export interface Look {
  /** Source time, like cuts and captions. */
  start_ms: number
  end_ms: number
  brightness: number
  contrast: number
  saturation: number
  sharpen: number
  vignette: boolean
}
export interface Effects {
  fade_in_ms: number
  fade_out_ms: number
  /** At each cut between kept parts: none, dip to black, or a white flash. */
  transition: 'none' | 'dip' | 'flash'
  transition_ms: number
  looks: Look[]
}
export const NO_EFFECTS: Effects = { fade_in_ms: 0, fade_out_ms: 0, transition: 'none', transition_ms: 300, looks: [] }
export const MAX_LOOKS = 20
const finite = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
const int = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && finite(v, lo, hi)

export function parseEffects(value: unknown, duration: number): Effects {
  if (value === undefined || value === null) return { ...NO_EFFECTS, looks: [] }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid effects')
  const v = value as Record<string, unknown>
  if (Object.keys(v).some((k) => !['fade_in_ms', 'fade_out_ms', 'transition', 'transition_ms', 'looks'].includes(k))) throw new Error('Invalid effects')
  const effects = { ...NO_EFFECTS, ...v } as Record<string, unknown>
  if (!int(effects.fade_in_ms, 0, 3000) || !int(effects.fade_out_ms, 0, 3000) || !['none', 'dip', 'flash'].includes(effects.transition as string) ||
      !int(effects.transition_ms, 100, 1000) || !Array.isArray(effects.looks) || effects.looks.length > MAX_LOOKS) throw new Error('Invalid effects settings')
  const looks = (effects.looks as unknown[]).map((item): Look => {
    const l = item as Record<string, unknown>
    if (!l || typeof l !== 'object' || Object.keys(l).sort().join() !== 'brightness,contrast,end_ms,saturation,sharpen,start_ms,vignette' ||
        !finite(l.start_ms, 0, duration) || !finite(l.end_ms, 0, duration) || l.end_ms - l.start_ms < 100 || !finite(l.brightness, -.3, .3) ||
        !finite(l.contrast, .5, 1.8) || !finite(l.saturation, 0, 2) || !finite(l.sharpen, 0, 2) || typeof l.vignette !== 'boolean') throw new Error('Invalid look')
    return { start_ms: l.start_ms, end_ms: l.end_ms, brightness: l.brightness, contrast: l.contrast, saturation: l.saturation, sharpen: l.sharpen, vignette: l.vignette }
  })
  return { fade_in_ms: effects.fade_in_ms as number, fade_out_ms: effects.fade_out_ms as number, transition: effects.transition as Effects['transition'], transition_ms: effects.transition_ms as number, looks }
}
export function hasEffects(e?: Effects | null): e is Effects {
  return !!e && (e.fade_in_ms > 0 || e.fade_out_ms > 0 || e.transition !== 'none' || e.looks.length > 0)
}

/** Edited-clock position (before speed) of a source time, or null when it was cut. */
export function editedTime(ranges: [number, number][], t: number): number | null {
  let edited = 0
  for (const [a, b] of ranges) {
    if (t >= a && t < b) return edited + t - a
    edited += b - a
  }
  return null
}

/**
 * How the export darkens or whitens the frame at source time `t` (fades and
 * cut transitions), as an overlay color and opacity: a guide for the live
 * preview, matching effects.picture_filters.
 */
export function fadeAt(c: Pick<CandidateEdit, 'ranges' | 'video_speed'>, effects: Effects, t: number): { color: string; opacity: number } | null {
  const edited = editedTime(c.ranges, t)
  if (edited === null) return null
  const total = c.ranges.reduce((n, [a, b]) => n + b - a, 0) / c.video_speed, now = edited / c.video_speed
  if (effects.fade_in_ms && now < Math.min(effects.fade_in_ms, total / 2)) return { color: '#000', opacity: 1 - now / Math.min(effects.fade_in_ms, total / 2) }
  const out = Math.min(effects.fade_out_ms, total / 2)
  if (effects.fade_out_ms && now > total - out) return { color: '#000', opacity: (now - (total - out)) / out }
  if (effects.transition !== 'none') {
    let cut = 0
    for (const [a, b] of c.ranges.slice(0, -1)) {
      cut += (b - a) / c.video_speed
      const d = Math.min(effects.transition_ms / 2, cut, total - cut)
      if (d > 0 && Math.abs(now - cut) < d) return { color: effects.transition === 'flash' ? '#fff' : '#000', opacity: 1 - Math.abs(now - cut) / d }
    }
  }
  return null
}

/** Look in effect at source time `t`, if any (the last one listed wins in the preview). */
export function lookAt(effects: Effects, t: number): Look | null {
  return [...effects.looks].reverse().find((l) => l.start_ms <= t && t < l.end_ms) ?? null
}
