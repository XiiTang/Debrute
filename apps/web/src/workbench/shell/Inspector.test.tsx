import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@debrute/canvas-core';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import { DiagnosticList, Inspector } from './Inspector';

describe('DiagnosticList', () => {
  it('keeps diagnostic icon, message, and code as direct grid children', () => {
    const html = renderToStaticMarkup(
      <DiagnosticList
        diagnostics={[{
          id: 'diag-1',
          source: 'project',
          severity: 'warning',
          code: 'missing_asset',
          message: 'Missing asset',
          filePath: 'briefs/scene.md'
        } satisfies Diagnostic]}
        onSelect={() => undefined}
      />
    );

    expect(html).toMatch(/<button[^>]*class="[^"]*diagnostic warning[^"]*"[^>]*><svg[\s\S]*<\/svg><span>Missing asset<\/span><small>briefs\/scene\.md \/ missing_asset<\/small><\/button>/);
    expect(html).not.toContain('db-button__label');
  });
});

describe('Inspector property density', () => {
  it('keeps default selected-node details focused on actionable properties', () => {
    const html = renderToStaticMarkup(
      <Inspector
        activeCanvasId="canvas"
        selection={{ kind: 'node', projectRelativePath: 'flow/cover.png' }}
        state={{
          snapshot: {
            canvases: [{
              id: 'canvas',
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
              preferences: { showDiagnostics: true },
              schemaVersion: 1
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
    expect(html).not.toContain('<dt>Path</dt>');
    expect(html).not.toContain('<dt>Visible</dt>');
    expect(html).not.toContain('<dt>Locked</dt>');
    expect(html).not.toContain('<dt>Status</dt>');
  });
});
