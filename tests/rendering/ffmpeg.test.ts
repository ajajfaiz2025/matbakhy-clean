import { describe, expect, it } from 'vitest';
import {
  FfmpegExitError,
  FfmpegMissingError,
  FfmpegTimeoutError,
  probeMedia,
  runSubprocess,
} from '../../lib/rendering/ffmpeg';
import { generateSyntheticVideo, hasRealFfmpeg } from './fixtures';

describe('runSubprocess', () => {
  it('rejects with FfmpegMissingError when the binary does not exist (ENOENT)', async () => {
    await expect(runSubprocess('definitely-not-a-real-binary-xyz', [], 5000)).rejects.toBeInstanceOf(FfmpegMissingError);
  });

  it('rejects with FfmpegTimeoutError and kills the process when it exceeds the timeout', async () => {
    const startedAt = Date.now();
    await expect(runSubprocess('sleep', ['5'], 200)).rejects.toBeInstanceOf(FfmpegTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(2000); // actually killed, not left to run to completion
  });

  it('rejects with FfmpegExitError on a non-zero exit code', async () => {
    await expect(runSubprocess('sh', ['-c', 'echo failing 1>&2; exit 3'], 5000)).rejects.toBeInstanceOf(FfmpegExitError);
  });

  it('resolves with stdout/stderr on success', async () => {
    const result = await runSubprocess('sh', ['-c', 'echo hello'], 5000);
    expect(result.stdout.trim()).toBe('hello');
  });
});

describe('probeMedia (real ffprobe)', () => {
  it('reports duration/resolution/codecs/audio for a real generated fixture', async () => {
    if (!(await hasRealFfmpeg())) {
      console.warn('FFMPEG MOCKED (ffmpeg not available in this environment) — probeMedia real test skipped.');
      return;
    }
    console.log('REAL FFMPEG VERIFIED — probeMedia against a real encoded fixture.');

    const outputPath = `/tmp/vitest-probe-fixture-${Date.now()}.mp4`;
    await generateSyntheticVideo({ outputPath, durationSeconds: 3, width: 640, height: 360, withAudio: true });

    const probe = await probeMedia(outputPath, 30_000);
    expect(probe.durationMs).toBeGreaterThan(2500);
    expect(probe.durationMs).toBeLessThan(3500);
    expect(probe.width).toBe(640);
    expect(probe.height).toBe(360);
    expect(probe.videoCodec).toBe('h264');
    expect(probe.hasAudio).toBe(true);
    expect(probe.audioCodec).toBe('aac');
  });

  it('throws a clear error for a corrupt/invalid file rather than crashing', async () => {
    if (!(await hasRealFfmpeg())) {
      console.warn('FFMPEG MOCKED — corrupt-file probeMedia test skipped.');
      return;
    }
    const badPath = `/tmp/vitest-corrupt-${Date.now()}.mp4`;
    await import('node:fs/promises').then((fs) => fs.writeFile(badPath, 'this is not a video file'));
    await expect(probeMedia(badPath, 10_000)).rejects.toThrow();
  });
});
