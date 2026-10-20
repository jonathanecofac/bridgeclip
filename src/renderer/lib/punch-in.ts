import { framingAt, type CandidateEdit, type Crop, type EditorScene } from '../../shared/clip-editor'

/**
 * A punch-in: a smooth zoom on the current framing at `at`, back out at
 * `at + length`, as two layout changes the editor and export already render.
 * Returns null when it cannot be added (whole-frame layout, no room).
 */
export function punchInScenes(c: CandidateEdit, at: number, length: number, zoom: number): EditorScene[] | null {
  const clipEnd = c.ranges[c.ranges.length - 1][1]
  const next = c.scenes.find((s) => s.at_ms > at)?.at_ms ?? clipEnd
  const end = Math.round(Math.min(at + length, next - 1, clipEnd - 1))
  const current = framingAt(c, at)
  if (current.layout === 'fit' || end - at < 300 || c.scenes.length > 58 || c.scenes.some((s) => Math.abs(s.at_ms - at) < 1)) return null
  const zoomed = current.crops.map(([x, y, w, h]): Crop => {
    const nw = w / zoom, nh = h / zoom
    return [Math.max(0, Math.min(1 - nw, x + (w - nw) / 2)), Math.max(0, Math.min(1 - nh, y + (h - nh) / 2)), nw, nh]
  })
  const ease = Math.max(100, Math.min(250, Math.floor((end - at) / 3 / 100) * 100))
  return [...c.scenes,
    { at_ms: Math.round(at), layout: current.layout, crops: zoomed, transition_ms: ease },
    { at_ms: end, layout: current.layout, crops: current.crops.map((crop) => [...crop] as Crop), transition_ms: ease }
  ].sort((a, b) => a.at_ms - b.at_ms)
}
