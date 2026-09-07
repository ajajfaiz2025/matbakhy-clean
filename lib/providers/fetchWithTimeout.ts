/**
 * Shared timeout wrapper for real-provider HTTP calls (P1 from the
 * Step 6/7 quality gate: "no upstream request can hang indefinitely").
 * A timeout surfaces as a plain thrown Error — indistinguishable from
 * any other provider failure to the callers in lib/pipeline/*, so it
 * flows into the exact same job-level retry/backoff (lib/queue.ts)
 * and, for content generation, primary/fallback behavior that already
 * exists for other provider errors. No new retry mechanism needed.
 */

const DEFAULT_TIMEOUT_MS = 60_000;

export function getProviderTimeoutMs(specificEnvVar: string, fallbackMs = DEFAULT_TIMEOUT_MS): number {
  const raw = process.env[specificEnvVar] ?? process.env.PROVIDER_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
