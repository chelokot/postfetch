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

`downloadBlob(url, options?)` materializes an already-resolved media URL for
clients that need an uploadable `Blob`. Pass the resolved item's headers for
protected CDN URLs: `downloadBlob(item.url, { headers: item.headers })`. Set
`remux: true` to normalize an MP4 with an FFmpeg stream copy (fast-start,
non-negative timestamps, no edit list). Remuxing defaults to off, uses `ffmpeg`
from `PATH` unless `ffmpegPath` is set, and falls back to the original Blob on
failure. The legacy `(url, headers?, options?)` overload remains supported.

- `PostfetchOptions` — `{ fetch?: typeof fetch; preferredWidth?: number; tryMaxBytes?: number }`. `tryMaxBytes` is a soft byte cap. X probes every MP4 variant and selects the highest-quality complete result that fits, falling back to its smallest variants when none do. Other platforms return a smaller available rendition when possible and otherwise keep the normal result. Inject `fetch` to unit-test resolvers offline.
- Every request rotates a consistent browser/app fingerprint, so a fixed user-agent never gets the whole fleet blocked.
- No runtime dependencies, no `yt-dlp`, no cookies. `ffmpeg` is only used when
  the opt-in `downloadBlob(..., { remux: true })` path is requested.

See the [root README](https://github.com/chelokot/postfetch#readme) for the full API table, supported inputs and the fingerprint design.
