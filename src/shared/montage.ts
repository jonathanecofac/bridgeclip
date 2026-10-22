/**
 * AI Video Editor — Auto Montage: a permanent library of rushes (copied into
 * the Library folder and analyzed once) and montage jobs that plan, assemble
 * and optionally export edits made from them. Shared types and options.
 */

export type RushStatus = 'queued' | 'analyzing' | 'ready' | 'failed'
/** What the engine's analysis says about a rush (analysis/<id>.summary.json). */
export interface RushSummary {
  duration_ms: number; width: number; height: number; fps: number; has_audio: boolean
  scenes: number; segments: number; speech: boolean
  category: string | null; description: string; tags: string[]
  /** Another rush with the same footage; this one is left out of montages. */
  duplicate_of: string | null; similarity: number
  notes: string[]
  /** File in thumbs/<id>/. */
  thumbnail: string | null
  vision_cost_usd: number | null
}
export interface Rush {
  id: string
  /** The imported file's name. */
  name: string
  ext: string
  size: number
  sha256: string
  importedAt: string
  status: RushStatus
  error?: string
  summary?: RushSummary
  /** Absolute paths for display, filled in by main. */
  mediaPath?: string
  thumbnailPath?: string | null
}

export const MONTAGE_STYLES = [
  { id: 'viral', name: 'Viral TikTok', description: 'Fast pace, bold captions, punch-in zooms, flashes at cuts.' },
  { id: 'gaming', name: 'Gaming', description: 'Spectacular action, punchy colors, flash cuts and zooms.' },
  { id: 'cinematic', name: 'Cinematic', description: 'Soft dips between shots, graded look with vignette, gentle fades.' },
  { id: 'vlog', name: 'Vlog', description: 'Natural storytelling with clean cuts and light fades.' },
  { id: 'podcast', name: 'Podcast', description: 'Follows the speakers, splits the frame for two people, big captions.' },
  { id: 'compilation', name: 'Compilation', description: 'Best moments back to back, with short dips between them.' },
  { id: 'minimal', name: 'Minimal', description: 'Sober edit with discreet captions and no effects.' }
] as const
export type MontageStyle = typeof MONTAGE_STYLES[number]['id']
export const MONTAGE_DURATIONS = [15, 30, 45, 60, 90] as const
/** Long videos, in seconds: 3 to 30 minutes. */
export const LONG_DURATIONS = [180, 300, 600, 900, 1200, 1800] as const
export const MAX_LONG_VIDEOS = 5

export interface MontageRequest {
  /** Short clips for social networks, or long videos (vlog, compilation, report…). */
  mode: 'short' | 'long'
  instruction: string
  count: number
  /** Seconds per video; null lets the AI choose (20 to 90 s). */
  duration_s: number | null
  aspect: '9:16' | '16:9'
  style: MontageStyle
  /** Rushes to use; empty uses every analyzed rush. */
  rush_ids: string[]
  captions: boolean
  smart_framing: boolean
  hook: boolean
  beat_sync: boolean
  /** Export every video to the Library as soon as it is assembled. */
  auto_export: boolean
  /** Long videos: a story only when the rushes support one, else a thematic compilation ('auto' decides). */
  structure: 'auto' | 'story' | 'compilation'
  /** Long videos: chapter titles on screen (the chapter list is always made). */
  chapters: boolean
  /** Long videos: a teaser and opening title, and a closing line, when the content calls for them. */
  intro_outro: boolean
  /** Long videos: cut silences inside dialogue. */
  cut_silences: boolean
}
export const DEFAULT_MONTAGE_REQUEST: MontageRequest = {
  mode: 'short', instruction: '', count: 3, duration_s: 30, aspect: '9:16', style: 'viral', rush_ids: [],
  captions: true, smart_framing: true, hook: true, beat_sync: true, auto_export: false,
  structure: 'auto', chapters: true, intro_outro: true, cut_silences: true
}
export const DEFAULT_LONG_REQUEST: Partial<MontageRequest> = { mode: 'long', count: 1, duration_s: 600, aspect: '16:9', style: 'vlog' }
export const DEFAULT_SHORT_REQUEST: Partial<MontageRequest> = { mode: 'short', count: 3, duration_s: 30, aspect: '9:16', style: 'viral' }

export type MontageJobStatus = 'queued' | 'running' | 'exporting' | 'done' | 'failed' | 'cancelled'
export interface MontageJob {
  id: string
  createdAt: string
  request: MontageRequest
  /** Music copied into the rush library, if any; its display name. */
  music: { file: string; name: string } | null
  status: MontageJobStatus
  progress?: { phase: string; percent: number }
  /** Run folder in the Library (an editor project once assembled). */
  runDir: string
  error?: string
  summary?: { planner: 'ai' | 'heuristic'; notes: string[]; videos: number; rushes: number; seconds: number; cost_usd: number | null
    mode?: 'short' | 'long'
    /** Long videos: each video's chapters on the final clock, for a YouTube description. */
    chapters?: { video: number; title: string; description: string; structure: 'story' | 'compilation'; duration_ms: number; chapters: { title: string; start_ms: number }[] }[] }
  exported?: number
  finishedAt?: string
}

export interface MontageTemplate { id: string; name: string; request: Omit<MontageRequest, 'rush_ids'> }

export interface MontageState {
  rushes: Rush[]
  jobs: MontageJob[]
  importing: { done: number; total: number; current: string; skipped: number } | null
  /** Analysis progress of rushes being analyzed now. */
  analyzing: Record<string, { phase: string; percent: number }>
  templates: MontageTemplate[]
  libraryDir: string
}

export const RUSH_EXTENSIONS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'flv'] as const
export const MUSIC_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'mp4'] as const
export const MAX_RUSHES = 5000

const finite = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi

/** A validated montage request (mirrors planner.validate_request in the engine). */
export function parseMontageRequest(value: unknown): MontageRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid montage settings')
  const v = { ...DEFAULT_MONTAGE_REQUEST, ...(value as Record<string, unknown>) } as Record<string, unknown>
  const bools = ['captions', 'smart_framing', 'hook', 'beat_sync', 'auto_export', 'chapters', 'intro_outro', 'cut_silences'] as const
  const long = v.mode === 'long'
  if ((v.mode !== 'short' && !long) || !['auto', 'story', 'compilation'].includes(v.structure as string) || typeof v.instruction !== 'string' || v.instruction.length > 2000 ||
      [...v.instruction].some((c) => c.charCodeAt(0) < 32 && c !== '\n' && c !== '\t') ||
      !Number.isInteger(v.count) || !finite(v.count, 1, long ? MAX_LONG_VIDEOS : 50) ||
      !(v.duration_s === null || (Number.isInteger(v.duration_s) && (long ? finite(v.duration_s, 60, 3600) : finite(v.duration_s, 5, 180)))) ||
      !['9:16', '16:9'].includes(v.aspect as string) || !MONTAGE_STYLES.some((s) => s.id === v.style) ||
      !Array.isArray(v.rush_ids) || v.rush_ids.length > MAX_RUSHES || v.rush_ids.some((id) => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) ||
      bools.some((k) => typeof v[k] !== 'boolean')) throw new Error('Invalid montage settings')
  return { mode: long ? 'long' : 'short', structure: v.structure as MontageRequest['structure'], chapters: v.chapters as boolean,
    intro_outro: v.intro_outro as boolean, cut_silences: v.cut_silences as boolean, instruction: (v.instruction as string).trim(), count: v.count as number, duration_s: v.duration_s as number | null,
    aspect: v.aspect as MontageRequest['aspect'], style: v.style as MontageStyle, rush_ids: [...new Set(v.rush_ids as string[])],
    captions: v.captions as boolean, smart_framing: v.smart_framing as boolean, hook: v.hook as boolean, beat_sync: v.beat_sync as boolean,
    auto_export: v.auto_export as boolean }
}

export const styleName = (id: string): string => MONTAGE_STYLES.find((s) => s.id === id)?.name ?? id
export const ANALYSIS_PHASES: Record<string, string> = {
  probe: 'Reading', scenes: 'Finding shots', audio: 'Measuring sound', frames: 'Keyframes', transcript: 'Transcribing',
  vision: 'AI vision', segments: 'Scoring moments', done: 'Done'
}
export const MONTAGE_PHASES: Record<string, string> = {
  plan: 'Planning the edit', music: 'Reading the music', pieces: 'Cutting the rushes', concat: 'Assembling', preview: 'Preparing the editor',
  framing: 'Framing', save: 'Saving', done: 'Done', export: 'Exporting'
}

/** "1:05:03" or "4:07" for a chapter start. */
export function chapterTime(ms: number): string {
  const total = Math.floor(ms / 1000), h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, sec = total % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}
type LongVideo = NonNullable<NonNullable<MontageJob['summary']>['chapters']>[number]
/** A long video's description followed by its chapters, ready to paste on YouTube. */
export function youtubeDescription(video: LongVideo): string {
  return [video.description, '', youtubeChapters(video.chapters)].join('\n').trim()
}
/** Chapters as YouTube reads them in a description: one "0:00 Title" per line, starting at 0:00. */
export function youtubeChapters(marks: { title: string; start_ms: number }[]): string {
  return marks.map((m) => `${chapterTime(m.start_ms)} ${m.title}`).join('\n')
}
