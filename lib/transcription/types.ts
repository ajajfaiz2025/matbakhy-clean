export interface TranscriptionSegment {
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
}

export interface TranscriptionResult {
  language: string;
  confidence: number | null;
  segments: TranscriptionSegment[];
}

// Provider abstraction (section 4.1 / 6.2): the pipeline should be able
// to swap speech-to-text providers, or fall back between them, without
// changing the transcription worker or the internal transcript schema.
export interface TranscriptionProvider {
  name: string;
  transcribe(input: { filePath: string }): Promise<TranscriptionResult>;
}
