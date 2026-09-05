import { stat } from 'node:fs/promises';
import type { TranscriptionProvider } from './types';

/**
 * Deterministic placeholder provider — it does not perform real speech
 * recognition. It exists so the ingestion -> normalization ->
 * transcription pipeline can be built, run, and tested end to end
 * before a real speech-to-text budget/API key is wired up. Swap
 * getTranscriptionProvider() (./index.ts) to a real provider once one
 * is configured.
 */
export const mockTranscriptionProvider: TranscriptionProvider = {
  name: 'mock',
  async transcribe({ filePath }) {
    const { size } = await stat(filePath);
    const approxSeconds = Math.max(5, Math.min(60, Math.round(size / 50_000)));

    return {
      language: 'en',
      confidence: null,
      segments: [
        {
          startMs: 0,
          endMs: approxSeconds * 1000,
          text: '[mock transcript — configure a real speech-to-text provider to replace this]',
          speaker: null,
        },
      ],
    };
  },
};
