import { spawn } from 'node:child_process';

export class FfmpegMissingError extends Error {
  constructor(binary: string) {
    super(`${binary} is not installed on this worker (install FFmpeg to enable short-video rendering).`);
  }
}

export class FfmpegTimeoutError extends Error {
  constructor(binary: string, timeoutMs: number) {
    super(`${binary} process timed out after ${timeoutMs}ms and was killed.`);
  }
}

export class FfmpegExitError extends Error {
  constructor(binary: string, code: number | null, signal: string | null, stderrTail: string) {
    super(`${binary} exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}: ${stderrTail}`);
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs an ffmpeg/ffprobe subprocess with a hard timeout (Step 8,
 * section 12: "a hung FFmpeg process must not leave a render job
 * permanently running"). Mirrors the AbortController pattern already
 * used for HTTP providers (lib/providers/fetchWithTimeout.ts), just at
 * the subprocess level: SIGKILL on timeout, always cleaned up, and
 * ENOENT (binary missing) surfaced as a distinct, clearly-named error
 * rather than a generic spawn failure.
 */
export function runSubprocess(binary: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(new FfmpegMissingError(binary));
      } else {
        reject(error);
      }
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new FfmpegTimeoutError(binary, timeoutMs));
        return;
      }
      if (code !== 0) {
        reject(new FfmpegExitError(binary, code, signal, stderr.slice(-2000)));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export interface ProbeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
}

export interface ProbeResult {
  durationMs: number;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
}

/**
 * Real, measured media metadata via ffprobe — never assumed. Used both
 * to validate the source before rendering and to record the actual
 * output metadata (duration/resolution/codec/size) after.
 */
export async function probeMedia(filePath: string, timeoutMs: number): Promise<ProbeResult> {
  const { stdout } = await runSubprocess(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    timeoutMs
  );

  let parsed: { format?: { duration?: string }; streams?: ProbeStream[] };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`ffprobe produced unparseable output for ${filePath}`);
  }

  const durationSeconds = parsed.format?.duration ? Number(parsed.format.duration) : NaN;
  if (!Number.isFinite(durationSeconds)) {
    throw new Error(`ffprobe could not determine a duration for ${filePath} — file may be corrupt or invalid.`);
  }

  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');

  return {
    durationMs: Math.round(durationSeconds * 1000),
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    hasAudio: Boolean(audioStream),
  };
}
