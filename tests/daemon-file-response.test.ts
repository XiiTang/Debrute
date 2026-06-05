import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { writeRevisionedFileResponse } from '../apps/daemon/src/http/fileResponse';

describe('daemon revisioned file responses', () => {
  it('writes immutable cache headers for revisioned files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'debrute-file-response-'));
    try {
      const path = join(dir, 'image.png');
      await writeFile(path, Buffer.from('image-bytes'));
      const request = new EventEmitter();
      const response = fakeResponse();

      await writeRevisionedFileResponse({
        request,
        response,
        absolutePath: path,
        contentType: 'image/png'
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers).toMatchObject({
        'cache-control': 'public, max-age=31536000, immutable',
        'content-length': String(Buffer.byteLength('image-bytes')),
        'content-type': 'image/png'
      });
      expect(response.body).toBe('image-bytes');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('settles cleanly when the request closes before the stream finishes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'debrute-file-response-close-'));
    try {
      const path = join(dir, 'large.bin');
      await writeFile(path, Buffer.alloc(1024 * 1024, 1));
      const request = new EventEmitter();
      const response = fakeResponse({
        onFirstWrite: () => request.emit('close')
      });

      await expect(writeRevisionedFileResponse({
        request,
        response,
        absolutePath: path,
        contentType: 'application/octet-stream'
      })).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function fakeResponse(input: { onFirstWrite?: () => void } = {}) {
  let firstWrite = true;
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      if (firstWrite) {
        firstWrite = false;
        input.onFirstWrite?.();
      }
      callback();
    }
  }) as Writable & {
    statusCode?: number;
    headers?: Record<string, string>;
    body?: string;
    writeHead(statusCode: number, headers: Record<string, string>): void;
  };
  writable.writeHead = (statusCode, headers) => {
    writable.statusCode = statusCode;
    writable.headers = headers;
  };
  Object.defineProperty(writable, 'body', {
    get: () => Buffer.concat(chunks).toString('utf8')
  });
  return writable;
}
