FROM node:20-alpine

WORKDIR /app
COPY server.js ./
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

ENV PORT=3000
ENV SERVERS=server-1,server-2,server-3,server-4,server-5
ENV DATA_FILE=/app/data/store.json

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
