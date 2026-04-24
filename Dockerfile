FROM node:20-alpine

WORKDIR /app/server

COPY server/package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server ./
COPY web ../web

RUN mkdir -p /data && chown -R node:node /data /app

ENV NODE_ENV=production
ENV PORT=7777
ENV HOST=0.0.0.0
ENV DATA_DIR=/data

EXPOSE 7777

USER node

CMD ["node", "server.js"]
