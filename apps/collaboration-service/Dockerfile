FROM oven/bun:1.3.14 AS install
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps apps
COPY packages packages
# The server image does not ship Electron; dependency lifecycle scripts are
# unnecessary here and remain disabled in this isolated build stage.
RUN bun install --frozen-lockfile --ignore-scripts \
  --filter @selene/collaboration --filter @selene/collaboration-service
RUN bun run --cwd packages/collaboration build

FROM oven/bun:1.3.14
WORKDIR /app
COPY --from=install /app/node_modules node_modules
COPY apps/collaboration-service apps/collaboration-service
COPY --from=install /app/packages/collaboration/package.json packages/collaboration/package.json
COPY --from=install /app/packages/collaboration/dist packages/collaboration/dist
COPY --from=install /app/packages/collaboration/migrations packages/collaboration/migrations
ENV NODE_ENV=production
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8787/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["bun", "run", "--cwd", "apps/collaboration-service", "start"]
