import { Music, RefreshCw, Trash2 } from 'lucide-react'
import type { CandidateEdit } from '../../shared/clip-editor'
import { DEFAULT_AUDIO, type AudioSettings, type BackgroundMusic } from '../../shared/audio'
import { formatTimecode } from '../lib/utils'
import { Button } from './ui/Button'
import { Group, Range } from './EditorControls'
import { Switch } from './ui/Switch'

const db = (v: number): string => `${v > 0 ? '+' : ''}${v} dB`
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

/**
 * Audio tab: the clip's own sound (volume, mute, loudness normalization) and
 * background music (volume, start point, fades, lowering it while people speak).
 * The live preview plays both; what it cannot play is said next to the control.
 */
export function AudioPanel({ candidate, musicMs, disabled, importing, onImport, onChange }: {
  candidate: CandidateEdit
  /** Length of the imported music file, once the preview has loaded it. */
  musicMs: number | null
  disabled: boolean; importing: boolean
  onImport: () => void
  onChange: (patch: Partial<CandidateEdit>, remember?: boolean) => void
}): React.JSX.Element {
  const audio = candidate.audio ?? DEFAULT_AUDIO
  const set = (patch: Partial<AudioSettings>, remember = true): void => onChange({ audio: { ...audio, ...patch } }, remember)
  const music = audio.music
  const setMusic = (patch: Partial<BackgroundMusic>, remember = true): void => { if (music) set({ music: { ...music, ...patch } }, remember) }
  return <fieldset disabled={disabled} className="space-y-4 mt-4">
    <Group title="Clip sound">
      <div className="flex items-center justify-between text-xs"><span>Mute</span><Switch label="Mute clip sound" checked={audio.mute} onChange={(mute) => set({ mute })} /></div>
      {!audio.mute && <Range label="Volume" value={audio.volume_db} min={-20} max={12} format={db} onChange={(volume_db, r) => set({ volume_db }, r)} />}
      {!audio.mute && audio.volume_db > 0 && <p className="text-2xs text-warning">The preview can't play louder than the original. The boost is applied on export.</p>}
      <div className="flex items-center justify-between text-xs"><span title="Brings the clip to -14 LUFS, the level social platforms use, like Automatic clips.">Normalize loudness</span>
        <Switch label="Normalize loudness" checked={audio.normalize} onChange={(normalize) => set({ normalize })} /></div>
      <p className="text-2xs text-ink-subtle">{audio.normalize ? 'Normalization is applied on export; the preview plays the original level.' : 'Exports keep the original level, changed only by Volume.'} Fade in and out are in Effects.</p>
    </Group>
    <Group title="Background music">
      {!music ? <>
        <Button size="sm" icon={<Music size={12} />} loading={importing} onClick={onImport}
          tooltip="Choose an MP3, WAV, M4A, AAC, OGG or FLAC file. BridgeClip keeps a copy with this project.">Add music…</Button>
        <p className="text-2xs text-ink-subtle">Music plays under the whole clip, loops if it is shorter, and keeps its own tempo when you change speed. Use music you have the rights to.</p>
      </> : <>
        <div className="editor-overlay-row"><span className="flex items-center gap-2 truncate"><Music size={12} /><span className="truncate" title={music.name}>{music.name}</span></span>
          {musicMs !== null && <span className="font-mono text-2xs text-ink-subtle">{formatTimecode(musicMs)}</span>}</div>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} loading={importing} onClick={onImport}>Replace</Button>
          <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => set({ music: null })}>Remove music</Button>
        </div>
        <Range label="Music volume" value={music.volume_db} min={-40} max={6} format={db} onChange={(volume_db, r) => setMusic({ volume_db }, r)} />
        {musicMs !== null && musicMs > 1000 && <Range label="Start in track" value={Math.min(music.offset_ms, Math.floor(musicMs / 100) * 100)} min={0} max={Math.floor((musicMs - 500) / 100) * 100} step={100}
          format={(v) => formatTimecode(v)} onChange={(offset_ms, r) => setMusic({ offset_ms }, r)} />}
        <div className="flex items-center justify-between text-xs"><span title="Lowers the music while people speak, using the transcript's word timing.">Lower while people speak</span>
          <Switch label="Lower music while people speak" checked={music.duck} onChange={(duck) => setMusic({ duck })} /></div>
        {music.duck && <Range label="Lower by" value={music.duck_db} min={-30} max={0} format={db} onChange={(duck_db, r) => setMusic({ duck_db }, r)} />}
        <Range label="Music fade in" value={music.fade_in_ms} min={0} max={5000} step={100} format={seconds} onChange={(fade_in_ms, r) => setMusic({ fade_in_ms }, r)} />
        <Range label="Music fade out" value={music.fade_out_ms} min={0} max={5000} step={100} format={seconds} onChange={(fade_out_ms, r) => setMusic({ fade_out_ms }, r)} />
        {music.volume_db > 0 && <p className="text-2xs text-warning">The preview plays music at most at its original level; louder settings are applied on export.</p>}
      </>}
    </Group>
  </fieldset>
}
