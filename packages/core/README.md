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

`downloadBlob(url, headers?, options?)` materializes an already-resolved media URL for
clients that need an uploadable `Blob`. Pass the resolved item's headers for
protected CDN URLs: `downloadBlob(item.url, item.headers)`.

- `PostfetchOptions` — `{ fetch?: typeof fetch; preferredWidth?: number; tryMaxBytes?: number }`. `tryMaxBytes` is a soft byte cap: when the normal media is larger, a smaller available rendition is returned; if its size cannot be discovered or no smaller rendition is available, the normal result is kept. Inject `fetch` to unit-test resolvers offline.
- Every request rotates a consistent browser/app fingerprint, so a fixed user-agent never gets the whole fleet blocked.
- No runtime dependencies, no `ffmpeg` / `yt-dlp`, no cookies.

See the [root README](https://github.com/chelokot/postfetch#readme) for the full API table, supported inputs and the fingerprint design.
