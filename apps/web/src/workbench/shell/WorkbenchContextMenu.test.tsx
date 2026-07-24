import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchContextMenu } from './WorkbenchContextMenu';
import { I18nProvider } from '../i18n';

describe('WorkbenchContextMenu', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders separators and disabled menu items', () => {
    vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 720 });
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <WorkbenchContextMenu
          productPlatform="win32"
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
