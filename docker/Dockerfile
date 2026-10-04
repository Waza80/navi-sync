# syntax=docker/dockerfile:1
# NaviSync — production image (Bun runtime)
FROM oven/bun:1.2-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Install dependencies (cached layer)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Build the SvelteKit app
COPY . .
RUN bun install --frozen-lockfile && bun ./node_modules/.bin/vite build && bun install --frozen-lockfile --production

# Runtime
FROM oven/bun:1.2-slim
WORKDIR /app
ENV NODE_ENV=production PORT=7158
COPY --from=base /app /app
EXPOSE 7158
# Migrations run automatically on boot (drizzle migrator, idempotent).
CMD ["bun", "./build/index.js"]
