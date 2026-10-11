# syntax=docker/dockerfile:1
# AgentSign server image (Fly.io): Telegram channel, eth device mode, approval page on 7788.
# The Ledger is never attached to this machine; it signs through the approval page (WebHID) in a browser.

FROM node:22-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app

# Build stage: native modules (better-sqlite3, node-hid, usb) need a compiler when no prebuilt binary matches.
FROM base AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ libusb-1.0-0-dev libudev-dev pkg-config ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml ./
# All dependencies, dev included: the server runs TypeScript through tsx and bundles the approval page with esbuild at start.
RUN pnpm install --frozen-lockfile

# Runtime stage: only the shared libraries the native modules load, plus ImageMagick for image conversion (see docker/sips).
FROM base AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends libusb-1.0-0 libudev1 imagemagick \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    DB_PATH=/data/agentsign.db \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=7788
COPY --chmod=755 docker/sips /usr/local/bin/sips
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/agentsign-entrypoint
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY voice ./voice
# Everything persistent lives on the /data volume. data/ (relative to /app) also points there,
# so Telegram image downloads (data/telegram) land on the volume and stay writable.
RUN mkdir -p /data && chown node:node /data && ln -s /data /app/data
EXPOSE 7788
ENTRYPOINT ["agentsign-entrypoint"]
CMD ["node", "--import", "tsx", "src/index.ts"]
