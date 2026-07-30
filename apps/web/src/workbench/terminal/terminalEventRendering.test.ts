import { describe, expect, it, vi } from 'vitest';
import type { TerminalEvent } from '@debrute/app-protocol';
import { createTerminalEventRenderer } from './terminalEventRendering';

describe('terminal event rendering', { tags: ['terminal'] }, () => {
  it('does not write replay or data chunks that were already rendered', () => {
    const writes: string[] = [];
    const onError = vi.fn();
    const render = createTerminalEventRenderer({
      write: (data) => writes.push(data),
      onError
    });

    render(replayEvent([
      { sequence: 1, data: 'one\n' },
      { sequence: 2, data: 'two\n' }
    ]));
    render(replayEvent([
      { sequence: 1, data: 'one\n' },
      { sequence: 2, data: 'two\n' }
    ]));
    render({ type: 'data', terminalId: 'terminal-1', sequence: 2, data: 'two\n' });
    render({ type: 'data', terminalId: 'terminal-1', sequence: 3, data: 'three\n' });

    expect(writes).toEqual(['one\n', 'two\n', 'three\n']);
    expect(onError).not.toHaveBeenCalled();
  });

  it('leaves session metadata and collection changes to the topology projection', () => {
    const write = vi.fn();
    const onError = vi.fn();
    const render = createTerminalEventRenderer({
      write,
      onError
    });

    render({ type: 'closed', terminalId: 'terminal-1' });
    const session = sessionFixture('terminal-1', 'terminating');
    render({ type: 'status', terminalId: 'terminal-1', session });

    expect(write).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

function replayEvent(chunks: Array<{ sequence: number; data: string }>): TerminalEvent {
  return {
    type: 'replay',
    terminalId: 'terminal-1',
    chunks,
    lastSequence: chunks.at(-1)?.sequence ?? 0
  };
}

function sessionFixture(id: string, status: 'running' | 'terminating') {
  return {
    id,
    title: id,
    cwdProjectRelativePath: '',
    cols: 80,
    rows: 24,
    status,
    exitCode: null,
    signal: null,
    createdAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z'
  };
}
