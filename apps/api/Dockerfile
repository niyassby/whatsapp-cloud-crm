# syntax=docker/dockerfile:1.7
# API image. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t wacrm-api .
# The `tools` target is the full workspace with dev dependencies, for migrations and operator
# scripts (pnpm db:migrate:deploy, plans:import, rates:import, admin:grant, wallet:credit):
#   docker build -f apps/api/Dockerfile --target tools -t wacrm-tools .

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
# Lockfile first, so dependency downloads are cached until it changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
# Husky's git hooks have no place in an image.
RUN npm pkg delete scripts.prepare
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --offline
# prisma.config.ts reads DIRECT_URL even for `generate`; nothing connects during the build.
RUN DIRECT_URL=postgresql://build:build@127.0.0.1:5432/build pnpm turbo run build --filter=@wacrm/api...

FROM build AS tools
CMD ["pnpm", "db:migrate:deploy"]

FROM build AS prune
# Reinstall production dependencies of the API and the packages it uses only.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    find . -name node_modules -type d -prune -exec rm -rf {} + \
 && pnpm install --frozen-lockfile --offline --prod --filter=@wacrm/api...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prune --chown=node:node /app /app
USER node
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
