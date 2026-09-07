import { NextResponse } from 'next/server';
import { storage } from '../../../../../lib/storage';

// Dev stand-in for a signed S3 PUT URL (see lib/storage.ts). Swap this
// route out entirely once uploads go directly to real object storage —
// the API layer should never proxy media bytes in production.
export async function PUT(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');

  if (!key) {
    return NextResponse.json({ error: 'Missing key query parameter' }, { status: 400 });
  }
  if (!request.body) {
    return NextResponse.json({ error: 'Missing request body' }, { status: 400 });
  }

  try {
    const bytesWritten = await storage.writeStream(key, request.body);
    return NextResponse.json({ storageKey: key, sizeBytes: bytesWritten });
  } catch {
    return NextResponse.json({ error: 'Invalid storage key' }, { status: 400 });
  }
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.ass': 'text/plain',
  '.srt': 'text/plain',
};

// GET reads a stored object back — the dev-only counterpart to PUT,
// so a rendered short_video's downloadUrl (and any other stored
// object) is actually fetchable in this environment. Note: like PUT,
// this proxy performs no per-request authorization beyond a valid
// storage key existing on disk — acceptable for local dev storage,
// but real object storage should be swapped in (per lib/storage.ts's
// ObjectStorage abstraction) with real signed, time-limited URLs
// before this holds anything sensitive in production.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');
  if (!key) {
    return NextResponse.json({ error: 'Missing key query parameter' }, { status: 400 });
  }

  let result;
  try {
    result = await storage.readStream(key);
  } catch {
    return NextResponse.json({ error: 'Invalid storage key' }, { status: 400 });
  }
  if (!result) {
    return NextResponse.json({ error: 'Object not found' }, { status: 404 });
  }

  const ext = key.slice(key.lastIndexOf('.'));
  const contentType = CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream';

  return new Response(result.stream, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-length': String(result.sizeBytes),
      'accept-ranges': 'bytes',
    },
  });
}
