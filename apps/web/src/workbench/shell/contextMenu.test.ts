import { describe, expect, it } from 'vitest';
import type { CanvasProjection } from '@debrute/canvas-core';
import {
  buildWorkbenchContextMenuItems,
  clampWorkbenchContextMenuPosition,
  cameraCenteredOnNode
} from './contextMenu';

describe('workbench context menu', () => {
  it('shows Canvas actions and copy path for targets projected in the active Canvas', () => {
    const items = buildWorkbenchContextMenuItems({
      target: { source: 'canvas', kind: 'file', projectRelativePath: 'flow/cover.png' },
      projection: projectionWithNodes(['flow/cover.png']),
      canRevealInCanvas: true
    });

    expect(actionCommands(items)).toEqual([
      'show-details',
      'reveal-in-canvas',
      'copy-relative-path'
    ]);
  });

  it('shows only copy path for targets absent from the active Canvas projection', () => {
    const items = buildWorkbenchContextMenuItems({
      target: { source: 'canvas', kind: 'file', projectRelativePath: 'briefs/concept.md' },
      projection: projectionWithNodes(['flow/cover.png']),
      canRevealInCanvas: true
    });

    expect(actionCommands(items)).toEqual(['copy-relative-path']);
  });

  it('hides reveal when the active Canvas surface cannot navigate', () => {
    const items = buildWorkbenchContextMenuItems({
      target: { source: 'canvas', kind: 'file', projectRelativePath: 'flow/cover.png' },
      projection: projectionWithNodes(['flow/cover.png']),
      canRevealInCanvas: false
    });

    expect(actionCommands(items)).toEqual([
      'show-details',
      'copy-relative-path'
    ]);
  });

  it('builds VS Code-style Project Tree menu groups for directories with an empty file clipboard', () => {
    const items = buildWorkbenchContextMenuItems({
      target: {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'assets', kind: 'directory' }],
        primaryPath: 'assets',
        targetDirectoryPath: 'assets'
      },
      projection: projectionWithNodes([]),
      canRevealInCanvas: false,
      fileClipboard: undefined,
      desktopPlatform: 'darwin'
    });

    expect(items.map((item) => item.kind === 'separator' ? '---' : `${item.command}:${item.disabled === true ? 'disabled' : 'enabled'}`)).toEqual([
      'create-file:enabled',
      'create-directory:enabled',
      '---',
      'cut:enabled',
      'copy:enabled',
      'paste:disabled',
      'open-terminal:enabled',
      '---',
      'copy-path:enabled',
      'copy-relative-path:enabled',
      'reveal-in-system-file-manager:enabled',
      '---',
      'rename:enabled',
      'delete:enabled'
    ]);
    expect(actionLabels(items)).toContain('Copy Path');
    expect(actionLabels(items)).toContain('Copy Relative Path');
    expect(actionLabels(items)).toContain('Reveal in Finder');
    expect(actionLabels(items)).toContain('Delete');
    expect(actionLabels(items)).not.toContain('Move to Trash');
    expect(actionLabels(items)).not.toContain('Delete Permanently');
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

  it('hides folder-only creation actions for Project Tree file targets', () => {
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
      fileClipboard: undefined,
      desktopPlatform: 'linux'
    });

    expect(actionCommands(items)).not.toContain('create-file');
    expect(actionCommands(items)).not.toContain('create-directory');
    expect(actionCommands(items)).toContain('copy-path');
    expect(actionCommands(items)).toContain('delete');
    expect(actionCommands(items)).not.toContain('delete-permanently');
    expect(actionCommands(items)).not.toContain('move-to-trash');
    expect(actionLabels(items)).toContain('Delete');
    expect(actionLabels(items)).toContain('Copy Path');
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

  it('keeps Canvas node menus free of file-management commands', () => {
    const items = buildWorkbenchContextMenuItems({
      target: { source: 'canvas', kind: 'file', projectRelativePath: 'flow/cover.png' },
      projection: projectionWithNodes(['flow/cover.png']),
      canRevealInCanvas: true,
      fileClipboard: {
        operation: 'cut',
        entries: [{ projectRelativePath: 'briefs/concept.md', kind: 'file' }]
      },
      desktopPlatform: 'linux'
    });

    expect(actionCommands(items)).toEqual(['show-details', 'reveal-in-canvas', 'copy-relative-path']);
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

function projectionWithNodes(paths: string[]): CanvasProjection {
  return {
    canvasId: 'main',
    nodes: paths.map((path) => ({
      projectRelativePath: path,
      nodeKind: 'file',
      mediaKind: 'image',
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      z: 0,
      availability: {
        state: 'available',
        size: 100,
        mimeType: 'image/png',
        fileUrl: `http://127.0.0.1:17321/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/${path}?v=rev`,
        revision: 'rev'
      }
    })),
    edges: [],
    diagnostics: []
  };
}
