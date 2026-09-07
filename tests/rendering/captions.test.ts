import { describe, expect, it } from 'vitest';
import { buildAssDocument, buildCaptionCues, type CaptionSegmentInput } from '../../lib/rendering/captions';
import { RENDER_CONFIG } from '../../lib/rendering/config';

function seg(id: string, text: string, startMs: number, endMs: number): CaptionSegmentInput {
  return { id, text, startMs, endMs };
}

describe('buildCaptionCues', () => {
  it('produces cues clipped to the clip window and re-based to clip-relative time', () => {
    const segments = [seg('s1', 'hello there friend', 0, 3000), seg('s2', 'this is segment two', 3000, 6000)];
    const cues = buildCaptionCues(segments, 1000, 5000);

    for (const cue of cues) {
      expect(cue.startMs).toBeGreaterThanOrEqual(0);
      expect(cue.endMs).toBeLessThanOrEqual(5000 - 1000);
    }
  });

  it('never splits a segment into a cue that starts before or ends after its own clamped span', () => {
    const segments = [seg('s1', 'a b c d e f g h i j k l m n o p q r s t', 0, 10000)];
    const cues = buildCaptionCues(segments, 0, 10000);
    expect(cues.length).toBeGreaterThan(1); // long text gets chunked into multiple readable cues
    for (const cue of cues) {
      expect(cue.startMs).toBeGreaterThanOrEqual(0);
      expect(cue.endMs).toBeLessThanOrEqual(10000);
    }
    // cues are in non-decreasing time order
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i].startMs).toBeGreaterThanOrEqual(cues[i - 1].startMs);
    }
  });

  it('drops segments entirely outside the clip window', () => {
    const segments = [seg('before', 'not in clip', 0, 1000), seg('in', 'in the clip', 5000, 6000)];
    const cues = buildCaptionCues(segments, 5000, 7000);
    expect(cues.every((c) => c.segmentId === 'in')).toBe(true);
  });

  it('handles an Arabic segment: chunking on whitespace works the same as English', () => {
    const segments = [seg('s1', 'مرحبا بكم في هذا الاختبار للترجمة العربية اليوم', 0, 4000)];
    const cues = buildCaptionCues(segments, 0, 4000);
    expect(cues.length).toBeGreaterThan(0);
    expect(cues.every((c) => c.text.length > 0)).toBe(true);
  });

  it('handles a segment mixing Arabic and English/numbers without crashing', () => {
    const segments = [seg('s1', 'مرحبا Hello 123 مزيج mixed text', 0, 3000)];
    const cues = buildCaptionCues(segments, 0, 3000);
    expect(cues.length).toBeGreaterThan(0);
  });

  it('is deterministic: identical input always produces identical cues', () => {
    const segments = [seg('s1', 'the quick brown fox jumps over the lazy dog again and again', 0, 5000)];
    const a = buildCaptionCues(segments, 0, 5000);
    const b = buildCaptionCues(segments, 0, 5000);
    expect(a).toEqual(b);
  });

  it('produces no cues for a clip window with no overlapping segments', () => {
    const segments = [seg('s1', 'somewhere else', 20000, 21000)];
    expect(buildCaptionCues(segments, 0, 5000)).toEqual([]);
  });
});

describe('buildAssDocument', () => {
  it('emits both a Default and an Arabic style, and PlayRes matching the render config', () => {
    const doc = buildAssDocument([], RENDER_CONFIG);
    expect(doc).toContain(`PlayResX: ${RENDER_CONFIG.width}`);
    expect(doc).toContain(`PlayResY: ${RENDER_CONFIG.height}`);
    expect(doc).toContain('Style: Default,DejaVu Sans');
    expect(doc).toContain('Style: Arabic,Noto Naskh Arabic');
  });

  it('routes an Arabic-containing cue to the Arabic style and a Latin cue to Default', () => {
    const cues = [
      { startMs: 0, endMs: 1000, text: 'Hello world', segmentId: 's1' },
      { startMs: 1000, endMs: 2000, text: 'مرحبا بكم', segmentId: 's2' },
    ];
    const doc = buildAssDocument(cues, RENDER_CONFIG);
    const lines = doc.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(lines[0]).toContain(',Default,');
    expect(lines[0]).toContain('Hello world');
    expect(lines[1]).toContain(',Arabic,');
    expect(lines[1]).toContain('مرحبا بكم');
  });

  it('routes a mixed-script cue to the Arabic style (so the Arabic portion shapes correctly)', () => {
    const cues = [{ startMs: 0, endMs: 1000, text: 'Hello مرحبا 123', segmentId: 's1' }];
    const doc = buildAssDocument(cues, RENDER_CONFIG);
    expect(doc).toMatch(/Dialogue:.*,Arabic,.*Hello مرحبا 123/);
  });

  it('escapes ASS override-code braces so transcript text cannot inject styling commands', () => {
    const cues = [{ startMs: 0, endMs: 1000, text: 'weird {test} value}', segmentId: 's1' }];
    const doc = buildAssDocument(cues, RENDER_CONFIG);
    expect(doc).toContain('weird \\{test\\} value\\}');
  });

  it('converts newlines to ASS hard line breaks', () => {
    const cues = [{ startMs: 0, endMs: 1000, text: 'line one\nline two', segmentId: 's1' }];
    const doc = buildAssDocument(cues, RENDER_CONFIG);
    expect(doc).toContain('line one\\Nline two');
  });

  it('produces a valid, non-empty document even with zero cues (silent clip)', () => {
    const doc = buildAssDocument([], RENDER_CONFIG);
    expect(doc).toContain('[Script Info]');
    expect(doc).toContain('[V4+ Styles]');
    expect(doc).toContain('[Events]');
  });
});
