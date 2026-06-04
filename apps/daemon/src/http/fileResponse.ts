import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';

export interface RevisionedFileResponseInput {
  request: EventEmitter;
  response: Writable & {
    writeHead(statusCode: number, headers: Record<string, string>): void;
  };
  absolutePath: string;
  contentType: string;
}

export async function writeRevisionedFileResponse(input: RevisionedFileResponseInput): Promise<void> {
  const fileStat = await stat(input.absolutePath);
  input.response.writeHead(200, {
    'cache-control': 'public, max-age=31536000, immutable',
    'content-length': String(fileStat.size),
    'content-type': input.contentType
  });

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(input.absolutePath);
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
