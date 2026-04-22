## syntax=docker/dockerfile:1.6

# ---------- Build stage ----------
FROM node:20-alpine AS builder
WORKDIR /app

# Install build-time deps (including devDeps for tsc).
COPY package.json package-lock.json ./
RUN npm ci

# Copy sources and compile.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune to production-only deps for the runtime image.
RUN npm prune --omit=dev


# ---------- Runtime stage ----------
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NODE_OPTIONS="--enable-source-maps"

# Copy only what the server needs at runtime.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Writable directory for downloaded attachments.
RUN mkdir -p /app/downloads && chown -R node:node /app

# Drop privileges.
USER node

# MCP stdio servers have no HTTP port to probe. The healthcheck imports a
# pure, side-effect-free module from the compiled output to verify the dist
# is intact without booting the server (which would consume stdin/stdout and
# conflict with the live stdio transport). The entrypoint is ESM, so we use
# dynamic import, not require().
HEALTHCHECK --interval=60s --timeout=10s --start-period=5s --retries=3 \
  CMD node --input-type=module -e "await import('./dist/config/env.js')" > /dev/null 2>&1 || exit 1

CMD ["node", "dist/index.js"]
