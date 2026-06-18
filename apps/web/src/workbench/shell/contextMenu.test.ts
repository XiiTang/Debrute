import { describe, expect, it } from 'vitest';
import type { CanvasProjection } from '@debrute/canvas-core';
import {
  buildWorkbenchContextMenuItems,
  clampWorkbenchContextMenuPosition,
  cameraCenteredOnNode
} from './contextMenu';

describe('workbench context menu', () => {
  it('builds the aligned Canvas file node menu without Explorer edit-only actions', () => {
    const items = buildWorkbenchContextMenuItems({
      target: { source: 'canvas', kind: 'file', projectRelativePath: 'flow/cover.png' },
      projection: projectionWithNodes(['flow/cover.png']),
      canSelectCanvasNode: true,
      canRevealInCanvas: true,
      fileClipboard: undefined,
      desktopPlatform: 'darwin',
      adobeBridgeEnabled: true
    });

    expect(menuShape(items)).toEqual([
      'show-details:enabled',
      'reveal-in-canvas:enabled',
      'reset-auto-layout:disabled',
      '---',
      'cut:enabled',
      'copy:enabled',
      '---',
      'open-terminal:enabled',
      'copy-path:enabled',
      'copy-relative-path:enabled',
      'send-to-photoshop:enabled',
      'reveal-in-system-file-manager:enabled',
      '---',
      'delete:enabled'
    ]);
    expect(actionCommands(items)).not.toContain('create-file');
    expect(actionCommands(items)).not.toContain('create-directory');
    expect(actionCommands(items)).not.toContain('rename');
    expect(actionCommands(items)).not.toContain('paste');
  });

  it('builds the aligned Canvas directory node menu with directory paste', () => {
    const items = buildWorkbenchContextMenuItems({
      target: { source: 'canvas', kind: 'directory', projectRelativePath: 'assets' },
      projection: projectionWithNodes([{ projectRelativePath: 'assets', nodeKind: 'directory', layoutMode: 'manual' }]),
      canSelectCanvasNode: true,
      canRevealInCanvas: true,
      fileClipboard: {
        operation: 'copy',
        entries: [{ projectRelativePath: 'briefs/concept.md', kind: 'file' }]
      },
      desktopPlatform: 'linux'
    });

    expect(menuShape(items)).toEqual([
      'show-details:enabled',
      'reveal-in-canvas:enabled',
      'reset-auto-layout:enabled',
      '---',
      'cut:enabled',
      'copy:enabled',
      'paste:enabled',
      '---',
      'open-terminal:enabled',
      'copy-path:enabled',
      'copy-relative-path:enabled',
      'reveal-in-system-file-manager:enabled',
      '---',
      'delete:enabled'
    ]);
    expect(actionCommands(items)).not.toContain('rename');
  });

  it('builds the Canvas project root node menu without root entry file operations', () => {
    const items = buildWorkbenchContextMenuItems({
      target: { source: 'canvas', kind: 'directory', projectRelativePath: '' },
      projection: projectionWithNodes([{ projectRelativePath: '', nodeKind: 'directory', layoutMode: 'manual' }]),
      canSelectCanvasNode: true,
      canRevealInCanvas: true,
      fileClipboard: {
        operation: 'copy',
        entries: [{ projectRelativePath: 'briefs/concept.md', kind: 'file' }]
      },
      desktopPlatform: 'darwin'
    });

    expect(menuShape(items)).toEqual([
      'show-details:enabled',
      'reveal-in-canvas:enabled',
      'reset-auto-layout:enabled',
      '---',
      'paste:enabled',
      '---',
      'open-terminal:enabled',
      'copy-path:enabled',
      'reveal-in-system-file-manager:enabled'
    ]);
    expect(actionCommands(items)).not.toContain('cut');
    expect(actionCommands(items)).not.toContain('copy');
    expect(actionCommands(items)).not.toContain('copy-relative-path');
    expect(actionCommands(items)).not.toContain('delete');
  });

  it('shows disabled Canvas actions for Project Explorer items absent from the active Canvas', () => {
    const items = buildWorkbenchContextMenuItems({
      target: {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'briefs/concept.md', kind: 'file' }],
        primaryPath: 'briefs/concept.md',
        targetDirectoryPath: 'briefs'
      },
      projection: projectionWithNodes(['flow/cover.png']),
      canSelectCanvasNode: true,
      canRevealInCanvas: true,
      fileClipboard: undefined,
      desktopPlatform: 'win32'
    });

    expect(menuShape(items)).toEqual([
      'show-details:disabled',
      'reveal-in-canvas:disabled',
      'reset-auto-layout:disabled',
      '---',
      'cut:enabled',
      'copy:enabled',
      '---',
      'open-terminal:enabled',
      'copy-path:enabled',
      'copy-relative-path:enabled',
      'reveal-in-system-file-manager:enabled',
      '---',
      'rename:enabled',
      'delete:enabled'
    ]);
    expect(actionLabels(items)).toContain('Reveal in File Explorer');
    expect(actionCommands(items)).not.toContain('paste');
  });

  it('shows enabled Canvas actions for Project Explorer items in the active Canvas', () => {
    const items = buildWorkbenchContextMenuItems({
      target: {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'assets', kind: 'directory' }],
        primaryPath: 'assets',
        targetDirectoryPath: 'assets'
      },
      projection: projectionWithNodes([{ projectRelativePath: 'assets', nodeKind: 'directory', layoutMode: 'manual' }]),
      canSelectCanvasNode: true,
      canRevealInCanvas: true,
      fileClipboard: undefined,
      desktopPlatform: 'darwin'
    });

    expect(menuShape(items)).toEqual([
      'show-details:enabled',
      'reveal-in-canvas:enabled',
      'reset-auto-layout:enabled',
      '---',
      'create-file:enabled',
      'create-directory:enabled',
      '---',
      'cut:enabled',
      'copy:enabled',
      'paste:disabled',
      '---',
      'open-terminal:enabled',
      'copy-path:enabled',
      'copy-relative-path:enabled',
      'reveal-in-system-file-manager:enabled',
      '---',
      'rename:enabled',
      'delete:enabled'
    ]);
    expect(actionLabels(items)).toContain('Reveal in Finder');
  });

  it('disables Reveal in Canvas when the active Canvas surface cannot navigate', () => {
    const items = buildWorkbenchContextMenuItems({
      target: {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'flow/cover.png', kind: 'file' }],
        primaryPath: 'flow/cover.png',
        targetDirectoryPath: 'flow'
      },
      projection: projectionWithNodes(['flow/cover.png']),
      canSelectCanvasNode: true,
      canRevealInCanvas: false,
      fileClipboard: undefined,
      desktopPlatform: 'linux'
    });

    expect(menuShape(items).slice(0, 3)).toEqual([
      'show-details:enabled',
      'reveal-in-canvas:disabled',
      'reset-auto-layout:disabled'
    ]);
  });

  it('enables Project Tree paste when the internal clipboard has a source', () => {
    const items = buildWorkbenchContextMenuItems({
      target: {
        source: 'explorer',
        targetKind: 'root',
        paths: [],
        primaryPath: null,
        targetDirectoryPath: ''
      },
      projection: projectionWithNodes([]),
      canRevealInCanvas: false,
      fileClipboard: {
        operation: 'copy',
        entries: [{ projectRelativePath: 'briefs/concept.md', kind: 'file' }]
      },
      desktopPlatform: 'win32'
    });

    expect(actionCommands(items)).toContain('paste');
    expect(items.find((item) => item.kind === 'action' && item.command === 'paste')).toMatchObject({ disabled: false });
    expect(actionLabels(items)).not.toContain('Reveal in File Explorer');
  });

  it('keeps Project Tree paste disabled when the internal clipboard has no entries', () => {
    const items = buildWorkbenchContextMenuItems({
      target: {
        source: 'explorer',
        targetKind: 'root',
        paths: [],
        primaryPath: null,
        targetDirectoryPath: ''
      },
      projection: projectionWithNodes([]),
      canRevealInCanvas: false,
      fileClipboard: {
        operation: 'copy',
        entries: []
      },
      desktopPlatform: 'linux'
    });

    expect(items.find((item) => item.kind === 'action' && item.command === 'paste')).toMatchObject({ disabled: true });
  });

  it('shows Send to Photoshop for supported Project Tree image files when bridge is enabled', () => {
    const items = buildWorkbenchContextMenuItems({
      target: {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'assets/cover.png', kind: 'file' }],
        primaryPath: 'assets/cover.png',
        targetDirectoryPath: 'assets'
      },
      projection: projectionWithNodes([]),
      canRevealInCanvas: false,
      desktopPlatform: 'linux',
      adobeBridgeEnabled: true
    });

    expect(actionCommands(items)).toContain('send-to-photoshop');
    expect(actionLabels(items)).toContain('Send to Photoshop...');
  });

  it('does not show Send to Photoshop for unsupported files', () => {
    const items = buildWorkbenchContextMenuItems({
      target: {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'brief.md', kind: 'file' }],
        primaryPath: 'brief.md',
        targetDirectoryPath: ''
      },
      projection: projectionWithNodes([]),
      canRevealInCanvas: false,
      desktopPlatform: 'linux',
      adobeBridgeEnabled: true
    });

    expect(actionCommands(items)).not.toContain('send-to-photoshop');
  });

  it('shows only root-level creation and paste actions for blank Project Tree targets', () => {
    const items = buildWorkbenchContextMenuItems({
      target: {
        source: 'explorer',
        targetKind: 'root',
        paths: [],
        primaryPath: null,
        targetDirectoryPath: ''
      },
      projection: projectionWithNodes([]),
      canRevealInCanvas: false,
      fileClipboard: undefined,
      desktopPlatform: 'linux'
    });

    expect(actionCommands(items)).toEqual(['create-file', 'create-directory', 'paste', 'open-terminal']);
    expect(items.find((item) => item.kind === 'action' && item.command === 'paste')).toMatchObject({ disabled: true });
  });

  it('uses the restricted multi-selection Project Tree menu', () => {
    const items = buildWorkbenchContextMenuItems({
      target: {
        source: 'explorer',
        targetKind: 'selection',
        paths: [
          { projectRelativePath: 'assets/cover.png', kind: 'file' },
          { projectRelativePath: 'briefs', kind: 'directory' }
        ],
        primaryPath: 'assets/cover.png',
        targetDirectoryPath: ''
      },
      projection: projectionWithNodes([]),
      canRevealInCanvas: false,
      fileClipboard: undefined,
      desktopPlatform: 'linux'
    });

    expect(actionCommands(items)).toEqual([
      'cut',
      'copy',
      'open-terminal',
      'copy-path',
      'copy-relative-path',
      'delete'
    ]);
  });

  it('centers a Canvas camera on the node while preserving z', () => {
    expect(cameraCenteredOnNode({
      node: {
        x: 120,
        y: 80,
        width: 200,
        height: 120
      },
      surfaceSize: {
        width: 1000,
        height: 600
      },
      camera: {
        z: 0.5
      }
    })).toEqual({
      x: 390,
      y: 230,
      z: 0.5
    });
  });

  it('clamps menu position inside the visible viewport', () => {
    expect(clampWorkbenchContextMenuPosition({
      position: { x: 790, y: 590 },
      menuSize: { width: 180, height: 140 },
      viewportSize: { width: 800, height: 600 }
    })).toEqual({
      x: 612,
      y: 452
    });
  });
});

function actionCommands(items: ReturnType<typeof buildWorkbenchContextMenuItems>): string[] {
  return items.filter((item) => item.kind === 'action').map((item) => item.command);
}

function actionLabels(items: ReturnType<typeof buildWorkbenchContextMenuItems>): string[] {
  return items.filter((item) => item.kind === 'action').map((item) => item.label);
}

function menuShape(items: ReturnType<typeof buildWorkbenchContextMenuItems>): string[] {
  return items.map((item) => (
    item.kind === 'separator'
      ? '---'
      : `${item.command}:${item.disabled === true ? 'disabled' : 'enabled'}`
  ));
}

function projectionWithNodes(
  nodes: Array<string | {
    projectRelativePath: string;
    nodeKind?: 'file' | 'directory';
    layoutMode?: 'manual';
  }>,
  manualPaths = new Set<string>()
): CanvasProjection {
  return {
    canvasId: 'main',
    nodes: nodes.map((entry) => {
      const node = typeof entry === 'string'
        ? {
            projectRelativePath: entry,
            nodeKind: 'file' as const,
            layoutMode: manualPaths.has(entry) ? 'manual' as const : undefined
          }
        : entry;
      const nodeKind = node.nodeKind ?? 'file';
      return {
        projectRelativePath: node.projectRelativePath,
        nodeKind,
        ...(nodeKind === 'directory' ? {} : { mediaKind: 'image' as const }),
        x: 0,
        y: 0,
        width: 200,
        height: 120,
        z: 0,
        ...(node.layoutMode ? { layoutMode: node.layoutMode } : {}),
        availability: {
          state: 'available',
          size: 100,
          mimeType: 'image/png',
          fileUrl: `http://127.0.0.1:17321/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/${node.projectRelativePath}?v=rev`,
          revision: 'rev'
        }
      };
    }),
    edges: [],
    diagnostics: []
  };
}
