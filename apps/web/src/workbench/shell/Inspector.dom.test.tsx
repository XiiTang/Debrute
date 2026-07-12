import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Diagnostic } from '@debrute/canvas-core';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import { DiagnosticList, Inspector } from './Inspector';
import { I18nProvider } from '../i18n';

function renderStaticWithI18n(element: React.ReactElement): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en">
      {element}
    </I18nProvider>
  );
}

describe('DiagnosticList', () => {
  it('exposes selectable diagnostics as buttons and reports the selected diagnostic', async () => {
    const diagnostic = {
      id: 'diag-1',
      source: 'project',
      severity: 'warning',
      code: 'missing_asset',
      message: 'Missing asset',
      filePath: 'briefs/scene.md'
    } satisfies Diagnostic;
    const onSelect = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <DiagnosticList diagnostics={[diagnostic]} onSelect={onSelect} />
          </I18nProvider>
        );
      });

      const row = container.querySelector('button');
      expect(row).toBeInstanceOf(HTMLButtonElement);
      expect(row?.getAttribute('type')).toBe('button');
      expect(row?.textContent).toContain('Missing asset');
      expect(row?.textContent).toContain('briefs/scene.md / missing_asset');

      await act(async () => {
        row?.click();
      });
      expect(onSelect).toHaveBeenCalledOnce();
      expect(onSelect).toHaveBeenCalledWith(diagnostic);
    } finally {
      await unmount(root, container);
    }
  });
});

describe('Inspector property density', () => {
  it('starts with selection content and does not repeat the shell title', () => {
    const html = renderStaticWithI18n(
      <Inspector
        activeCanvasId={undefined}
        selection={undefined}
        state={{ snapshot: undefined } as unknown as WorkbenchState}
        actions={{} as WorkbenchActions}
      />
    );

    expect(html).not.toContain('>Inspector<');
    expect(html).toContain('Select a node or diagnostic');
  });

  it('keeps default selected-node details focused on actionable properties', () => {
    const html = renderStaticWithI18n(
      <Inspector
        activeCanvasId="canvas"
        selection={{ kind: 'node', projectRelativePath: 'flow/cover.png' }}
        state={{
          snapshot: {
            canvases: [{
              id: 'canvas',
              name: 'canvas',
              nodeElements: [{
                projectRelativePath: 'flow/cover.png',
                nodeKind: 'file',
                mediaKind: 'image',
                x: 12,
                y: 24,
                width: 320,
                height: 180,
                z: 0
              }],
              annotations: [],
              preferences: { showDiagnostics: true }
            }],
            projections: [{
              canvasId: 'canvas',
              nodes: [{
                projectRelativePath: 'flow/cover.png',
                nodeKind: 'file',
                mediaKind: 'image',
                x: 12,
                y: 24,
                width: 320,
                height: 180,
                z: 0,
                availability: { state: 'available', revision: 'rev', size: 1, mimeType: 'image/png', fileUrl: '/file.png' }
              }],
              edges: [],
              diagnostics: []
            }],
            diagnostics: []
          }
        } as unknown as WorkbenchState}
        actions={{} as WorkbenchActions}
      />
    );

    expect(html).toContain('flow/cover.png');
    expect(html).toContain('<dt>Type</dt>');
    expect(html).toContain('<dt>Position</dt>');
    expect(html).toContain('<dt>Size</dt>');
    expect(html).not.toContain('<dt>Layer</dt>');
    expect(html).not.toContain('Move forward');
    expect(html).not.toContain('Move backward');
    expect(html).not.toContain('<dt>Path</dt>');
    expect(html).not.toContain('<dt>Visible</dt>');
    expect(html).not.toContain('<dt>Locked</dt>');
    expect(html).not.toContain('<dt>Status</dt>');
  });
});


async function unmount(root: Root, container: HTMLElement): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}
