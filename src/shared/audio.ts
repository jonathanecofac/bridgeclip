/**
 * Editor audio settings; mirrors engine/clip_engine/services/audio_mix.py
 * (validation, speech intervals for ducking and the ducking ramps), so the
 * live preview lowers the music where the export does.
 */
import type { CandidateEdit, EditorProject } from './clip-editor'

export interface BackgroundMusic {
  /** editor-music-<id>.mp4 in the editor folder (main imports it). */
  file: string
  /** The imported file's name, for display. */
  name: string
  volume_db: number
  /** Where the music starts, in the track (ms). */
  offset_ms: number
  /** Lower the music while people speak. */
  duck: boolean
  duck_db: number
  fade_in_ms: number
  fade_out_ms: number
}
export interface AudioSettings {
  /** Voice (the video's own sound) level, in dB. */
  volume_db: number
  mute: boolean
  /** Loudness normalization to -14 LUFS, as Automatic clips. */
  normalize: boolean
  music: BackgroundMusic | null
}
export const DEFAULT_AUDIO: AudioSettings = { volume_db: 0, mute: false, normalize: true, music: null }
export const MUSIC_FILE = /^editor-music-[a-f0-9]{32}\.mp4$/
export const SPEECH_GAP_MS = 600
export const DUCK_RAMP_MS = 200
const MAX_SPEECH_INTERVALS = 400
const MAX_MUSIC_MS = 30 * 60 * 1000

const finite = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
const int = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && finite(v, lo, hi)

export function newMusic(file: string, name: string): BackgroundMusic {
  return { file, name: name.slice(0, 200) || 'Music', volume_db: -18, offset_ms: 0, duck: true, duck_db: -12, fade_in_ms: 500, fade_out_ms: 1500 }
}

export function parseAudio(value: unknown): AudioSettings {
  if (value === undefined || value === null) return { ...DEFAULT_AUDIO }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid audio settings')
  const v = value as Record<string, unknown>
  if (Object.keys(v).some((k) => !(k in DEFAULT_AUDIO))) throw new Error('Invalid audio settings')
  const audio = { ...DEFAULT_AUDIO, ...v } as Record<string, unknown>
  if (!finite(audio.volume_db, -20, 12) || typeof audio.mute !== 'boolean' || typeof audio.normalize !== 'boolean') throw new Error('Invalid audio settings')
  let music: BackgroundMusic | null = null
  if (audio.music !== null) {
    const m = audio.music as Record<string, unknown>
    if (!m || typeof m !== 'object' || Array.isArray(m) ||
        Object.keys(m).sort().join() !== 'duck,duck_db,fade_in_ms,fade_out_ms,file,name,offset_ms,volume_db' ||
        typeof m.file !== 'string' || !MUSIC_FILE.test(m.file) || typeof m.name !== 'string' || !m.name || m.name.length > 200 ||
        [...m.name].some((c) => c.charCodeAt(0) < 32) || !finite(m.volume_db, -40, 6) || !int(m.offset_ms, 0, MAX_MUSIC_MS) ||
        typeof m.duck !== 'boolean' || !finite(m.duck_db, -30, 0) || !int(m.fade_in_ms, 0, 5000) || !int(m.fade_out_ms, 0, 5000)) throw new Error('Invalid background music')
    music = { file: m.file, name: m.name, volume_db: m.volume_db, offset_ms: m.offset_ms, duck: m.duck, duck_db: m.duck_db, fade_in_ms: m.fade_in_ms, fade_out_ms: m.fade_out_ms }
  }
  return { volume_db: audio.volume_db as number, mute: audio.mute as boolean, normalize: audio.normalize as boolean, music }
}
export function hasAudio(a?: AudioSettings | null): a is AudioSettings {
  return !!a && (a.volume_db !== 0 || a.mute || !a.normalize || a.music !== null)
}

type Transcript = EditorProject['transcript']
/** Speech on the final clock (ms, after cuts and speed), merged across short pauses, like audio_mix.speech_intervals. */
export function speechIntervals(transcript: Transcript, c: Pick<CandidateEdit, 'ranges' | 'video_speed'>): [number, number][] {
  const words: [number, number][] = []
  for (const row of transcript) {
    if (row.words && row.words.length === row.text.split(/\s+/).filter(Boolean).length) words.push(...row.words)
    else words.push([row.start_ms, row.end_ms])
  }
  const pieces: [number, number][] = []
  let offset = 0
  for (const [keepStart, keepEnd] of c.ranges) {
    for (const [start, end] of words) {
      const lo = Math.max(start, keepStart), hi = Math.min(end, keepEnd)
      if (hi > lo) pieces.push([(offset + lo - keepStart) / c.video_speed, (offset + hi - keepStart) / c.video_speed])
    }
    offset += keepEnd - keepStart
  }
  pieces.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merge = (list: [number, number][], gap: number, extend: boolean): [number, number][] => {
    const out: [number, number][] = []
    for (const [a, b] of list) {
      const last = out.at(-1)
      if (last && a - last[1] < gap) last[1] = extend ? Math.max(last[1], b) : b
      else out.push([a, b])
    }
    return out
  }
  let merged = merge(pieces, SPEECH_GAP_MS, true), gap = SPEECH_GAP_MS
  while (merged.length > MAX_SPEECH_INTERVALS) { gap *= 2; merged = merge(merged, gap, false) }
  // Python's round() rounds halves to even; match it so both sides agree to the millisecond.
  const round = (n: number): number => { const f = Math.floor(n), d = n - f; return d > .5 ? f + 1 : d < .5 ? f : f % 2 === 0 ? f : f + 1 }
  return merged.map(([a, b]) => [round(a), round(b)])
}

/** Music gain from ducking at final time `t` (ms): 1, easing to the duck level around speech. */
export function duckGain(speech: [number, number][], duckDb: number, t: number): number {
  let r = 0
  for (const [a, b] of speech) r += Math.max(0, Math.min(1, (t - (a - DUCK_RAMP_MS)) / DUCK_RAMP_MS, ((b + DUCK_RAMP_MS) - t) / DUCK_RAMP_MS))
  return 1 - (1 - 10 ** (duckDb / 20)) * Math.min(1, r)
}

export const dbToGain = (db: number): number => 10 ** (db / 20)

/** Music level (linear) at final time `t` of a clip `total` ms long: volume, ducking and its fades. */
export function musicGainAt(music: BackgroundMusic, speech: [number, number][], t: number, total: number): number {
  let gain = dbToGain(music.volume_db) * (music.duck ? duckGain(speech, music.duck_db, t) : 1)
  const fadeIn = Math.min(music.fade_in_ms, total / 2), fadeOut = Math.min(music.fade_out_ms, total / 2)
  if (fadeIn > 0 && t < fadeIn) gain *= Math.max(0, t / fadeIn)
  if (fadeOut > 0 && t > total - fadeOut) gain *= Math.max(0, (total - t) / fadeOut)
  return gain
}

/** Position in the music file (seconds) at final time `t` (ms): the offset, then looping from the start. */
export function musicPosition(music: BackgroundMusic, musicMs: number, t: number): number {
  if (!(musicMs > 0)) return 0
  const offset = music.offset_ms % musicMs
  const at = offset + t
  return (at < musicMs ? at : (at - musicMs) % musicMs) / 1000
}
