# postfetch

**Turn social post URLs into media files.** A zero-dependency typed core, a superminimal showcase Bun image, and deploy templates.

Send one URL, get back the media. Reels and videos come back as `video/mp4`, photos as `image/jpeg`, carousels and slideshows as a `zip`. No browser automation, no `yt-dlp`, no `ffmpeg`, no cookies — just the small Cobalt-style extraction paths needed for public posts, written by hand and fully typed. When a platform splits a video into separate DASH audio and video streams, they are remuxed into a single MP4 in-process — still no `ffmpeg`.

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
import { postfetch, download, archive } from "@postfetch/core";

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
| `archive` | `(result, options?) => Promise<{ bytes, filename, mime }>` | Zips every item (store mode, in-process). |
| `toResponse` | `(result, options?) => Promise<Response>` | One item → streamed file; many → zip. Used by the server and templates. |
| `PostfetchError` | `class { status, message }` | Carries an HTTP status for adapters to map. |

`PostfetchOptions` — `{ fetch?: typeof fetch; preferredWidth?: number; tryMaxBytes?: number }`. `tryMaxBytes` is a soft byte cap: postfetch probes the normally selected media with `HEAD` and, when it is too large, returns a smaller available rendition. If the size or a smaller rendition is unavailable, it keeps the normal result. Injecting `fetch` is what makes the resolvers unit-testable offline:

```ts
const result = await postfetch(url, { fetch: myStub });
```

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
| X (Twitter) | tweet / status with video, gif, or photos | `video/mp4`, `image/jpeg`, or `zip` |
| Reddit | image or gallery post | `image/jpeg` or `zip` of images |
| Reddit | video post (audio remuxed in-process) | `video/mp4` |
| Pinterest | image pin | `image/jpeg` |
| Pinterest | video pin (progressive rendition) | `video/mp4` |
| Pinterest | idea pin (HLS, video + audio merged) | `video/mp4` |
| SoundCloud | track (progressive or HLS) | `audio/mpeg` or `audio/mp4` |

YouTube and Reddit hand out HD video and audio as separate DASH streams; both are fetched and **remuxed into one MP4 in-process** at download time — recombining the fragments at the box level, no `ffmpeg` ([`remux.ts`](packages/core/src/remux.ts)). YouTube picks H.264 video close to the preferred width (so the default stays modest, not 4K) plus the best AAC track. Pinterest idea pins and SoundCloud's HLS-only tracks expose their media as **HLS playlists**, whose CMAF segments are fetched and concatenated into a fragmented MP4 — and merged, for a separate video+audio pair — the same way, again with no `ffmpeg` ([`hls.ts`](packages/core/src/hls.ts)).

## Staying unblocked

A single hard-coded user-agent is the fastest way to get the whole fleet banned at once. Every request instead draws a **fresh, internally-consistent fingerprint** from a pool ([`fingerprint.ts`](packages/core/src/fingerprint.ts)): a Chrome UA always carries a matching `sec-ch-ua` version and the right platform token; the Instagram mobile path rotates real app UAs; YouTube rotates matched Innertube client versions. Consistency is unit-tested, and a live test rotates the fingerprint repeatedly to confirm the combinations aren't all blocked.

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
- No browser automation, no `yt-dlp` / `youtubei.js` / `ffmpeg` / Express / Axios / archive libraries.
- Fragmented-MP4 remuxing (DASH video+audio → one MP4) done by hand at the box level — no `ffmpeg`.
- No env vars, no platform cookies.
- Hand-written Cobalt-style extraction for public posts; zips built in-process in store mode.

## License

MIT
