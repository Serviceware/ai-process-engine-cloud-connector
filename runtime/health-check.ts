import { describeError } from "./runtime-error.ts";

export type HealthFetch = typeof fetch;

/**
 * Health check script for Docker HEALTHCHECK.
 * Checks if the Cloud Connector is responding to the health endpoint.
 */
export async function checkHealth(port = 8080, fetcher: HealthFetch = fetch): Promise<number> {
  try {
    const response = await fetcher(`http://localhost:${port}/health`);
    if (response.ok) return 0;
    console.error(`Health check failed: HTTP ${response.status}`);
    return 1;
  } catch (error) {
    console.error(`Health check failed: ${describeError(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await checkHealth());
}
