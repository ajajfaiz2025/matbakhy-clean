import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout, getProviderTimeoutMs } from '../../lib/providers/fetchWithTimeout';

describe('getProviderTimeoutMs', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('falls back to the given default when nothing is configured', () => {
    delete process.env.SOME_TIMEOUT_MS;
    delete process.env.PROVIDER_TIMEOUT_MS;
    expect(getProviderTimeoutMs('SOME_TIMEOUT_MS', 9999)).toBe(9999);
  });

  it('prefers the specific env var over the generic PROVIDER_TIMEOUT_MS', () => {
    process.env.SOME_TIMEOUT_MS = '1234';
    process.env.PROVIDER_TIMEOUT_MS = '5678';
    expect(getProviderTimeoutMs('SOME_TIMEOUT_MS', 9999)).toBe(1234);
  });

  it('falls back to the generic PROVIDER_TIMEOUT_MS when the specific one is unset', () => {
    delete process.env.SOME_TIMEOUT_MS;
    process.env.PROVIDER_TIMEOUT_MS = '5678';
    expect(getProviderTimeoutMs('SOME_TIMEOUT_MS', 9999)).toBe(5678);
  });

  it('ignores garbage values and falls back to the default', () => {
    process.env.SOME_TIMEOUT_MS = 'not-a-number';
    expect(getProviderTimeoutMs('SOME_TIMEOUT_MS', 9999)).toBe(9999);
  });
});

describe('fetchWithTimeout', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('rejects with a clear timeout error when the upstream request never resolves', async () => {
    // Simulate a hung request: fetch's promise only ever settles when
    // the AbortController's signal fires.
    global.fetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }) as unknown as typeof fetch;

    const start = Date.now();
    await expect(fetchWithTimeout('https://example.invalid/hang', {}, 50)).rejects.toThrow(/timed out after 50ms/);
    // A real request-hang scenario, not an immediate synchronous throw —
    // proves the timer, not some other code path, triggered the reject.
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it('resolves normally when the upstream request finishes before the timeout', async () => {
    global.fetch = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
    const response = await fetchWithTimeout('https://example.invalid/fast', {}, 5000);
    expect(response.status).toBe(200);
  });

  it('propagates non-abort errors unchanged (e.g. DNS/network failure)', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network error: getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    await expect(fetchWithTimeout('https://example.invalid/broken', {}, 5000)).rejects.toThrow(/network error/);
  });
});
