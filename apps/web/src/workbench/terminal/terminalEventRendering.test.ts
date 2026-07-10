import { describe, expect, it, vi } from 'vitest';
import type { TerminalEvent } from '@debrute/app-protocol';
import { createTerminalEventRenderer } from './terminalEventRendering';

describe('terminal event rendering', () => {
  it('does not write replay or data chunks that were already rendered', () => {
    const writes: string[] = [];
    const onSessionUpdate = vi.fn();
    const onSessionClose = vi.fn();
    const onError = vi.fn();
    const render = createTerminalEventRenderer({
      write: (data) => writes.push(data),
      onSessionUpdate,
      onSessionClose,
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
    expect(onSessionUpdate).not.toHaveBeenCalled();
    expect(onSessionClose).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports closed terminal events to the panel state owner', () => {
    const onSessionClose = vi.fn();
    const render = createTerminalEventRenderer({
      write: vi.fn(),
      onSessionUpdate: vi.fn(),
      onSessionClose,
      onError: vi.fn()
    });

    render({ type: 'closed', terminalId: 'terminal-1' });

    expect(onSessionClose).toHaveBeenCalledWith('terminal-1');
  });

  it('forwards terminating status updates to the panel state owner', () => {
    const onSessionUpdate = vi.fn();
    const render = createTerminalEventRenderer({
      write: vi.fn(),
      onSessionUpdate,
      onSessionClose: vi.fn(),
      onError: vi.fn()
    });
    const session = sessionFixture('terminal-1', 'terminating');

    render({ type: 'status', terminalId: 'terminal-1', session });

    expect(onSessionUpdate).toHaveBeenCalledExactlyOnceWith(session);
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
