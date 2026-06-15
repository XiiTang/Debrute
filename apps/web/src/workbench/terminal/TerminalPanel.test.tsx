import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkbenchApiClient } from '@debrute/app-protocol';
import { TerminalPanel } from './TerminalPanel';

const joinText = (...parts: string[]) => parts.join('');

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
    expect(html).toContain('db-icon-button');
    expect(html).toContain('New Terminal');
    expect(html).toContain('Restart Terminal');
    expect(html).toContain('Close Terminal');
    expect(html).not.toContain(joinText('terminal-panel__tab', '--active'));
    expect(html).not.toContain('terminal-panel__status">Loading terminal');
  });
});
