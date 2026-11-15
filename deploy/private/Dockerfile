FROM node:24.17.0-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages ./packages
RUN npm install --global pnpm@11.28.5 && pnpm install --frozen-lockfile
COPY tsconfig.json plugin.schema.json ./
COPY src ./src
COPY scripts ./scripts
COPY fixtures/conformance-plugin ./fixtures/conformance-plugin
COPY web ./web
COPY client/web ./client/web
RUN pnpm build && mkdir -p /app/.local && chown -R 1000:1000 /app/.local
USER node
CMD ["node", "scripts/private/entrypoint.mjs"]
