import { readFile } from 'node:fs/promises';
import { fetchWithTimeout, getProviderTimeoutMs } from '../providers/fetchWithTimeout';
import type { TranscriptionProvider } from './types';

/**
 * Whisper-backed provider. NOTE: this has not been exercised against a
 * real OpenAI API key in this environment — review it against a live
 * account before depending on it in production, and confirm the
 * `verbose_json` segment shape still matches OpenAI's current API.
 */
export const openaiTranscriptionProvider: TranscriptionProvider = {
  name: 'openai:whisper-1',
  async transcribe({ filePath }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not configured.');
    }

    const fileBuffer = await readFile(filePath);
    const form = new FormData();
    form.append('file', new Blob([fileBuffer]), 'source');
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');

    // Audio upload + transcription can legitimately take longer than a
    // typical JSON call, hence the higher default (section: real-provider
    // readiness — a timeout throws into the same job retry/backoff as
    // any other provider failure, it doesn't add a new retry path).
    const timeoutMs = getProviderTimeoutMs('TRANSCRIPTION_TIMEOUT_MS', 120_000);
    const response = await fetchWithTimeout('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    }, timeoutMs);

    if (!response.ok) {
      throw new Error(`OpenAI transcription failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as {
      language: string;
      segments: Array<{ start: number; end: number; text: string }>;
    };

    return {
      language: data.language,
      confidence: null,
      segments: data.segments.map((segment) => ({
        startMs: Math.round(segment.start * 1000),
        endMs: Math.round(segment.end * 1000),
        text: segment.text.trim(),
        speaker: null,
      })),
    };
  },
};
