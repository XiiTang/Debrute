import { describe, expect, it } from 'vitest';
import { PHOTOSHOP_MAX_FILE_BYTES } from '@debrute/app-protocol';
import type { CanvasProjection } from '@debrute/canvas-core';
import {
  buildWorkbenchContextMenuItems,
  cameraCenteredOnNode,
  clampWorkbenchContextMenuPosition,
  isPhotoshopTransferEligible,
  type WorkbenchContextMenuTarget
} from './contextMenu';

describe('Workbench context menu', () => {
  it('builds one Canvas multi-selection menu with both delete commands and no single-file actions', () => {
    const target = canvasTarget('flow/a.png', [
      { projectRelativePath: 'flow/a.png', kind: 'file' },
      { projectRelativePath: 'flow/b.png', kind: 'file' }
    ]);
    const commands = actionCommands(buildWorkbenchContextMenuItems({
      target,
      projection: projection([
        node('flow/a.png', 'manual'),
        node('flow/b.png')
      ]),
    }));

    expect(commands).toEqual(expect.arrayContaining([
      'show-details',
      'reset-auto-layout',
      'cut',
      'copy',
      'open-terminal',
      'copy-path',
      'copy-relative-path',
      'reveal-in-system-file-manager',
      'delete',
      'delete-permanently'
    ]));
    expect(commands).not.toContain('rename');
    expect(commands).not.toContain('send-to-photoshop');
  });

  it('keeps the Explorer root menu limited to creation, paste, and one terminal', () => {
    expect(actionCommands(buildWorkbenchContextMenuItems({
      target: {
        source: 'explorer',
        invocationEntry: { projectRelativePath: '', kind: 'directory' },
        selectedEntries: []
      },
      projection: undefined
    }))).toEqual(['create-file', 'create-directory', 'paste', 'open-terminal']);
  });

  it('shows Photoshop only for exactly one eligible selected file', () => {
    const items = buildWorkbenchContextMenuItems({
      target: canvasTarget('cover.png', [{ projectRelativePath: 'cover.png', kind: 'file', sizeBytes: 1024 }]),
      projection: projection([node('cover.png')]),
      photoshop: { sessions: [] }
    });
    expect(items.some((item) => item.kind === 'photoshop-submenu')).toBe(true);
  });

  it('preserves Photoshop format, size, and AVIF host compatibility boundaries', () => {
    expect(isPhotoshopTransferEligible({
      projectRelativePath: 'cover.png', kind: 'file', sizeBytes: PHOTOSHOP_MAX_FILE_BYTES
    })).toBe(true);
    expect(isPhotoshopTransferEligible({
      projectRelativePath: 'cover.png', kind: 'file', sizeBytes: PHOTOSHOP_MAX_FILE_BYTES + 1
    })).toBe(false);
    expect(isPhotoshopTransferEligible({
      projectRelativePath: 'cover.txt', kind: 'file', sizeBytes: 10
    })).toBe(false);

    const items = buildWorkbenchContextMenuItems({
      target: canvasTarget('cover.avif', [{ projectRelativePath: 'cover.avif', kind: 'file', sizeBytes: 10 }]),
      projection: projection([node('cover.avif')]),
      photoshop: {
        sessions: [{
          pluginSessionId: 'legacy',
          hostVersion: '26.7.0',
          placementMimeTypes: ['image/png'],
          documents: [{ documentId: 7, title: 'Legacy.psd' }]
        }, {
          pluginSessionId: 'current',
          hostVersion: '26.8.0',
          placementMimeTypes: ['image/avif'],
          documents: [{ documentId: 8, title: 'Current.psd' }]
        }]
      }
    });
    const submenu = items.find((item) => item.kind === 'photoshop-submenu');
    expect(submenu?.kind).toBe('photoshop-submenu');
    if (submenu?.kind === 'photoshop-submenu') {
      expect(submenu.targets[0]).toMatchObject({ disabled: true, requirement: 'photoshop_26_8_for_avif' });
      expect(submenu.targets[1]?.disabled).toBeUndefined();
    }
  });

  it('keeps a selected Canvas Project root out of filesystem source commands while allowing paste', () => {
    const items = buildWorkbenchContextMenuItems({
      target: canvasTarget('', [{ projectRelativePath: '', kind: 'directory' }]),
      projection: projection([directoryNode('')]),
      fileClipboard: { operation: 'copy', entries: [{ projectRelativePath: 'a.png', kind: 'file' }] }
    });

    for (const command of ['cut', 'copy', 'delete', 'delete-permanently'] as const) {
      expect(items.find((item) => item.kind === 'action' && item.command === command)).toMatchObject({ disabled: true });
    }
    expect(items.find((item) => item.kind === 'action' && item.command === 'paste')).toMatchObject({ disabled: false });
  });

  it('disables filesystem mutations for a batch containing a missing node', () => {
    const items = buildWorkbenchContextMenuItems({
      target: canvasTarget('missing.png', [{
        projectRelativePath: 'missing.png',
        kind: 'file',
        availability: 'missing'
      }]),
      projection: projection([node('missing.png')])
    });
    for (const command of ['cut', 'copy', 'delete', 'delete-permanently'] as const) {
      expect(items.find((item) => item.kind === 'action' && item.command === command)).toMatchObject({ disabled: true });
    }
  });

  it('centers nodes without changing zoom and clamps menus to the viewport', () => {
    expect(cameraCenteredOnNode({
      node: { x: 100, y: 200, width: 80, height: 40 },
      surfaceSize: { width: 400, height: 300 },
      camera: { z: 2 }
    })).toEqual({ x: -80, y: -290, z: 2 });
    expect(clampWorkbenchContextMenuPosition({
      position: { x: 990, y: 790 },
      menuSize: { width: 200, height: 300 },
      viewportSize: { width: 1000, height: 800 }
    })).toEqual({ x: 792, y: 492 });
  });
});

function canvasTarget(
  invocationPath: string,
  selectedEntries: WorkbenchContextMenuTarget['selectedEntries']
): WorkbenchContextMenuTarget {
  return {
    source: 'canvas',
    invocationEntry: selectedEntries.find((entry) => entry.projectRelativePath === invocationPath)!,
    selectedEntries
  };
}

function actionCommands(items: ReturnType<typeof buildWorkbenchContextMenuItems>): string[] {
  return items.flatMap((item) => item.kind === 'action' ? [item.command] : []);
}

function projection(nodes: CanvasProjection['nodes']): CanvasProjection {
  return { canvasId: 'canvas-1', nodes, edges: [], diagnostics: [] };
}

function node(path: string, layoutMode?: 'manual'): CanvasProjection['nodes'][number] {
  return {
    projectRelativePath: path,
    nodeKind: 'file',
    mediaKind: 'image',
    x: 0,
    y: 0,
    width: 200,
    height: 120,
    z: 0,
    ...(layoutMode ? { layoutMode } : {}),
    availability: {
      state: 'available',
      size: 1024,
      mimeType: 'image/png',
      fileUrl: `/files/${path}`,
      revision: 'rev'
    }
  };
}

function directoryNode(path: string): CanvasProjection['nodes'][number] {
  const { mediaKind: _mediaKind, ...base } = node(path);
  return { ...base, nodeKind: 'directory' };
}
