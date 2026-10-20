import { execFile } from 'child_process'
import { join } from 'path'
import { promisify } from 'util'
import { app, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { ChannelWatcher } from './watched-channels'
import { startClipJobRequest } from './job-start'
import { onJobUpdate } from './job-manager'
import { addLibraryClipsToAutomation, listAutomations } from './automations'
import { validateJobConfig } from './validation'
import { readResponseText } from './http-response'
import { resolveBinary } from './tools'
import { logger } from './logger'
import { DEFAULT_WATCH_SETTINGS, type WatchClipSettings } from '../shared/watched-channels'

const execFileAsync = promisify(execFile)
const YOUTUBE = 'https://www.youtube.com'
/** Development and e2e runs can point the watcher at a local stand-in for YouTube. */
const base = (): string => (!app.isPackaged && process.env.BRIDGECLIP_E2E_YOUTUBE_URL) || YOUTUBE
const local = (url: string): string => url.startsWith(YOUTUBE) ? base() + url.slice(YOUTUBE.length) : url

async function fetchText(url: string): Promise<string> {
  const response = await fetch(local(url), { redirect: 'follow', signal: AbortSignal.timeout(15000),
    headers: { 'Accept-Language': 'en-US,en;q=0.8', Cookie: 'SOCS=CAI', Accept: 'text/html,application/xml,application/atom+xml;q=0.9,*/*;q=0.5' } })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`YouTube answered ${response.status}`) }
  return readResponseText(response, 4 * 1024 * 1024, 'YouTube response is too large')
}

const SETTINGS_FIELDS = Object.keys(DEFAULT_WATCH_SETTINGS).concat('clipRequest', 'plannerModel', 'transcriptionModel') as (keyof WatchClipSettings)[]
function validateSettings(settings: unknown): WatchClipSettings {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid clip settings')
  const config = validateJobConfig({ ...settings, videoUrl: `${YOUTUBE}/watch?v=aaaaaaaaaaa`, startTimeSeconds: null, endTimeSeconds: null, bannerPlatform: null, bannerChannelUrl: null })
  return Object.fromEntries(SETTINGS_FIELDS.filter((key) => config[key] !== undefined).map((key) => [key, config[key]])) as unknown as WatchClipSettings
}

/** @handle, /c/ and /user/ pages to a channel id: the page's own metadata first (the SOCS cookie skips the EU consent page), yt-dlp if YouTube served something else. */
async function resolveChannelPage(pageUrl: string): Promise<{ channelId: string; name: string }> {
  try {
    const html = await fetchText(pageUrl)
    const channelId = /<meta itemprop="(?:identifier|channelId)" content="(UC[\w-]{22})"/.exec(html)?.[1]
      ?? /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/.exec(html)?.[1]
      ?? /"externalId":"(UC[\w-]{22})"/.exec(html)?.[1]
    if (channelId) return { channelId, name: /<meta property="og:title" content="([^"]{1,200})"/.exec(html)?.[1] ?? '' }
  } catch { /* Try yt-dlp. */ }
  const { stdout } = await execFileAsync(resolveBinary('yt-dlp'), [
    '--ignore-config', '--skip-download', '--flat-playlist', '--playlist-end', '1', '--no-warnings', '--no-cache-dir',
    '--socket-timeout', '10', '--print', '%(channel_id)s\t%(channel)s', '--', pageUrl
  ], { timeout: 45000, maxBuffer: 256 * 1024, windowsHide: true })
  const [channelId, name = ''] = stdout.trim().split('\n')[0].split('\t')
  if (!/^UC[\w-]{22}$/.test(channelId)) throw new Error('Channel not found')
  return { channelId, name: name === 'NA' ? '' : name }
}

async function videoDetails(videoId: string): Promise<{ durationSeconds: number | null; live: 'live' | 'upcoming' | null }> {
  if (base() !== YOUTUBE) {
    const info = JSON.parse(await fetchText(`${YOUTUBE}/details/${videoId}`)) as { duration?: number; live_status?: string }
    return { durationSeconds: typeof info.duration === 'number' ? info.duration : null, live: info.live_status === 'is_live' ? 'live' : info.live_status === 'is_upcoming' ? 'upcoming' : null }
  }
  const { stdout } = await execFileAsync(resolveBinary('yt-dlp'), [
    '--ignore-config', '--skip-download', '--no-playlist', '--no-warnings', '--no-cache-dir', '--use-extractors', 'youtube',
    '--socket-timeout', '10', '--print', '{"duration":%(duration)j,"live_status":%(live_status)j}', '--', `${YOUTUBE}/watch?v=${videoId}`
  ], { timeout: 45000, maxBuffer: 64 * 1024, windowsHide: true })
  const info = JSON.parse(stdout.trim()) as { duration?: unknown; live_status?: unknown }
  const live = info.live_status === 'is_live' || info.live_status === 'post_live' ? 'live' : info.live_status === 'is_upcoming' ? 'upcoming' : null
  return { durationSeconds: typeof info.duration === 'number' && Number.isFinite(info.duration) ? info.duration : null, live }
}

function automationName(id: string): string | null {
  try { return listAutomations().find((a) => a.id === id)?.name ?? null } catch { return null }
}

let watcher: ChannelWatcher | null = null

/** Start watching (if the user turned it on) and expose the watch list to the window. */
export function initWatchedChannels(getWindow: () => BrowserWindow | null, handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void): void {
  watcher = new ChannelWatcher({
    file: join(app.getPath('userData'), 'watched-channels.json'),
    fetchText, resolveChannelPage, videoDetails, validateSettings,
    startJob: async (request) => {
      const result = await startClipJobRequest(request)
      return 'error' in result ? result : { jobId: result.jobId, outputDir: result.job.outputDir }
    },
    onJobUpdate,
    sendToAutomation: async (id, outputDir, indices) => { await addLibraryClipsToAutomation(id, outputDir, indices) },
    automationName,
    now: () => Date.now(),
    changed: (state) => {
      const window = getWindow()
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('watch:update', state)
    },
    log: (event, data) => logger.info(event, data)
  })
  const w = watcher
  handle('watch:state', () => w.state())
  handle('watch:setEnabled', (_e, enabled) => w.setEnabled(enabled))
  handle('watch:setInterval', (_e, minutes) => w.setInterval(minutes))
  handle('watch:add', (_e, input, settings) => w.addChannel(input, settings ?? DEFAULT_WATCH_SETTINGS))
  handle('watch:update', (_e, id, patch) => w.updateChannel(id, patch))
  handle('watch:remove', (_e, id) => w.removeChannel(id))
  handle('watch:check', (_e, id) => w.checkNow(id ?? undefined))
  handle('watch:clip', (_e, id, videoId) => w.clipVideo(id, videoId))
  w.start()
  app.on('before-quit', () => w.stop())
}
