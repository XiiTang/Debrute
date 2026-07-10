import { describe, expect, it, vi } from 'vitest';
import type { TerminalSessionView } from '@debrute/app-protocol';
import { createTerminalMetadataEventHandler } from './terminalMetadataEvents';

describe('terminalMetadataEvents', () => {
  it('updates terminal metadata without rendering terminal output', () => {
    const onSessionUpdate = vi.fn();
    const onSessionClose = vi.fn();
    const onError = vi.fn();
    const handleEvent = createTerminalMetadataEventHandler({
      onSessionUpdate,
      onSessionClose,
      onError
    });
    const session = sessionFixture('terminal-1', 'terminating');

    handleEvent({ type: 'replay', terminalId: 'terminal-1', chunks: [{ sequence: 1, data: 'ignored' }], lastSequence: 1 });
    handleEvent({ type: 'data', terminalId: 'terminal-1', sequence: 2, data: 'ignored' });
    handleEvent({ type: 'exit', terminalId: 'terminal-1', exitCode: 0, signal: null });
    handleEvent({ type: 'status', terminalId: 'terminal-1', session });
    handleEvent({ type: 'closed', terminalId: 'terminal-1' });
    handleEvent({ type: 'error', terminalId: 'terminal-1', code: 'terminal_spawn_failed', message: 'spawn failed' });

    expect(onSessionUpdate).toHaveBeenCalledExactlyOnceWith(session);
    expect(onSessionClose).toHaveBeenCalledExactlyOnceWith('terminal-1');
    expect(onError).toHaveBeenCalledExactlyOnceWith(new Error('spawn failed'));
  });
});

function sessionFixture(id: string, status: TerminalSessionView['status']): TerminalSessionView {
  return {
    id,
    title: id,
    cwdProjectRelativePath: '',
    cols: 80,
    rows: 24,
    status,
    exitCode: status === 'exited' ? 0 : null,
    signal: null,
    createdAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z'
  };
}
