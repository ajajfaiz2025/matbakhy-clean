import { mockTranscriptionProvider } from './mockProvider';
import { openaiTranscriptionProvider } from './openaiProvider';
import type { TranscriptionProvider } from './types';

export function getTranscriptionProvider(): TranscriptionProvider {
  return process.env.OPENAI_API_KEY ? openaiTranscriptionProvider : mockTranscriptionProvider;
}

export type { TranscriptionProvider, TranscriptionResult, TranscriptionSegment } from './types';
