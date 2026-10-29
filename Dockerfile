FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: lefthook's install hook needs git and is a dev-only tool anyway.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=build /app/dist ./dist
# The server binds 127.0.0.1 by default, which is unreachable from outside the container.
# 8000 is the port the catalog assumes for runtimes whose docs don't name one.
# Images go back inline: the agents calling this runtime can't see its filesystem.
ENV FRAMELINK_HOST=0.0.0.0 \
    FRAMELINK_PORT=8000 \
    FRAMELINK_TELEMETRY=off \
    INLINE_IMAGES=true
EXPOSE 8000
USER node
CMD ["node", "dist/bin.js"]
