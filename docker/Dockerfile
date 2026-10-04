# syntax=docker/dockerfile:1
# NaviSync — production image (Bun runtime)
# Build:  docker build -f docker/Dockerfile -t navisync .
# Run:    docker compose -f docker/compose.prod.yaml up -d

FROM oven/bun:1.2-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY . .
# svelte-kit sync happens inside vite build via the check script chain;
# build directly with vite (dev deps present in this stage)
RUN bun ./node_modules/.bin/vite build

FROM oven/bun:1.2-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=7158 \
    HOST=0.0.0.0
# Runtime: compiled server, production deps only, SQL migrations
COPY --from=build /app/build ./build
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json
COPY --from=deps /app/node_modules ./node_modules
RUN mkdir -p /music /app/.tmp /app/logs
VOLUME ["/music", "/app/logs"]
EXPOSE 7158
# Migrations apply automatically on boot (idempotent).
CMD ["bun", "./build/index.js"]
