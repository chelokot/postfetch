# postfetch

Dependency-free social post media extractor with a tiny Bun server template.

The core API resolves a post URL into typed media sources. The server artifact is intentionally thin: send one URL, get back one file. If the post contains multiple media items, the response is a zip archive.

## Supported

| Platform | Input | Response |
| --- | --- | --- |
| TikTok | video URL or `vt.tiktok.com` shortlink | `video/mp4` |
| TikTok | image/slideshow post | `application/zip` with images |
| Instagram | reel, video, or photo post | `video/mp4` or `image/jpeg` |
| Instagram | carousel post | `application/zip` with images/videos |
| YouTube | `watch`, `shorts`, `live`, `embed`, `youtu.be` | progressive `video/mp4` |

YouTube support bootstraps a public watch page session, calls Innertube through an Android VR client, and selects a progressive MP4 stream. It does not use `yt-dlp`, `youtubei.js`, or ffmpeg.

## Run

```bash
bun install
bun run start
```

```bash
curl -OJ 'http://localhost:3040/?url=https://vt.tiktok.com/ZSxpHvCUM/'
curl -OJ 'http://localhost:3040/?url=https://www.instagram.com/p/CvYrSgnsKjv/'
curl -OJ 'http://localhost:3040/?url=https://www.youtube.com/shorts/r5FpeOJItbw'
```

POST body works too:

```bash
curl -OJ -X POST http://localhost:3040 --data 'https://vt.tiktok.com/ZSxpHvCUM/'
```

## Library

```ts
import { postfetch } from "postfetch";

const result = await postfetch("https://vt.tiktok.com/ZSxpHvCUM/");
```

`postfetch()` returns a typed media result with remote media URLs, headers, MIME types, filenames, platform id, and media kind. The server is just a deployment wrapper around this core API.

## API

`GET /?url=<post-url>`

`POST /` with the URL as a plain text body.

Response headers:

| Header | Meaning |
| --- | --- |
| `content-disposition` | download filename |
| `content-type` | media MIME type or `application/zip` |
| `x-media-platform` | `tiktok`, `instagram`, or `youtube` |
| `x-media-id` | platform media id |
| `x-media-count` | number of files in the response |
| `x-media-kind` | `video`, `image`, or `audio` for single-file responses |

## Container

```bash
bun run container:build
docker run --rm -p 3040:3040 postfetch:local
```

The image is `scratch` based. Bun is compiled into one executable, then UPX-compressed. Current local image size is about `27.7 MB`.

## Design

- TypeScript + Bun.
- No browser automation.
- No `yt-dlp`, `youtubei.js`, ffmpeg, Express, Axios, or archive libraries.
- No env vars or platform cookies.
- TikTok and Instagram logic follows the small Cobalt-style extraction paths needed for public posts.
- Zip files are generated in-process with store mode.

## Checks

```bash
bun run check
bun run build:bin
bun run container:build
```

Run live e2e checks against a running container:

```bash
POSTFETCH_E2E_BASE_URL=http://127.0.0.1:3040 bun run e2e
```

CI runs typecheck, unit tests, standalone binary build, container build, starts the image, and runs blocking live e2e checks against TikTok and Instagram. It also runs the YouTube live e2e probe as non-blocking because GitHub-hosted runner IPs currently hit YouTube's sign-in bot gate without account cookies.
