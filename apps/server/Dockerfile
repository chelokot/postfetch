# syntax=docker/dockerfile:1
# Build context is the repository root: docker build -f apps/server/Dockerfile -t postfetch:local .
FROM docker.io/oven/bun:1.3.14-alpine AS build

WORKDIR /src
RUN apk add --no-cache ca-certificates upx
COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY templates ./templates
RUN bun install --frozen-lockfile
RUN bun build --compile --minify --target=bun-linux-x64-musl-baseline apps/server/src/index.ts --outfile /rootfs/server
RUN upx --best --lzma /rootfs/server

RUN set -eux; \
  mkdir -p /rootfs/etc/ssl/certs /rootfs/lib /rootfs/usr/lib; \
  cp /etc/ssl/certs/ca-certificates.crt /rootfs/etc/ssl/certs/; \
  cp -L /lib/ld-musl-x86_64.so.1 /rootfs/lib/ld-musl-x86_64.so.1; \
  cp /usr/lib/libstdc++.so.6 /rootfs/usr/lib/; \
  cp /usr/lib/libgcc_s.so.1 /rootfs/usr/lib/

FROM scratch
COPY --from=build /rootfs /
EXPOSE 3040
ENTRYPOINT ["/server"]
