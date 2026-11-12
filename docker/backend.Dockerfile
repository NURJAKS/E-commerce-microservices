FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

COPY tsconfig.base.json tsconfig.json tsconfig.typecheck.json tsconfig.build.json nx.json ./
COPY scripts ./scripts
COPY libs ./libs
COPY apps ./apps

RUN npm run prisma:generate && npx tsc -p tsconfig.build.json && node scripts/link-paths.js

ARG APP_NAME=api-gateway
ENV APP_NAME=${APP_NAME}

CMD ["sh", "-c", "if [ -f apps/${APP_NAME}/prisma/schema.prisma ]; then npx prisma db push --schema=apps/${APP_NAME}/prisma/schema.prisma --skip-generate; fi && node dist/backend/apps/${APP_NAME}/src/main.js"]
