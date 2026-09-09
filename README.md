# postfetch

**Turn social post URLs into media files.** A zero-dependency typed core, a superminimal showcase Bun image, and deploy templates.

Send one URL, get back the media. Reels and videos come back as `video/mp4`, photos as `image/jpeg`, carousels and slideshows as a `zip`. No browser automation, no `yt-dlp`, no cookies — just the small Cobalt-style extraction paths needed for public posts, written by hand and fully typed. When a platform splits a video into separate DASH audio and video streams, they are remuxed into a single MP4 in-process. An optional `downloadBlob` mode can use a local `ffmpeg` binary to normalize arbitrary MP4 containers.

## What's in the box

| Artifact | Path | What it is |
| --- | --- | --- |
| `@postfetch/core` | [`packages/core`](packages/core) | The library. `postfetch(url)` → typed result. Zero runtime dependencies, injectable `fetch`, fully tested. |
| `@postfetch/server` | [`apps/server`](apps/server) | The showcase: a tiny Bun HTTP server, compiled to one UPX-packed binary in a `scratch` image (~27 MB). |
| `@postfetch/cli` | [`apps/cli`](apps/cli) | A ready-to-run command-line downloader: `postfetch <url> -o <dir>`. |
| templates | [`templates/`](templates) | Copy-and-go deploy starters: AWS Lambda, Bun/Node server, Cloudflare Worker, Azure Functions. |

## Use it as a library

```bash
bun add @postfetch/core         # or: npm i @postfetch/core
deno add jsr:@postfetch/core    # Deno / JSR
```

```ts
import { postfetch, download, downloadBlob, archive } from "@postfetch/core";

const result = await postfetch("https://www.instagram.com/reel/DZ0ixNxtvYq/");
// result.platform === "instagram"
// result.items === [{ kind: "video", mime: "video/mp4", filename, url, headers, ... }]

if (result.items.length === 1) {
  await Bun.write(result.items[0].filename, await download(result.items[0]));
} else {
  const { bytes, filename } = await archive(result);
  await Bun.write(filename, bytes);
}
```

`postfetch` only **resolves** the media (URLs + the headers needed to fetch them); you decide how to stream, store, or serve it. The `download`, `archive` and `toResponse` helpers cover the common cases.

### API

| Export | Signature | Notes |
| --- | --- | --- |
| `postfetch` | `(url, options?) => Promise<PostfetchResult>` | Detects the platform and resolves its media. |
| `detect` | `(url) => Platform` | `"facebook" \| "instagram" \| "linkedin" \| "pinterest" \| "reddit" \| "soundcloud" \| "tiktok" \| "twitter" \| "youtube"`; throws on anything else. |
| `download` | `(item, options?) => Promise<Response>` | Fetches one item from its CDN with the right headers. |
| `downloadBlob` | `(itemOrUrl, options?) => Promise<Blob \| RemuxedVideo>` | Downloads a media item including separate audio, or a direct URL; `remux: true` also returns video upload metadata. |
| `buildAudioSliderVideo` | `(items, options) => Promise<Blob>` | Encodes images/videos followed by one audio item into an MP4 slideshow using local FFmpeg. |
| `archive` | `(result, options?) => Promise<{ bytes, filename, mime }>` | Zips every item (store mode, in-process). |
| `toResponse` | `(result, options?) => Promise<Response>` | One item → streamed file; many → zip. Used by the server and templates. |
| `PostfetchError` | `class { status, message }` | Carries an HTTP status for adapters to map. |

`PostfetchOptions` — `{ fetch?: typeof fetch; preferredWidth?: number; tryMaxBytes?: number }`. `tryMaxBytes` is a soft byte cap: postfetch probes the normally selected media with `HEAD` and, when it is too large, returns a smaller available rendition. For X videos, every MP4 variant is probed and the highest-quality combination whose complete result fits is selected; if none fit, the smallest variants are returned. Other platforms keep the normal result when its size or a smaller rendition cannot be discovered. Injecting `fetch` is what makes the resolvers unit-testable offline:

```ts
const result = await postfetch(url, { fetch: myStub });
```

Clients that must upload media themselves, such as Telegram rich-message
senders, can materialize protected CDN media without handling its request
body directly:

```ts
const [media] = (await postfetch(rawUrl)).items;
const video = await downloadBlob(media, {
  remux: true,
});
form.append("video", video.blob, media.filename);
form.append("thumbnail", video.thumbnail, "thumbnail.jpg");
```

Pass the full media item to include separate audio and assemble HLS playlists.
Passing only `media.url` downloads that URL alone, which may contain video without audio.

`remux` defaults to `false`. When enabled, `downloadBlob` returns
`{ blob, thumbnail, width, height, duration }`: an FFmpeg stream-copy normalized
MP4 (fast-start, non-negative timestamps, no edit list), a JPEG thumbnail within
Telegram's 320x320/200 kB limits, and presentation metadata. It runs `ffmpeg`
and `ffprobe` from `PATH` by default (override with `ffmpegPath` and
`ffprobePath`) and throws if the complete result cannot be produced. The legacy
`(url, headers?, options?)` overload remains available for non-remux downloads.

Turn a photo carousel with a soundtrack into a video:

```ts
import { buildAudioSliderVideo, postfetch } from "@postfetch/core";

const result = await postfetch(photoUrl);
const blob = await buildAudioSliderVideo(result.items, { delay: 3000 });
form.append("video", blob, "slideshow.mp4");
```

`buildAudioSliderVideo` requires one or more `image`/`video` items followed by
exactly one `audio` item. `delay` is the minimum milliseconds per visual. The
actual slot is `max(delay / 1000, audio duration / visual count)` seconds, rounded
up to 30 fps (minimum two frames), so the audio can finish. Each slot includes a
right-to-left transition over the last 300 ms (or half the slot, whichever is
shorter). Total duration is visual count × slot duration. The last
visual stays on screen, and a single visual has no transition. Video clips loop
or trim to fit; their original audio is discarded. If the selected minimum makes
the video longer than the audio, the track loops and is trimmed to fit. Otherwise
it plays once, with silence filling any final partial-frame rounding remainder.

The returned `video/mp4` Blob contains H.264 video and AAC audio. Visuals fit
inside a 720×1280 canvas with black padding and preserved aspect ratio. Override
`width` and `height` with positive even integers. `AudioSliderVideoOptions` also
accepts `fetch`, `ffmpegPath`, and `ffprobePath`. Downloads preserve item headers and assemble
HLS/separate streams. This utility requires Node, Bun or Deno with filesystem
and process access, plus FFprobe and FFmpeg with the `libx264` encoder; it does not run in
browsers or edge workers. Temporary files are removed on success and failure.

## Run the server

```bash
bun install
bun start            # http://localhost:3040/?url=
curl -OJ 'http://localhost:3040/?url=https://vt.tiktok.com/ZSxpHvCUM/'

# Prefer the normal rendition, but try a smaller one when it exceeds 50 MB
curl -OJ 'http://localhost:3040/?tryMaxBytes=50000000&url=https%3A%2F%2Fwww.facebook.com%2Fshare%2Fr%2F19DLkVRYDA%2F'
```

Build the showcase image:

```bash
docker build -f apps/server/Dockerfile -t postfetch .
docker run --rm -p 3040:3040 postfetch
```

The response carries `x-media-platform`, `x-media-id`, `x-media-count` and (for single files) `x-media-kind`, plus a `content-disposition` filename.

## Use the CLI

```bash
bun install

# run it straight from the repo
bun apps/cli/src/index.ts https://www.instagram.com/reel/DZ0ixNxtvYq/ -o ~/Downloads

# or install the `postfetch` command and call it anywhere
cd apps/cli && bun link
postfetch https://vt.tiktok.com/ZSxpHvCUM/
```

A single post is written as one file, carousels and slideshows as a `.zip`; the written path is printed to stdout.

## Supported

| Platform | Input | Output |
| --- | --- | --- |
| TikTok | video URL or `vt.tiktok.com` shortlink | `video/mp4` |
| TikTok | image / slideshow post | `zip` of images (+ audio) |
| Instagram | reel, video, or photo | `video/mp4` or `image/jpeg` |
| Instagram | carousel | `zip` of images / videos |
| LinkedIn | public post with video | highest-bitrate `video/mp4` |
| LinkedIn | public post with an image | `image/jpeg` |
| YouTube | `watch`, `shorts`, `live`, `embed`, `youtu.be` | up to 1080p `video/mp4` (audio remuxed) |
| Facebook | reel, video, `/share/v/…`, `fb.watch` | `video/mp4` |
| Facebook | public text post | metadata (`items: []`) |
| X (Twitter) | tweet / status with video, gif, or photos (including an embedded quoted post) | `video/mp4`, `image/jpeg`, or `zip` |
| X (Twitter) | public text-only status | metadata (`items: []`) |
| Reddit | image or gallery post | `image/jpeg` or `zip` of images |
| Reddit | video post (audio remuxed in-process) | `video/mp4` |
| Reddit | text post | metadata (`items: []`) |
| Pinterest | image pin | `image/jpeg` |
| Pinterest | video pin (progressive rendition) | `video/mp4` |
| Pinterest | idea pin (HLS, video + audio merged) | `video/mp4` |
| SoundCloud | track (progressive or HLS) | `audio/mpeg` or `audio/mp4` |

For an X quote post, `items` are ordered outer post first and quoted post second; each item's `id` identifies the status it came from. The quoted post's text and author are available at `metadata.extra.quotedTweet.metadata`.

X's syndication endpoint can return only a preview of long posts. When a post or quote has a long-post marker or at least 270 characters of preview text, postfetch makes a best-effort request to the public [FxTwitter API](https://docs.fxembed.com/api/introduction/) for full text. Complete text already present in the X response needs no extra request. This adds an external service dependency for text expansion; if it fails or supplies no longer text, the original preview and media remain available. The length check is a heuristic, so some ordinary tweets also trigger a lookup, and unmarked shorter previews may remain truncated.

YouTube and Reddit hand out HD video and audio as separate streams; both are fetched and **remuxed into one MP4 in-process** at download time — recombining the fragments at the box level, no `ffmpeg` ([`remux.ts`](packages/core/src/remux.ts)). YouTube first tries the Android VR client for H.264 video close to the preferred width plus AAC audio. If that lookup fails or either stream rejects a download request, it retries with the visionOS client and selects a fragmented-MP4 HLS variant (VP9/AV1) with AAC-LC audio. MPEG-TS video variants are excluded. The packed AAC segments are packaged into MP4 while preserving their timestamps, then merged with the video. Pinterest idea pins and SoundCloud's HLS-only tracks also use **HLS playlists**, whose CMAF segments are assembled and merged in-process ([`hls.ts`](packages/core/src/hls.ts), [`packed-aac.ts`](packages/core/src/packed-aac.ts)). Pass the full media item to the download helpers so they include the audio and assemble HLS.

## Staying unblocked

Browser requests draw a **fresh, internally-consistent fingerprint** from a pool ([`fingerprint.ts`](packages/core/src/fingerprint.ts)): a Chrome UA carries a matching `sec-ch-ua` version and the right platform token, and the Instagram mobile path rotates real app UAs. YouTube uses matched Innertube client identities with an Android VR → visionOS fallback. Fingerprint consistency is unit-tested, and live tests exercise the platform requests.

This matters because, logged out, Instagram fingerprints the client: `api/v1/media/info` can return `403`, and the embed may carry only the cover image. The core reads inline page media first, but never accepts a cover as the result of an explicit reel URL; it continues through the current logged-out GraphQL query until it finds a real video.

## Layout

```
packages/core     @postfetch/core — the library
apps/server       @postfetch/server — showcase Bun image
apps/cli          @postfetch/cli — command-line downloader
templates/        aws-lambda · bun-server · cloudflare-worker · azure-functions
```

## Develop

```bash
bun install
bun run check                       # typecheck every workspace + unit tests
POSTFETCH_LIVE=1 bun test \
  packages/core/test/live.test.ts   # opt-in: hit the real platforms
```

CI runs the offline checks and the container build on every push, plus a non-gating live job (the reel-resolves-to-video regression and the fingerprint-rotation probe) on a schedule.

## Design

- TypeScript + Bun, zero runtime dependencies in the core.
- No browser automation, no `yt-dlp` / `youtubei.js` / Express / Axios / archive libraries.
- Fragmented-MP4 remuxing (DASH video+audio → one MP4) done by hand at the box level — no `ffmpeg`.
- Optional arbitrary-MP4 normalization uses a local `ffmpeg` binary only when `downloadBlob(..., { remux: true })` is requested.
- Optional slideshow encoding uses local FFmpeg when `buildAudioSliderVideo` is called.
- No env vars, no platform cookies.
- Hand-written Cobalt-style extraction for public posts; zips built in-process in store mode.

## License

MIT
