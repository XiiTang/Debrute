import { describe, expect, it } from 'vitest';
import { consumeSseEvents, readJsonSseStream } from './streamingSse';

describe('Runtime streaming SSE client', () => {
  it('parses JSON data across arbitrary response chunks without EventSource', async () => {
    const values: unknown[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(': keepalive\n\ndata: {"type":"sy'));
        controller.enqueue(new TextEncoder().encode('nc","revision":1}\n\ndata: {"type":"changed"}\n\n'));
        controller.close();
      }
    });
    await readJsonSseStream(new Response(stream), (value) => values.push(value));
    expect(values).toEqual([{ type: 'sync', revision: 1 }, { type: 'changed' }]);
  });

  it('retains one incomplete event between chunks', () => {
    const values: unknown[] = [];
    const pending = consumeSseEvents('data: {"ok":true}\n\ndata: {"next"', (value) => values.push(value));
    expect(values).toEqual([{ ok: true }]);
    expect(pending).toBe('data: {"next"');
  });
});
