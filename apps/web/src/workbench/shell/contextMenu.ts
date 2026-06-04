import type { CanvasProjection, ProjectedCanvasNode } from '@axis/canvas-core';
import type { CanvasCamera } from '../canvas/runtime/canvasCamera';
import { cameraCenteredOnCanvasPoint } from '../canvas/runtime/canvasCamera';

export type WorkbenchContextMenuSource = 'canvas' | 'explorer';
export type WorkbenchContextMenuTargetKind = 'file' | 'directory';

export type WorkbenchContextMenuCommand =
  | 'show-details'
  | 'reveal-in-canvas'
  | 'create-file'
  | 'create-directory'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'reveal-in-system-file-manager'
  | 'rename'
  | 'move-to-trash'
  | 'delete-permanently'
  | 'copy-relative-path';

export interface WorkbenchContextMenuTarget {
  source: WorkbenchContextMenuSource;
  kind: WorkbenchContextMenuTargetKind;
  projectRelativePath: string;
}

export interface WorkbenchContextMenuPosition {
  x: number;
  y: number;
}

export interface WorkbenchFileClipboard {
  operation: 'copy' | 'cut';
  projectRelativePath: string;
  kind: WorkbenchContextMenuTargetKind;
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

  return [
    ...(input.target.kind === 'directory' ? [
      action('create-file', 'New File'),
      action('create-directory', 'New Folder'),
      separator('new')
    ] : []),
    action('cut', 'Cut'),
    action('copy', 'Copy'),
    action('paste', 'Paste', { disabled: !input.fileClipboard }),
    separator('path-actions'),
    action('copy-relative-path', 'Copy Relative Path'),
    action('reveal-in-system-file-manager', projectSystemFileManagerLabel(input.desktopPlatform ?? 'linux')),
    separator('modify'),
    action('rename', 'Rename'),
    action('move-to-trash', 'Move to Trash'),
    action('delete-permanently', 'Delete Permanently')
  ];
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
