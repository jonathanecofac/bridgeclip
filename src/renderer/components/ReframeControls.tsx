import { Crosshair, Maximize, ScanFace, Sparkles } from 'lucide-react'
import type { ReframeMode } from '../../shared/clip-editor'
import { cn } from '../lib/utils'

const MODES: { id: ReframeMode; name: string; icon: React.JSX.Element; description: string }[] = [
  { id: 'auto', name: 'Auto', icon: <Sparkles size={13} />, description: 'Picks each shot’s layout from the people it sees: follows one speaker, splits two people or a screen with a webcam, shows screens whole.' },
  { id: 'face', name: 'Face tracking', icon: <ScanFace size={13} />, description: 'Keeps the speaker full frame and follows their face across the clip.' },
  { id: 'center', name: 'Center', icon: <Crosshair size={13} />, description: 'One fixed crop in the middle of the video.' },
  { id: 'off', name: 'Off', icon: <Maximize size={13} />, description: 'No reframing: the whole video over a blurred background.' }
]
export const reframeLabel = (mode?: ReframeMode): string => MODES.find((m) => m.id === mode)?.name ?? 'Manual'

/**
 * Smart reframing in the Framing tab. Auto and Face tracking analyze the clip
 * with the local face detector; every mode replaces the clip's layouts as one
 * edit that Undo reverts, and editing any crop by hand switches to Manual.
 */
export function ReframeControls({ mode, disabled, running, onReframe }: {
  mode?: ReframeMode; disabled: boolean; running: boolean
  onReframe: (mode: ReframeMode) => void
}): React.JSX.Element {
  return <section className="editor-style-group" aria-label="Smart reframing">
    <h4 className="flex items-center justify-between">Smart reframing<span className="editor-reframe-mode">{reframeLabel(mode)}</span></h4>
    <div className="grid grid-cols-2 gap-1.5">{MODES.map((m) => <button key={m.id} type="button" title={m.description} disabled={disabled || running}
      aria-pressed={mode === m.id} className={cn('editor-overlay-row editor-reframe-button', mode === m.id && 'selected')} onClick={() => onReframe(m.id)}>
      <span className="flex items-center gap-2">{m.icon}{m.name}</span></button>)}</div>
    <p className="text-2xs text-ink-subtle">{mode ? MODES.find((m) => m.id === mode)!.description : 'Your own layouts. Choose a mode to reframe the whole clip.'}{mode === 'center' || mode === 'off' ? '' : ' Auto and Face tracking use face detection on this computer, no credits.'} Undo restores your layouts; moving a crop by hand switches to Manual.</p>
  </section>
}
