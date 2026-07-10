import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDebruteDaemonHttpServer } from '@debrute/daemon';
import type { TerminalEvent } from '@debrute/app-protocol';
import type {
  TerminalPty,
  TerminalPtyDisposable,
  TerminalPtyExit,
  TerminalPtyFactory,
  TerminalPtySpawnInput
} from '../apps/app-server/src/terminal/TerminalPty';

describe('daemon terminal routes', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.shift()?.();
    }
  });

  it('handles terminal lifecycle routes without exposing absolute project paths', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-terminal-'));
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await writeFile(join(projectRoot, 'src/index.ts'), '', 'utf8');
    const factory = createFakePtyFactory();
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      appServerOptions: {
        terminalPtyFactory: factory.factory
      }
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      body: JSON.stringify({ projectRoot })
    });

    const created = await requestJson<{ session: { id: string; cwdProjectRelativePath: string; status: string } }>(
      `${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals`,
      {
        method: 'POST',
        body: JSON.stringify({
          cwdProjectRelativePath: 'src/index.ts',
          cols: 90,
          rows: 30
        })
      }
    );

    expect(created.session).toMatchObject({
      cwdProjectRelativePath: 'src',
      status: 'running'
    });
    expect(created.session).not.toHaveProperty('cwdAbsolutePath');
    expect(JSON.stringify(created)).not.toContain(projectRoot);
    expect(factory.spawns[0]).toMatchObject({
      cwd: await realpath(join(projectRoot, 'src')),
      cols: 90,
      rows: 30
    });

    await expect(requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals`)).resolves.toMatchObject({
      sessions: [expect.objectContaining({ id: created.session.id })]
    });

    await requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals/${created.session.id}/input`, {
      method: 'POST',
      body: JSON.stringify({ data: 'pwd\r' })
    });
    expect(factory.ptys[0]!.writes).toEqual(['pwd\r']);

    await requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals/${created.session.id}/resize`, {
      method: 'POST',
      body: JSON.stringify({ cols: 100, rows: 24 })
    });
    expect(factory.ptys[0]!.resizes).toEqual([{ cols: 100, rows: 24 }]);

    const deleteRequest = requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals/${created.session.id}`, {
      method: 'DELETE'
    });
    await waitForPtyTermination(factory.ptys[0]!);
    factory.ptys[0]!.emitExit({ exitCode: 0, signal: 'SIGHUP' });
    await expect(deleteRequest).resolves.toEqual({ ok: true });
    await expect(requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals`)).resolves.toEqual({
      sessions: []
    });
  });

  it('waits for terminal close cleanup before returning from DELETE', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-terminal-close-wait-'));
    const factory = createFakePtyFactory();
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      appServerOptions: {
        terminalPtyFactory: factory.factory
      }
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      body: JSON.stringify({ projectRoot })
    });
    const created = await requestJson<{ session: { id: string } }>(
      `${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals`,
      { method: 'POST', body: JSON.stringify({}) }
    );

    let deleteResolved = false;
    const deleteRequest = requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals/${created.session.id}`, {
      method: 'DELETE'
    }).then((result) => {
      deleteResolved = true;
      return result;
    });

    await waitForPtyTermination(factory.ptys[0]!);
    expect(deleteResolved).toBe(false);

    factory.ptys[0]!.emitExit({ exitCode: 0, signal: 'SIGHUP' });
    await expect(deleteRequest).resolves.toEqual({ ok: true });
    expect(deleteResolved).toBe(true);
  });

  it('returns terminal_close_failed and keeps the session listed when DELETE termination fails', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-terminal-close-error-'));
    const factory = createFakePtyFactory();
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      appServerOptions: {
        terminalPtyFactory: factory.factory
      }
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      body: JSON.stringify({ projectRoot })
    });
    const created = await requestJson<{ session: { id: string } }>(
      `${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals`,
      { method: 'POST', body: JSON.stringify({}) }
    );
    factory.ptys[0]!.terminateError = new Error('terminate denied');

    const response = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals/${created.session.id}`, {
      method: 'DELETE',
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'terminal_close_failed',
        message: 'Terminal close failed: terminate denied',
        details: {}
      }
    });
    await expect(requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals`)).resolves.toEqual({
      sessions: [expect.objectContaining({ id: created.session.id, status: 'running' })]
    });
  });

  it('lets terminal sessions normalize create and resize dimensions', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-terminal-dimensions-'));
    const factory = createFakePtyFactory();
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      appServerOptions: {
        terminalPtyFactory: factory.factory
      }
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      body: JSON.stringify({ projectRoot })
    });

    const created = await requestJson<{ session: { id: string } }>(
      `${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals`,
      {
        method: 'POST',
        body: JSON.stringify({ cols: 0, rows: 10.8 })
      }
    );
    expect(factory.spawns[0]).toMatchObject({ cols: 1, rows: 10 });

    await requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals/${created.session.id}/resize`, {
      method: 'POST',
      body: JSON.stringify({ cols: 0, rows: 10.8 })
    });
    expect(factory.ptys[0]!.resizes).toEqual([{ cols: 1, rows: 10 }]);
  });

  it('streams terminal replay and live events over per-terminal SSE', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-terminal-sse-'));
    const factory = createFakePtyFactory();
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null,
      appServerOptions: {
        terminalPtyFactory: factory.factory
      }
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      body: JSON.stringify({ projectRoot })
    });
    const created = await requestJson<{ session: { id: string } }>(
      `${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals`,
      { method: 'POST', body: JSON.stringify({}) }
    );
    factory.ptys[0]!.emitData('before attach\r\n');

    const tokenless = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals/${created.session.id}/events`);
    expect(tokenless.status).toBe(403);

    const response = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals/${created.session.id}/events`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    const stream = new SseTestReader(response);
    try {
      await expect(stream.next()).resolves.toEqual({
        type: 'replay',
        terminalId: created.session.id,
        chunks: [{ sequence: 1, data: 'before attach\r\n' }],
        lastSequence: 1
      });

      factory.ptys[0]!.emitData('after attach\r\n');

      await expect(stream.next()).resolves.toEqual({
        type: 'data',
        terminalId: created.session.id,
        sequence: 2,
        data: 'after attach\r\n'
      });

      const deleteRequest = requestJson(`${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals/${created.session.id}`, {
        method: 'DELETE'
      });

      await expect(stream.next()).resolves.toMatchObject({
        type: 'status',
        terminalId: created.session.id,
        session: { status: 'terminating' }
      });

      factory.ptys[0]!.emitExit({ exitCode: 0, signal: 'SIGHUP' });
      await deleteRequest;

      await expect(stream.next()).resolves.toEqual({
        type: 'exit',
        terminalId: created.session.id,
        exitCode: 0,
        signal: 'SIGHUP'
      });
      await expect(stream.next()).resolves.toMatchObject({
        type: 'status',
        terminalId: created.session.id,
        session: { status: 'exited', exitCode: 0, signal: 'SIGHUP' }
      });
      await expect(stream.next()).resolves.toEqual({
        type: 'closed',
        terminalId: created.session.id
      });
      await expect(stream.done()).resolves.toBe(true);
    } finally {
      await stream.close();
    }
  });

  it('returns a structured not-found response before opening terminal event streams', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-terminal-sse-missing-'));
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      body: JSON.stringify({ projectRoot })
    });

    const response = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals/missing/events`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'terminal_not_found',
        message: 'Terminal session not found: missing',
        details: { terminalId: 'missing' }
      }
    });
  });

  it('returns terminal_not_found when deleting a missing terminal', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-terminal-delete-missing-'));
    const daemon = createDebruteDaemonHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      webBaseUrl: null
    });
    cleanups.push(() => daemon.close(), () => rm(projectRoot, { recursive: true, force: true }));
    const runtime = await daemon.listen();
    const opened = await requestJson<{ projectId: string }>(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      body: JSON.stringify({ projectRoot })
    });

    const response = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/terminals/missing`, {
      method: 'DELETE',
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'terminal_not_found',
        message: 'Terminal session not found: missing',
        details: { terminalId: 'missing' }
      }
    });
  });
});

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  if (!headers.has('x-debrute-daemon-token')) {
    headers.set('x-debrute-daemon-token', 'test-token');
  }
  const response = await fetch(url, {
    ...init,
    headers
  });
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<T>;
}

class SseTestReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private content = '';

  constructor(private readonly response: Response) {
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('SSE response did not include a body.');
    }
    this.reader = reader;
  }

  async next(): Promise<TerminalEvent> {
    while (true) {
      const event = this.readBufferedEvent();
      if (event) {
        return event;
      }
      const chunk = await this.readWithTimeout();
      if (chunk.done) {
        throw new Error('SSE response ended before the next terminal event.');
      }
      this.content += new TextDecoder().decode(chunk.value);
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
    this.reader.releaseLock();
  }

  async done(): Promise<boolean> {
    const chunk = await this.readWithTimeout();
    return chunk.done;
  }

  private readBufferedEvent(): TerminalEvent | undefined {
    const boundary = this.content.indexOf('\n\n');
    if (boundary < 0) {
      return undefined;
    }
    const rawEvent = this.content.slice(0, boundary);
    this.content = this.content.slice(boundary + 2);
    const dataLine = rawEvent.split('\n').find((line) => line.startsWith('data: '));
    return dataLine ? JSON.parse(dataLine.slice('data: '.length)) as TerminalEvent : undefined;
  }

  private async readWithTimeout(): Promise<ReadableStreamReadResult<Uint8Array>> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Timed out waiting for terminal SSE event.')), 1000);
        })
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

function createFakePtyFactory(): {
  factory: TerminalPtyFactory;
  spawns: TerminalPtySpawnInput[];
  ptys: FakeTerminalPty[];
} {
  const spawns: TerminalPtySpawnInput[] = [];
  const ptys: FakeTerminalPty[] = [];
  return {
    spawns,
    ptys,
    factory: (input) => {
      spawns.push(input);
      const pty = new FakeTerminalPty(ptys.length + 1);
      ptys.push(pty);
      return pty;
    }
  };
}

class FakeTerminalPty implements TerminalPty {
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  terminated = false;
  forceKilled = false;
  terminateError: Error | undefined;
  forceKillError: Error | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: TerminalPtyExit) => void>();

  constructor(readonly pid: number) {}

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  terminate(): void {
    if (this.terminateError) {
      throw this.terminateError;
    }
    this.terminated = true;
  }

  forceKill(): void {
    if (this.forceKillError) {
      throw this.forceKillError;
    }
    this.forceKilled = true;
  }

  onData(listener: (data: string) => void): TerminalPtyDisposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: TerminalPtyExit) => void): TerminalPtyDisposable {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitExit(event: TerminalPtyExit): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

async function waitForPtyTermination(pty: FakeTerminalPty): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (pty.terminated) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(pty.terminated).toBe(true);
}
