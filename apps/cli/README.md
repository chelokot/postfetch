# @postfetch/cli

One-shot command-line downloader built on [`@postfetch/core`](../../packages/core).

```bash
bun install
bun run --filter='@postfetch/cli' start https://vt.tiktok.com/ZSxpHvCUM/
# or, linked as a bin:
postfetch https://www.instagram.com/reel/DZ0ixNxtvYq/ -o ~/Downloads
```

Single posts are written as one file; carousels and slideshows as a `.zip`.
The written path is printed to stdout.
