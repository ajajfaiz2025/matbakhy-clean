import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { runSubprocess } from '../../lib/rendering/ffmpeg';

let cachedHasFfmpeg: boolean | null = null;

/**
 * Whether this environment has a real, working `ffmpeg`. Render tests
 * that need real encoding are gated on this and skip (with a clear
 * console banner) rather than silently mocking FFmpeg and calling the
 * feature verified — see the Step 8 spec's explicit "Clearly
 * distinguish: REAL FFMPEG VERIFIED vs. FFMPEG MOCKED."
 */
export async function hasRealFfmpeg(): Promise<boolean> {
  if (cachedHasFfmpeg !== null) return cachedHasFfmpeg;
  try {
    await runSubprocess('ffmpeg', ['-version'], 5000);
    cachedHasFfmpeg = true;
  } catch {
    cachedHasFfmpeg = false;
  }
  return cachedHasFfmpeg;
}

export interface SyntheticVideoParams {
  outputPath: string;
  durationSeconds: number;
  width?: number;
  height?: number;
  withAudio?: boolean;
}

/**
 * Generates a real, playable synthetic test video via ffmpeg's lavfi
 * test sources (testsrc2 + a sine tone) — a real encoded H.264/AAC MP4,
 * not a fixture file checked into the repo, so tests can freely vary
 * duration/resolution/audio presence per case.
 */
export async function generateSyntheticVideo(params: SyntheticVideoParams): Promise<void> {
  const { outputPath, durationSeconds, width = 1280, height = 720, withAudio = true } = params;
  await mkdir(path.dirname(outputPath), { recursive: true });

  const args = [
    '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30:duration=${durationSeconds}`,
    ...(withAudio ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSeconds}`] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    ...(withAudio ? ['-c:a', 'aac', '-shortest'] : []),
    outputPath,
  ];

  await runSubprocess('ffmpeg', args, 60_000);
}
