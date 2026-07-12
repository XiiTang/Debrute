import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TerminalEvent } from '@debrute/app-protocol';
import type {
  TerminalPty,
  TerminalPtyDisposable,
  TerminalPtyExit,
  TerminalPtyFactory,
  TerminalPtySpawnInput
} from '../../../../apps/app-server/src/terminal/TerminalPty.js';
import {
  DaemonTestHarness,
  readDaemonSseChunkWithDeadline
} from '../../../helpers/daemonTestHarness.js';

describe('daemon terminal routes', { tags: ['terminal'] }, () => {
  it('handles terminal lifecycle routes without exposing absolute project paths', async () => {
    const factory = createFakePtyFactory();
    await using harness = await DaemonTestHarness.create({
      appServerOptions: { terminalPtyFactory: factory.factory }
    });
    const project = await harness.createProject({ 'src/index.ts': '' });
    await harness.openProject(project);

    const created = await harness.fetchOkJson<{
      session: { id: string; cwdProjectRelativePath: string; status: string };
    }>(`/api/projects/${project.projectId}/terminals`, {
      method: 'POST',
      body: JSON.stringify({
        cwdProjectRelativePath: 'src/index.ts',
        cols: 90,
        rows: 30
      })
    });

    expect(created.session).toMatchObject({
      cwdProjectRelativePath: 'src',
      status: 'running'
    });
    expect(created.session).not.toHaveProperty('cwdAbsolutePath');
    expect(JSON.stringify(created)).not.toContain(project.rootPath);
    expect(factory.spawns[0]).toMatchObject({
      cwd: await realpath(join(project.rootPath, 'src')),
      cols: 90,
      rows: 30
    });

    await expect(harness.fetchOkJson(`/api/projects/${project.projectId}/terminals`)).resolves.toMatchObject({
      sessions: [expect.objectContaining({ id: created.session.id })]
    });

    await harness.fetchOkJson(`/api/projects/${project.projectId}/terminals/${created.session.id}/input`, {
      method: 'POST',
      body: JSON.stringify({ data: 'pwd\r' })
    });
    expect(factory.ptys[0]!.writes).toEqual(['pwd\r']);

    await harness.fetchOkJson(`/api/projects/${project.projectId}/terminals/${created.session.id}/resize`, {
      method: 'POST',
      body: JSON.stringify({ cols: 100, rows: 24 })
    });
    expect(factory.ptys[0]!.resizes).toEqual([{ cols: 100, rows: 24 }]);

    const deleteRequest = harness.fetchOkJson(
      `/api/projects/${project.projectId}/terminals/${created.session.id}`,
      { method: 'DELETE' }
    );
    await factory.ptys[0]!.waitForTerminationRequest();
    factory.ptys[0]!.emitExit({ exitCode: 0, signal: 'SIGHUP' });
    await expect(deleteRequest).resolves.toEqual({ ok: true });
    await expect(harness.fetchOkJson(`/api/projects/${project.projectId}/terminals`)).resolves.toEqual({
      sessions: []
    });
  });

  it('waits for terminal close cleanup before returning from DELETE', async () => {
    const factory = createFakePtyFactory();
    await using harness = await DaemonTestHarness.create({
      appServerOptions: { terminalPtyFactory: factory.factory }
    });
    const project = await harness.createProject();
    await harness.openProject(project);
    const created = await harness.fetchOkJson<{ session: { id: string } }>(
      `/api/projects/${project.projectId}/terminals`,
      { method: 'POST', body: JSON.stringify({}) }
    );

    let deleteResolved = false;
    const deleteRequest = harness.fetchOkJson(
      `/api/projects/${project.projectId}/terminals/${created.session.id}`,
      { method: 'DELETE' }
    ).then((result) => {
      deleteResolved = true;
      return result;
    });

    await factory.ptys[0]!.waitForTerminationRequest();
    expect(deleteResolved).toBe(false);

    factory.ptys[0]!.emitExit({ exitCode: 0, signal: 'SIGHUP' });
    await expect(deleteRequest).resolves.toEqual({ ok: true });
    expect(deleteResolved).toBe(true);
  });

  it('returns terminal_close_failed and keeps the session listed when DELETE termination fails', async () => {
    const factory = createFakePtyFactory();
    await using harness = await DaemonTestHarness.create({
      appServerOptions: { terminalPtyFactory: factory.factory }
    });
    const project = await harness.createProject();
    await harness.openProject(project);
    const created = await harness.fetchOkJson<{ session: { id: string } }>(
      `/api/projects/${project.projectId}/terminals`,
      { method: 'POST', body: JSON.stringify({}) }
    );
    factory.ptys[0]!.terminateError = new Error('terminate denied');

    const response = await harness.fetchJson<{
      error: { code: string; message: string; details: Record<string, unknown> };
    }>(`/api/projects/${project.projectId}/terminals/${created.session.id}`, {
      method: 'DELETE'
    });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: 'terminal_close_failed',
        message: 'Terminal close failed: terminate denied',
        details: {}
      }
    });
    await expect(harness.fetchOkJson(`/api/projects/${project.projectId}/terminals`)).resolves.toEqual({
      sessions: [expect.objectContaining({ id: created.session.id, status: 'running' })]
    });

    factory.ptys[0]!.terminateError = undefined;
    const closeRequest = harness.fetchOkJson(
      `/api/projects/${project.projectId}/terminals/${created.session.id}`,
      { method: 'DELETE' }
    );
    await factory.ptys[0]!.waitForTerminationRequest();
    factory.ptys[0]!.emitExit({ exitCode: 0, signal: 'SIGHUP' });
    await closeRequest;
  });

  it('lets terminal sessions normalize create and resize dimensions', async () => {
    const factory = createFakePtyFactory();
    await using harness = await DaemonTestHarness.create({
      appServerOptions: { terminalPtyFactory: factory.factory }
    });
    const project = await harness.createProject();
    await harness.openProject(project);

    const created = await harness.fetchOkJson<{ session: { id: string } }>(
      `/api/projects/${project.projectId}/terminals`,
      {
        method: 'POST',
        body: JSON.stringify({ cols: 0, rows: 10.8 })
      }
    );
    expect(factory.spawns[0]).toMatchObject({ cols: 1, rows: 10 });

    await harness.fetchOkJson(`/api/projects/${project.projectId}/terminals/${created.session.id}/resize`, {
      method: 'POST',
      body: JSON.stringify({ cols: 0, rows: 10.8 })
    });
    expect(factory.ptys[0]!.resizes).toEqual([{ cols: 1, rows: 10 }]);

    const closeRequest = harness.fetchOkJson(
      `/api/projects/${project.projectId}/terminals/${created.session.id}`,
      { method: 'DELETE' }
    );
    await factory.ptys[0]!.waitForTerminationRequest();
    factory.ptys[0]!.emitExit({ exitCode: 0, signal: 'SIGHUP' });
    await closeRequest;
  });

  it('streams terminal replay and live events over per-terminal SSE', async () => {
    const factory = createFakePtyFactory();
    await using harness = await DaemonTestHarness.create({
      appServerOptions: { terminalPtyFactory: factory.factory }
    });
    const project = await harness.createProject();
    await harness.openProject(project);
    const created = await harness.fetchOkJson<{ session: { id: string } }>(
      `/api/projects/${project.projectId}/terminals`,
      { method: 'POST', body: JSON.stringify({}) }
    );
    factory.ptys[0]!.emitData('before attach\r\n');

    const tokenless = await fetch(
      `${harness.daemonUrl}/api/projects/${project.projectId}/terminals/${created.session.id}/events`
    );
    expect(tokenless.status).toBe(403);

    const response = await fetch(
      `${harness.daemonUrl}/api/projects/${project.projectId}/terminals/${created.session.id}/events`,
      { headers: { 'x-debrute-daemon-token': harness.token } }
    );
    const stream = new TerminalSseReader(response);
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

      const deleteRequest = harness.fetchOkJson(
        `/api/projects/${project.projectId}/terminals/${created.session.id}`,
        { method: 'DELETE' }
      );

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
    await using harness = await DaemonTestHarness.create();
    const project = await harness.createProject();
    await harness.openProject(project);

    const response = await harness.fetchJson<{
      error: { code: string; message: string; details: { terminalId: string } };
    }>(`/api/projects/${project.projectId}/terminals/missing/events`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: 'terminal_not_found',
        message: 'Terminal session not found: missing',
        details: { terminalId: 'missing' }
      }
    });
  });

  it('returns terminal_not_found when deleting a missing terminal', async () => {
    await using harness = await DaemonTestHarness.create();
    const project = await harness.createProject();
    await harness.openProject(project);

    const response = await harness.fetchJson<{
      error: { code: string; message: string; details: { terminalId: string } };
    }>(`/api/projects/${project.projectId}/terminals/missing`, {
      method: 'DELETE'
    });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: 'terminal_not_found',
        message: 'Terminal session not found: missing',
        details: { terminalId: 'missing' }
      }
    });
  });
});

class TerminalSseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private content = '';

  constructor(response: Response) {
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
      const chunk = await readDaemonSseChunkWithDeadline(this.reader, 'terminal SSE event');
      if (chunk.done) {
        throw new Error('SSE response ended before the next terminal event.');
      }
      this.content += new TextDecoder().decode(chunk.value);
    }
  }

  async close(): Promise<void> {
    try {
      await this.reader.cancel();
    } finally {
      this.reader.releaseLock();
    }
  }

  async done(): Promise<boolean> {
    const chunk = await readDaemonSseChunkWithDeadline(this.reader, 'terminal SSE completion');
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
  private readonly terminationRequest: Promise<void>;
  private resolveTerminationRequest!: () => void;

  constructor(readonly pid: number) {
    this.terminationRequest = new Promise((resolve) => {
      this.resolveTerminationRequest = resolve;
    });
  }

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
    this.resolveTerminationRequest();
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

  waitForTerminationRequest(): Promise<void> {
    return this.terminationRequest;
  }
}
