import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TerminalSessionView, WorkbenchApiClient } from '@debrute/app-protocol';
import { TerminalPanel, TerminalPanelToolbar } from './TerminalPanel';
import { I18nProvider } from '../i18n';

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
});

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
