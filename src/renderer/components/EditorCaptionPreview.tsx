import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { CandidateEdit, EditorProject } from '../../shared/clip-editor'
import { effectiveCaptionStyle, type CaptionStyleValues } from '../../shared/caption-style'
import { captionAnchor } from '../lib/caption-preview'
import { captionLines, captionWordsAt } from '../lib/caption-words'

/** CSS faces for the engine's caption fonts (bundled in globals.css). */
export const FONT_CSS: Record<CaptionStyleValues['font_name'], { family: string; weight: number; italic?: boolean }> = {
  'Montserrat Black': { family: '"Montserrat", sans-serif', weight: 900 },
  'Montserrat ExtraBold': { family: '"Montserrat", sans-serif', weight: 800 },
  'Poppins Black': { family: '"Poppins", sans-serif', weight: 900 },
  'Poppins ExtraBold': { family: '"Poppins", sans-serif', weight: 800 },
  Anton: { family: '"Anton", "Impact", sans-serif', weight: 400 },
  'Archivo Black': { family: '"Archivo Black", sans-serif', weight: 400 },
  'Instrument Serif Italic': { family: '"Instrument Serif", serif', weight: 400, italic: true }
}

/** Stroke as ring text-shadows plus the style's drop shadow, scaled to the monitor. */
function shadows(style: CaptionStyleValues, scale: number): string {
  const layers: string[] = []
  const w = style.outline_width * scale
  if (w > 0) for (let a = 0; a < 16; a++) {
    const r = a / 16 * Math.PI * 2
    layers.push(`${(Math.cos(r) * w).toFixed(2)}px ${(Math.sin(r) * w).toFixed(2)}px 0 ${style.outline_color}`)
  }
  if (style.shadow_opacity > 0) layers.push(`0 ${(style.shadow_offset * scale).toFixed(2)}px ${(style.shadow_blur * scale).toFixed(2)}px rgb(0 0 0 / ${style.shadow_opacity})`)
  return layers.join(', ') || 'none'
}
const alpha = (hex: string, opacity: number): string => `${hex}${Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, '0')}`

/**
 * Live captions over the output monitor: the words on screen at the playhead in
 * the clip's style. Drag to place them (up/down, left/right). Browser text
 * differs slightly from libass, so "Exact preview" renders the real frame.
 */
/** The title card's lines, as rendering_service._build_title_card splits them. */
function titleLines(title: string): string[] {
  let words = title.split(/\s+/).filter(Boolean).join(' ').slice(0, 120).split(' ').filter(Boolean)
  if (!words.length) return []
  if (words.length < 2) words = [words[0], words[0]]
  words = words.slice(0, 7)
  if (words.length <= 3) return [words.join(' ')]
  const mid = Math.ceil(words.length / 2)
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')]
}

export function EditorCaptionPreview({ canvas, project, candidate, time, disabled, guide, onMove, onMoveX, onDrag }: {
  canvas: RefObject<HTMLCanvasElement | null>; project: EditorProject; candidate: CandidateEdit; time: number
  disabled: boolean
  /** Show a placeholder when nothing is spoken, so captions can still be placed. */
  guide: boolean
  onMove: (y: number, remember: boolean) => void; onMoveX: (x: number, remember: boolean) => void; onDrag: (active: boolean) => void
}): React.JSX.Element | null {
  const [bounds, setBounds] = useState({ width: 0, height: 0, left: 0, top: 0 })
  const drag = useRef<{ pointer: number; startX: number; startY: number; x: number; y: number; changed: boolean } | null>(null)
  useEffect(() => {
    const element = canvas.current, parent = element?.parentElement
    if (!element || !parent) return
    const measure = (): void => {
      const box = element.getBoundingClientRect(), outer = parent.getBoundingClientRect()
      const aspect = element.width / element.height
      const width = Math.min(box.width, box.height * aspect), height = width / aspect
      setBounds({ width, height, left: box.left - outer.left + (box.width - width) / 2, top: box.top - outer.top + (box.height - height) / 2 })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element); observer.observe(parent); measure()
    return () => observer.disconnect()
  }, [canvas, project.aspect_ratio])
  const style = effectiveCaptionStyle(candidate.caption_preset, candidate.caption_style)
  const lines = useMemo(() => captionLines(project, candidate), [project, candidate])
  const suppressed = (candidate.caption_suppression_ranges ?? []).some(([a, b]) => a <= time && time < b)
  const now = suppressed ? null : captionWordsAt(lines, candidate.ranges, style.max_words_per_line, time)
  const landscape = project.aspect_ratio === '16:9'
  const title = candidate.title_card ? titleLines(candidate.title) : []
  const showCaptions = candidate.captions && (!!now || guide)
  if (!bounds.width || (!showCaptions && !title.length)) return null
  // Title card geometry in output pixels (42 px Montserrat Black, 110 px from the top on 9:16).
  const titlePx = bounds.height / (landscape ? 1080 : 1920)
  const anchor = captionAnchor(project, candidate, time)
  // The engine's font sizes are in output pixels (1080 wide, or scaled for 16:9 output).
  const scale = bounds.width / (landscape ? 1920 : 1080) * (landscape ? .65 : 1)
  const font = FONT_CSS[style.font_name]
  const size = style.font_size * scale
  const textShadow = shadows(style, scale)
  // Like the engine's _display_word: trailing , . ; : are not drawn.
  const words = now?.words.map((w) => w.text.length > 1 ? w.text.replace(/[,.;:]+$/, '') : w.text) ?? ['Captions', 'go', 'here']
  const active = now?.active ?? 1
  const base: CSSProperties = { fontFamily: font.family, fontWeight: font.weight, fontStyle: font.italic ? 'italic' : 'normal',
    fontSize: size, letterSpacing: style.letter_spacing * scale, textTransform: style.uppercase ? 'uppercase' : 'none',
    color: style.primary_color, textShadow, opacity: now ? 1 : .55 }
  return <div className="editor-caption-overlay" style={bounds}>
    {title.length > 0 && <div className="editor-title-card" aria-label="Title card" style={{ top: bounds.height * 110 / 1920, fontSize: 42 * titlePx,
      padding: `${20 * titlePx}px ${28 * titlePx}px`, borderRadius: 16 * titlePx }}>{title.map((line, i) => <span key={i}>{line}</span>)}</div>}
    {showCaptions && <button type="button" aria-label="Subtitle position" title="Drag to place subtitles. Arrow keys move them; Shift moves farther."
      className="editor-caption-preview" disabled={disabled}
      style={{ top: `${anchor.y * 100}%`, left: `${style.x * 100}%`, transform: `translate(-50%, ${anchor.bottom ? '-100%' : '-50%'})`, ...base }}
      onPointerDown={e => {
        if (e.button !== 0) return
        e.preventDefault(); e.stopPropagation()
        const box = e.currentTarget.getBoundingClientRect()
        drag.current = { pointer: e.pointerId, startX: e.clientX, startY: e.clientY, x: style.x, y: anchor.y - (anchor.bottom ? box.height / bounds.height / 2 : 0), changed: false }
        e.currentTarget.focus({ preventScroll: true }); e.currentTarget.setPointerCapture(e.pointerId); onDrag(true)
      }}
      onPointerMove={e => {
        const state = drag.current
        if (!state || e.pointerId !== state.pointer) return
        const dx = e.clientX - state.startX, dy = e.clientY - state.startY
        if (!state.changed && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
        const first = !state.changed
        state.changed = true
        if (Math.abs(dy) >= 2) onMove(Math.max(.1, Math.min(.9, state.y + dy / bounds.height)), first)
        if (Math.abs(dx) >= 2) onMoveX(Math.round(Math.max(.1, Math.min(.9, state.x + dx / bounds.width)) * 100) / 100, first && Math.abs(dy) < 2)
      }}
      onLostPointerCapture={() => { drag.current = null; onDrag(false) }}
      onKeyDown={e => {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
        e.preventDefault(); e.stopPropagation()
        const step = e.shiftKey ? .05 : .01
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { onMoveX(Math.round(Math.max(.1, Math.min(.9, style.x + (e.key === 'ArrowLeft' ? -step : step))) * 100) / 100, true); return }
        const center = anchor.y - (anchor.bottom ? e.currentTarget.getBoundingClientRect().height / bounds.height / 2 : 0)
        onMove(Math.max(.1, Math.min(.9, center + (e.key === 'ArrowUp' ? -step : step))), true)
      }}>
      <span className="editor-caption-words" style={{ background: style.line_box_color ? alpha(style.line_box_color, style.line_box_opacity) : undefined }}>
        {words.map((word, i) => {
          const state = i === active ? 'active' : i < active ? 'past' : 'future'
          const css: CSSProperties = {}
          if (state === 'future' && !style.karaoke_fill) {
            if (style.future_words === 'hide') css.visibility = 'hidden'
            if (style.future_words === 'dim') css.opacity = .5
          }
          if (style.word_by_word_highlight && !style.karaoke_fill && state === 'active') {
            css.color = style.highlight_color
            if (style.highlight_box_color) { css.background = style.highlight_box_color; css.textShadow = 'none'; css.padding = '0 .15em'; css.borderRadius = '.15em' }
            if (style.glow_color) css.textShadow = `${textShadow}, 0 0 ${size / 3}px ${style.glow_color}`
          }
          if (style.karaoke_fill && state === 'past') css.color = style.highlight_color
          return <span key={i} style={css} className="relative">{word}
            {style.karaoke_fill && state === 'active' && <span aria-hidden className="absolute inset-0" style={{ color: style.highlight_color, clipPath: `inset(0 ${(1 - (now?.progress ?? .5)) * 100}% 0 0)` }}>{word}</span>}
          </span>
        })}
      </span>
    </button>}
  </div>
}
