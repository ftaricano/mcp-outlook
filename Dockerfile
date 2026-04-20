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

# MCP stdio servers have no HTTP port to probe — the healthcheck instead
# verifies that `node dist/index.js --help`-style syntax imports cleanly.
# (A stdio server exits immediately if stdin closes, so we can't run it.)
HEALTHCHECK --interval=60s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('./dist/index.js')" > /dev/null 2>&1 || exit 1

CMD ["node", "dist/index.js"]
