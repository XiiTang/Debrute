import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders } from 'node:http';
import type { Writable } from 'node:stream';

export interface RevisionedFileResponseInput {
  request: EventEmitter & {
    headers?: IncomingHttpHeaders | undefined;
  };
  response: Writable & {
    writeHead(statusCode: number, headers: Record<string, string>): void;
  };
  absolutePath: string;
  contentType: string;
}

interface ByteRange {
  start: number;
  end: number;
}

export async function writeRevisionedFileResponse(input: RevisionedFileResponseInput): Promise<void> {
  const fileStat = await stat(input.absolutePath);
  const fileSize = fileStat.size;
  const range = parseByteRange(input.request.headers?.range, fileSize);
  if (range === 'unsatisfiable') {
    input.response.writeHead(416, {
      'accept-ranges': 'bytes',
      'content-range': `bytes */${fileSize}`
    });
    input.response.end();
    return;
  }

  if (range) {
    input.response.writeHead(206, {
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=31536000, immutable',
      'content-length': String(range.end - range.start + 1),
      'content-range': `bytes ${range.start}-${range.end}/${fileSize}`,
      'content-type': input.contentType
    });
    await pipeFileResponse(input, range);
    return;
  }

  input.response.writeHead(200, {
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=31536000, immutable',
    'content-length': String(fileSize),
    'content-type': input.contentType
  });
  await pipeFileResponse(input);
}

export function parseByteRange(rangeHeader: string | string[] | undefined, fileSize: number): ByteRange | 'unsatisfiable' | undefined {
  if (rangeHeader === undefined) {
    return undefined;
  }
  const raw = Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader;
  if (!raw || !raw.startsWith('bytes=') || raw.includes(',')) {
    return 'unsatisfiable';
  }
  const match = raw.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return 'unsatisfiable';
  }
  const [, startRaw = '', endRaw = ''] = match;
  if (!startRaw && !endRaw) {
    return 'unsatisfiable';
  }
  if (fileSize <= 0) {
    return 'unsatisfiable';
  }
  if (!startRaw) {
    const suffixLength = Number(endRaw);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return 'unsatisfiable';
    }
    const length = Math.min(suffixLength, fileSize);
    return { start: fileSize - length, end: fileSize - 1 };
  }
  const start = Number(startRaw);
  const end = endRaw ? Number(endRaw) : fileSize - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= fileSize) {
    return 'unsatisfiable';
  }
  return { start, end: Math.min(end, fileSize - 1) };
}

async function pipeFileResponse(input: RevisionedFileResponseInput, range?: ByteRange): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(input.absolutePath, range);
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      input.request.off('close', onClose);
      stream.off('error', onError);
      stream.off('end', onEnd);
      callback();
    };
    const onClose = () => {
      stream.destroy();
      settle(resolve);
    };
    const onError = (error: Error) => settle(() => reject(error));
    const onEnd = () => settle(resolve);

    input.request.once('close', onClose);
    stream.once('error', onError);
    stream.once('end', onEnd);
    stream.pipe(input.response);
  });
}
