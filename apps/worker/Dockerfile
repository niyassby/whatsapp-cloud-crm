# syntax=docker/dockerfile:1.7
# Worker image (BullMQ processors and scheduled jobs). Build from the repository root:
#   docker build -f apps/worker/Dockerfile -t wacrm-worker .
# Run as many containers as you need; they share the queues.

FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    npm_config_store_dir=/pnpm/store \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1 \
    SCARF_ANALYTICS=false
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
RUN npm pkg delete scripts.prepare
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --offline
RUN DIRECT_URL=postgresql://build:build@127.0.0.1:5432/build pnpm turbo run build --filter=@wacrm/worker...

FROM build AS prune
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    find . -name node_modules -type d -prune -exec rm -rf {} + \
 && pnpm install --frozen-lockfile --offline --prod --filter=@wacrm/worker...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prune --chown=node:node /app /app
USER node
WORKDIR /app/apps/worker
EXPOSE 4001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||4001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
