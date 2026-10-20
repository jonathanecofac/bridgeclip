# Changelog

What's new in each version of BridgeClip, newest first. You can also read this in the app under **Settings → About → Changelog** or **Help → Changelog**. This is Jonathan's fork of BridgeMind's BridgeClip: versions from 0.2.0 are on [this fork's releases](https://github.com/jonathanecofac/bridgeclip/releases); earlier ones are on [BridgeMind's](https://github.com/bridge-mind/bridgeclip/releases).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Maintainers: see [Changelog](CONTRIBUTING.md#changelog) in the contributing guide before editing.

## [Unreleased]

### Added

- **Caption templates** in the editor: Viral Bold, Hormozi Style, Karaoke, Minimal Clean, Gaming and Cinematic (also in Create).
- **Customize captions** per clip: font, size, letter spacing, caps, words on screen (word by word or groups), text, spoken-word, outline and key-word colors, outline, shadow, background plate, highlight block, glow, upcoming words, pop or fade in, fade out, and horizontal and vertical position. **Save as preset** keeps a look for other clips.
- **Edit caption timing**: change a line's start and end, drag captions on the new caption track, delete a line, or **Add** your own captions.
- **Exact preview** renders the frame at the playhead with the export engine, so captions, fonts, title card and framing look exactly as in the exported MP4.
- The output preview shows the real captions at the playhead in the clip's style, plus the title card; drag the captions to place them.
- **Text overlays and hooks** in the editor's new Text tab: add a text or a bold hook for the first seconds, set its timing, font, size, colors, outline, background and pop or fade animation, and drag it on the preview. Texts stay visible in caption-free sections and follow your cuts.
- **Effects** tab in the editor: **Edit style** presets (Clean, Viral, Cinematic) that you apply yourself and can undo, playback speed from 0.5× (slow motion) to 2×, fade in and out from black, dip-to-black or white flash transitions at cuts, punch-in **Zoom** at the playhead, and **Looks** (brightness, contrast, saturation, sharpen, vignette) on any part of the timeline. Nothing is applied automatically.
- **Audio** tab in the editor: mute or change the clip's volume, turn loudness normalization off, and **Add music**: BridgeClip keeps a copy of the track with the project, loops it under the clip, and lowers it while people speak. Set its volume, start point, ducking level and fades; the preview plays the music with the video.
- **Smart reframing** in the editor's Framing tab: **Auto** picks each shot's layout from the people it sees (follows one speaker, splits two people or a screen with a webcam, shows screens whole), **Face tracking** keeps the speaker full frame and follows their face, **Center** uses one centered crop, and **Off** shows the whole video. It uses face detection on your computer, no credits. Each mode is one edit you can undo, and the layouts it makes stay editable by hand (Manual).

## [0.2.0] - 2026-10-20

### Added

- **Edit clip** on every clip in the Library opens the editor on that clip. Automatic runs become editable once: BridgeClip brings back the original video (linked, not copied, on the same drive), keeps each clip's cut, framing, captions and title card, and asks you to locate the video if it moved. **Export clip** renders your edit as a new clip marked **Edited**; the original clip is never overwritten.
- **Title card** switch per clip in the editor's Captions tab.

- **What to clip** in Create → Clips: describe the moments you want, such as "every time they talk about pricing". Leave it blank to get the strongest moments as before.
- **Show title at the top** in Create → Captions turns off the title card on Automatic clips.
- **Review & edit** workflow: look over clip candidates before exporting. Trim, split and extend cuts, change layouts and camera changes, fix and place captions, then bake one clip or every ready clip with **Bake all**. You can also swap in a higher-quality copy of the source video.
- Jobs show progress for each stage on a timeline, a **Job Breakdown** of where the time went, and **Details** with reviews, the transcript and source research.
- The Library shows how many clips in each run are posted, lets you bookmark runs, and deletes whole runs or single clips.
- Settings → About shows how much disk space your output folder uses.
- YouTube links show a preview in Create.
- Automations have **Submitted** and **Needs attention** sections, drag to reorder, **View in Library**, reviewable title and caption drafts, **Refresh post status** and **Return to queue**.
- **TypeSafe Jev review** and **Research the source before clipping**, both in beta and off by default. Turn them on in Settings. Both use extra OpenRouter credit.
- **Free editor media** removes an editor project's source copy and preview once you're done with it.
- BridgeClip asks whether to save or discard unsaved edits before quitting, and offers **Reload project** when a project was changed elsewhere.
- This changelog, in Settings → About and the Help menu.
- **Chat**: run BridgeClip in plain words. It uses your Claude (Pro or Max, through Claude Code) or ChatGPT (through Codex) subscription, or any OpenRouter model with your OpenRouter key; connect them in **Settings → Assistant**. The assistant can start clipping jobs, manage the Library and automations, and post or schedule clips. Anything that publishes, deletes or spends OpenRouter credit on clipping asks you first.
- Chat's model menu has a tab each for Claude, OpenAI and OpenRouter (search every OpenRouter model that can use tools, with prices), and each reply shows the logo and model that wrote it. Recent chats are listed beside the conversation, with search.
- Chat can find YouTube videos by channel or search, so "clip the latest BridgeMind video" works without a link, and can search the web and read web pages.

### Changed

- Updates come from this fork's releases only, so an official BridgeClip release can no longer replace features added here. Your settings, keys and Library are unchanged.
- Smart framing ignores weak background faces, stays on a speaker who briefly looks away, follows talking heads inside 4:3 video, and analyzes footage faster.
- Screen + webcam clips fill the top panel again.
- Editor previews use much less disk space, and downloaded sources are moved into the project instead of copied.

### Fixed

- Smooth camera movement in the editor works in installed apps.
- **Bake all** keeps going when one clip fails, and says what went wrong.
- Titles with emoji at the length limit no longer break editor projects.
- Automations: submitted and held clips can be removed, posted clips no longer count toward the 500-clip limit, a post deleted in Zernio no longer leaves its clip stuck, slots that come due during an enhancement are kept, and one pending draft no longer blocks the rest of the queue.
- Unattended posts no longer use text from the source video's description, and refuse web addresses or @handles that aren't said in the video.
- Deleting a clip also removes its caption and YouTube text files.
- A missing transcript shows a clear message, and research citations can be selected and copied.
- Screen + webcam clips fill the bottom panel with the webcam, instead of showing a small webcam over a blurred copy of itself when the webcam in the source video is small.

## [0.1.19] - 2026-09-27

One release for macOS, Windows and Linux.

### Added

- Linux installers for x64: an AppImage and a DEB package.

### Changed

- YouTube downloads that fail for a temporary reason retry automatically with a fresh link.
- Playlists and live or upcoming streams are turned away before downloading. Paste a link to a single, finished video.

### Fixed

- An automation keeps posting the rest of its queue when one clip's details can't be verified.
- Generated post captions that quote the video are accepted when the speaker stutters, and captions can no longer contain web links.
- Hardened how BridgeClip handles captions, file paths, titles, downloads and its bundled Python, so unusual input can't change video processing commands or load unexpected code.

## [0.1.18] - 2026-09-25

### Added

- A signed installer for Windows x64. This version shipped for Windows only and has no other changes from 0.1.17.

## [0.1.17] - 2026-09-25

The first version with downloadable installers, starting with macOS.

### Added

- macOS apps for Apple silicon and Intel, signed with BridgeMind's Developer ID and notarized by Apple.
- Automatic updates. BridgeClip checks shortly after launch and every four hours, downloads in the background, and installs when you choose **Restart to update** or the next time you quit. Settings → About shows the status and has **Check for updates**.
- Clip public, finished Twitch VODs by pasting their link.
- **Video speed** in Create → Format speeds up every clip in a job, from 1.1× to 2×. Voices keep their pitch and captions stay in sync.
- TikTok accounts in automations. Each clip gets a review of its caption, audience, interactions and disclosures before it can post.
- **Economy** clipping mode, which uses lower-cost models and skips AI vision checks.
- **Advanced** clipping mode, for choosing your own transcription and planning models from OpenRouter.
- A **Posts** page with your posting history.
- Run stats that compare time and cost with OpusClip when there's enough information for a fair comparison.
- New app icons.

### Changed

- Captions are placed more carefully around faces.
- Jobs with a start and end time only transcribe that part of the video, which is faster and cheaper.
- Accounts, Automations and Jobs are more compact, and menus and confirmation dialogs work with the keyboard.
- Clip cost details name both transcription models when a job switches models partway through.
- Setting up a Zernio profile, and recovering from access problems, is clearer in Accounts.

### Fixed

- Automations could post the same clip twice after a slow or failed response.
- A clip you return to the automation queue after checking it by hand can post again.
- A scheduled slot stays free when a changed clip's TikTok approval is withdrawn, so you can review it and still post on time.
- Automation retries no longer stop at transcription with an HTTP 400 error.
- Page shortcuts no longer close a post dialog while it's uploading.
- Starting a job no longer fails on some IPv6 networks.
- Windows: Python is found reliably, edits with many cuts work, and saved results are opened safely.
- Exports whose audio drifts out of sync are caught before they're saved.

## [0.1.16] - 2026-09-24

### Added

- BridgeClip's source code is public under the MIT license. Installers start with 0.1.17.

[Unreleased]: https://github.com/jonathanecofac/bridgeclip/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jonathanecofac/bridgeclip/releases/tag/v0.2.0
[0.1.19]: https://github.com/bridge-mind/bridgeclip/releases/tag/v0.1.19
[0.1.18]: https://github.com/bridge-mind/bridgeclip/releases/tag/v0.1.18
[0.1.17]: https://github.com/bridge-mind/bridgeclip/releases/tag/v0.1.17
[0.1.16]: https://github.com/bridge-mind/bridgeclip/tree/7107574215cc7f1d4059d10d62bd82014a3ba46f
