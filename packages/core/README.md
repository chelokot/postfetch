# @postfetch/core

Zero-dependency typed core that turns Facebook, Instagram, LinkedIn, Pinterest, Reddit, SoundCloud, TikTok, X and YouTube post URLs into media files. Part of [postfetch](https://github.com/chelokot/postfetch).

```ts
import { postfetch, download, downloadBlob, archive, toResponse, PostfetchError } from "@postfetch/core";

const result = await postfetch("https://vt.tiktok.com/ZSxpHvCUM/");
for (const item of result.items) {
  console.log(item.kind, item.mime, item.url);
}
```

`postfetch(url, options?)` detects the platform and resolves its media into a typed `PostfetchResult` (URLs plus the headers needed to fetch them). It performs no side effects beyond the lookup — `download`, `downloadBlob`, `archive` and `toResponse` materialize the result.

`downloadBlob(itemOrUrl, options?)` materializes resolved media for clients that
need an uploadable `Blob`. Prefer `downloadBlob(item, { remux: true })` to
include separate audio, assemble HLS playlists and use the item's headers.
Passing only `item.url` fetches that URL alone and may omit separate audio;
for direct URLs, pass `{ headers: item.headers }` when needed. Set
`remux: true` to return `{ blob, thumbnail, width, height, duration }`: a
normalized MP4, upload thumbnail and calculated presentation metadata. Remuxing
defaults to off, uses `ffmpeg` and `ffprobe` from `PATH` unless their paths are
set, and throws if the complete result cannot be produced. The legacy
`(url, headers?, options?)` overload remains supported for non-remux downloads.

`buildAudioSliderVideo(items, { delay: 3000 })` returns an MP4 `Blob` from one or
more images/videos followed by exactly one audio item. `delay` is milliseconds
per visual, rounded to 30 fps (minimum two frames), including a right-to-left
transition lasting up to 300 ms or half the delay. The last visual stays visible;
a single visual has no transition. Total duration is visual count × rounded
delay. Videos loop or trim to fit and their own audio is discarded; the trailing
audio loops and trims to the result. The default 720×1280 canvas preserves
aspect ratio with black padding. `AudioSliderVideoOptions` supports `width` and
`height` (positive even integers), `fetch`, and `ffmpegPath`. Requires local
FFmpeg with `libx264` and a runtime with filesystem/process access (Node, Bun,
Deno). Downloads retain item headers and assemble HLS; temporary files are
cleaned up on success and failure.

```ts
import { buildAudioSliderVideo } from "@postfetch/core";

const blob = await buildAudioSliderVideo(result.items, { delay: 3000 });
form.append("video", blob, "slideshow.mp4");
```

- `PostfetchOptions` — `{ fetch?: typeof fetch; preferredWidth?: number; tryMaxBytes?: number }`. `tryMaxBytes` is a soft byte cap. X probes every MP4 variant and selects the highest-quality complete result that fits, falling back to its smallest variants when none do. Other platforms return a smaller available rendition when possible and otherwise keep the normal result. Inject `fetch` to unit-test resolvers offline.
- Every request rotates a consistent browser/app fingerprint, so a fixed user-agent never gets the whole fleet blocked.
- No runtime dependencies, no `yt-dlp`, no cookies. `ffmpeg` is only used when
  `downloadBlob(..., { remux: true })` or `buildAudioSliderVideo` is requested.

See the [root README](https://github.com/chelokot/postfetch#readme) for the full API table, supported inputs and the fingerprint design.
