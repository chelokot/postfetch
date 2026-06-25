# postfetch

**Turn social post URLs into media files.** A zero-dependency typed core, a superminimal showcase Bun image, and deploy templates.

Send one URL, get back the media. Reels and videos come back as `video/mp4`, photos as `image/jpeg`, carousels and slideshows as a `zip`. No browser automation, no `yt-dlp`, no `ffmpeg`, no cookies — just the small Cobalt-style extraction paths needed for public posts, written by hand and fully typed.

## What's in the box

| Artifact | Path | What it is |
| --- | --- | --- |
| `@postfetch/core` | [`packages/core`](packages/core) | The library. `postfetch(url)` → typed result. Zero runtime dependencies, injectable `fetch`, fully tested. |
| `@postfetch/server` | [`apps/server`](apps/server) | The showcase: a tiny Bun HTTP server, compiled to one UPX-packed binary in a `scratch` image (~27 MB). |
| templates | [`templates/`](templates) | Copy-and-go starters: AWS Lambda, Bun/Node server, Cloudflare Worker, CLI, Azure Functions. |

## Use it as a library

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
| `detect` | `(url) => Platform` | `"instagram" \| "tiktok" \| "youtube"`; throws on anything else. |
| `download` | `(item, options?) => Promise<Response>` | Fetches one item from its CDN with the right headers. |
| `archive` | `(result, options?) => Promise<{ bytes, filename, mime }>` | Zips every item (store mode, in-process). |
| `toResponse` | `(result, options?) => Promise<Response>` | One item → streamed file; many → zip. Used by the server and templates. |
| `PostfetchError` | `class { status, message }` | Carries an HTTP status for adapters to map. |

`PostfetchOptions` — `{ fetch?: typeof fetch; preferredWidth?: number }`. Injecting `fetch` is what makes the resolvers unit-testable offline:

```ts
const result = await postfetch(url, { fetch: myStub });
```

## Run the server

```bash
bun install
bun start            # http://localhost:3040/?url=
curl -OJ 'http://localhost:3040/?url=https://vt.tiktok.com/ZSxpHvCUM/'
```

Build the showcase image:

```bash
docker build -f apps/server/Dockerfile -t postfetch .
docker run --rm -p 3040:3040 postfetch
```

The response carries `x-media-platform`, `x-media-id`, `x-media-count` and (for single files) `x-media-kind`, plus a `content-disposition` filename.

## Supported

| Platform | Input | Output |
| --- | --- | --- |
| TikTok | video URL or `vt.tiktok.com` shortlink | `video/mp4` |
| TikTok | image / slideshow post | `zip` of images (+ audio) |
| Instagram | reel, video, or photo | `video/mp4` or `image/jpeg` |
| Instagram | carousel | `zip` of images / videos |
| YouTube | `watch`, `shorts`, `live`, `embed`, `youtu.be` | progressive `video/mp4` |

YouTube uses a direct Innertube player request and picks a progressive MP4. It does **not** merge adaptive video+audio, so it is not a full `yt-dlp` replacement.

## Staying unblocked

A single hard-coded user-agent is the fastest way to get the whole fleet banned at once. Every request instead draws a **fresh, internally-consistent fingerprint** from a pool ([`fingerprint.ts`](packages/core/src/fingerprint.ts)): a Chrome UA always carries a matching `sec-ch-ua` version and the right platform token; the Instagram mobile path rotates real app UAs; YouTube rotates matched Innertube client versions. Consistency is unit-tested, and a live test rotates the fingerprint repeatedly to confirm the combinations aren't all blocked.

This matters because, logged out, Instagram fingerprints the client: `api/v1/media/info` and `graphql/query` return `403`, and the embed only carries the cover image — so the reel video lives **inline in the post page HTML**, reachable only with a consistent browser fingerprint. That path is what the core resolves first.

## Layout

```
packages/core     @postfetch/core — the library
apps/server       @postfetch/server — showcase Bun image
templates/        aws-lambda · bun-server · cloudflare-worker · cli · azure-functions
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
- No env vars, no platform cookies.
- Hand-written Cobalt-style extraction for public posts; zips built in-process in store mode.

## License

MIT
