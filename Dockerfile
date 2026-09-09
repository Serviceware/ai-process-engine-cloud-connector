FROM denoland/deno:2.8.1

# Create app directory
WORKDIR /app

# Keep production dependency resolution identical to local development and CI.
COPY deno.json deno.lock ./
COPY runtime/ ./runtime/

# Cache dependencies without allowing the lock file to change.
RUN deno cache --frozen --config deno.json runtime/main.ts

# Non-root user (Deno image uses uid 1000)
USER deno

# Expose default port
EXPOSE 8080

# Health check (liveness). Needs --allow-env to read CONNECTOR_PORT.
# start-period covers the initial WebSocket connect so the container is not
# marked unhealthy while it is still establishing the first connection.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD deno run --allow-net --allow-env runtime/health-check.ts || exit 1

# Start the connector
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "runtime/main.ts"]
