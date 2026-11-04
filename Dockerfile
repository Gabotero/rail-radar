FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8610

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
COPY web ./web
# Prebuilt rail network (npm run build:rail). The Renfe timetables are downloaded at start
# into data/gtfs, which is a volume so they survive rebuilds.
COPY data/rail-graph.json ./data/
RUN mkdir -p data/gtfs && chown -R node:node data

USER node
EXPOSE 8610
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s \
  CMD wget -qO- http://127.0.0.1:8610/api/status > /dev/null || exit 1
CMD ["node", "server/index.mjs"]
