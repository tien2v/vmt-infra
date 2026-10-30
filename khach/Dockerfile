FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production DATA_DIR=/data ADMIN_DB=/admin/vmt.db PORT=3001 NODE_NO_WARNINGS=1
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3001/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
