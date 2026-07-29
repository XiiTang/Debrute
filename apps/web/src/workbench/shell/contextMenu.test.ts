import { describe, expect, it } from 'vitest';
import type { PhotoshopStateView } from '@debrute/app-protocol';
import type { CanvasProjection } from '@debrute/canvas-core';
import {
  buildWorkbenchContextMenuItems,
  clampWorkbenchContextMenuPosition,
  cameraCenteredOnNode
} from './contextMenu';

describe('workbench context menu', () => {
  it('builds the aligned Canvas file node menu without Explorer edit-only actions', () => {
    const items = buildWorkbenchContextMenuItems({
      target: { source: 'canvas', kind: 'file', projectRelativePath: 'flow/cover.png', sizeBytes: 1024 },
      projection: projectionWithNodes(['flow/cover.png']),
      canSelectCanvasNode: true,
      canRevealInCanvas: true,
      fileClipboard: undefined,
      photoshop: photoshopState()
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
      'send-to-photoshop:submenu:2',
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
    });

    expect(actionCommands(items)).toContain('paste');
    expect(items.find((item) => item.kind === 'action' && item.command === 'paste')).toMatchObject({ disabled: false });
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
    });

    expect(items.find((item) => item.kind === 'action' && item.command === 'paste')).toMatchObject({ disabled: true });
  });

  it('shows every live Photoshop document for an eligible Project file', () => {
    const items = buildWorkbenchContextMenuItems({
      target: {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'assets/cover.png', kind: 'file', sizeBytes: 1024 }],
        primaryPath: 'assets/cover.png',
        targetDirectoryPath: 'assets'
      },
      projection: projectionWithNodes([]),
      canRevealInCanvas: false,
      photoshop: photoshopState()
    });

    expect(actionCommands(items)).toContain('send-to-photoshop');
    expect(items.find((item) => item.kind === 'photoshop-submenu')).toMatchObject({
      targets: [
        { pluginSessionId: 'session-1', documentId: 7, title: 'Poster.psd' },
        { pluginSessionId: 'session-2', documentId: 9, title: 'Poster.psd' }
      ]
    });
  });

  it('keeps every live Document visible and disables only AVIF-incompatible sessions', () => {
    const items = buildWorkbenchContextMenuItems({
      target: {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'assets/cover.avif', kind: 'file', sizeBytes: 1024 }],
        primaryPath: 'assets/cover.avif',
        targetDirectoryPath: 'assets'
      },
      projection: projectionWithNodes([]),
      canRevealInCanvas: false,
      photoshop: {
        sessions: [
          {
            pluginSessionId: 'session-1',
            hostVersion: '26.7.0',
            placementMimeTypes: [
              'image/png',
              'image/jpeg',
              'image/webp',
              'image/vnd.adobe.photoshop'
            ],
            documents: [{ documentId: 7, title: 'Legacy.psd' }]
          },
          {
            pluginSessionId: 'session-2',
            hostVersion: '26.8.0',
            placementMimeTypes: [
              'image/png',
              'image/jpeg',
              'image/webp',
              'image/vnd.adobe.photoshop',
              'image/avif'
            ],
            documents: [{ documentId: 9, title: 'Current.psd' }]
          }
        ]
      }
    });

    expect(items.find((item) => item.kind === 'photoshop-submenu')).toMatchObject({
      targets: [
        {
          pluginSessionId: 'session-1',
          documentId: 7,
          title: 'Legacy.psd',
          disabled: true,
          requirement: 'photoshop_26_8_for_avif'
        },
        { pluginSessionId: 'session-2', documentId: 9, title: 'Current.psd' }
      ]
    });
  });

  it('keeps the AVIF submenu and every Document visible when all sessions are incompatible', () => {
    const items = buildWorkbenchContextMenuItems({
      target: {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'assets/cover.avif', kind: 'file', sizeBytes: 1024 }],
        primaryPath: 'assets/cover.avif',
        targetDirectoryPath: 'assets'
      },
      projection: projectionWithNodes([]),
      canRevealInCanvas: false,
      photoshop: {
        sessions: [{
          pluginSessionId: 'session-1',
          hostVersion: '24.4.0',
          placementMimeTypes: [
            'image/png',
            'image/jpeg',
            'image/webp',
            'image/vnd.adobe.photoshop'
          ],
          documents: [
            { documentId: 7, title: 'Poster.psd' },
            { documentId: 9, title: 'Reference.psd' }
          ]
        }]
      }
    });

    expect(items.find((item) => item.kind === 'photoshop-submenu')).toMatchObject({
      targets: [
        {
          documentId: 7,
          title: 'Poster.psd',
          disabled: true,
          requirement: 'photoshop_26_8_for_avif'
        },
        {
          documentId: 9,
          title: 'Reference.psd',
          disabled: true,
          requirement: 'photoshop_26_8_for_avif'
        }
      ]
    });
  });

  it('keeps an eligible submenu visible with no document targets', () => {
    const items = buildWorkbenchContextMenuItems({
      target: {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'assets/cover.webp', kind: 'file', sizeBytes: 0 }],
        primaryPath: 'assets/cover.webp',
        targetDirectoryPath: 'assets'
      },
      projection: projectionWithNodes([]),
      canRevealInCanvas: false,
      photoshop: { sessions: [] }
    });

    expect(items.find((item) => item.kind === 'photoshop-submenu')).toMatchObject({ targets: [] });
  });

  it('does not show Send to Photoshop for unsupported, oversized, or unsized files', () => {
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
      photoshop: photoshopState()
    });

    expect(actionCommands(items)).not.toContain('send-to-photoshop');

    for (const entry of [
      { projectRelativePath: 'too-large.psd', kind: 'file' as const, sizeBytes: 256 * 1024 * 1024 + 1 },
      { projectRelativePath: 'unknown.png', kind: 'file' as const }
    ]) {
      expect(actionCommands(buildWorkbenchContextMenuItems({
        target: {
          source: 'explorer',
          targetKind: 'item',
          paths: [entry],
          primaryPath: entry.projectRelativePath,
          targetDirectoryPath: ''
        },
        projection: projectionWithNodes([]),
        canRevealInCanvas: false,
        photoshop: photoshopState()
      }))).not.toContain('send-to-photoshop');
    }
  });

  it('applies the Photoshop format and size boundary to Canvas-owned file facts', () => {
    const build = (projectRelativePath: string, sizeBytes?: number) => actionCommands(
      buildWorkbenchContextMenuItems({
        target: {
          source: 'canvas',
          kind: 'file',
          projectRelativePath,
          ...(sizeBytes === undefined ? {} : { sizeBytes })
        },
        projection: projectionWithNodes([]),
        canRevealInCanvas: false,
        photoshop: photoshopState()
      })
    );

    expect(build('data/deep/cover.png', 256 * 1024 * 1024)).toContain('send-to-photoshop');
    expect(build('data/deep/missing.png')).not.toContain('send-to-photoshop');
    expect(build('data/deep/too-large.png', 256 * 1024 * 1024 + 1)).not.toContain('send-to-photoshop');
    expect(build('data/deep/notes.txt', 1024)).not.toContain('send-to-photoshop');
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
  return items.filter((item) => item.kind !== 'separator').map((item) => item.command);
}

function menuShape(items: ReturnType<typeof buildWorkbenchContextMenuItems>): string[] {
  return items.map((item) => (
    item.kind === 'separator'
      ? '---'
      : item.kind === 'photoshop-submenu'
        ? `${item.command}:submenu:${item.targets.length}`
        : `${item.command}:${item.disabled === true ? 'disabled' : 'enabled'}`
  ));
}

function photoshopState(): PhotoshopStateView {
  return {
    sessions: [
      {
        pluginSessionId: 'session-1',
        hostVersion: '27.0',
        placementMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/vnd.adobe.photoshop', 'image/avif'],
        documents: [{ documentId: 7, title: 'Poster.psd' }]
      },
      {
        pluginSessionId: 'session-2',
        hostVersion: '27.0',
        placementMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/vnd.adobe.photoshop', 'image/avif'],
        documents: [{ documentId: 9, title: 'Poster.psd' }]
      }
    ]
  };
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
          fileUrl: `/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/${node.projectRelativePath}?v=rev`,
          revision: 'rev'
        }
      };
    }),
    edges: [],
    diagnostics: []
  };
}
