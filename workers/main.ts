import 'dotenv/config';
import { extractInsights } from '../lib/pipeline/extractInsights';
import { generateContent } from '../lib/pipeline/generateContent';
import { normalizeMedia } from '../lib/pipeline/normalizeMedia';
import { renderShortVideo } from '../lib/pipeline/renderShortVideo';
import { transcribeMedia } from '../lib/pipeline/transcribeMedia';
import { startPipelineWorker } from '../lib/queue';

// Standalone media-processing-plane entrypoint (section 4): run with
// `npm run worker`, separately from the Next.js API process, so
// long-running FFmpeg/transcription/analysis/generation/render work
// can't degrade request latency and each plane can scale independently.
const worker = startPipelineWorker({
  normalization: normalizeMedia,
  transcription: transcribeMedia,
  analysis: extractInsights,
  generation: generateContent,
  render: renderShortVideo,
});

console.log('Pipeline worker started — listening for normalization/transcription/analysis/generation/render jobs.');

async function shutdown() {
  await worker.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
