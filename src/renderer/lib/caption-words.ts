import type { CandidateEdit, EditorProject } from '../../shared/clip-editor'

/** One caption line as the export will use it, in source time. */
export interface CaptionLine {
  /** Transcript line index, or null for a caption added by hand. */
  segment: number | null
  /** Index in caption_inserts for added captions. */
  insert?: number
  start: number
  end: number
  text: string
  edited: boolean
  /** Each word's [start, end], as the export will time it. */
  words: [number, number][]
}

const spread = (count: number, start: number, end: number): [number, number][] => {
  const span = Math.max(1, end - start)
  return Array.from({ length: count }, (_, i) => [Math.round(start + i * span / count), Math.round(start + (i + 1) * span / count)])
}

/** Transcript lines with this clip's corrections, retiming and added captions (manual_editor.caption_transcript). */
export function captionLines(project: EditorProject, candidate: CandidateEdit): CaptionLine[] {
  const edits = new Map(candidate.caption_edits.map((e) => [e.segment, e]))
  const lines: CaptionLine[] = []
  project.transcript.forEach((row, segment) => {
    const edit = edits.get(segment)
    const tokens = (edit?.text ?? row.text).split(/\s+/).filter(Boolean)
    if (!tokens.length) return
    // Same rules as manual_editor.caption_transcript.
    const start = row.words?.[0]?.[0] ?? row.start_ms, end = row.words?.[row.words.length - 1]?.[1] ?? row.end_ms
    let words = row.words && row.words.length === tokens.length ? row.words.map((w) => [...w] as [number, number]) : spread(tokens.length, start, end)
    if (edit?.start_ms !== undefined && edit.end_ms !== undefined) {
      const a = edit.start_ms, b = edit.end_ms, scale = (b - a) / Math.max(1, end - start)
      const at = (t: number): number => Math.max(a, Math.min(b, Math.round(a + (t - start) * scale)))
      words = words.map(([ws, we]) => [at(ws), Math.max(at(ws) + 1, at(we))])
    }
    lines.push({ segment, start: edit?.start_ms ?? row.start_ms, end: edit?.end_ms ?? row.end_ms, text: tokens.join(' '), edited: !!edit, words })
  })
  ;(candidate.caption_inserts ?? []).forEach((item, insert) => {
    const tokens = item.text.split(/\s+/).filter(Boolean)
    if (tokens.length) lines.push({ segment: null, insert, start: item.start_ms, end: item.end_ms, text: tokens.join(' '), edited: true, words: spread(tokens.length, item.start_ms, item.end_ms) })
  })
  return lines.sort((a, b) => a.start - b.start)
}

export interface CaptionWord { text: string; start: number; end: number }
const SENTENCE_END = /[.!?…]$/

/**
 * The words on screen at `time` and which one is spoken, grouped like the
 * engine (max words, sentence ends, commas), from the words' own timing when
 * the transcript has it. A live guide: "Exact preview" renders the real frame.
 */
export function captionWordsAt(lines: CaptionLine[], cuts: [number, number][], maxWords: number, time: number):
    { words: CaptionWord[]; active: number; progress: number } | null {
  if (!cuts.some(([a, b]) => a <= time && time < b)) return null
  const inCut = (w: CaptionWord): boolean => cuts.some(([a, b]) => w.end > a && w.start < b)
  const words: CaptionWord[] = []
  for (const line of lines) {
    if (line.end <= cuts[0][0] - 60000 || line.start >= cuts[cuts.length - 1][1] + 60000) continue
    line.text.split(' ').forEach((text, i) => words.push({ text, start: line.words[i][0], end: line.words[i][1] }))
  }
  // Like the engine: words in line order (lines sorted by start), not re-sorted across lines.
  const kept = words.filter(inCut)
  const groups: CaptionWord[][] = []
  let current: CaptionWord[] = []
  for (const word of kept) {
    current.push(word)
    if (current.length >= maxWords || SENTENCE_END.test(word.text) || (word.text.endsWith(',') && current.length >= 2)) { groups.push(current); current = [] }
  }
  if (current.length) groups.push(current)
  const LINGER = 700
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g], next = groups[g + 1]
    // A group ends when the next one starts; one cut short by an overlapping line is never shown.
    const end = Math.min(next ? next[0].start : Infinity, group[group.length - 1].end + LINGER)
    if (time < group[0].start || time >= end) continue
    let active = group.findIndex((w, i) => time < (group[i + 1]?.start ?? end))
    if (active < 0) active = group.length - 1
    const word = group[active]
    return { words: group, active, progress: Math.max(0, Math.min(1, (time - word.start) / Math.max(1, word.end - word.start))) }
  }
  return null
}
