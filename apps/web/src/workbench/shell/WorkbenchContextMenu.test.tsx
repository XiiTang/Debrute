import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkbenchContextMenu } from './WorkbenchContextMenu';
import { I18nProvider } from '../i18n';

describe('WorkbenchContextMenu', () => {
  it('renders separators and disabled menu items', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <WorkbenchContextMenu
          items={[
            { kind: 'action', command: 'copy' },
            { kind: 'separator', id: 'cut-copy' },
            { kind: 'action', command: 'paste', disabled: true }
          ]}
          position={{ x: 12, y: 16 }}
          onCommand={() => undefined}
          onClose={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Paste');
    expect(html).toContain('db-menu');
    expect(html).toContain('db-menu__item');
  });
});
