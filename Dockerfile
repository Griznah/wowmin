# syntax=docker/dockerfile:1
# Web-service image — no Electron at runtime; serves dist/web-server.js (WOWMIN_* env config).
FROM node:20-slim AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:ts && npm run build:css

FROM node:20-slim
ENV NODE_ENV=production WOWMIN_HOST=0.0.0.0 WOWMIN_PORT=3000 WOWMIN_DATA_DIR=/data
WORKDIR /app
# Runtime needs only the esbuild externals: mysql2, ssh2, xml2js (+ transitives).
# --ignore-scripts: skips stormlib-js native build (unused by web server) and
# ssh2 optional crypto binding (pure-JS fallback).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist/ dist/
COPY --from=build /app/renderer/ renderer/
COPY assets/ assets/
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
USER node
EXPOSE 3000
CMD ["node", "dist/web-server.js"]
