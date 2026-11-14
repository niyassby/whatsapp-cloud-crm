# syntax=docker/dockerfile:1.7
# Dashboard image. Build from the repository root. The API address is compiled into the
# browser code, so it is a build argument, not a runtime setting:
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t wacrm-web .

FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    npm_config_store_dir=/pnpm/store \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    SCARF_ANALYTICS=false
RUN corepack enable
WORKDIR /app

FROM base AS build
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
RUN npm pkg delete scripts.prepare
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --offline
RUN DIRECT_URL=postgresql://build:build@127.0.0.1:5432/build pnpm turbo run build --filter=@wacrm/web...

FROM build AS prune
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    find . -name node_modules -type d -prune -exec rm -rf {} + \
 && pnpm install --frozen-lockfile --offline --prod --filter=@wacrm/web... \
 && rm -rf apps/web/.next/cache

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prune --chown=node:node /app /app
USER node
WORKDIR /app/apps/web
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/next", "start", "-p", "3000", "-H", "0.0.0.0"]
