# syntax=docker/dockerfile:1

# ---- deps: install all dependencies once (cached on package-lock changes)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- build: type-check, run the automated tests, then build both bundles
FROM deps AS build
COPY tsconfig*.json vite.config.ts vitest.config.ts ./
COPY src ./src
ARG SKIP_TESTS=false
RUN npm run typecheck
RUN if [ "$SKIP_TESTS" != "true" ]; then npm test; fi
RUN npm run build

# ---- prod-deps: runtime dependencies only
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- runtime: small image, non-root user, no build tooling
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STATIC_DIR=/app/dist/web
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "dist/server/index.js"]
