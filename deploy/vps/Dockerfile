FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY api ./api
COPY deploy/vps ./deploy/vps

RUN npm ci

ARG VITE_PUBLIC_BASE_URL
ARG VITE_UPSTASH_REDIS_REST_URL
ARG VITE_UPSTASH_REDIS_REST_TOKEN
ENV VITE_PUBLIC_BASE_URL=${VITE_PUBLIC_BASE_URL}
ENV VITE_UPSTASH_REDIS_REST_URL=${VITE_UPSTASH_REDIS_REST_URL}
ENV VITE_UPSTASH_REDIS_REST_TOKEN=${VITE_UPSTASH_REDIS_REST_TOKEN}

RUN test -n "$VITE_PUBLIC_BASE_URL" \
  && test -n "$VITE_UPSTASH_REDIS_REST_URL" \
  && test -n "$VITE_UPSTASH_REDIS_REST_TOKEN" \
  && npm run build:ordered \
  && npx tsc -p deploy/vps/tsconfig.json --noEmit \
  && ./node_modules/.bin/esbuild deploy/vps/server.ts \
    --bundle --platform=node --format=esm --packages=external --target=node20 \
    --outfile=runtime/server.js

FROM node:20-bookworm-slim AS production-dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps

RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/package.json ./package.json
COPY --from=production-dependencies /app/packages ./packages
COPY --from=production-dependencies /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/runtime/server.js ./runtime/server.js
COPY deploy/vps/package.json ./runtime/package.json
COPY deploy/vps/scripts/healthcheck.sh ./deploy/vps/scripts/healthcheck.sh
COPY deploy/vps/scripts/smoke-redis.mjs ./deploy/vps/scripts/smoke-redis.mjs

RUN chmod 755 deploy/vps/scripts/healthcheck.sh

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/app/deploy/vps/scripts/healthcheck.sh"]

CMD ["node", "runtime/server.js"]
