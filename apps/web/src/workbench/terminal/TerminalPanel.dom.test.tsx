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
        canSubmitRequestedCwd={() => true}
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

  it('creates an empty Project-root Terminal with the one current input shape', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const created = sessionFixture('one');
    const harness = createTerminalApiHarness({
      createTerminalSession: vi.fn(async () => ({ session: created }))
    });

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <TerminalPanel
              api={harness.api}
              resolvedTheme="light"
              requestedCwdProjectRelativePath={null}
              canSubmitRequestedCwd={() => true}
              onRequestedCwdConsumed={() => undefined}
            />
          </I18nProvider>
        );
      });

      await act(async () => harness.emitSessions([]));
      expect(harness.api.createTerminalSession).toHaveBeenCalledOnce();
      expect(harness.api.createTerminalSession).toHaveBeenCalledWith({ cwdProjectRelativePath: '' });
      expect(container.textContent).not.toContain('one');
      expect(container.querySelector('[data-testid="terminal-panel-loading-state"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="terminal-panel-empty-state"]')).toBeNull();

      await act(async () => harness.emitSessions([created]));
      expect(container.textContent).toContain('one');
    } finally {
      await unmount(root, container);
      terminalHookState.activeInput = null;
    }
  });

  it('refuses a queued Project-path Terminal request whose accepted scope closed before the lazy panel submitted it', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onRequestedCwdConsumed = vi.fn();
    const harness = createTerminalApiHarness();

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <TerminalPanel
              api={harness.api}
              resolvedTheme="light"
              requestedCwdProjectRelativePath="assets"
              canSubmitRequestedCwd={() => false}
              onRequestedCwdConsumed={onRequestedCwdConsumed}
            />
          </I18nProvider>
        );
      });

      expect(onRequestedCwdConsumed).toHaveBeenCalledOnce();
      expect(harness.api.createTerminalSession).not.toHaveBeenCalled();
    } finally {
      await unmount(root, container);
      terminalHookState.activeInput = null;
    }
  });

  it('submits a queued Project-path Terminal request through its still-current accepted scope', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onRequestedCwdConsumed = vi.fn();
    const harness = createTerminalApiHarness();

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <TerminalPanel
              api={harness.api}
              resolvedTheme="light"
              requestedCwdProjectRelativePath="assets"
              canSubmitRequestedCwd={() => true}
              onRequestedCwdConsumed={onRequestedCwdConsumed}
            />
          </I18nProvider>
        );
      });

      expect(onRequestedCwdConsumed).toHaveBeenCalledOnce();
      expect(harness.api.createTerminalSession).toHaveBeenCalledOnce();
      expect(harness.api.createTerminalSession).toHaveBeenCalledWith({
        cwdProjectRelativePath: 'assets'
      });
    } finally {
      await unmount(root, container);
      terminalHookState.activeInput = null;
    }
  });

  it('keeps the current terminal active until topology accepts a newly created session', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const existing = sessionFixture('one');
    const created = sessionFixture('two');
    const harness = createTerminalApiHarness({
      createTerminalSession: vi.fn(async () => ({ session: created }))
    });

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <TerminalPanel
              api={harness.api}
              resolvedTheme="light"
              requestedCwdProjectRelativePath={null}
              canSubmitRequestedCwd={() => true}
              onRequestedCwdConsumed={() => undefined}
            />
          </I18nProvider>
        );
      });
      await act(async () => harness.emitSessions([existing]));
      expect(terminalHookState.activeInput?.session?.id).toBe('one');

      const createButton = container.querySelector('button[aria-label="New Terminal"]') as HTMLButtonElement;
      await act(async () => {
        createButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(harness.api.createTerminalSession).toHaveBeenCalledWith({ cwdProjectRelativePath: '' });
      expect(terminalHookState.activeInput?.session?.id).toBe('one');

      await act(async () => harness.emitSessions([existing, created]));
      expect(terminalHookState.activeInput?.session?.id).toBe('two');
    } finally {
      await unmount(root, container);
      terminalHookState.activeInput = null;
    }
  });

  it('activates a created session when topology arrives before the create response', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const existing = sessionFixture('one');
    const created = sessionFixture('two');
    let resolveCreate!: (value: { session: TerminalSessionView }) => void;
    const harness = createTerminalApiHarness({
      createTerminalSession: vi.fn(() => new Promise<{ session: TerminalSessionView }>((resolve) => {
        resolveCreate = resolve;
      }))
    });

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <TerminalPanel
              api={harness.api}
              resolvedTheme="light"
              requestedCwdProjectRelativePath={null}
              canSubmitRequestedCwd={() => true}
              onRequestedCwdConsumed={() => undefined}
            />
          </I18nProvider>
        );
      });
      await act(async () => harness.emitSessions([existing]));

      const createButton = container.querySelector('button[aria-label="New Terminal"]') as HTMLButtonElement;
      await act(async () => {
        createButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await act(async () => harness.emitSessions([existing, created]));
      expect(terminalHookState.activeInput?.session?.id).toBe('one');

      await act(async () => resolveCreate({ session: created }));
      expect(terminalHookState.activeInput?.session?.id).toBe('two');
    } finally {
      await unmount(root, container);
      terminalHookState.activeInput = null;
    }
  });

  it('keeps a closing terminal visible until the backend reports closed', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let resolveClose!: () => void;
    const harness = createTerminalApiHarness({
      closeTerminalSession: vi.fn(() => new Promise<{ ok: true }>((resolve) => {
        resolveClose = () => resolve({ ok: true });
      }))
    });

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <TerminalPanel
              api={harness.api}
              resolvedTheme="light"
              requestedCwdProjectRelativePath={null}
              canSubmitRequestedCwd={() => true}
              onRequestedCwdConsumed={() => undefined}
            />
          </I18nProvider>
        );
      });
      await act(async () => harness.emitSessions([sessionFixture('one')]));

      const closeButton = container.querySelector('button[aria-label="Close Terminal one"]') as HTMLButtonElement;
      await act(async () => {
        closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(harness.api.closeTerminalSession).toHaveBeenCalledWith({ terminalId: 'one' });
      expect(container.textContent).toContain('one');
      expect(closeButton.disabled).toBe(true);

      await act(async () => {
        harness.emitSessions([sessionFixture('one', 'terminating')]);
      });
      expect(container.textContent).toContain('terminating');

      await act(async () => {
        resolveClose();
      });
      expect(container.textContent).toContain('one');

      await act(async () => harness.emitSessions([]));

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
    const harness = createTerminalApiHarness({
      closeTerminalSession: vi.fn(() => {
        throw new Error('close failed');
      })
    });

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <TerminalPanel
              api={harness.api}
              resolvedTheme="light"
              requestedCwdProjectRelativePath={null}
              canSubmitRequestedCwd={() => true}
              onRequestedCwdConsumed={() => undefined}
            />
          </I18nProvider>
        );
      });
      await act(async () => harness.emitSessions([sessionFixture('one')]));

      const closeButton = container.querySelector('button[aria-label="Close Terminal one"]') as HTMLButtonElement;
      await act(async () => {
        closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(harness.api.closeTerminalSession).toHaveBeenCalledWith({ terminalId: 'one' });
      expect(container.textContent).toContain('close failed');
      expect((container.querySelector('button[aria-label="Close Terminal one"]') as HTMLButtonElement).disabled).toBe(false);
    } finally {
      await unmount(root, container);
      terminalHookState.activeInput = null;
    }
  });

  it('renders a terminal error when the collection stream fails', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const harness = createTerminalApiHarness();

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <TerminalPanel
              api={harness.api}
              resolvedTheme="light"
              requestedCwdProjectRelativePath={null}
              canSubmitRequestedCwd={() => true}
              onRequestedCwdConsumed={() => undefined}
            />
          </I18nProvider>
        );
      });
      await act(async () => harness.emitError(new Error('Debrute project is not open.')));

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

function createTerminalApiHarness(overrides: Record<string, unknown> = {}) {
  let sessionsListener: ((sessions: TerminalSessionView[]) => void) | undefined;
  let sessionsErrorListener: ((error: Error) => void) | undefined;
  const api = {
    subscribeTerminalSessions: vi.fn((
      listener: (sessions: TerminalSessionView[]) => void,
      onError: (error: Error) => void
    ) => {
      sessionsListener = listener;
      sessionsErrorListener = onError;
      return { close: vi.fn() };
    }),
    createTerminalSession: vi.fn(async () => ({ session: sessionFixture('created') })),
    closeTerminalSession: vi.fn(async () => ({ ok: true as const })),
    subscribeTerminalEvents: vi.fn(() => ({ close: vi.fn() })),
    writeTerminalInput: vi.fn(async () => ({ ok: true as const })),
    resizeTerminal: vi.fn(async () => ({ session: sessionFixture('one') })),
    ...overrides
  };
  return {
    api: api as typeof api & WorkbenchApiClient,
    emitSessions(sessions: TerminalSessionView[]) {
      sessionsListener?.(sessions);
    },
    emitError(error: Error) {
      sessionsErrorListener?.(error);
    }
  };
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
