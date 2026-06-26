import { randomUUID } from 'node:crypto';
import {
  type CloseTerminalSessionInput,
  type CreateTerminalSessionInput,
  type TerminalEvent,
  type TerminalEventSubscription,
  type TerminalInputWrite,
  type TerminalResize,
  type TerminalSessionStatus,
  type TerminalSessionView
} from '@debrute/app-protocol';
import { serviceError } from '../server/ServiceErrors.js';
import { nodePtyTerminalPtyFactory } from './NodePtyTerminalPty.js';
import { resolveTerminalCwd, type ResolvedTerminalCwd } from './TerminalCwd.js';
import type { TerminalPty, TerminalPtyDisposable, TerminalPtyExit, TerminalPtyFactory } from './TerminalPty.js';
import { TerminalReplayBuffer } from './TerminalReplayBuffer.js';

export interface TerminalServiceOptions {
  projectRoot: string;
  ptyFactory?: TerminalPtyFactory;
  replayMaxLines?: number;
  replayMaxBytes?: number;
  now?: () => Date;
  idFactory?: () => string;
}

interface TerminalSession {
  view: TerminalSessionView;
  cwdAbsolutePath: string;
  pty: TerminalPty | null;
  replayBuffer: TerminalReplayBuffer;
  disposables: TerminalPtyDisposable[];
  subscribers: Set<(event: TerminalEvent) => void>;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_REPLAY_MAX_LINES = 10_000;
const DEFAULT_REPLAY_MAX_BYTES = 4 * 1024 * 1024;

export class TerminalService {
  private readonly ptyFactory: TerminalPtyFactory;
  private readonly replayMaxLines: number;
  private readonly replayMaxBytes: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(private readonly options: TerminalServiceOptions) {
    this.ptyFactory = options.ptyFactory ?? nodePtyTerminalPtyFactory;
    this.replayMaxLines = options.replayMaxLines ?? DEFAULT_REPLAY_MAX_LINES;
    this.replayMaxBytes = options.replayMaxBytes ?? DEFAULT_REPLAY_MAX_BYTES;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  listSessions(): TerminalSessionView[] {
    return [...this.sessions.values()].map((session) => ({ ...session.view }));
  }

  async createSession(input: CreateTerminalSessionInput = {}): Promise<TerminalSessionView> {
    const cwd = await resolveTerminalCwd({
      projectRoot: this.options.projectRoot,
      ...(input.cwdProjectRelativePath === undefined ? {} : { cwdProjectRelativePath: input.cwdProjectRelativePath })
    });
    const dimensions = terminalDimensions(input);
    const now = this.nowIso();
    const session: TerminalSession = {
      view: {
        id: this.idFactory(),
        title: cwd.title,
        cwdProjectRelativePath: cwd.projectRelativePath,
        cols: dimensions.cols,
        rows: dimensions.rows,
        status: 'starting',
        exitCode: null,
        signal: null,
        createdAt: now,
        updatedAt: now
      },
      cwdAbsolutePath: cwd.absolutePath,
      pty: null,
      replayBuffer: this.createReplayBuffer(),
      disposables: [],
      subscribers: new Set()
    };
    this.sessions.set(session.view.id, session);
    this.spawnSession(session, cwd);
    return { ...session.view };
  }

  writeInput(input: TerminalInputWrite): void {
    const session = this.requireSession(input.terminalId);
    if (!session.pty || session.view.status !== 'running') {
      throw serviceError('terminal_not_running', `Terminal is not running: ${input.terminalId}`);
    }
    session.pty.write(input.data);
  }

  resize(input: TerminalResize): TerminalSessionView {
    const session = this.requireSession(input.terminalId);
    const dimensions = terminalDimensions(input);
    session.view = {
      ...session.view,
      cols: dimensions.cols,
      rows: dimensions.rows,
      updatedAt: this.nowIso()
    };
    session.pty?.resize(dimensions.cols, dimensions.rows);
    this.publish(session, { type: 'status', terminalId: session.view.id, session: { ...session.view } });
    return { ...session.view };
  }

  close(input: CloseTerminalSessionInput): void {
    const session = this.requireSession(input.terminalId);
    this.closeSession(session);
  }

  closeAll(): void {
    for (const session of [...this.sessions.values()]) {
      this.closeSession(session);
    }
  }

  subscribe(terminalId: string, listener: (event: TerminalEvent) => void): TerminalEventSubscription {
    const session = this.requireSession(terminalId);
    session.subscribers.add(listener);
    const snapshot = session.replayBuffer.snapshot();
    listener({
      type: 'replay',
      terminalId,
      chunks: snapshot.chunks,
      lastSequence: snapshot.lastSequence
    });
    if (session.view.status !== 'running') {
      listener({ type: 'status', terminalId, session: { ...session.view } });
    }
    return {
      close: () => {
        session.subscribers.delete(listener);
      }
    };
  }

  private spawnSession(session: TerminalSession, cwd: ResolvedTerminalCwd): void {
    try {
      const pty = this.ptyFactory({
        shell: defaultShell(),
        args: [],
        cwd: cwd.absolutePath,
        env: terminalEnv(cwd.absolutePath),
        cols: session.view.cols,
        rows: session.view.rows
      });
      session.pty = pty;
      session.disposables = [
        pty.onData((data) => this.handleData(session, data)),
        pty.onExit((event) => this.handleExit(session, event))
      ];
      this.updateStatus(session, 'running');
    } catch (error) {
      session.pty = null;
      const message = error instanceof Error ? error.message : String(error);
      this.handleSpawnFailure(session, message);
    }
  }

  private handleData(session: TerminalSession, data: string): void {
    const chunk = session.replayBuffer.append(data);
    this.publish(session, {
      type: 'data',
      terminalId: session.view.id,
      sequence: chunk.sequence,
      data: chunk.data
    });
  }

  private handleExit(session: TerminalSession, event: TerminalPtyExit): void {
    const signal = event.signal === undefined ? null : String(event.signal);
    session.pty = null;
    session.view = {
      ...session.view,
      status: 'exited',
      exitCode: event.exitCode,
      signal,
      updatedAt: this.nowIso()
    };
    this.publish(session, {
      type: 'exit',
      terminalId: session.view.id,
      exitCode: event.exitCode,
      signal
    });
    this.publish(session, { type: 'status', terminalId: session.view.id, session: { ...session.view } });
  }

  private handleSpawnFailure(session: TerminalSession, message: string): void {
    const chunk = session.replayBuffer.append(`Terminal failed to start: ${message}\r\n`);
    session.view = {
      ...session.view,
      status: 'failed',
      updatedAt: this.nowIso()
    };
    this.publish(session, {
      type: 'data',
      terminalId: session.view.id,
      sequence: chunk.sequence,
      data: chunk.data
    });
    this.publish(session, {
      type: 'error',
      terminalId: session.view.id,
      code: 'terminal_spawn_failed',
      message
    });
    this.publish(session, { type: 'status', terminalId: session.view.id, session: { ...session.view } });
  }

  private updateStatus(session: TerminalSession, status: TerminalSessionStatus): void {
    session.view = {
      ...session.view,
      status,
      updatedAt: this.nowIso()
    };
    this.publish(session, { type: 'status', terminalId: session.view.id, session: { ...session.view } });
  }

  private disposePty(session: TerminalSession): void {
    const pty = session.pty;
    this.disposeSubscriptions(session);
    session.pty = null;
    if (pty) {
      pty.kill();
    }
  }

  private closeSession(session: TerminalSession): void {
    this.disposePty(session);
    this.publish(session, { type: 'closed', terminalId: session.view.id });
    this.sessions.delete(session.view.id);
    session.subscribers.clear();
  }

  private disposeSubscriptions(session: TerminalSession): void {
    for (const disposable of session.disposables) {
      disposable.dispose();
    }
    session.disposables = [];
  }

  private publish(session: TerminalSession, event: TerminalEvent): void {
    for (const subscriber of session.subscribers) {
      subscriber(event);
    }
  }

  private requireSession(terminalId: string): TerminalSession {
    const session = this.sessions.get(terminalId);
    if (!session) {
      throw serviceError('terminal_not_found', `Terminal session not found: ${terminalId}`, { terminalId });
    }
    return session;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private createReplayBuffer(): TerminalReplayBuffer {
    return new TerminalReplayBuffer({
      maxLines: this.replayMaxLines,
      maxBytes: this.replayMaxBytes
    });
  }
}

function terminalDimensions(input: { cols?: number; rows?: number }): { cols: number; rows: number } {
  return {
    cols: terminalDimension(input.cols, DEFAULT_COLS),
    rows: terminalDimension(input.rows, DEFAULT_ROWS)
  };
}

function terminalDimension(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value)) {
    throw serviceError('terminal_invalid_dimensions', 'Terminal dimensions must be finite numbers.');
  }
  return Math.max(1, Math.floor(value));
}

function terminalEnv(cwd: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'debrute',
    PWD: cwd
  };
}

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec ?? 'cmd.exe';
  }
  return process.env.SHELL ?? '/bin/sh';
}
