import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { IconButton } from './IconButton';
import { FolderTree, WorkbenchIconProvider } from './WorkbenchIconProvider.js';

describe('WorkbenchIconProvider', () => {
  it('applies the solid 16px Debrute Cutout icon contract', () => {
    const html = renderToStaticMarkup(
      <WorkbenchIconProvider>
        <FolderTree />
      </WorkbenchIconProvider>
    );

    expect(html).toContain('width="16"');
    expect(html).toContain('height="16"');
    expect(html).toContain('data-debrute-icon="folder-tree"');
    expect(html).toContain('fill="currentColor"');
    expect(html).not.toContain('stroke=');
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
