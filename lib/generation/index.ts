import { mockContentProvider } from './mockProvider';
import { openaiContentProvider } from './openaiProvider';
import type { ContentGenerationProvider } from './types';

export interface ContentProviderSelection {
  primary: ContentGenerationProvider;
  // A safety net if the primary provider fails outright (network error,
  // rate limit, auth failure) — see lib/pipeline/generateContent.ts,
  // which only falls back on a provider-level throw, never to paper
  // over a validation/grounding failure.
  fallback: ContentGenerationProvider | null;
}

/**
 * Provider router (section 7: "primary provider, fallback provider,
 * future Arabic-specialized provider"). GENERATION_PROVIDER lets an
 * operator pin a primary provider explicitly; otherwise it falls back
 * to OpenAI if a key is configured, or the mock provider for dev/test.
 *
 * "allam"/"humain" are accepted as valid selections so the
 * abstraction is ready to route to an Arabic-focused model once an
 * API for it exists — selecting it fails loudly rather than silently
 * using a different model, since a caller who explicitly asked for it
 * should know it isn't available yet.
 */
export function getContentProviders(): ContentProviderSelection {
  const requested = process.env.GENERATION_PROVIDER?.toLowerCase();

  if (requested === 'allam' || requested === 'humain') {
    throw new Error(
      `GENERATION_PROVIDER="${requested}" is not implemented yet — no HUMAIN/ALLAM API integration exists in this codebase. Unset GENERATION_PROVIDER or set it to "mock"/"openai".`
    );
  }
  if (requested === 'openai') {
    return { primary: openaiContentProvider, fallback: mockContentProvider };
  }
  if (requested === 'mock') {
    return { primary: mockContentProvider, fallback: null };
  }

  return process.env.OPENAI_API_KEY
    ? { primary: openaiContentProvider, fallback: mockContentProvider }
    : { primary: mockContentProvider, fallback: null };
}

export type { ContentGenerationProvider, ContentGenerationInput, InsightSummary } from './types';
