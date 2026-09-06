import { mockInsightProvider } from './mockProvider';
import { openaiInsightProvider } from './openaiProvider';
import type { InsightExtractionProvider } from './types';

/**
 * Provider router (section 6.4.8: "select models by task requirements
 * rather than using one model for every call"). INSIGHT_PROVIDER lets
 * an operator pin a provider explicitly; otherwise it falls back to
 * OpenAI if a key is configured, or the mock provider for dev/test.
 *
 * "allam" is accepted as a valid selection so the abstraction is ready
 * to route to an Arabic-focused model (e.g. HUMAIN/ALLAM) once an API
 * for it exists — it fails loudly rather than silently falling back,
 * since a caller who explicitly asked for it should not get a
 * different model's output without knowing.
 */
export function getInsightProvider(): InsightExtractionProvider {
  const requested = process.env.INSIGHT_PROVIDER?.toLowerCase();

  if (requested === 'allam' || requested === 'humain') {
    throw new Error(
      `INSIGHT_PROVIDER="${requested}" is not implemented yet — no HUMAIN/ALLAM API integration exists in this codebase. Unset INSIGHT_PROVIDER or set it to "mock"/"openai".`
    );
  }
  if (requested === 'openai') {
    return openaiInsightProvider;
  }
  if (requested === 'mock') {
    return mockInsightProvider;
  }

  return process.env.OPENAI_API_KEY ? openaiInsightProvider : mockInsightProvider;
}

export type { InsightExtractionProvider, InsightExtractionInput, TranscriptSegmentInput } from './types';
