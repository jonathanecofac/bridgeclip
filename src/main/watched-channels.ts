import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { ClipJobRequest, JobSnapshot } from '../shared/jobs'
import {
  DEFAULT_WATCH_SETTINGS, MAX_ACTIVITY, MAX_CHANNELS, MAX_INTERVAL_MINUTES, MAX_VIDEOS_PER_CHANNEL, MIN_INTERVAL_MINUTES,
  chooseNewVideos, feedUrl, parseChannelFeed, parseChannelInput, videoUrl,
  type FeedEntry, type WatchActivity, type WatchBacklog, type WatchChannelUpdate, type WatchClipSettings, type WatchState, type WatchedChannel, type WatchedVideo
} from '../shared/watched-channels'

/** Everything the watcher needs from the rest of the app; tests pass fakes. */
export interface WatchDeps {
  /** Where the watch list is saved. */
  file: string
  /** GET a public YouTube URL as text (feeds); throws on failure. */
  fetchText: (url: string) => Promise<string>
  /** The channel's latest uploads another way (yt-dlp), for when YouTube's feed is down or empty. */
  listUploads?: (channelId: string) => Promise<{ name: string; entries: FeedEntry[] }>
  /** A channel page (@handle, /c/, /user/) to its channel id. */
  resolveChannelPage: (pageUrl: string) => Promise<{ channelId: string; name: string }>
  /** Length and live state of a video; nulls when unknown. */
  videoDetails: (videoId: string) => Promise<{ durationSeconds: number | null; live: 'live' | 'upcoming' | null }>
  /** Validated clip settings (throws a readable error). */
  validateSettings: (settings: unknown) => WatchClipSettings
  startJob: (request: ClipJobRequest) => Promise<{ jobId: string; outputDir: string } | { error: string }>
  onJobUpdate: (listener: (job: JobSnapshot) => void) => () => void
  /** Hand clips of a finished run to an Automation. */
  sendToAutomation: (automationId: string, outputDir: string, clipIndices: number[]) => Promise<void>
  automationName: (automationId: string) => string | null
  now: () => number
  changed: (state: WatchState) => void
  log: (event: string, data?: Record<string, unknown>) => void
}

const iso = (ms: number): string => new Date(ms).toISOString()
const quote = (title: string): string => `“${title.length > 70 ? `${title.slice(0, 69)}…` : title}”`
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

interface Saved { version: 1; enabled: boolean; intervalMinutes: number; channels: WatchedChannel[]; activity: WatchActivity[] }

function readSaved(file: string): Saved {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>
    if (value && value.version === 1 && Array.isArray(value.channels)) {
      return {
        version: 1, enabled: value.enabled === true,
        intervalMinutes: clampInterval(value.intervalMinutes),
        channels: value.channels.filter((c) => c && typeof c.id === 'string' && /^UC[\w-]{22}$/.test(c.channelId)).slice(0, MAX_CHANNELS),
        activity: Array.isArray(value.activity) ? value.activity.slice(0, MAX_ACTIVITY) : []
      }
    }
  } catch { /* Missing or unreadable: start empty. */ }
  return { version: 1, enabled: false, intervalMinutes: 15, channels: [], activity: [] }
}
function clampInterval(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(MIN_INTERVAL_MINUTES, Math.min(MAX_INTERVAL_MINUTES, value))) : 15
}

/**
 * Watches YouTube channels while BridgeClip is running. Each channel's feed is
 * read every `intervalMinutes`; the first look only records what is already
 * there, and every later video is clipped once with the channel's settings.
 * A finished run can be handed to an Automation, which posts on its own schedule.
 */
export class ChannelWatcher {
  private saved: Saved
  private checking: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopJobs: (() => void) | null = null
  private running = false

  constructor(private deps: WatchDeps) {
    this.saved = readSaved(deps.file)
    // Runs do not survive a restart; say so instead of showing them as still clipping.
    let interrupted = false
    for (const channel of this.saved.channels) {
      for (const video of channel.videos) {
        if (video.status === 'clipping') { video.status = 'failed'; video.note = 'BridgeClip closed before this video finished. Use Clip again.'; interrupted = true }
      }
    }
    if (interrupted) this.save()
  }

  state(): WatchState {
    const due = this.saved.enabled ? this.saved.channels.filter((c) => c.enabled).map((c) => this.dueAt(c)) : []
    return structuredClone({ enabled: this.saved.enabled, intervalMinutes: this.saved.intervalMinutes, channels: this.saved.channels,
      activity: this.saved.activity, nextCheckAt: due.length ? iso(Math.max(this.deps.now(), Math.min(...due))) : null, checking: this.checking })
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.stopJobs = this.deps.onJobUpdate((job) => { void this.onJob(job) })
    this.schedule(1000)
  }
  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.stopJobs?.()
    this.stopJobs = null
  }

  setEnabled(enabled: unknown): WatchState {
    if (typeof enabled !== 'boolean') throw new Error('Invalid setting')
    this.saved.enabled = enabled
    this.event(null, enabled ? 'Watching turned on.' : 'Watching turned off.', 'info')
    this.save(); this.schedule(500)
    return this.state()
  }
  setInterval(minutes: unknown): WatchState {
    if (typeof minutes !== 'number' || !Number.isFinite(minutes)) throw new Error('Invalid interval')
    this.saved.intervalMinutes = clampInterval(minutes)
    this.save(); this.schedule(500)
    return this.state()
  }

  async addChannel(input: unknown, settings: unknown = DEFAULT_WATCH_SETTINGS): Promise<WatchState> {
    if (this.saved.channels.length >= MAX_CHANNELS) throw new Error(`You can watch up to ${MAX_CHANNELS} channels.`)
    const clipSettings = this.deps.validateSettings(settings)
    const parsed = parseChannelInput(input)
    let channelId: string, name = ''
    if ('channelId' in parsed) channelId = parsed.channelId
    else {
      try { ({ channelId, name } = await this.deps.resolveChannelPage(parsed.pageUrl)) } catch { throw new Error('Could not find that channel on YouTube. Check the link or @handle.') }
    }
    if (this.saved.channels.some((c) => c.channelId === channelId)) throw new Error('This channel is already watched.')
    // Reading the feed now proves the channel exists and records what it already has.
    let feed
    try { feed = await this.readChannel(channelId) } catch { throw new Error('YouTube did not return this channel’s videos, through its feed or yt-dlp. Check the link, or try again in a few minutes.') }
    const now = this.deps.now()
    const channel: WatchedChannel = {
      id: randomUUID(), channelId, name: feed.name || name || channelId, enabled: true, addedAt: iso(now), settings: clipSettings,
      automationId: null, sendClips: 3, backlog: 'newest', minMinutes: 3, lastCheckAt: iso(now), lastOkAt: iso(now), lastError: null,
      videos: feed.entries.map((e) => ({ videoId: e.videoId, title: e.title, publishedAt: e.publishedAt, status: 'earlier' as const, seenAt: iso(now) }))
    }
    this.saved.channels.push(channel)
    this.event(channel.id, `Now watching ${channel.name}. ${plural(feed.entries.length, 'earlier video')} left as they are; new uploads are clipped.`, 'info')
    this.save(); this.schedule(500)
    return this.state()
  }

  updateChannel(id: unknown, patch: unknown): WatchState {
    const channel = this.find(id)
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid update')
    const p = patch as WatchChannelUpdate & Record<string, unknown>
    const allowed = ['enabled', 'settings', 'automationId', 'sendClips', 'backlog', 'minMinutes']
    if (Object.keys(p).some((k) => !allowed.includes(k))) throw new Error('Invalid update')
    const next = { ...channel }
    if (p.enabled !== undefined) { if (typeof p.enabled !== 'boolean') throw new Error('Invalid update'); next.enabled = p.enabled }
    if (p.settings !== undefined) next.settings = this.deps.validateSettings(p.settings)
    if (p.automationId !== undefined) {
      if (p.automationId !== null && (typeof p.automationId !== 'string' || !this.deps.automationName(p.automationId))) throw new Error('Choose one of your automations.')
      next.automationId = p.automationId
    }
    if (p.sendClips !== undefined) { if (!Number.isInteger(p.sendClips) || p.sendClips < 0 || p.sendClips > 30) throw new Error('Send between 0 (all) and 30 clips.'); next.sendClips = p.sendClips }
    if (p.backlog !== undefined) { if (!['newest', 'all', 'day', 'none'].includes(p.backlog as string)) throw new Error('Invalid update'); next.backlog = p.backlog as WatchBacklog }
    if (p.minMinutes !== undefined) { if (!Number.isInteger(p.minMinutes) || p.minMinutes < 0 || p.minMinutes > 600) throw new Error('Minimum length must be 0 to 600 minutes.'); next.minMinutes = p.minMinutes }
    if (next.settings.workflow === 'review' && next.automationId) throw new Error('Review runs wait for you to bake their clips, so they can’t go to an automation. Use Automatic, or keep them in the Library.')
    Object.assign(channel, next)
    this.save(); this.schedule(500)
    return this.state()
  }

  removeChannel(id: unknown): WatchState {
    const channel = this.find(id)
    this.saved.channels = this.saved.channels.filter((c) => c !== channel)
    this.event(null, `Stopped watching ${channel.name}. Its clips stay in the Library.`, 'info')
    this.save()
    return this.state()
  }

  /** Look at one channel (or every enabled one) now, even while watching is off. */
  async checkNow(id?: unknown): Promise<WatchState> {
    const channels = id === undefined ? this.saved.channels.filter((c) => c.enabled) : [this.find(id)]
    for (const channel of channels) await this.check(channel)
    return this.state()
  }

  /** Clip a video the watcher left alone (earlier, skipped, failed or cancelled). */
  async clipVideo(id: unknown, videoId: unknown): Promise<WatchState> {
    const channel = this.find(id)
    const video = channel.videos.find((v) => v.videoId === videoId)
    if (!video) throw new Error('This video is no longer listed for the channel.')
    if (video.status === 'clipping') throw new Error('This video is already being clipped.')
    await this.clip(channel, video, true)
    return this.state()
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * A channel's newest uploads: YouTube's feed first, and the channel's Videos
   * tab through yt-dlp when the feed fails or comes back empty (it has outages,
   * answering 404 or 500 for hours).
   */
  private async readChannel(channelId: string): Promise<{ name: string; entries: FeedEntry[] }> {
    let reason: string
    try {
      const feed = parseChannelFeed(await this.deps.fetchText(feedUrl(channelId)))
      if (feed.entries.length || !this.deps.listUploads) return feed
      reason = 'empty feed'
    } catch (error) {
      if (!this.deps.listUploads) throw error
      reason = error instanceof Error ? error.message : 'feed failed'
    }
    this.deps.log('watch.feed.fallback', { channel: channelId, reason: reason.slice(0, 120) })
    return this.deps.listUploads(channelId)
  }

  private find(id: unknown): WatchedChannel {
    const channel = this.saved.channels.find((c) => c.id === id)
    if (!channel) throw new Error('This channel is no longer watched.')
    return channel
  }
  private dueAt(channel: WatchedChannel): number {
    return (channel.lastCheckAt ? Date.parse(channel.lastCheckAt) : 0) + this.saved.intervalMinutes * 60_000
  }
  private schedule(delay?: number): void {
    if (!this.running) return
    if (this.timer) clearTimeout(this.timer)
    const due = this.saved.enabled ? this.saved.channels.filter((c) => c.enabled).map((c) => this.dueAt(c)) : []
    const wait = delay ?? (due.length ? Math.max(1000, Math.min(...due) - this.deps.now()) : 60_000)
    this.timer = setTimeout(() => { void this.tick() }, Math.min(wait, 60_000))
    this.timer.unref?.()
  }
  private async tick(): Promise<void> {
    this.timer = null
    try {
      if (this.saved.enabled && !this.checking) {
        for (const channel of [...this.saved.channels]) {
          if (!this.running || !this.saved.enabled) break
          if (channel.enabled && this.dueAt(channel) <= this.deps.now() && this.saved.channels.includes(channel)) await this.check(channel)
        }
      }
    } finally { this.schedule() }
  }

  private async check(channel: WatchedChannel): Promise<void> {
    if (this.checking) return
    this.checking = channel.id
    this.deps.changed(this.state())
    const now = this.deps.now()
    try {
      let feed
      try { feed = await this.readChannel(channel.channelId) } catch {
        throw new Error('YouTube did not answer for this channel. BridgeClip will try again at the next check.')
      }
      if (feed.name) channel.name = feed.name
      const known = new Map(channel.videos.map((v) => [v.videoId, v]))
      const fresh = feed.entries.filter((e) => !known.has(e.videoId))
      // Live or upcoming videos are looked at again until they can be clipped.
      const retry = feed.entries.filter((e) => known.get(e.videoId)?.status === 'waiting')
      const { take, skip } = chooseNewVideos(fresh, channel.lastOkAt, channel.backlog, now, this.saved.intervalMinutes)
      for (const entry of fresh) {
        const video: WatchedVideo = { videoId: entry.videoId, title: entry.title, publishedAt: entry.publishedAt, status: 'skipped', seenAt: iso(now) }
        if (entry.short) video.note = 'A Short.'
        else if (skip.includes(entry.videoId)) video.note = 'Posted while BridgeClip wasn’t watching; left by the backlog choice.'
        channel.videos.unshift(video)
      }
      channel.lastOkAt = iso(now); channel.lastError = null
      for (const entry of [...retry, ...feed.entries.filter((e) => take.includes(e.videoId)).reverse()]) {
        const video = channel.videos.find((v) => v.videoId === entry.videoId)!
        if (entry.short) continue
        if (!this.saved.channels.includes(channel)) break
        await this.consider(channel, video)
      }
      channel.videos.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      channel.videos = channel.videos.slice(0, MAX_VIDEOS_PER_CHANNEL)
    } catch (error) {
      channel.lastError = error instanceof Error ? error.message : 'Check failed.'
      this.event(channel.id, `${channel.name}: ${channel.lastError}`, 'error')
      this.deps.log('watch.check.failed', { channel: channel.channelId })
    } finally {
      channel.lastCheckAt = iso(now)
      this.checking = null
      this.save()
    }
  }

  /** A new video: skip Shorts and short videos, wait for lives and premieres, clip the rest. */
  private async consider(channel: WatchedChannel, video: WatchedVideo): Promise<void> {
    const details = await this.deps.videoDetails(video.videoId).catch(() => ({ durationSeconds: null, live: null }))
    if (details.live) {
      if (video.status !== 'waiting') this.event(channel.id, `${quote(video.title)} is ${details.live === 'live' ? 'live' : 'scheduled'}; it will be clipped once it has ended.`, 'info')
      video.status = 'waiting'; video.note = details.live === 'live' ? 'Live now; clipped after it ends.' : 'Upcoming; clipped after it airs.'
      return
    }
    if (details.durationSeconds !== null && details.durationSeconds < 60 * channel.minMinutes) {
      video.status = 'skipped'; video.note = `Shorter than ${plural(channel.minMinutes, 'minute')}.`
      return
    }
    await this.clip(channel, video, false)
  }

  private async clip(channel: WatchedChannel, video: WatchedVideo, manual: boolean): Promise<void> {
    const request: ClipJobRequest = { ...channel.settings, videoUrl: videoUrl(video.videoId), startTimeSeconds: null, endTimeSeconds: null, bannerPlatform: null, bannerChannelUrl: null }
    const result = await this.deps.startJob(request).catch((error: unknown) => ({ error: error instanceof Error ? error.message : 'Could not start clipping.' }))
    if ('error' in result && /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|hostname lookup/i.test(result.error)) {
      result.error = 'Could not reach YouTube. Check your internet connection, then use Clip again.'
    }
    if ('error' in result) {
      video.status = 'failed'; video.note = result.error
      this.event(channel.id, `Could not clip ${quote(video.title)}: ${result.error}`, 'error')
    } else {
      Object.assign(video, { status: 'clipping', jobId: result.jobId, outputDir: result.outputDir, note: undefined, clips: undefined, sent: undefined })
      this.event(channel.id, `${manual ? 'Clipping' : 'New video from ' + channel.name + ': clipping'} ${quote(video.title)}.`, 'queued')
    }
    this.save()
  }

  private async onJob(job: JobSnapshot): Promise<void> {
    if (job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled') return
    for (const channel of this.saved.channels) {
      const video = channel.videos.find((v) => v.jobId === job.id && v.status === 'clipping')
      if (!video) continue
      if (job.status !== 'completed') {
        video.status = job.status === 'cancelled' ? 'cancelled' : 'failed'
        video.note = job.status === 'cancelled' ? 'Cancelled in Jobs.' : job.error ?? 'Clipping failed.'
        this.event(channel.id, `${job.status === 'cancelled' ? 'Cancelled' : 'Clipping failed for'} ${quote(video.title)}${job.status === 'failed' && job.error ? `: ${job.error}` : '.'}`, job.status === 'failed' ? 'error' : 'info')
        this.save(); return
      }
      const clips = [...(job.output?.clips ?? [])]
      video.status = 'done'; video.clips = clips.length; video.outputDir = job.outputDir
      const automation = channel.automationId ? this.deps.automationName(channel.automationId) : null
      if (channel.automationId && channel.settings.workflow !== 'review' && clips.length) {
        if (!automation) {
          video.note = 'Its automation no longer exists; the clips are in the Library.'
          this.event(channel.id, `${quote(video.title)}: ${plural(clips.length, 'clip')} in the Library. Its automation no longer exists.`, 'error')
        } else {
          const chosen = clips.sort((a, b) => (b.virality_score ?? 0) - (a.virality_score ?? 0))
            .slice(0, channel.sendClips > 0 ? channel.sendClips : 30).map((c) => c.clip_index)
          try {
            await this.deps.sendToAutomation(channel.automationId, job.outputDir, chosen)
            video.status = 'sent'; video.sent = chosen.length
            this.event(channel.id, `${quote(video.title)}: ${plural(clips.length, 'clip')}, ${chosen.length} sent to ${automation}.`, 'done')
          } catch (error) {
            video.note = `Not sent to ${automation}: ${error instanceof Error ? error.message : 'unknown error'}`
            this.event(channel.id, `${quote(video.title)}: clips are in the Library but could not go to ${automation}. ${error instanceof Error ? error.message : ''}`.trim(), 'error')
          }
        }
      } else {
        this.event(channel.id, `${quote(video.title)}: ${clips.length ? `${plural(clips.length, 'clip')} ready in the Library.` : 'no clips were found.'}${channel.settings.workflow === 'review' ? ' Review them before baking.' : ''}`, 'done')
      }
      this.save(); return
    }
  }

  private event(channelId: string | null, text: string, kind: WatchActivity['kind']): void {
    this.saved.activity.unshift({ at: iso(this.deps.now()), channelId, text, kind })
    this.saved.activity = this.saved.activity.slice(0, MAX_ACTIVITY)
  }
  private save(): void {
    const file = this.deps.file, temp = `${file}.${randomUUID()}.tmp`
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(temp, JSON.stringify(this.saved), { mode: 0o600, flag: 'wx' })
      renameSync(temp, file)
    } catch (error) {
      try { unlinkSync(temp) } catch { /* Not written. */ }
      this.deps.log('watch.save.failed', { error: error instanceof Error ? error.message : 'unknown' })
    }
    this.deps.changed(this.state())
  }
}
