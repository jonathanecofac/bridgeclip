import { app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CAPTION_PRESET_IDS } from '../shared/caption-presets'
import { USER_PRESET_LIMIT, parseCaptionStyle, parseUserCaptionPreset, type UserCaptionPreset } from '../shared/caption-style'
import { logger } from './logger'

/** Caption looks the user saved from the editor, kept with their settings. */
const file = (): string => join(app.getPath('userData'), 'caption-presets.json')

export function listCaptionPresets(): UserCaptionPreset[] {
  const path = file()
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    // Skip anything unreadable instead of losing every preset.
    return raw.slice(0, USER_PRESET_LIMIT).flatMap((item) => { try { return [parseUserCaptionPreset(item, CAPTION_PRESET_IDS)] } catch { return [] } })
  } catch (error) {
    logger.warn('captionPresets.unreadable', { message: error instanceof Error ? error.name : 'unknown' })
    return []
  }
}

function write(presets: UserCaptionPreset[]): void {
  const path = file(), temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(presets, null, 2), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally { try { unlinkSync(temporary) } catch { /* Already renamed. */ } }
}

/** Save a new look, or replace one with the same name. */
export function saveCaptionPreset(name: unknown, base: unknown, style: unknown): UserCaptionPreset[] {
  const presets = listCaptionPresets()
  const label = typeof name === 'string' ? name.trim() : ''
  const existing = presets.find((p) => p.name.toLowerCase() === label.toLowerCase())
  const preset = parseUserCaptionPreset({ id: existing?.id ?? randomUUID().replaceAll('-', ''), name: label, base, style: parseCaptionStyle(style) }, CAPTION_PRESET_IDS)
  if (!existing && presets.length >= USER_PRESET_LIMIT) throw new Error(`You can save up to ${USER_PRESET_LIMIT} caption presets. Delete one first.`)
  const next = existing ? presets.map((p) => p.id === existing.id ? preset : p) : [...presets, preset]
  write(next)
  return next
}

export function deleteCaptionPreset(id: unknown): UserCaptionPreset[] {
  const presets = listCaptionPresets()
  const next = presets.filter((p) => p.id !== id)
  if (next.length !== presets.length) write(next)
  return next
}
