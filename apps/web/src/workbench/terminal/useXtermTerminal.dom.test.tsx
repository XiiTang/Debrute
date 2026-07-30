import { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalSessionView, WorkbenchApiClient } from '@debrute/app-protocol';
import { useXtermTerminal } from './useXtermTerminal';

const xtermMockState = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {};

    loadAddon(): void {}
    open(): void {}
    write(): void {}
    dispose(): void {}
    onData(): { dispose(): void } {
      xtermMockState.calls.push('onData');
      return { dispose() {} };
    }
  }
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 100, rows: 30 };
    }
  }
}));

describe('useXtermTerminal', { tags: ['terminal'] }, () => {
  beforeEach(() => {
    xtermMockState.calls.length = 0;
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('subscribes before issuing controls for a newly mounted Terminal', async () => {
    const session = sessionFixture();
    const api = {
      subscribeTerminalEvents: vi.fn(() => {
        xtermMockState.calls.push('subscribe');
        return { close: vi.fn() };
      }),
      resizeTerminal: vi.fn(async () => {
        xtermMockState.calls.push('resize');
        return { session: { ...session, cols: 100, rows: 30 } };
      }),
      writeTerminalInput: vi.fn(async () => ({ ok: true as const }))
    } as unknown as WorkbenchApiClient;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<TerminalHarness api={api} session={session} />);
      });

      expect(xtermMockState.calls).toEqual(['onData', 'subscribe', 'resize']);
    } finally {
      await unmount(root, container);
    }
  });
});

function TerminalHarness({ api, session }: { api: WorkbenchApiClient; session: TerminalSessionView }) {
  const containerRef = useRef<HTMLDivElement>(null);
  useXtermTerminal({
    api,
    resolvedTheme: 'dark',
    session,
    containerRef,
    onError: () => undefined
  });
  return <div ref={containerRef} />;
}

function sessionFixture(): TerminalSessionView {
  return {
    id: 'terminal-1',
    title: 'Terminal',
    cwdProjectRelativePath: '',
    cols: 80,
    rows: 24,
    status: 'running',
    exitCode: null,
    signal: null,
    createdAt: 'now',
    updatedAt: 'now'
  };
}

async function unmount(root: Root, container: HTMLElement): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}
