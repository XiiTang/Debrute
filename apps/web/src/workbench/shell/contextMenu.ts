import type { CanvasProjection, ProjectedCanvasNode } from '@debrute/canvas-core';
import { isSupportedAdobeBridgeWorkbenchFile } from '../adobe-bridge/adobeBridgeLabels';
import type { CanvasCamera } from '../canvas/runtime/canvasCamera';
import { cameraCenteredOnCanvasPoint } from '../canvas/runtime/canvasCamera';

export type WorkbenchContextMenuSource = 'canvas' | 'explorer';
export type WorkbenchContextMenuTargetKind = 'file' | 'directory';
export type WorkbenchExplorerContextMenuTargetKind = 'root' | 'item' | 'selection';

export type WorkbenchContextMenuCommand =
  | 'send-to-photoshop'
  | 'show-details'
  | 'reveal-in-canvas'
  | 'reset-auto-layout'
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
  | 'open-terminal'
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
      disabled?: boolean;
    }
  | {
      kind: 'separator';
      id: string;
    };

export function buildWorkbenchContextMenuItems(input: {
  target: WorkbenchContextMenuTarget;
  projection: CanvasProjection | undefined;
  canSelectCanvasNode?: boolean | undefined;
  canRevealInCanvas: boolean;
  fileClipboard?: WorkbenchFileClipboard | undefined;
  desktopPlatform?: NodeJS.Platform | undefined;
  adobeBridgeEnabled?: boolean | undefined;
}): WorkbenchContextMenuItem[] {
  if (input.target.source === 'explorer' && input.target.targetKind === 'root') {
    return [
      action('create-file'),
      action('create-directory'),
      action('paste', { disabled: !input.fileClipboard?.entries.length }),
      action('open-terminal')
    ];
  }

  if (input.target.source === 'explorer' && input.target.targetKind === 'selection') {
    return [
      action('cut'),
      action('copy'),
      action('open-terminal'),
      action('copy-path'),
      action('copy-relative-path'),
      action('delete')
    ];
  }

  const targetEntry = explorerContextMenuPrimaryEntry(input.target);
  if (!targetEntry) {
    return [];
  }
  const node = projectedContextMenuNode(input.projection, targetEntry.projectRelativePath);
  return buildSinglePathContextMenuItems({
    ...input,
    targetEntry,
    node
  });
}

function buildSinglePathContextMenuItems(input: {
  target: WorkbenchContextMenuTarget;
  targetEntry: WorkbenchProjectPathEntry;
  node: ProjectedCanvasNode | undefined;
  canSelectCanvasNode?: boolean | undefined;
  canRevealInCanvas: boolean;
  fileClipboard?: WorkbenchFileClipboard | undefined;
  desktopPlatform?: NodeJS.Platform | undefined;
  adobeBridgeEnabled?: boolean | undefined;
}): WorkbenchContextMenuItem[] {
  const explorerItem = input.target.source === 'explorer';
  const directory = input.targetEntry.kind === 'directory';
  const canvasProjectRoot = input.target.source === 'canvas'
    && directory
    && input.targetEntry.projectRelativePath === '';
  const canvasActions = [
    action('show-details', {
      disabled: !(input.node && input.canSelectCanvasNode === true)
    }),
    action('reveal-in-canvas', {
      disabled: !(input.node && input.canRevealInCanvas)
    }),
    action('reset-auto-layout', {
      disabled: input.node?.layoutMode !== 'manual'
    })
  ];
  const creationActions = explorerItem && directory
    ? [
        action('create-file'),
        action('create-directory')
      ]
    : [];
  const fileActions = compactMenuItems([
    canvasProjectRoot ? undefined : action('cut'),
    canvasProjectRoot ? undefined : action('copy'),
    directory ? action('paste', { disabled: !input.fileClipboard?.entries.length }) : undefined
  ]);
  const pathActions = compactMenuItems([
    action('open-terminal'),
    action('copy-path'),
    canvasProjectRoot ? undefined : action('copy-relative-path'),
    input.targetEntry.kind === 'file'
      && input.adobeBridgeEnabled === true
      && isSupportedAdobeBridgeWorkbenchFile(input.targetEntry.projectRelativePath)
      ? action('send-to-photoshop')
      : undefined,
    action('reveal-in-system-file-manager')
  ]);
  const modifyActions = compactMenuItems([
    explorerItem ? action('rename') : undefined,
    canvasProjectRoot ? undefined : action('delete')
  ]);
  return groupedMenuItems([
    { id: 'canvas-actions', items: canvasActions },
    { id: 'new', items: creationActions },
    { id: 'file-actions', items: fileActions },
    { id: 'path-actions', items: pathActions },
    { id: 'modify', items: modifyActions }
  ]);
}

function groupedMenuItems(groups: Array<{ id: string; items: WorkbenchContextMenuItem[] }>): WorkbenchContextMenuItem[] {
  const populated = groups.filter((group) => group.items.length > 0);
  return populated.flatMap((group, index) => (
    index === 0 ? group.items : [separator(group.id), ...group.items]
  ));
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
  options: { disabled?: boolean } = {}
): WorkbenchContextMenuItem {
  return {
    kind: 'action',
    command,
    ...(options.disabled === undefined ? {} : { disabled: options.disabled })
  };
}

function separator(id: string): WorkbenchContextMenuItem {
  return { kind: 'separator', id };
}

function compactMenuItems(items: Array<WorkbenchContextMenuItem | undefined>): WorkbenchContextMenuItem[] {
  return items.filter((item): item is WorkbenchContextMenuItem => Boolean(item));
}
