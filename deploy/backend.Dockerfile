# syntax=docker/dockerfile:1
# Build from the repository root; private files are excluded by .dockerignore.
FROM node:24.18.0-bookworm-slim AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY shared/package.json ./shared/package.json
RUN npm ci --ignore-scripts --workspace backend --include-workspace-root
COPY tsconfig.json ./tsconfig.json
COPY backend/tsconfig.json ./backend/tsconfig.json
COPY backend/scripts ./backend/scripts
COPY backend/src ./backend/src
COPY shared ./shared
RUN npm run build --workspace backend

FROM node:24.18.0-bookworm-slim AS runtime-dependencies
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY shared/package.json ./shared/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace backend --include-workspace-root

FROM node:24.18.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3210 DATA_DIR=/var/lib/private-stage
WORKDIR /workspace
# Dependency stage contains workspace manifests and installed API dependencies,
# not frontend source, frontend assets, local configuration or private data.
COPY --from=runtime-dependencies --chown=node:node /workspace/ ./
COPY --from=build --chown=node:node /workspace/backend/dist ./backend/dist
COPY --chown=node:node --chmod=0555 deploy/backend-entrypoint.sh /usr/local/bin/private-stage-backend
RUN mkdir -p /var/lib/private-stage && chown node:node /var/lib/private-stage
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node --input-type=module -e "import http from 'node:http'; const req=http.get('http://127.0.0.1:3210/healthz',{headers:{host:new URL(process.env.APP_URL).host},timeout:3000},r=>{let body='';r.on('data',chunk=>body+=chunk);r.on('end',()=>{try{const b=JSON.parse(body);process.exit(r.statusCode===200&&b.ok&&b.service==='private-stage'?0:1);}catch{process.exit(1);}});r.on('error',()=>process.exit(1));});req.on('timeout',()=>req.destroy());req.on('error',()=>process.exit(1));"
ENTRYPOINT ["/usr/local/bin/private-stage-backend"]
CMD ["node", "backend/dist/index.js", "--api-only"]
