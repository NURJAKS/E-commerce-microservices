# ============================================================
# Stage 1: Builder — compiles TypeScript and generates Prisma clients
# ============================================================
FROM node:20-alpine AS builder

RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

COPY tsconfig.base.json tsconfig.json tsconfig.typecheck.json tsconfig.build.json nx.json vitest.config.ts ./
COPY scripts ./scripts
COPY libs ./libs
COPY apps ./apps

RUN npm run prisma:generate && npx tsc -p tsconfig.build.json && node scripts/link-paths.js

# ============================================================
# Stage 2: Production dependencies only (+ Prisma CLI for schema sync)
# ============================================================
FROM node:20-alpine AS prod-deps

RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --legacy-peer-deps --no-audit --no-fund \
  && npm install --no-save --legacy-peer-deps --no-audit --no-fund prisma@5.20.0 \
  && npm cache clean --force

# ============================================================
# Stage 3: Minimal hardened runtime running as non-root `node` user
# ============================================================
FROM node:20-alpine AS runner

RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist/backend ./dist/backend
COPY --from=builder /app/scripts/link-paths.js ./scripts/link-paths.js
COPY --from=builder /app/apps/auth-service/prisma ./apps/auth-service/prisma
COPY --from=builder /app/apps/catalog-service/prisma ./apps/catalog-service/prisma
COPY --from=builder /app/apps/order-service/prisma ./apps/order-service/prisma
COPY --from=builder /app/apps/payment-service/prisma ./apps/payment-service/prisma

RUN node scripts/link-paths.js && chown -R node:node /app

ARG APP_NAME=api-gateway
ENV APP_NAME=${APP_NAME}

USER node

# `exec node` ensures Node.js becomes PID 1 and receives SIGTERM directly for graceful shutdown
CMD ["sh", "-c", "if [ -f apps/${APP_NAME}/prisma/schema.prisma ]; then ./node_modules/.bin/prisma db push --schema=apps/${APP_NAME}/prisma/schema.prisma --skip-generate; fi && exec node dist/backend/apps/${APP_NAME}/src/main.js"]
