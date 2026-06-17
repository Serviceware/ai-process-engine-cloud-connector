FROM denoland/deno:2.8.1

# Create app directory
WORKDIR /app

# Copy source files
COPY deno.json .
COPY deno.lock .
COPY runtime/ ./runtime/
COPY sdk/ ./sdk/

# Cache dependencies
RUN deno cache runtime/main.ts

# Non-root user (Deno image uses uid 1000)
USER deno

# Expose default port
EXPOSE 8080

# Health check (liveness). Needs --allow-env to read CONNECTOR_PORT.
# start-period covers the initial WebSocket connect so the container is not
# marked unhealthy while it is still establishing the first connection.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD deno run --allow-net --allow-env health-check.ts || exit 1

# Start the connector
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "runtime/main.ts"]
