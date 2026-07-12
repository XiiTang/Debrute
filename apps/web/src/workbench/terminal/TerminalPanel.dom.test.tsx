import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalSessionView, WorkbenchApiClient } from '@debrute/app-protocol';
import { TerminalPanel, TerminalPanelToolbar } from './TerminalPanel';
import { I18nProvider } from '../i18n';
import type { UseXtermTerminalInput } from './useXtermTerminal';

const terminalHookState = vi.hoisted(() => ({
  activeInput: null as UseXtermTerminalInput | null
}));

vi.mock('./useXtermTerminal', () => ({
  useXtermTerminal: (input: UseXtermTerminalInput) => {
    terminalHookState.activeInput = input;
  }
}));

function renderStaticWithI18n(element: React.ReactElement): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en">
      {element}
    </I18nProvider>
  );
}

describe('TerminalPanel rendering', { tags: ['terminal'] }, () => {
  it('renders toolbar actions through Workbench UI primitives', () => {
    const html = renderStaticWithI18n(
      <TerminalPanel
        api={{} as WorkbenchApiClient}
        resolvedTheme="light"
        requestedCwdProjectRelativePath={null}
        onRequestedCwdConsumed={() => undefined}
      />
    );

    expect(html).toContain('db-toolbar');
    expect(html).toContain('db-terminal-tabs');
    expect(html).toContain('db-terminal-tab-end-slot');
    expect(html).toContain('db-icon-button');
    expect(html).toContain('New Terminal');
    expect(html).toContain('aria-label="New Terminal"');
    expect(html).toContain('db-icon-button--sm');
    expect(html).toContain('db-icon-button--chrome');
    expect(html).not.toContain('aria-label="Close Terminal"');
    expect(html).not.toContain('terminal-panel__status">Loading terminal');
  });

  it('renders a close button on each terminal tab instead of a global close action', () => {
    const html = renderStaticWithI18n(
      <TerminalPanelToolbar
        sessions={[sessionFixture('one'), sessionFixture('two')]}
        activeSessionId="one"
        closingSessionIds={['two']}
        onSelectSession={() => undefined}
        onCreateSession={() => undefined}
        onCloseSession={() => undefined}
      />
    );

    expect(html).toContain('db-terminal-tab-shell');
    expect(html.match(/db-tab--strip/g)).toHaveLength(2);
    expect(html.match(/db-terminal-tab__close/g)).toHaveLength(2);
    expect(html.match(/db-workbench-close-button/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Close Terminal one"');
    expect(html).toContain('aria-label="Close Terminal two"');
  });

  it('shows terminating sessions as closing and disables their close button', () => {
    const html = renderStaticWithI18n(
      <TerminalPanelToolbar
        sessions={[sessionFixture('one', 'terminating')]}
        activeSessionId="one"
        closingSessionIds={[]}
        onSelectSession={() => undefined}
        onCreateSession={() => undefined}
        onCloseSession={() => undefined}
      />
    );

    expect(html).toContain('terminating');
    expect(html).toContain('disabled=""');
  });

  it('keeps a closing terminal visible until the backend reports closed', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let resolveClose!: () => void;
    const api = {
      listTerminalSessions: vi.fn(async () => ({ sessions: [sessionFixture('one')] })),
      createTerminalSession: vi.fn(),
      closeTerminalSession: vi.fn(() => new Promise<{ ok: true }>((resolve) => {
        resolveClose = () => resolve({ ok: true });
      })),
      subscribeTerminalEvents: vi.fn(() => ({ close: vi.fn() })),
      writeTerminalInput: vi.fn(async () => ({ ok: true })),
      resizeTerminal: vi.fn(async () => ({ session: sessionFixture('one') }))
    } as unknown as WorkbenchApiClient;

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <TerminalPanel
              api={api}
              resolvedTheme="light"
              requestedCwdProjectRelativePath={null}
              onRequestedCwdConsumed={() => undefined}
            />
          </I18nProvider>
        );
      });

      const closeButton = container.querySelector('button[aria-label="Close Terminal one"]') as HTMLButtonElement;
      await act(async () => {
        closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(api.closeTerminalSession).toHaveBeenCalledWith({ terminalId: 'one' });
      expect(container.textContent).toContain('one');
      expect(closeButton.disabled).toBe(true);

      await act(async () => {
        terminalHookState.activeInput?.onSessionUpdate(sessionFixture('one', 'terminating'));
      });
      expect(container.textContent).toContain('terminating');

      await act(async () => {
        terminalHookState.activeInput?.onSessionClose('one');
        resolveClose();
      });

      expect(container.querySelector('[data-testid="terminal-panel-empty-state"]')).not.toBeNull();
    } finally {
      await unmount(root, container);
      terminalHookState.activeInput = null;
    }
  });

  it('clears closing state and shows the error when close throws synchronously', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const api = {
      listTerminalSessions: vi.fn(async () => ({ sessions: [sessionFixture('one')] })),
      createTerminalSession: vi.fn(),
      closeTerminalSession: vi.fn(() => {
        throw new Error('close failed');
      }),
      subscribeTerminalEvents: vi.fn(() => ({ close: vi.fn() })),
      writeTerminalInput: vi.fn(async () => ({ ok: true })),
      resizeTerminal: vi.fn(async () => ({ session: sessionFixture('one') }))
    } as unknown as WorkbenchApiClient;

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <TerminalPanel
              api={api}
              resolvedTheme="light"
              requestedCwdProjectRelativePath={null}
              onRequestedCwdConsumed={() => undefined}
            />
          </I18nProvider>
        );
      });

      const closeButton = container.querySelector('button[aria-label="Close Terminal one"]') as HTMLButtonElement;
      await act(async () => {
        closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(api.closeTerminalSession).toHaveBeenCalledWith({ terminalId: 'one' });
      expect(container.textContent).toContain('close failed');
      expect((container.querySelector('button[aria-label="Close Terminal one"]') as HTMLButtonElement).disabled).toBe(false);
    } finally {
      await unmount(root, container);
      terminalHookState.activeInput = null;
    }
  });

  it('renders a terminal error when listing sessions throws synchronously', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const api = {
      listTerminalSessions: () => {
        throw new Error('Debrute project is not open.');
      }
    } as unknown as WorkbenchApiClient;

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <TerminalPanel
              api={api}
              resolvedTheme="light"
              requestedCwdProjectRelativePath={null}
              onRequestedCwdConsumed={() => undefined}
            />
          </I18nProvider>
        );
      });

      expect(container.textContent).toContain('Debrute project is not open.');
      expect(container.querySelector('[data-testid="terminal-panel-loading-state"]')).toBeNull();
    } finally {
      await unmount(root, container);
    }
  });
});


async function unmount(root: Root, container: HTMLElement): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

function sessionFixture(id: string, status: TerminalSessionView['status'] = 'running'): TerminalSessionView {
  return {
    id,
    title: id,
    cwdProjectRelativePath: '',
    cols: 80,
    rows: 24,
    status,
    exitCode: status === 'exited' ? 0 : null,
    signal: null,
    createdAt: '2026-06-24T00:00:00.000Z',
    updatedAt: '2026-06-24T00:00:00.000Z'
  };
}
