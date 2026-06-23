import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkbenchApiClient } from '@debrute/app-protocol';
import { TerminalPanel } from './TerminalPanel';

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
    expect(html).toContain('Close Terminal');
    expect(html).not.toContain('terminal-panel__status">Loading terminal');
    expect(readFileSync('apps/web/src/workbench/terminal/TerminalPanel.tsx', 'utf8')).toContain('className="db-terminal-tab"');
  });
});
