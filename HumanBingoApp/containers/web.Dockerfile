FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY tsconfig*.json eslint.config.js .prettierrc.json ./
RUN npm ci && npm run build --workspace @human-bingo/browser-client && npm run build --workspace @human-bingo/worker

FROM nginx:1.27-alpine
COPY ops/nginx.conf /etc/nginx/conf.d/default.conf
COPY ops/security-headers.conf /etc/nginx/conf.d/security-headers.conf
COPY packages/browser-client/index.html /usr/share/nginx/html/index.html
COPY --from=build /app/packages/browser-client/dist /usr/share/nginx/html/dist
COPY --from=build /app/packages/worker/dist/service-worker-entry.js /usr/share/nginx/html/service-worker.js
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget --spider -q http://127.0.0.1:8080/healthz || exit 1
