export type HealthFetch = typeof fetch;

/**
 * Health check script for Docker HEALTHCHECK.
 * Checks if the Cloud Connector is responding to the health endpoint.
 */
export async function checkHealth(
  port = 8080,
  fetcher: HealthFetch = fetch,
): Promise<number> {
  try {
    const response = await fetcher(`http://localhost:${port}/health`);
    return response.ok ? 0 : 1;
  } catch {
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await checkHealth());
}
