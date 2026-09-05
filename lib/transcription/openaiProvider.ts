import { readFile } from 'node:fs/promises';
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

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

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
