# syntax=docker/dockerfile:1.7
# Immagine unica per api, worker e migrazioni: il comando viene scelto da docker-compose.

ARG NODE_VERSION=24
ARG PNPM_VERSION=11.7.0

# ---------- base ----------
FROM node:${NODE_VERSION}-alpine AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g pnpm@${PNPM_VERSION} && pnpm --version
WORKDIR /app

# ---------- dipendenze (tutte) ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/agent-core/package.json packages/agent-core/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/model-gateway/package.json packages/model-gateway/
COPY packages/observability/package.json packages/observability/
COPY packages/protocol/package.json packages/protocol/
COPY packages/soul/package.json packages/soul/
COPY tests/package.json tests/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------- build ----------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
# Solo i progetti applicativi (e i pacchetti che referenziano): tests/ non entra nell'immagine.
RUN pnpm exec tsc -b apps/api apps/worker

# ---------- dipendenze di produzione ----------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/agent-core/package.json packages/agent-core/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/model-gateway/package.json packages/model-gateway/
COPY packages/observability/package.json packages/observability/
COPY packages/protocol/package.json packages/protocol/
COPY packages/soul/package.json packages/soul/
COPY tests/package.json tests/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# ---------- runtime ----------
FROM node:${NODE_VERSION}-alpine AS runtime
ARG APP_VERSION=0.0.0-dev
ENV NODE_ENV=production
ENV APP_VERSION=${APP_VERSION}
WORKDIR /app
COPY --from=prod-deps /app ./
COPY --from=build /app/packages/agent-core/dist ./packages/agent-core/dist
COPY --from=build /app/packages/config/dist ./packages/config/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/model-gateway/dist ./packages/model-gateway/dist
COPY --from=build /app/packages/observability/dist ./packages/observability/dist
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/soul/dist ./packages/soul/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY infrastructure/migrations ./infrastructure/migrations
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
