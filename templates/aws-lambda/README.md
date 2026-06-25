# postfetch · AWS Lambda template

Function URL / API Gateway (payload v2) handler on top of
[`@postfetch/core`](../../packages/core). Returns the media base64-encoded so
binaries survive the JSON envelope.

```bash
bun install
# bundle for the Node runtime, e.g.:
bunx esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.mjs
```

Invoke with `?url=<post-url>` (or the URL as the request body).
