import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import type { CanvasCamera } from '../canvas/runtime/canvasCamera';
import { cameraCenteredOnCanvasPoint } from '../canvas/runtime/canvasCamera';

export type WorkbenchContextMenuSource = 'canvas' | 'explorer';
export type WorkbenchContextMenuTargetKind = 'file' | 'directory';
export type WorkbenchExplorerContextMenuTargetKind = 'root' | 'item' | 'selection';

export type WorkbenchContextMenuCommand =
  | 'show-details'
  | 'reveal-in-canvas'
  | 'create-file'
  | 'create-directory'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'copy-path'
  | 'reveal-in-system-file-manager'
  | 'rename'
  | 'delete'
  | 'delete-permanently'
  | 'copy-relative-path';

export interface WorkbenchProjectPathEntry {
  projectRelativePath: string;
  kind: WorkbenchContextMenuTargetKind;
}

export interface WorkbenchCanvasContextMenuTarget {
  source: 'canvas';
  kind: WorkbenchContextMenuTargetKind;
  projectRelativePath: string;
}

export type WorkbenchExplorerContextMenuTarget =
  | {
      source: 'explorer';
      targetKind: 'root';
      paths: [];
      primaryPath: null;
      targetDirectoryPath: string;
    }
  | {
      source: 'explorer';
      targetKind: 'item' | 'selection';
      paths: WorkbenchProjectPathEntry[];
      primaryPath: string;
      targetDirectoryPath: string;
    };

export type WorkbenchContextMenuTarget = WorkbenchCanvasContextMenuTarget | WorkbenchExplorerContextMenuTarget;

export interface WorkbenchContextMenuPosition {
  x: number;
  y: number;
}

export interface WorkbenchFileClipboard {
  operation: 'copy' | 'cut';
  entries: WorkbenchProjectPathEntry[];
}

export type WorkbenchContextMenuItem =
  | {
      kind: 'action';
      command: WorkbenchContextMenuCommand;
      label: string;
      disabled?: boolean;
    }
  | {
      kind: 'separator';
      id: string;
    };

export function buildWorkbenchContextMenuItems(input: {
  target: WorkbenchContextMenuTarget;
  projection: CanvasProjection | undefined;
  canRevealInCanvas: boolean;
  fileClipboard?: WorkbenchFileClipboard | undefined;
  desktopPlatform?: NodeJS.Platform | undefined;
}): WorkbenchContextMenuItem[] {
  if (input.target.source === 'canvas') {
    const node = projectedContextMenuNode(input.projection, input.target.projectRelativePath);
    return compactMenuItems([
      node ? action('show-details', 'Show Details') : undefined,
      node && input.canRevealInCanvas ? action('reveal-in-canvas', 'Reveal in Canvas') : undefined,
      action('copy-relative-path', 'Copy Relative Path')
    ]);
  }

  if (input.target.targetKind === 'root') {
    return [
      action('create-file', 'New File'),
      action('create-directory', 'New Folder'),
      action('paste', 'Paste', { disabled: !input.fileClipboard?.entries.length })
    ];
  }

  if (input.target.targetKind === 'selection') {
    return [
      action('cut', 'Cut'),
      action('copy', 'Copy'),
      action('copy-path', 'Copy Path'),
      action('copy-relative-path', 'Copy Relative Path'),
      action('delete', 'Delete')
    ];
  }

  const targetEntry = explorerContextMenuPrimaryEntry(input.target);
  return [
    ...(targetEntry?.kind === 'directory' ? [
      action('create-file', 'New File'),
      action('create-directory', 'New Folder'),
      separator('new')
    ] : []),
    action('cut', 'Cut'),
    action('copy', 'Copy'),
    ...(targetEntry?.kind === 'directory' ? [
      action('paste', 'Paste', { disabled: !input.fileClipboard?.entries.length })
    ] : []),
    separator('path-actions'),
    action('copy-path', 'Copy Path'),
    action('copy-relative-path', 'Copy Relative Path'),
    action('reveal-in-system-file-manager', projectSystemFileManagerLabel(input.desktopPlatform ?? 'linux')),
    separator('modify'),
    action('rename', 'Rename'),
    action('delete', 'Delete')
  ];
}

export function explorerContextMenuEntries(target: WorkbenchContextMenuTarget): WorkbenchProjectPathEntry[] {
  return target.source === 'explorer' ? target.paths : [{
    projectRelativePath: target.projectRelativePath,
    kind: target.kind
  }];
}

export function explorerContextMenuPrimaryEntry(target: WorkbenchContextMenuTarget): WorkbenchProjectPathEntry | undefined {
  return explorerContextMenuEntries(target)[0];
}

export function explorerContextMenuProjectRelativePaths(target: WorkbenchContextMenuTarget): string[] {
  return explorerContextMenuEntries(target).map((entry) => entry.projectRelativePath);
}

export function projectSystemFileManagerLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return 'Reveal in Finder';
  }
  if (platform === 'win32') {
    return 'Reveal in File Explorer';
  }
  return 'Open Containing Folder';
}

export function projectedContextMenuNode(
  projection: CanvasProjection | undefined,
  projectRelativePath: string
): ProjectedCanvasNode | undefined {
  return projection?.nodes.find((node) => node.projectRelativePath === projectRelativePath);
}

export function cameraCenteredOnNode(input: {
  node: Pick<ProjectedCanvasNode, 'x' | 'y' | 'width' | 'height'>;
  surfaceSize: { width: number; height: number };
  camera: Pick<CanvasCamera, 'z'>;
}): CanvasCamera {
  const nodeCenter = {
    x: input.node.x + input.node.width / 2,
    y: input.node.y + input.node.height / 2
  };
  return cameraCenteredOnCanvasPoint({
    center: nodeCenter,
    surfaceSize: input.surfaceSize,
    camera: input.camera
  });
}

export function clampWorkbenchContextMenuPosition(input: {
  position: WorkbenchContextMenuPosition;
  menuSize: { width: number; height: number };
  viewportSize: { width: number; height: number };
  margin?: number;
}): WorkbenchContextMenuPosition {
  const margin = input.margin ?? 8;
  return {
    x: clamp(input.position.x, margin, Math.max(margin, input.viewportSize.width - input.menuSize.width - margin)),
    y: clamp(input.position.y, margin, Math.max(margin, input.viewportSize.height - input.menuSize.height - margin))
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function action(
  command: WorkbenchContextMenuCommand,
  label: string,
  options: { disabled?: boolean } = {}
): WorkbenchContextMenuItem {
  return {
    kind: 'action',
    command,
    label,
    ...(options.disabled === undefined ? {} : { disabled: options.disabled })
  };
}

function separator(id: string): WorkbenchContextMenuItem {
  return { kind: 'separator', id };
}

function compactMenuItems(items: Array<WorkbenchContextMenuItem | undefined>): WorkbenchContextMenuItem[] {
  return items.filter((item): item is WorkbenchContextMenuItem => Boolean(item));
}
