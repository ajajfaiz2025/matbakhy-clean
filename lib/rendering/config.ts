import type { RenderConfig } from '../../src/domain/schemas';

/**
 * The one deterministic render configuration for the short-video MVP
 * (Step 8, section 3/4: "Use a deterministic render configuration for
 * MVP" / "implement ONE deterministic framing strategy"). This is not
 * a template system — there is exactly one strategy, and nothing here
 * is selectable per-request. Bump TEMPLATE_VERSION if the strategy
 * itself ever changes, so old renders remain traceable to the
 * configuration that actually produced them.
 *
 * Framing strategy ("scale-and-center-crop"): scale the source so both
 * dimensions are >= the 1080x1920 target while preserving its aspect
 * ratio (no distortion), then center-crop to exactly 1080x1920. This
 * one rule handles landscape, square, and already-vertical sources
 * uniformly without a crop editor — it always fills the frame, at the
 * cost of cropping the long axis on non-vertical sources (documented
 * trade-off, not a bug).
 */
export const TEMPLATE_VERSION = 'vertical-9x16-v1';

export const RENDER_CONFIG: RenderConfig = {
  templateVersion: TEMPLATE_VERSION,
  width: 1080,
  height: 1920,
  fps: 30,
  framingStrategy: 'scale-and-center-crop',
  videoCodec: 'libx264',
  audioCodec: 'aac',
  container: 'mp4',
  captionStyle: 'burned-in-single-style-v1',
};

export function getFfmpegTimeoutMs(): number {
  const raw = process.env.FFMPEG_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180_000;
}
