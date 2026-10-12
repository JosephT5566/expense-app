FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY packages/semantic-entry-contract packages/semantic-entry-contract
COPY services/semantic-entry/package*.json services/semantic-entry/
WORKDIR /app/services/semantic-entry
RUN npm ci
WORKDIR /app
COPY src/lib/types/expense.ts src/lib/types/expense.ts
COPY src/lib/utils/dates.ts src/lib/utils/dates.ts
COPY services/semantic-entry/src services/semantic-entry/src
WORKDIR /app/services/semantic-entry
RUN npm run build && npm prune --omit=dev
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app/services/semantic-entry
COPY --from=build --chown=node:node /app/services/semantic-entry/node_modules node_modules
COPY --from=build --chown=node:node /app/services/semantic-entry/dist dist
COPY --from=build --chown=node:node /app/services/semantic-entry/package.json package.json
USER node
EXPOSE 8080
CMD ["node","dist/server.js"]
