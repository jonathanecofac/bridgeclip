import { canAnimateScene, type CandidateEdit } from '../../shared/clip-editor'
import type { Effects, Look } from '../../shared/effects'
import { punchInScenes } from './punch-in'

/** A one-click editing style: captions, effects and framing for the whole clip. Undo restores the previous edit. */
export interface EditPreset { id: 'clean' | 'viral' | 'cinematic'; name: string; description: string }
export const EDIT_PRESETS: EditPreset[] = [
  { id: 'clean', name: 'Clean Edit', description: 'Sober: discreet captions, a light polish, no zooms or flashes.' },
  { id: 'viral', name: 'Viral Edit', description: 'Bold captions, punch-in zooms, a slightly faster pace and quick flashes at cuts.' },
  { id: 'cinematic', name: 'Cinematic Edit', description: 'Elegant captions, a graded look with vignette, slow fades and smooth framing.' }
]

const wholeClip = (c: CandidateEdit, look: Omit<Look, 'start_ms' | 'end_ms'>): Look =>
  ({ start_ms: c.ranges[0][0], end_ms: c.ranges[c.ranges.length - 1][1], ...look })

export function applyEditPreset(c: CandidateEdit, id: EditPreset['id']): Partial<CandidateEdit> {
  if (id === 'clean') {
    const effects: Effects = { fade_in_ms: 200, fade_out_ms: 300, transition: 'none', transition_ms: 300,
      looks: [wholeClip(c, { brightness: 0, contrast: 1.05, saturation: 1.05, sharpen: .3, vignette: false })] }
    return { captions: true, caption_preset: 'minimal_clean', caption_style: {}, effects }
  }
  if (id === 'viral') {
    const effects: Effects = { fade_in_ms: 0, fade_out_ms: 200, transition: 'flash', transition_ms: 200,
      looks: [wholeClip(c, { brightness: .02, contrast: 1.12, saturation: 1.25, sharpen: .5, vignette: false })] }
    // A short punch-in every few seconds of kept footage.
    let edit: CandidateEdit = { ...c }
    for (const [a, b] of c.ranges) {
      for (let at = a + 1000; at + 1200 < b; at += 4500) {
        const scenes = punchInScenes(edit, at, 1200, 1.25)
        if (scenes) edit = { ...edit, scenes }
      }
    }
    return { captions: true, caption_preset: 'hormozi', caption_style: {}, effects, scenes: edit.scenes, video_speed: Math.max(c.video_speed, 1.1) }
  }
  const effects: Effects = { fade_in_ms: 600, fade_out_ms: 800, transition: 'dip', transition_ms: 500,
    looks: [wholeClip(c, { brightness: -.03, contrast: 1.15, saturation: .85, sharpen: .2, vignette: true })] }
  // Ease every framing change that can move smoothly.
  const scenes = c.scenes.map((s, i) => canAnimateScene(c.scenes, i) && !s.transition_ms ? { ...s, transition_ms: 600 } : s)
  return { captions: true, caption_preset: 'cinematic', caption_style: {}, effects, scenes }
}
