const defaultTimeoutMs = 10_000;
const pollIntervalMs = 25;

/** Polls `probe` until it returns a value other than `undefined`. */
export async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  description: string,
  timeoutMs = defaultTimeoutMs,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
