import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TerminalSessionView, WorkbenchApiClient } from '@debrute/app-protocol';
import { TerminalPanel, TerminalPanelToolbar } from './TerminalPanel';

describe('TerminalPanel rendering', () => {
  it('renders toolbar actions through Workbench UI primitives', () => {
    const html = renderToStaticMarkup(
      <TerminalPanel
        api={{} as WorkbenchApiClient}
        requestedCwdProjectRelativePath={null}
        onRequestedCwdConsumed={() => undefined}
      />
    );

    expect(html).toContain('db-toolbar');
    expect(html).toContain('db-terminal-tabs');
    expect(html).toContain('db-action-row');
    expect(html).toContain('db-icon-button');
    expect(html).toContain('New Terminal');
    expect(html).toContain('Restart Terminal');
    expect(html).not.toContain('aria-label="Close Terminal"');
    expect(html).not.toContain('terminal-panel__status">Loading terminal');
    expect(readFileSync('apps/web/src/workbench/terminal/TerminalPanel.tsx', 'utf8')).toContain('className="db-terminal-tab"');
  });

  it('renders a close button on each terminal tab instead of a global close action', () => {
    const html = renderToStaticMarkup(
      <TerminalPanelToolbar
        sessions={[sessionFixture('one'), sessionFixture('two')]}
        activeSessionId="one"
        closingSessionIds={['two']}
        canRestartActiveSession
        onSelectSession={() => undefined}
        onCreateSession={() => undefined}
        onRestartActiveSession={() => undefined}
        onCloseSession={() => undefined}
      />
    );

    expect(html).toContain('db-terminal-tab-shell');
    expect(html.match(/db-terminal-tab__close/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Close one"');
    expect(html).toContain('aria-label="Close two"');
    expect(html).not.toContain('aria-label="Close Terminal"');
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
    updatedAt: '2026-06-24T00:00:00.000Z',
    restartCount: 0
  };
}
