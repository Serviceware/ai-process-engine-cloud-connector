FROM denoland/deno:2.8.1

# Create app directory
WORKDIR /app

# Copy source files
COPY runtime/ ./runtime/
COPY sdk/ ./sdk/

# Cache dependencies with the runtime configuration and lock file.
RUN deno cache --config runtime/deno.json runtime/main.ts

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
