import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkbenchContextMenu } from './WorkbenchContextMenu';

describe('WorkbenchContextMenu', () => {
  it('renders separators and disabled menu items', () => {
    const html = renderToStaticMarkup(
      <WorkbenchContextMenu
        items={[
          { kind: 'action', command: 'copy', label: 'Copy' },
          { kind: 'separator', id: 'cut-copy' },
          { kind: 'action', command: 'paste', label: 'Paste', disabled: true }
        ]}
        position={{ x: 12, y: 16 }}
        onCommand={() => undefined}
        onClose={() => undefined}
      />
    );

    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Paste');
  });
});
