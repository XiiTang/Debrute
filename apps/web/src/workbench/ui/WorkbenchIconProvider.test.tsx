import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FolderTree } from 'lucide-react';
import { IconButton } from './IconButton';
import { WorkbenchIconProvider } from './WorkbenchIconProvider';

describe('WorkbenchIconProvider', () => {
  it('applies Workbench chrome defaults to Lucide icons', () => {
    const html = renderToStaticMarkup(
      <WorkbenchIconProvider>
        <FolderTree />
      </WorkbenchIconProvider>
    );

    expect(html).toContain('width="16"');
    expect(html).toContain('height="16"');
    expect(html).toContain('stroke-width="2.625"');
  });

  it('keeps icon-only button labels on the button', () => {
    const html = renderToStaticMarkup(
      <WorkbenchIconProvider>
        <IconButton label="Open explorer" icon={<FolderTree />} />
      </WorkbenchIconProvider>
    );

    expect(html).toContain('aria-label="Open explorer"');
    expect(html).toContain('aria-hidden="true"');
  });
});
