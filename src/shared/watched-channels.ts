/**
 * Watched YouTube channels: BridgeClip checks each channel's public feed and
 * clips new videos with the channel's own clip settings, then keeps the clips
 * in the Library or hands them to one of the user's Automations.
 * Shared types and pure helpers (feed parsing, channel input, backlog choice).
 */
import type { ClipJobRequest } from './jobs'

/** The clip settings a watch uses for each new video (a Create request without the video). */
export type WatchClipSettings = Omit<ClipJobRequest, 'videoUrl' | 'startTimeSeconds' | 'endTimeSeconds' | 'bannerPlatform' | 'bannerChannelUrl'>
export type WatchBacklog = 'newest' | 'all' | 'day' | 'none'
export type WatchedVideoStatus =
  /** On the channel before it was watched; never clipped unless asked. */
  | 'earlier'
  /** Not taken: a Short, too short, or left by the backlog choice. */
  | 'skipped'
  /** Live or upcoming: looked at again on the next check. */
  | 'waiting'
  | 'clipping' | 'done' | 'sent' | 'failed' | 'cancelled'

export interface WatchedVideo {
  videoId: string
  title: string
  /** ISO time from the feed. */
  publishedAt: string
  status: WatchedVideoStatus
  /** Why it was skipped or failed, in plain words. */
  note?: string
  jobId?: string
  /** Run folder in the Library once clipping started. */
  outputDir?: string
  clips?: number
  /** Clips handed to the automation. */
  sent?: number
  seenAt: string
}

export interface WatchedChannel {
  id: string
  /** YouTube channel id, UC… */
  channelId: string
  name: string
  enabled: boolean
  addedAt: string
  settings: WatchClipSettings
  /** After clipping: Library only (null), or this Automation, which posts on its own schedule. */
  automationId: string | null
  /** Clips handed to the Automation per video, best first; 0 sends every clip. */
  sendClips: number
  /** Several new videos since the last look: which to clip. */
  backlog: WatchBacklog
  /** Shorter videos are skipped (Shorts always are). */
  minMinutes: number
  lastCheckAt: string | null
  lastOkAt: string | null
  lastError: string | null
  /** Newest first, capped. */
  videos: WatchedVideo[]
}

export interface WatchActivity { at: string; channelId: string | null; text: string; kind: 'info' | 'queued' | 'done' | 'error' }

export interface WatchState {
  /** Master switch: nothing is checked while off. */
  enabled: boolean
  intervalMinutes: number
  channels: WatchedChannel[]
  activity: WatchActivity[]
  /** When the next channel is due, while watching. */
  nextCheckAt: string | null
  /** A channel being checked right now. */
  checking: string | null
}

export type WatchChannelUpdate = Partial<Pick<WatchedChannel, 'enabled' | 'settings' | 'automationId' | 'sendClips' | 'backlog' | 'minMinutes'>>

export const MIN_INTERVAL_MINUTES = 5
export const MAX_INTERVAL_MINUTES = 24 * 60
export const MAX_CHANNELS = 50
export const MAX_VIDEOS_PER_CHANNEL = 200
export const MAX_ACTIVITY = 100

export const DEFAULT_WATCH_SETTINGS: WatchClipSettings = {
  workflow: 'automatic', clippingMode: 'quality', maxClips: null, autoClipCount: true, durationRanges: ['short'],
  aspectRatio: '9:16', layoutStyle: 'auto', layoutVision: true, pacing: 'tight', videoSpeed: 1,
  includeCaptions: true, captionPreset: 'pop', includeTitle: true
}

const CHANNEL_ID = /^UC[\w-]{22}$/
const HANDLE = /^@[\w.-]{3,100}$/
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com'])

/**
 * What the user typed, as a channel id or a channel page to look up.
 * Accepts a channel link (/channel/UC…, /@handle, /c/name, /user/name), an
 * @handle, or a bare UC… id. Throws a readable error otherwise.
 */
export function parseChannelInput(value: unknown): { channelId: string } | { pageUrl: string } {
  const input = typeof value === 'string' ? value.trim() : ''
  if (!input || input.length > 500) throw new Error('Paste a YouTube channel link or @handle.')
  if (CHANNEL_ID.test(input)) return { channelId: input }
  if (HANDLE.test(input)) return { pageUrl: `https://www.youtube.com/${input}` }
  let url: URL
  try { url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`) } catch { throw new Error('Paste a YouTube channel link or @handle.') }
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.port) throw new Error('Paste a YouTube channel link, like https://www.youtube.com/@name.')
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] === 'channel' && parts[1] && CHANNEL_ID.test(parts[1])) return { channelId: parts[1] }
  if (parts[0] && HANDLE.test(decodeURIComponent(parts[0]))) return { pageUrl: `https://www.youtube.com/${encodeURIComponent(decodeURIComponent(parts[0])).replace(/^%40/, '@')}` }
  if ((parts[0] === 'c' || parts[0] === 'user') && parts[1] && /^[\w.-]{1,100}$/.test(parts[1])) return { pageUrl: `https://www.youtube.com/${parts[0]}/${parts[1]}` }
  if (url.pathname === '/watch' || parts[0] === 'shorts' || parts[0] === 'live') throw new Error('That is a video link. Paste the channel’s link or @handle instead.')
  throw new Error('Paste a YouTube channel link, like https://www.youtube.com/@name.')
}

export const feedUrl = (channelId: string): string => `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
export const videoUrl = (videoId: string): string => `https://www.youtube.com/watch?v=${videoId}`

function decode(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}
const clean = (text: string, max = 300): string => Array.from(decode(text)).map((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c).join('').replace(/\s+/g, ' ').trim().slice(0, max)

export interface FeedEntry { videoId: string; title: string; publishedAt: string; short: boolean }
/** A channel's YouTube feed (Atom): its name and newest videos, newest first. Throws if it is not a channel feed. */
export function parseChannelFeed(xml: string): { channelId: string | null; name: string; entries: FeedEntry[] } {
  if (typeof xml !== 'string' || !/<feed[\s>]/.test(xml)) throw new Error('Not a YouTube channel feed')
  const head = xml.split(/<entry[\s>]/)[0]
  const name = clean(/<title>([\s\S]*?)<\/title>/.exec(head)?.[1] ?? '') || clean(/<author>\s*<name>([\s\S]*?)<\/name>/.exec(head)?.[1] ?? '')
  const channelId = /<yt:channelId>(UC[\w-]{22})<\/yt:channelId>/.exec(head)?.[1] ?? null
  const entries: FeedEntry[] = []
  for (const [, body] of xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/g)) {
    const videoId = /<yt:videoId>([\w-]{11})<\/yt:videoId>/.exec(body)?.[1]
    const published = /<published>([^<]+)<\/published>/.exec(body)?.[1]
    if (!videoId || !published || !Number.isFinite(Date.parse(published))) continue
    const link = /<link[^>]*rel="alternate"[^>]*href="([^"]+)"/.exec(body)?.[1] ?? ''
    entries.push({ videoId, title: clean(/<title>([\s\S]*?)<\/title>/.exec(body)?.[1] ?? '') || videoId,
      publishedAt: new Date(Date.parse(published)).toISOString(), short: /\/shorts\//.test(link) })
  }
  entries.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  return { channelId, name, entries }
}

/**
 * Which new videos to clip. Videos posted while BridgeClip was watching (since
 * the last successful look, when looks were on time) are always taken. Older
 * ones, missed while it was closed or YouTube did not answer, follow the
 * backlog choice. Returns ids, oldest first.
 */
export function chooseNewVideos(fresh: FeedEntry[], lastOkAt: string | null, backlog: WatchBacklog, now: number, intervalMinutes = 15): { take: string[]; skip: string[] } {
  const interval = intervalMinutes * 60_000, last = lastOkAt ? Date.parse(lastOkAt) : now
  const since = now - last <= 2 * interval + 5 * 60_000 ? last : now - interval
  const recent = fresh.filter((e) => Date.parse(e.publishedAt) > since)
  const missed = fresh.filter((e) => Date.parse(e.publishedAt) <= since).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  let fromMissed: FeedEntry[] = []
  if (backlog === 'all') fromMissed = missed
  else if (backlog === 'day') fromMissed = missed.filter((e) => now - Date.parse(e.publishedAt) <= 24 * 3600 * 1000)
  else if (backlog === 'newest' && !recent.length) fromMissed = missed.slice(0, 1)
  const take = [...recent, ...fromMissed].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)).map((e) => e.videoId)
  return { take, skip: fresh.map((e) => e.videoId).filter((id) => !take.includes(id)) }
}

export const BACKLOG_LABELS: Record<WatchBacklog, string> = {
  newest: 'Only the newest', all: 'All of them', day: 'Those from the last 24 hours', none: 'None'
}
