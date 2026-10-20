import { useRef, type RefObject } from 'react'
import type { TextOverlay } from '../../shared/text-overlays'
import { useMonitorBounds } from '../lib/monitor-bounds'
import { cn } from '../lib/utils'
import { FONT_CSS } from './EditorCaptionPreview'

const alpha = (hex: string, opacity: number): string => `${hex}${Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, '0')}`
const stroke = (width: number, color: string): string => {
  if (width <= 0) return 'none'
  const layers: string[] = []
  for (let a = 0; a < 16; a++) { const r = a / 16 * Math.PI * 2; layers.push(`${(Math.cos(r) * width).toFixed(2)}px ${(Math.sin(r) * width).toFixed(2)}px 0 ${color}`) }
  return layers.join(', ')
}

/**
 * Text overlays on screen at the playhead, over the output monitor, as the
 * export draws them (text_overlays.py): font, size, colors, outline and plate.
 * Drag one to move it; click to select it in the Text tab.
 */
export function TextOverlayPreview({ canvas, landscape, overlays, time, selected, disabled, onSelect, onMove, onDrag }: {
  canvas: RefObject<HTMLCanvasElement | null>; landscape: boolean; overlays: TextOverlay[]; time: number; selected: number | null; disabled: boolean
  onSelect: (index: number) => void; onMove: (index: number, x: number, y: number, remember: boolean) => void; onDrag: (active: boolean) => void
}): React.JSX.Element | null {
  const bounds = useMonitorBounds(canvas, landscape)
  const drag = useRef<{ index: number; pointer: number; startX: number; startY: number; x: number; y: number; moved: boolean } | null>(null)
  const visible = overlays.map((overlay, index) => ({ overlay, index })).filter(({ overlay }) => overlay.start_ms <= time && time < overlay.end_ms)
  if (!bounds.width || !visible.length) return null
  // Sizes are output pixels of a 1080-wide vertical (or 1920-wide landscape) frame.
  const scale = bounds.width / (landscape ? 1920 : 1080)
  return <div className="editor-caption-overlay" style={bounds}>
    {visible.map(({ overlay, index }) => {
      const font = FONT_CSS[overlay.font], size = overlay.size * scale
      const lines = overlay.text.split('\n').map((line) => line.split(/\s+/).filter(Boolean).join(' ')).filter(Boolean)
      return <button key={index} type="button" aria-label={`Text overlay: ${overlay.text}`} disabled={disabled}
        className={cn('editor-text-overlay', selected === index && 'selected')}
        style={{ left: `${overlay.x * 100}%`, top: `${overlay.y * 100}%`, fontFamily: font.family, fontWeight: font.weight, fontStyle: font.italic ? 'italic' : 'normal',
          fontSize: size, color: overlay.color, textTransform: overlay.uppercase ? 'uppercase' : 'none', textShadow: stroke(overlay.outline * scale, overlay.outline_color) }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault(); e.stopPropagation(); onSelect(index)
          drag.current = { index, pointer: e.pointerId, startX: e.clientX, startY: e.clientY, x: overlay.x, y: overlay.y, moved: false }
          e.currentTarget.setPointerCapture(e.pointerId); onDrag(true)
        }}
        onPointerMove={(e) => {
          const state = drag.current
          if (!state || e.pointerId !== state.pointer) return
          const dx = e.clientX - state.startX, dy = e.clientY - state.startY
          if (!state.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
          const round = (n: number): number => Math.round(Math.max(.05, Math.min(.95, n)) * 1000) / 1000
          onMove(state.index, round(state.x + dx / bounds.width), round(state.y + dy / bounds.height), !state.moved)
          state.moved = true
        }}
        onLostPointerCapture={() => { drag.current = null; onDrag(false) }}
        onKeyDown={(e) => {
          if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
          e.preventDefault(); e.stopPropagation()
          const step = e.shiftKey ? .05 : .01, round = (n: number): number => Math.round(Math.max(.05, Math.min(.95, n)) * 1000) / 1000
          onMove(index, round(overlay.x + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0)),
            round(overlay.y + (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0)), true)
        }}>
        {/* One plate per line, like the export's opaque boxes (text_overlays.plate_padding). */}
        {lines.map((line, i) => <span key={i} style={overlay.background ? { background: alpha(overlay.background, overlay.background_opacity), padding: Math.max(6, Math.round(overlay.size * .22)) * scale } : undefined}>{line}</span>)}
      </button>
    })}
  </div>
}
