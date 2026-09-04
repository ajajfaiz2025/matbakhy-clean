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
