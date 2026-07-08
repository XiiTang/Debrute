// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalSessionView, WorkbenchApiClient } from '@debrute/app-protocol';
import { TerminalPanel, TerminalPanelToolbar } from './TerminalPanel';
import { I18nProvider } from '../i18n';

vi.mock('./useXtermTerminal', () => ({
  useXtermTerminal: () => undefined
}));

function renderStaticWithI18n(element: React.ReactElement): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en">
      {element}
    </I18nProvider>
  );
}

describe('TerminalPanel rendering', () => {
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
    expect(html).toContain('db-icon-button--xs');
    expect(html).toContain('db-terminal-tab-new-button');
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
    expect(html.match(/db-terminal-tab__close/g)).toHaveLength(2);
    expect(html.match(/db-workbench-close-button/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Close Terminal one"');
    expect(html).toContain('aria-label="Close Terminal two"');
  });

  it('renders a terminal error when listing sessions throws synchronously', async () => {
    const restoreActEnvironment = installReactActEnvironment();
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
      restoreActEnvironment();
    }
  });
});

function installReactActEnvironment(): () => void {
  const globalWithActFlag = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const hadPreviousActEnvironment = 'IS_REACT_ACT_ENVIRONMENT' in globalWithActFlag;
  const previousActEnvironment = globalWithActFlag.IS_REACT_ACT_ENVIRONMENT;
  globalWithActFlag.IS_REACT_ACT_ENVIRONMENT = true;
  return () => {
    if (hadPreviousActEnvironment && previousActEnvironment !== undefined) {
      globalWithActFlag.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    } else {
      delete globalWithActFlag.IS_REACT_ACT_ENVIRONMENT;
    }
  };
}

async function unmount(root: Root, container: HTMLElement): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

function sessionFixture(id: string): TerminalSessionView {
  return {
    id,
    title: id,
    cwdProjectRelativePath: '',
    cols: 80,
    rows: 24,
    status: 'running',
    exitCode: null,
    signal: null,
    createdAt: '2026-06-24T00:00:00.000Z',
    updatedAt: '2026-06-24T00:00:00.000Z'
  };
}
