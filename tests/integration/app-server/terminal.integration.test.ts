import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DebruteAppServer } from '@debrute/app-server';
import { TerminalService } from '../../../apps/app-server/src/terminal/TerminalService';
import {
  type TerminalPty,
  type TerminalPtyDisposable,
  type TerminalPtyExit,
  type TerminalPtyFactory,
  type TerminalPtySpawnInput
} from '../../../apps/app-server/src/terminal/TerminalPty';

describe('app-server terminal', { tags: ['terminal'] }, () => {
  describe('TerminalService', () => {
    const roots: string[] = [];
    afterEach(async () => {
      while (roots.length > 0) {
        await rm(roots.pop()!, { recursive: true, force: true });
      }
    });

    it('creates a terminal session with resolved cwd, dimensions, and env', async () => {
      const projectRoot = await tempProjectRoot('terminal-service-create-');
      await mkdir(join(projectRoot, 'src'), { recursive: true });
      const factory = createFakePtyFactory();
      const service = new TerminalService({
        projectRoot,
        ptyFactory: factory.factory,
        idFactory: () => 'terminal-1',
        now: fixedNow
      });
      const session = await service.createSession({
        cwdProjectRelativePath: 'src',
        cols: 120,
        rows: 34
      });
      expect(session).toMatchObject({
        id: 'terminal-1',
        title: 'src',
        cwdProjectRelativePath: 'src',
        cols: 120,
        rows: 34,
        status: 'running'
      });
      expect(session).not.toHaveProperty('cwdAbsolutePath');
      expect(Object.keys(session).sort()).toEqual([
        'cols',
        'createdAt',
        'cwdProjectRelativePath',
        'exitCode',
        'id',
        'rows',
        'signal',
        'status',
        'title',
        'updatedAt'
      ]);
      expect(factory.spawns).toHaveLength(1);
      expect(factory.spawns[0]).toMatchObject({
        cwd: await realpath(join(projectRoot, 'src')),
        cols: 120,
        rows: 34
      });
      expect(factory.spawns[0]!.env).toMatchObject({
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'debrute',
        PWD: await realpath(join(projectRoot, 'src'))
      });
    });

    it('writes input, resizes the PTY, and broadcasts output', async () => {
      const projectRoot = await tempProjectRoot('terminal-service-io-');
      const factory = createFakePtyFactory();
      const service = new TerminalService({
        projectRoot,
        ptyFactory: factory.factory,
        idFactory: () => 'terminal-1',
        now: fixedNow
      });
      const session = await service.createSession();
      const events: unknown[] = [];
      const subscription = service.subscribe(session.id, (event) => events.push(event));
      service.writeInput({ terminalId: session.id, data: 'echo hello\r' });
      service.resize({ terminalId: session.id, cols: 0, rows: 10.8 });
      factory.ptys[0]!.emitData('hello\r\n');
      expect(factory.ptys[0]!.writes).toEqual(['echo hello\r']);
      expect(factory.ptys[0]!.resizes).toEqual([{ cols: 1, rows: 10 }]);
      expect(events).toEqual([
        { type: 'replay', terminalId: session.id, chunks: [], lastSequence: 0 },
        expect.objectContaining({
          type: 'status',
          terminalId: session.id,
          session: expect.objectContaining({ cols: 1, rows: 10 })
        }),
        { type: 'data', terminalId: session.id, sequence: 1, data: 'hello\r\n' }
      ]);
      subscription.close();
    });

    it('replays bounded output to new subscribers', async () => {
      const projectRoot = await tempProjectRoot('terminal-service-replay-');
      const factory = createFakePtyFactory();
      const service = new TerminalService({
        projectRoot,
        ptyFactory: factory.factory,
        replayMaxLines: 2,
        replayMaxBytes: 4 * 1024 * 1024,
        idFactory: () => 'terminal-1',
        now: fixedNow
      });
      const session = await service.createSession();
      factory.ptys[0]!.emitData('one\n');
      factory.ptys[0]!.emitData('two\n');
      factory.ptys[0]!.emitData('three\n');
      const events: unknown[] = [];
      service.subscribe(session.id, (event) => events.push(event)).close();
      expect(events).toEqual([
        {
          type: 'replay',
          terminalId: session.id,
          chunks: [
            { sequence: 2, data: 'two\n' },
            { sequence: 3, data: 'three\n' }
          ],
          lastSequence: 3
        }
      ]);
    });

    it('updates status on PTY exit and kills all sessions on closeAll', async () => {
      const projectRoot = await tempProjectRoot('terminal-service-exit-');
      const factory = createFakePtyFactory();
      const service = new TerminalService({
        projectRoot,
        ptyFactory: factory.factory,
        idFactory: sequentialIds('terminal-'),
        now: fixedNow
      });
      const first = await service.createSession();
      const second = await service.createSession();
      const events: unknown[] = [];
      service.subscribe(first.id, (event) => events.push(event)).close();
      factory.ptys[0]!.emitExit({ exitCode: 7, signal: 'SIGTERM' });
      expect(service.listSessions().find((session) => session.id === first.id)).toMatchObject({
        status: 'exited',
        exitCode: 7,
        signal: 'SIGTERM'
      });
      expect(events).toEqual([
        { type: 'replay', terminalId: first.id, chunks: [], lastSequence: 0 }
      ]);
      service.closeAll();
      expect(factory.ptys[1]!.terminated).toBe(true);
      expect(factory.ptys[1]!.forceKilled).toBe(true);
      expect(service.listSessions()).toEqual([]);
      expect(second.id).toBe('terminal-2');
    });

    it('clears all sessions during shutdown when one PTY termination fails', async () => {
      const projectRoot = await tempProjectRoot('terminal-service-close-all-error-');
      const factory = createFakePtyFactory();
      const service = new TerminalService({
        projectRoot,
        ptyFactory: factory.factory,
        idFactory: sequentialIds('terminal-'),
        now: fixedNow
      });
      await service.createSession();
      await service.createSession();
      factory.ptys[0]!.terminateError = new Error('terminate denied');
      service.closeAll();
      expect(factory.ptys[1]!.terminated).toBe(true);
      expect(factory.ptys[1]!.forceKilled).toBe(true);
      expect(service.listSessions()).toEqual([]);
    });

    it('sends current exited status to subscribers that attach after PTY exit', async () => {
      const projectRoot = await tempProjectRoot('terminal-service-inactive-exit-');
      const factory = createFakePtyFactory();
      const service = new TerminalService({
        projectRoot,
        ptyFactory: factory.factory,
        idFactory: sequentialIds('terminal-'),
        now: fixedNow
      });
      await service.createSession();
      const inactive = await service.createSession();
      factory.ptys[1]!.emitExit({ exitCode: 9, signal: 'SIGHUP' });
      const events: unknown[] = [];
      service.subscribe(inactive.id, (event) => events.push(event)).close();
      expect(events).toEqual([
        { type: 'replay', terminalId: inactive.id, chunks: [], lastSequence: 0 },
        {
          type: 'status',
          terminalId: inactive.id,
          session: expect.objectContaining({
            id: inactive.id,
            status: 'exited',
            exitCode: 9,
            signal: 'SIGHUP'
          })
        }
      ]);
    });

    it('keeps tail output replayable when PTY data arrives after exit', async () => {
      const projectRoot = await tempProjectRoot('terminal-service-exit-tail-');
      const factory = createFakePtyFactory();
      const service = new TerminalService({
        projectRoot,
        ptyFactory: factory.factory,
        idFactory: () => 'terminal-1',
        now: fixedNow
      });
      const session = await service.createSession();
      factory.ptys[0]!.emitExit({ exitCode: 0 });
      factory.ptys[0]!.emitData('tail output\r\n');
      const replayAfterExit: unknown[] = [];
      service.subscribe(session.id, (event) => replayAfterExit.push(event)).close();
      expect(replayAfterExit).toEqual([
        {
          type: 'replay',
          terminalId: session.id,
          chunks: [{ sequence: 1, data: 'tail output\r\n' }],
          lastSequence: 1
        },
        {
          type: 'status',
          terminalId: session.id,
          session: expect.objectContaining({
            id: session.id,
            status: 'exited',
            exitCode: 0,
            signal: null
          })
        }
      ]);
    });

    it('publishes terminating, waits for PTY exit, then closes and removes a running session', async () => {
      const projectRoot = await tempProjectRoot('terminal-service-close-running-');
      const factory = createFakePtyFactory();
      const service = new TerminalService({
        projectRoot,
        ptyFactory: factory.factory,
        idFactory: () => 'terminal-1',
        now: fixedNow
      });
      const session = await service.createSession();
      const events: unknown[] = [];
      service.subscribe(session.id, (event) => events.push(event));
      const closePromise = service.close({ terminalId: session.id });
      expect(closePromise).toBeInstanceOf(Promise);
      expect(factory.ptys[0]!.terminated).toBe(true);
      expect(service.listSessions()).toEqual([
        expect.objectContaining({ id: session.id, status: 'terminating' })
      ]);
      expect(() => service.writeInput({ terminalId: session.id, data: 'x' })).toThrow('Terminal is not running');
      factory.ptys[0]!.emitExit({ exitCode: 0, signal: 'SIGHUP' });
      await closePromise;
      expect(events).toEqual([
        { type: 'replay', terminalId: session.id, chunks: [], lastSequence: 0 },
        expect.objectContaining({
          type: 'status',
          terminalId: session.id,
          session: expect.objectContaining({ status: 'terminating' })
        }),
        { type: 'exit', terminalId: session.id, exitCode: 0, signal: 'SIGHUP' },
        expect.objectContaining({
          type: 'status',
          terminalId: session.id,
          session: expect.objectContaining({ status: 'exited', exitCode: 0, signal: 'SIGHUP' })
        }),
        { type: 'closed', terminalId: session.id }
      ]);
      expect(service.listSessions()).toEqual([]);
    });

    it('deduplicates duplicate close requests for one session', async () => {
      const projectRoot = await tempProjectRoot('terminal-service-close-dedupe-');
      const factory = createFakePtyFactory();
      const service = new TerminalService({
        projectRoot,
        ptyFactory: factory.factory,
        idFactory: () => 'terminal-1',
        now: fixedNow
      });
      const session = await service.createSession();
      const first = service.close({ terminalId: session.id });
      const second = service.close({ terminalId: session.id });
      expect(second).toBe(first);
      factory.ptys[0]!.emitExit({ exitCode: 0, signal: 'SIGHUP' });
      await Promise.all([first, second]);
      expect(service.listSessions()).toEqual([]);
    });

    it('force-kills a terminal that does not exit within the close grace window', async () => {
      vi.useFakeTimers();
      try {
        const projectRoot = await tempProjectRoot('terminal-service-close-force-');
        const factory = createFakePtyFactory();
        const service = new TerminalService({
          projectRoot,
          ptyFactory: factory.factory,
          idFactory: () => 'terminal-1',
          now: fixedNow
        });
        const session = await service.createSession();
        const closePromise = service.close({ terminalId: session.id });
        await vi.advanceTimersByTimeAsync(1000);
        await closePromise;
        expect(factory.ptys[0]!.terminated).toBe(true);
        expect(factory.ptys[0]!.forceKilled).toBe(true);
        expect(service.listSessions()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('restores a running session and permits retry when PTY termination fails', async () => {
      const projectRoot = await tempProjectRoot('terminal-service-close-terminate-error-');
      const factory = createFakePtyFactory();
      const service = new TerminalService({
        projectRoot,
        ptyFactory: factory.factory,
        idFactory: () => 'terminal-1',
        now: fixedNow
      });
      const session = await service.createSession();
      const events: unknown[] = [];
      service.subscribe(session.id, (event) => events.push(event));
      factory.ptys[0]!.terminateError = new Error('terminate denied');
      const closeError = await captureError(() => service.close({ terminalId: session.id }));
      expect(closeError).toBeInstanceOf(Error);
      expect((closeError as {
        code?: unknown;
      }).code).toBe('terminal_close_failed');
      expect((closeError as Error).message).toBe('Terminal close failed: terminate denied');
      expect(service.listSessions()).toEqual([
        expect.objectContaining({ id: session.id, status: 'running' })
      ]);
      expect(events).toEqual([
        { type: 'replay', terminalId: session.id, chunks: [], lastSequence: 0 },
        expect.objectContaining({
          type: 'status',
          terminalId: session.id,
          session: expect.objectContaining({ status: 'terminating' })
        }),
        {
          type: 'error',
          terminalId: session.id,
          code: 'terminal_close_failed',
          message: 'Terminal close failed: terminate denied'
        },
        expect.objectContaining({
          type: 'status',
          terminalId: session.id,
          session: expect.objectContaining({ status: 'running' })
        })
      ]);
      factory.ptys[0]!.terminateError = undefined;
      const retry = service.close({ terminalId: session.id });
      factory.ptys[0]!.emitExit({ exitCode: 0, signal: 'SIGHUP' });
      await retry;
      expect(service.listSessions()).toEqual([]);
    });

    it('restores a running session and permits retry when PTY force kill fails', async () => {
      vi.useFakeTimers();
      try {
        const projectRoot = await tempProjectRoot('terminal-service-close-force-error-');
        const factory = createFakePtyFactory();
        const service = new TerminalService({
          projectRoot,
          ptyFactory: factory.factory,
          idFactory: () => 'terminal-1',
          now: fixedNow
        });
        const session = await service.createSession();
        const events: unknown[] = [];
        service.subscribe(session.id, (event) => events.push(event));
        factory.ptys[0]!.forceKillError = new Error('kill denied');
        const closePromise = service.close({ terminalId: session.id });
        const closeErrorPromise = closePromise.catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(1000);
        const closeError = await closeErrorPromise;
        expect(closeError).toBeInstanceOf(Error);
        expect((closeError as {
          code?: unknown;
        }).code).toBe('terminal_close_failed');
        expect((closeError as Error).message).toBe('Terminal close failed: kill denied');
        expect(service.listSessions()).toEqual([
          expect.objectContaining({ id: session.id, status: 'running' })
        ]);
        expect(events).toContainEqual({
          type: 'error',
          terminalId: session.id,
          code: 'terminal_close_failed',
          message: 'Terminal close failed: kill denied'
        });
        factory.ptys[0]!.forceKillError = undefined;
        const retry = service.close({ terminalId: session.id });
        await vi.advanceTimersByTimeAsync(1000);
        await retry;
        expect(service.listSessions()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps a failed spawn session inspectable without accepting input', async () => {
      const projectRoot = await tempProjectRoot('terminal-service-failed-');
      const factory = createFakePtyFactory({ failFirstSpawn: true });
      const service = new TerminalService({
        projectRoot,
        ptyFactory: factory.factory,
        idFactory: () => 'terminal-1',
        now: fixedNow
      });
      const failed = await service.createSession();
      expect(failed.status).toBe('failed');
      expect(() => service.writeInput({ terminalId: failed.id, data: 'x' })).toThrow('Terminal is not running');
      const events: unknown[] = [];
      service.subscribe(failed.id, (event) => events.push(event)).close();
      expect(events).toEqual([
        {
          type: 'replay',
          terminalId: failed.id,
          chunks: [{ sequence: 1, data: 'Terminal failed to start: spawn failed\r\n' }],
          lastSequence: 1
        },
        {
          type: 'status',
          terminalId: failed.id,
          session: expect.objectContaining({
            id: failed.id,
            status: 'failed'
          })
        }
      ]);
      await service.close({ terminalId: failed.id });
      expect(service.listSessions()).toEqual([]);
    });

    it('exposes terminal methods through DebruteAppServer and closes PTYs with the server', async () => {
      const projectRoot = await tempProjectRoot('terminal-service-app-server-');
      const factory = createFakePtyFactory();
      const server = new DebruteAppServer({
        terminalPtyFactory: factory.factory
      });
      try {
        await server.openProject(projectRoot, { initializeIfMissing: true, createDefaultCanvas: true, watchFiles: false });
        const created = await server.createTerminalSession();
        expect(created.session).toMatchObject({
          status: 'running',
          cwdProjectRelativePath: ''
        });
        expect(created.session).not.toHaveProperty('cwdAbsolutePath');
        expect(server.listTerminalSessions().sessions).toHaveLength(1);
        server.close();
        expect(factory.ptys[0]!.terminated).toBe(true);
        expect(factory.ptys[0]!.forceKilled).toBe(true);
        expect(() => server.listTerminalSessions()).toThrow('Terminal service is unavailable');
      } finally {
        server.close();
      }
    });
    async function tempProjectRoot(prefix: string): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), prefix));
      roots.push(root);
      return root;
    }
  });
  function fixedNow(): Date {
    return new Date('2026-06-12T00:00:00.000Z');
  }

  function sequentialIds(prefix: string): () => string {
    let next = 1;
    return () => `${prefix}${next++}`;
  }

  function createFakePtyFactory(options: {
    failFirstSpawn?: boolean;
  } = {}): {
    factory: TerminalPtyFactory;
    spawns: TerminalPtySpawnInput[];
    ptys: FakeTerminalPty[];
  } {
    const spawns: TerminalPtySpawnInput[] = [];
    const ptys: FakeTerminalPty[] = [];
    let spawnCount = 0;
    return {
      spawns,
      ptys,
      factory: (input) => {
        spawnCount += 1;
        if (options.failFirstSpawn && spawnCount === 1) {
          throw new Error('spawn failed');
        }
        spawns.push(input);
        const pty = new FakeTerminalPty(spawnCount);
        ptys.push(pty);
        return pty;
      }
    };
  }

  class FakeTerminalPty implements TerminalPty {
    writes: string[] = [];
    resizes: Array<{
      cols: number;
      rows: number;
    }> = [];
    terminated = false;
    forceKilled = false;
    terminateError: Error | undefined;
    forceKillError: Error | undefined;
    private readonly dataListeners = new Set<(data: string) => void>();
    private readonly exitListeners = new Set<(event: TerminalPtyExit) => void>();
    constructor(readonly pid: number) { }
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

  async function captureError(action: () => Promise<unknown>): Promise<unknown> {
    try {
      await action();
      return undefined;
    } catch (error) {
      return error;
    }
  }
});
