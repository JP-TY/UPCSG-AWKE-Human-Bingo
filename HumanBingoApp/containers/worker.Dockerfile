FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY tsconfig*.json eslint.config.js .prettierrc.json ./
RUN npm ci && npm run build --workspace @human-bingo/worker

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/packages/worker/dist ./packages/worker/dist
COPY --from=build /app/packages/domain/dist ./packages/domain/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY containers/run-command.sh /usr/local/bin/run-command
RUN chmod +x /usr/local/bin/run-command
ENTRYPOINT ["/usr/local/bin/run-command"]
