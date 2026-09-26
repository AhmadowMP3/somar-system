# syntax=docker/dockerfile:1.7

# ---------- Stage 1: build ----------
FROM node:22-slim AS build
WORKDIR /app
ENV CI=true

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# --ignore-scripts skips the Supabase CLI / Playwright downloads; sharp and esbuild ship prebuilt binaries.
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web

# VITE_* values are baked into the SPA at build time (the server can also override them at runtime).
ARG VITE_SUPABASE_URL=""
ARG VITE_SUPABASE_ANON_KEY=""
ARG VITE_API_BASE_URL="/api"
ARG VITE_APP_NAME="سومر تورز — النقل الجامعي"
ARG VITE_VAPID_PUBLIC_KEY=""
ARG VITE_STUDENT_EMAIL_DOMAIN="somar.local"
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_APP_NAME=$VITE_APP_NAME \
    VITE_VAPID_PUBLIC_KEY=$VITE_VAPID_PUBLIC_KEY \
    VITE_STUDENT_EMAIL_DOMAIN=$VITE_STUDENT_EMAIL_DOMAIN

RUN npm run build -w @somar/shared \
 && npm run build -w @somar/web \
 && npm run build -w @somar/api

# ---------- Stage 2: production dependencies only ----------
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
      --workspace @somar/api --workspace @somar/shared --include-workspace-root=false \
 && find node_modules -type f \( -name "*.md" -o -name "*.map" \) -delete

# ---------- Stage 3: runtime ----------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Damascus \
    PORT=8080 \
    WEB_DIST_DIR=/app/apps/web/dist

# dumb-init as PID 1, curl for the healthcheck; npm/yarn/corepack are not needed at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init curl ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 app \
 && useradd --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/corepack

COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist

USER 10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT}/api/healthz" || exit 1

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "apps/api/dist/main.js"]
