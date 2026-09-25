FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig*.json eslint.config.js .prettierrc.json ./
RUN npm ci --fetch-retries=5 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=120000 \
  && npm run build --workspace @human-bingo/api \
  && npm run build --workspace @human-bingo/worker

FROM node:22-alpine
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
# AWS RDS CA bundle so verify-full PostgreSQL TLS works against RDS.
# node:alpine does not ship the RDS CA chain in its default trust store.
RUN apk add --no-cache ca-certificates curl \
  && curl -sSL -o /usr/local/share/rds-ca-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  && chmod 644 /usr/local/share/rds-ca-bundle.pem
WORKDIR /app
RUN addgroup -S bingo && adduser -S bingo -G bingo
COPY --from=build --chown=bingo:bingo /app/packages/api/dist ./packages/api/dist
COPY --from=build --chown=bingo:bingo /app/packages/domain/dist ./packages/domain/dist
COPY --from=build --chown=bingo:bingo /app/packages/persistence/dist ./packages/persistence/dist
COPY --from=build --chown=bingo:bingo /app/packages/worker/dist ./packages/worker/dist
COPY --from=build --chown=bingo:bingo /app/packages/persistence/src/migrations/001_initial_schema.sql ./packages/persistence/src/migrations/001_initial_schema.sql
COPY --from=build --chown=bingo:bingo /app/packages/persistence/src/migrations/002_face_stamps.sql ./packages/persistence/src/migrations/002_face_stamps.sql
COPY --from=build --chown=bingo:bingo /app/scripts/load-env.mjs ./scripts/load-env.mjs
COPY --from=build --chown=bingo:bingo /app/scripts/migrate-runtime.mjs ./scripts/migrate-runtime.mjs
COPY --from=build --chown=bingo:bingo /app/node_modules ./node_modules
COPY --from=build --chown=bingo:bingo /app/package.json ./package.json
# The API package exposes the framework-neutral HttpApi. Supply the deployment's
# HTTP adapter through API_START_COMMAND; fail closed instead of starting a stub.
COPY containers/run-command.sh /usr/local/bin/run-command
RUN chmod +x /usr/local/bin/run-command
USER bingo
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=4s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/run-command"]
