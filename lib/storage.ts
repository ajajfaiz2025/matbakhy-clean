import { randomUUID } from 'node:crypto';
import { mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Object storage abstraction (section 4.1 / 6.1). Production should
 * point this at S3-compatible storage with short-lived signed URLs;
 * this module ships a local-filesystem implementation so the upload
 * flow is runnable in dev without external credentials.
 */
export interface UploadSession {
  storageKey: string;
  uploadUrl: string;
  method: 'PUT';
  expiresAt: Date;
}

export interface ObjectHead {
  exists: boolean;
  sizeBytes: number | null;
}

export interface ObjectStorage {
  createUploadSession(params: { workspaceId: string; suggestedName: string }): Promise<UploadSession>;
  head(storageKey: string): Promise<ObjectHead>;
  getSignedDownloadUrl(storageKey: string): Promise<string>;
}

const UPLOAD_TTL_MS = 15 * 60 * 1000;
const STORAGE_ROOT = path.join(process.cwd(), '.data', 'storage');

class LocalFilesystemStorage implements ObjectStorage {
  async createUploadSession({
    workspaceId,
    suggestedName,
  }: {
    workspaceId: string;
    suggestedName: string;
  }): Promise<UploadSession> {
    const safeName = suggestedName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storageKey = `${workspaceId}/${randomUUID()}-${safeName}`;
    await mkdir(path.dirname(this.resolve(storageKey)), { recursive: true });
    return {
      storageKey,
      // Dev stand-in for a signed S3 PUT URL: a local API route that
      // streams the request body straight to disk at this key.
      uploadUrl: `/api/v1/uploads/blob?key=${encodeURIComponent(storageKey)}`,
      method: 'PUT',
      expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
    };
  }

  async head(storageKey: string): Promise<ObjectHead> {
    try {
      const info = await stat(this.resolve(storageKey));
      return { exists: true, sizeBytes: info.size };
    } catch {
      return { exists: false, sizeBytes: null };
    }
  }

  async getSignedDownloadUrl(storageKey: string): Promise<string> {
    return `/api/v1/uploads/blob?key=${encodeURIComponent(storageKey)}`;
  }

  resolve(storageKey: string): string {
    const resolved = path.join(STORAGE_ROOT, storageKey);
    if (!resolved.startsWith(STORAGE_ROOT)) {
      throw new Error('Invalid storage key');
    }
    return resolved;
  }

  async writeText(storageKey: string, contents: string): Promise<number> {
    const filePath = this.resolve(storageKey);
    await mkdir(path.dirname(filePath), { recursive: true });
    const buffer = Buffer.from(contents, 'utf-8');
    const handle = await open(filePath, 'w');
    try {
      await handle.write(buffer);
    } finally {
      await handle.close();
    }
    return buffer.byteLength;
  }

  async writeStream(storageKey: string, body: ReadableStream<Uint8Array>): Promise<number> {
    const filePath = this.resolve(storageKey);
    await mkdir(path.dirname(filePath), { recursive: true });
    const handle = await open(filePath, 'w');
    let bytesWritten = 0;
    try {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await handle.write(value);
        bytesWritten += value.byteLength;
      }
    } finally {
      await handle.close();
    }
    return bytesWritten;
  }
}

export const storage = new LocalFilesystemStorage();
