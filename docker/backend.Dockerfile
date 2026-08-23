FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app/backend

COPY --chown=node:node backend/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node backend/src ./src
COPY --chown=node:node frontend /app/frontend

USER node
EXPOSE 3000

CMD ["node", "src/server.js"]
