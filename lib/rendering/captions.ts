import { writeFile } from 'node:fs/promises';
import type { RenderConfig } from '../../src/domain/schemas';

export interface CaptionSegmentInput {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface CaptionCue {
  startMs: number;
  endMs: number;
  text: string;
  segmentId: string;
}

// Readability budget for one on-screen caption chunk. Deterministic,
// language-agnostic: it splits on whitespace, which works for both
// Arabic and English (both use spaces between words) and for mixed
// Arabic/English text within one segment.
const MAX_CHUNK_CHARS = 42;
const MAX_CHUNK_WORDS = 8;
const MIN_CUE_MS = 500;

function chunkText(text: string): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const word of words) {
    const addedLen = current.length === 0 ? word.length : currentLen + 1 + word.length;
    if (current.length > 0 && (addedLen > MAX_CHUNK_CHARS || current.length >= MAX_CHUNK_WORDS)) {
      chunks.push(current.join(' '));
      current = [word];
      currentLen = word.length;
    } else {
      current.push(word);
      currentLen = addedLen;
    }
  }
  if (current.length > 0) chunks.push(current.join(' '));
  return chunks;
}

/**
 * Builds caption cues from real transcript segments, clipped to a
 * candidateClip's [clipStartMs, clipEndMs) window and re-based to
 * clip-relative time (Step 8, section 5: "synchronize with speech
 * timing" / "break text into readable chunks"). Segment-level timing
 * is all the transcript provides, so a segment's chunks are
 * distributed proportionally across its (clip-clamped) time span by
 * cumulative character position — a deterministic approximation, not
 * word-level forced alignment, but it keeps every cue inside the
 * segment window it was spoken in and never outside the clip.
 */
export function buildCaptionCues(
  segments: CaptionSegmentInput[],
  clipStartMs: number,
  clipEndMs: number
): CaptionCue[] {
  const cues: CaptionCue[] = [];

  for (const segment of segments) {
    const effStart = Math.max(segment.startMs, clipStartMs);
    const effEnd = Math.min(segment.endMs, clipEndMs);
    if (effEnd <= effStart) continue;

    const chunks = chunkText(segment.text);
    if (chunks.length === 0) continue;

    const totalChars = chunks.reduce((sum, c) => sum + c.length, 0);
    const span = effEnd - effStart;
    let cursorChars = 0;

    for (const chunk of chunks) {
      const fractionStart = cursorChars / totalChars;
      cursorChars += chunk.length;
      const fractionEnd = cursorChars / totalChars;

      const cueStart = Math.round(effStart + fractionStart * span);
      const idealEnd = Math.round(effStart + fractionEnd * span);
      const withMinDuration = Math.max(idealEnd, cueStart + MIN_CUE_MS);
      const cueEnd = Math.max(cueStart + 1, Math.min(withMinDuration, effEnd));

      cues.push({
        startMs: cueStart - clipStartMs,
        endMs: cueEnd - clipStartMs,
        text: chunk,
        segmentId: segment.id,
      });
    }
  }

  return cues.sort((a, b) => a.startMs - b.startMs);
}

function formatAssTime(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalCentiseconds = Math.round(clamped / 10);
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

// ASS override-code braces would otherwise be interpreted as styling
// commands if they appeared literally in transcript text; \N is ASS's
// hard line break.
function escapeAssText(text: string): string {
  return text.replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');
}

// Arabic script blocks (Arabic, Supplement, Extended-A, Presentation
// Forms A/B) — covers Arabic-language transcript text plus common
// Arabic punctuation variants.
const ARABIC_RANGE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

function containsArabic(text: string): boolean {
  return ARABIC_RANGE.test(text);
}

/**
 * One deterministic caption *style* (Step 8, section 5: "exactly ONE
 * caption style. No style system.") — same size, color, outline, and
 * bottom-center position for every cue. Internally it is implemented
 * as two ASS style *records* differing only in Fontname, selected
 * automatically per-cue by script detection, never by user choice.
 * This is a correctness fix, not a style system: verified empirically
 * in this environment that libass's automatic fontconfig fallback from
 * a generic "Sans" alias resolves Arabic glyphs to DejaVu Sans (which
 * lacks Arabic coverage) rather than to an actual Arabic-capable font
 * — so an Arabic-containing cue is rendered directly with "Noto Naskh
 * Arabic" as PRIMARY font (which does correctly shape Arabic and
 * covers Western digits), and only a non-Arabic cue uses "DejaVu Sans"
 * as primary. Any Latin word embedded in an Arabic cue still resolves
 * correctly, since fontconfig fallback *from* Noto Naskh Arabic *to* a
 * Latin face was verified to work (unlike the reverse direction).
 * Bottom-center alignment plus libass's built-in fribidi+harfbuzz
 * (verified via `ffmpeg -version`) handles RTL reordering and complex
 * shaping without any further per-language branching here.
 */
export function buildAssDocument(cues: CaptionCue[], config: RenderConfig): string {
  const fontSize = Math.round(config.width * 0.06);
  const marginV = Math.round(config.height * 0.08);

  const styleFields = (name: string, fontName: string) =>
    `Style: ${name},${fontName},${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,60,60,${marginV},1`;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${config.width}
PlayResY: ${config.height}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleFields('Default', 'DejaVu Sans')}
${styleFields('Arabic', 'Noto Naskh Arabic')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const lines = cues.map((cue) => {
    const style = containsArabic(cue.text) ? 'Arabic' : 'Default';
    return `Dialogue: 0,${formatAssTime(cue.startMs)},${formatAssTime(cue.endMs)},${style},,0,0,0,,${escapeAssText(cue.text)}`;
  });

  return [header, ...lines].join('\n') + '\n';
}

export async function writeAssFile(filePath: string, cues: CaptionCue[], config: RenderConfig): Promise<void> {
  await writeFile(filePath, buildAssDocument(cues, config), 'utf-8');
}
