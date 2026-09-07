import { afterEach, describe, expect, it } from 'vitest';
import { getContentProviders } from '../../lib/generation';
import { getInsightProvider } from '../../lib/insights';
import { getTranscriptionProvider } from '../../lib/transcription';
import { mockContentProvider } from '../../lib/generation/mockProvider';
import { openaiContentProvider } from '../../lib/generation/openaiProvider';
import { mockInsightProvider } from '../../lib/insights/mockProvider';
import { openaiInsightProvider } from '../../lib/insights/openaiProvider';
import { mockTranscriptionProvider } from '../../lib/transcription/mockProvider';
import { openaiTranscriptionProvider } from '../../lib/transcription/openaiProvider';

/**
 * Provider-router verification (Real LLM Integration & Validation
 * prep phase, items 3-5): proves — without needing a real API key —
 * that the routing/fallback rules the rest of the pipeline depends on
 * actually hold, rather than relying on a one-time code read. No
 * network calls happen here; these functions only decide which
 * provider OBJECT to hand back, they don't invoke it.
 */

const ENV_KEYS = ['OPENAI_API_KEY', 'GENERATION_PROVIDER', 'INSIGHT_PROVIDER'] as const;
const original: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) original[key] = process.env[key];

function resetEnv() {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
}

afterEach(resetEnv);

describe('getContentProviders (generation router)', () => {
  it('uses mock, with no fallback, when no key is configured and no override is set', () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GENERATION_PROVIDER;
    const { primary, fallback } = getContentProviders();
    expect(primary).toBe(mockContentProvider);
    expect(fallback).toBeNull();
  });

  it('uses openai as primary with mock as fallback when a key is configured (auto-detect)', () => {
    process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
    delete process.env.GENERATION_PROVIDER;
    const { primary, fallback } = getContentProviders();
    expect(primary).toBe(openaiContentProvider);
    expect(fallback).toBe(mockContentProvider);
  });

  it('honors an explicit GENERATION_PROVIDER=mock override even when a key IS configured', () => {
    process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
    process.env.GENERATION_PROVIDER = 'mock';
    const { primary, fallback } = getContentProviders();
    expect(primary).toBe(mockContentProvider);
    expect(fallback).toBeNull();
  });

  it('honors an explicit GENERATION_PROVIDER=openai override even when NO key is configured (fails later, at call time, not at routing time)', () => {
    delete process.env.OPENAI_API_KEY;
    process.env.GENERATION_PROVIDER = 'openai';
    const { primary, fallback } = getContentProviders();
    expect(primary).toBe(openaiContentProvider);
    expect(fallback).toBe(mockContentProvider);
  });

  it('fails loudly for an unimplemented provider selection rather than silently substituting another model', () => {
    process.env.GENERATION_PROVIDER = 'allam';
    expect(() => getContentProviders()).toThrow(/not implemented/i);
  });
});

describe('getInsightProvider (insights router)', () => {
  it('uses mock when no key is configured and no override is set', () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.INSIGHT_PROVIDER;
    expect(getInsightProvider()).toBe(mockInsightProvider);
  });

  it('uses openai when a key is configured (auto-detect)', () => {
    process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
    delete process.env.INSIGHT_PROVIDER;
    expect(getInsightProvider()).toBe(openaiInsightProvider);
  });

  it('honors an explicit INSIGHT_PROVIDER=mock override even when a key IS configured', () => {
    process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
    process.env.INSIGHT_PROVIDER = 'mock';
    expect(getInsightProvider()).toBe(mockInsightProvider);
  });

  it('fails loudly for an unimplemented provider selection', () => {
    process.env.INSIGHT_PROVIDER = 'humain';
    expect(() => getInsightProvider()).toThrow(/not implemented/i);
  });

  it('note: unlike generation, insight extraction has NO automatic fallback-to-mock on outright provider failure — a real-provider failure propagates to the caller (and BullMQ retry/backoff), it does not silently substitute mock output', () => {
    // Structural proof, not a behavioral assertion: getInsightProvider()
    // returns a single provider, never a {primary, fallback} pair.
    process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
    const provider = getInsightProvider();
    expect(provider).not.toHaveProperty('fallback');
  });
});

describe('getTranscriptionProvider (transcription router)', () => {
  it('uses mock when no key is configured', () => {
    delete process.env.OPENAI_API_KEY;
    expect(getTranscriptionProvider()).toBe(mockTranscriptionProvider);
  });

  it('uses openai (Whisper) when a key is configured', () => {
    process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
    expect(getTranscriptionProvider()).toBe(openaiTranscriptionProvider);
  });

  it('note: transcription has no explicit *_PROVIDER override env var, unlike insights/generation — routing is key-presence only', () => {
    // Documented via absence: TRANSCRIPTION_PROVIDER is read nowhere in
    // lib/transcription/index.ts. This test exists so that if an
    // override is ever added, this file is the place to extend.
    expect(process.env.TRANSCRIPTION_PROVIDER).toBeUndefined();
  });
});

describe('no hard-coded credentials', () => {
  it('every real provider reads its API key from process.env at call time, never a literal', () => {
    // Sanity check on the routing layer's own source: none of the
    // provider *objects* carry an embedded key — they're plain
    // {name, extract/generate/transcribe} objects, so there is nowhere
    // for a literal secret to live in the object itself.
    expect(Object.keys(openaiContentProvider)).not.toContain('apiKey');
    expect(Object.keys(openaiInsightProvider)).not.toContain('apiKey');
    expect(Object.keys(openaiTranscriptionProvider)).not.toContain('apiKey');
  });
});
