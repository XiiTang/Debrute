import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TerminalEvent } from '@debrute/app-protocol';
import type { WorkbenchRuntimeState } from '@debrute/workbench-runtime';
import { ManagedRuntimeHarness } from '../../helpers/managedRuntimeHarness.js';
import { isProcessAlive, waitForCondition } from '../../helpers/testPaths.js';

describe('managed runtime terminal lifecycle', { tags: ['terminal'] }, () => {
  it('stops a live terminal child when the real runtime terminates', async () => {
    await using harness = await ManagedRuntimeHarness.create();
    const root = await mkdtemp(join(tmpdir(), 'debrute-terminal-project-'));
    let stream: TerminalSseReader | undefined;
    try {
      const runtime = await harness.start();
      await harness.runCli(['project', 'init', root]);
      const opened = await fetchOkJson<{ projectId: string }>(runtime, '/api/projects/open', {
        method: 'POST',
        body: JSON.stringify({ projectRoot: root })
      });
      const created = await fetchOkJson<{ session: { id: string; status: string } }>(
        runtime,
        `/api/projects/${opened.projectId}/terminals`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      expect(created.session.status).toBe('running');

      const response = await fetch(
        new URL(`/api/projects/${opened.projectId}/terminals/${created.session.id}/events`, runtime.daemonUrl),
        { headers: authenticatedHeaders(runtime) }
      );
      stream = new TerminalSseReader(response);
      await stream.waitForShellOutput();
      await fetchOkJson(
        runtime,
        `/api/projects/${opened.projectId}/terminals/${created.session.id}/input`,
        {
          method: 'POST',
          body: JSON.stringify({ data: 'echo DEBRUTE_TERMINAL_READY\r' })
        }
      );
      await stream.waitForReadyMarker();
      await fetchOkJson(
        runtime,
        `/api/projects/${opened.projectId}/terminals/${created.session.id}/input`,
        {
          method: 'POST',
          body: JSON.stringify({
            data: 'node -e "console.log(\'DBPID=\'+process.pid);setInterval(()=>{},1e3)"\r'
          })
        }
      );

      const terminalPid = await stream.readProcessId();
      expect(isProcessAlive(terminalPid)).toBe(true);

      await stream.close();
      stream = undefined;
      await harness.terminate();
      await waitForCondition('test terminal process exit', () => !isProcessAlive(terminalPid));
      expect(isProcessAlive(terminalPid)).toBe(false);
    } finally {
      await stream?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function fetchOkJson<T>(
  runtime: WorkbenchRuntimeState,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(new URL(path, runtime.daemonUrl), {
    ...init,
    headers: {
      ...authenticatedHeaders(runtime),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers
    }
  });
  if (!response.ok) {
    throw new Error(`Daemon request failed (${response.status}): ${await response.text()}`);
  }
  return await response.json() as T;
}

function authenticatedHeaders(runtime: WorkbenchRuntimeState): Record<string, string> {
  return { 'x-debrute-daemon-token': runtime.token };
}

class TerminalSseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private content = '';
  private terminalOutput = '';

  constructor(response: Response) {
    if (!response.ok || !response.body) {
      throw new Error(`Terminal event stream failed (${response.status}).`);
    }
    this.reader = response.body.getReader();
  }

  async readProcessId(): Promise<number> {
    while (true) {
      const match = /(?:^|\r?\n)DBPID=(\d+)\r?\n/.exec(this.terminalOutput);
      if (match?.[1]) {
        return Number(match[1]);
      }
      await this.readNextEvent('terminal process id');
    }
  }

  async waitForShellOutput(): Promise<void> {
    while (this.terminalOutput.length === 0) {
      await this.readNextEvent('initial terminal shell output');
    }
  }

  async waitForReadyMarker(): Promise<void> {
    while (!/(?:^|\r?\n)DEBRUTE_TERMINAL_READY\r?\n/.test(this.terminalOutput)) {
      await this.readNextEvent('terminal ready marker');
    }
  }

  async close(): Promise<void> {
    try {
      await this.reader.cancel();
    } finally {
      this.reader.releaseLock();
    }
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

  private async readNextEvent(description: string): Promise<void> {
    while (true) {
      const event = this.readBufferedEvent();
      if (event) {
        this.terminalOutput += event.type === 'replay'
          ? event.chunks.map((chunk) => chunk.data).join('')
          : event.type === 'data' ? event.data : '';
        return;
      }
      const chunk = await readWithDeadline(
        this.reader,
        `${description}; outputTail=${JSON.stringify(this.terminalOutput.slice(-1_000))}`
      );
      if (chunk.done) {
        throw new Error(`Terminal event stream ended before ${description}.`);
      }
      this.content += this.decoder.decode(chunk.value, { stream: true });
    }
  }
}

async function readWithDeadline<T>(
  reader: ReadableStreamDefaultReader<T>,
  description: string
): Promise<ReadableStreamReadResult<T>> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), 5_000);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
