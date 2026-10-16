FROM node:24.22.0-bookworm-slim

LABEL org.opencontainers.image.title="Serviceware AI Process Engine - Cloud Connector" \
    org.opencontainers.image.description="Connects Serviceware AI Process Engine to internal HTTP services" \
    org.opencontainers.image.source="https://github.com/Serviceware/ai-process-engine-cloud-connector" \
    org.opencontainers.image.documentation="https://github.com/Serviceware/ai-process-engine-cloud-connector/blob/main/docs/INSTALLATION.md" \
    org.opencontainers.image.licenses="MIT"

# Create app directory
WORKDIR /app

# Install production dependencies exactly as locked.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable     && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --prod --ignore-scripts     && rm -rf "$(pnpm store path)" /root/.cache

COPY runtime/ ./runtime/

# Non-root user (Node image uses uid 1000)
USER node

# Expose default port
EXPOSE 8080

# Health check (liveness) on the connector's fixed internal probe port.
# start-period covers the initial WebSocket connect so the container is not
# marked unhealthy while it is still establishing the first connection.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD node --permission --allow-fs-read=/app/ runtime/health-check.ts || exit 1

# Start the connector. The permission model limits file reads to the
# application and the mounted configuration; no writes, child processes,
# workers, or native addons.
CMD ["node", "--permission", "--allow-fs-read=/app/", "--allow-fs-read=/config/", "runtime/main.ts"]
