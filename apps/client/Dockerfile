FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

COPY tsconfig.base.json nx.json ./
COPY libs/contracts ./libs/contracts
COPY apps/client ./apps/client

RUN npx vite build --config apps/client/vite.config.ts

FROM nginx:1.27-alpine

COPY apps/client/nginx-spa.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist/apps/client /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
