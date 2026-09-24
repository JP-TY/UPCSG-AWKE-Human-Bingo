FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY tsconfig*.json ./
COPY . .
RUN npm ci && npm run build:web

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3001
WORKDIR /app
RUN addgroup -S web && adduser -S web -G web
COPY --from=build --chown=web:web /app/packages/web/.next/standalone ./
COPY --from=build --chown=web:web /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=build --chown=web:web /app/packages/web/public ./packages/web/public
USER web
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=4s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/web/server.js"]
