# syntax=docker/dockerfile:1
# NaviSync — production image (Bun runtime)
# Build:  docker build -f docker/Dockerfile -t navisync .
# Run:    docker compose -f docker/compose.prod.yaml up -d

FROM oven/bun:1-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY . .
# Build-time dummies (real secrets come from runtime env; .env is dockerignored).
# vite build imports server env which requires these to be present.
ARG APP_SECRET=build-time-dummy-secret-0123456789abcdef
ARG DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV APP_SECRET=${APP_SECRET} DATABASE_URL=${DATABASE_URL}
# svelte-kit sync happens inside vite build via the check script chain;
# build directly with vite (dev deps present in this stage)
RUN bun ./node_modules/.bin/vite build

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=7158 \
    HOST=0.0.0.0 \
    # A UTF-8 locale is REQUIRED, not cosmetic. metaflac writes every non-ASCII
    # byte of a tag value as '#' when LC_CTYPE is "C" — so under the slim image's
    # default locale every accented/zalgo title was silently stored as hashes
    # ("Björk" -> "Bj#rk", "#CUT4<zalgo>" -> "#CUT4#####Z###A###"). Verified by
    # round-tripping a mark-riddled title through metaflac under LC_ALL=C (179
    # spurious '#') versus C.UTF-8 (1, the real one).
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8
# Runtime: compiled server, production deps only, SQL migrations.
# flac (metaflac) embeds canonical tags into FLACs so Navidrome indexes
# real artists/albums instead of [Unknown]. curl serves Coolify's
# Dockerfile-deployment healthcheck (execs curl/wget in-container).
RUN apt-get update && apt-get install -y --no-install-recommends flac curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/build ./build
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json
COPY --from=deps /app/node_modules ./node_modules
RUN mkdir -p /music /app/.tmp /app/logs
VOLUME ["/music", "/app/logs"]
EXPOSE 7158
# Migrations apply automatically on boot (idempotent).
CMD ["bun", "./build/index.js"]
