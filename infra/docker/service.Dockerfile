# Shared multi-stage build for the NestJS services.
# Build from the repo root:  docker build --build-arg SERVICE=api -f infra/docker/service.Dockerfile .
FROM node:22-alpine AS build
ARG SERVICE
RUN npm install -g pnpm@10
WORKDIR /repo

# Manifests first so the dependency layer caches across source changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/bff-gateway/package.json apps/bff-gateway/
COPY apps/user-service/package.json apps/user-service/
COPY apps/spa/package.json apps/spa/
RUN pnpm install --frozen-lockfile --filter "@chatbot/${SERVICE}"

COPY apps/${SERVICE} apps/${SERVICE}
# Regenerate the Prisma client from the schema so the image is authoritative,
# not dependent on the committed copy being current. No-op for services without
# a db:generate script (bff-gateway, spa).
RUN pnpm --filter "@chatbot/${SERVICE}" run --if-present db:generate \
  && pnpm --filter "@chatbot/${SERVICE}" build \
  && pnpm --filter "@chatbot/${SERVICE}" deploy --prod --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production
USER node
WORKDIR /app
COPY --from=build --chown=node:node /out ./
CMD ["node", "dist/main.js"]
