import {
  PHOTOSHOP_MAX_FILE_BYTES,
  photoshopPlacementFormatForPath,
  type PhotoshopPlacementFormat,
  type PhotoshopPlacementRequirement,
  type PhotoshopStateView,
  type ProjectPathEntry,
  type ProjectPathRef
} from '@debrute/app-protocol';
import type { CanvasProjection, ProjectedCanvasNode } from '../canvas/CanvasScene';
import type { CanvasCamera } from '../canvas/runtime/canvasCamera';
import { cameraCenteredOnCanvasPoint } from '../canvas/runtime/canvasCamera';
import {
  resolveProjectPathCommandTarget,
  projectPathCommandsAvailable,
  type ProjectPathCommandTarget
} from '../services/projectPathCommandTarget';

export type ProjectPathCommand =
  | 'send-to-photoshop'
  | 'inspect'
  | 'reset-auto-layout'
  | 'create-file'
  | 'create-directory'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'copy-path'
  | 'reveal-in-canvas'
  | 'reveal-in-system-file-manager'
  | 'rename'
  | 'delete'
  | 'delete-permanently'
  | 'open-terminal'
  | 'copy-relative-path';

export type WorkbenchContextMenuTarget = ProjectPathCommandTarget;

export interface WorkbenchContextMenuPosition {
  x: number;
  y: number;
}

export interface WorkbenchFileClipboard {
  operation: 'copy' | 'cut';
  entries: ProjectPathRef[];
}

export type WorkbenchContextMenuItem =
  | {
      kind: 'action';
      command: ProjectPathCommand;
      disabled?: boolean;
    }
  | {
      kind: 'photoshop-submenu';
      command: 'send-to-photoshop';
      targets: PhotoshopDocumentTarget[];
    }
  | {
      kind: 'separator';
      id: string;
    };

export interface PhotoshopDocumentTarget {
  pluginSessionId: string;
  documentId: number;
  title: string;
  disabled?: boolean;
  requirement?: PhotoshopPlacementRequirement;
}

export function buildWorkbenchContextMenuItems(input: {
  target: WorkbenchContextMenuTarget;
  projection: CanvasProjection | undefined;
  fileClipboard?: WorkbenchFileClipboard | undefined;
  photoshop?: PhotoshopStateView | undefined;
}): WorkbenchContextMenuItem[] {
  const resolved = resolveProjectPathCommandTarget(input.target);
  const rootInvocation = input.target.invocation.projectRelativePath === ''
    && resolved.length === 0;
  if (rootInvocation && input.target.source === 'explorer') {
    return [
      action('create-file'),
      action('create-directory'),
      action('paste', { disabled: !input.fileClipboard?.entries.length }),
      action('open-terminal')
    ];
  }

  if (rootInvocation) {
    return groupedMenuItems([
      { id: 'file-actions', items: [
        action('cut', { disabled: true }),
        action('copy', { disabled: true }),
        action('paste', { disabled: !input.fileClipboard?.entries.length })
      ] },
      { id: 'path-actions', items: [action('open-terminal')] },
      { id: 'modify', items: [
        action('delete', { disabled: true }),
        action('delete-permanently', { disabled: true })
      ] }
    ]);
  }

  if (resolved.length === 0) {
    return [];
  }
  const explorerItem = input.target.source === 'explorer';
  const invocationDirectory = input.target.invocation.kind === 'directory';
  const selectionNodes = resolved.flatMap((entry) => {
    const node = projectedContextMenuNode(input.projection, entry.projectRelativePath);
    return node ? [node] : [];
  });
  const inspectionActions = [action('inspect')];
  const canvasActions = input.target.source === 'canvas' ? [
    action('reset-auto-layout', {
      disabled: selectionNodes.length !== resolved.length
        || !selectionNodes.some((node) => node.layoutMode === 'manual')
    })
  ] : [];
  const creationActions = explorerItem && invocationDirectory && resolved.length === 1
    ? [
        action('create-file'),
        action('create-directory')
      ]
    : [];
  const fileActions = compactMenuItems([
    action('cut', { disabled: !projectPathCommandsAvailable(resolved) }),
    action('copy', { disabled: !projectPathCommandsAvailable(resolved) }),
    invocationDirectory ? action('paste', {
      disabled: !input.fileClipboard?.entries.length || input.target.invocation.missing === true
    }) : undefined
  ]);
  const singleSelection = resolved.length === 1
    ? resolved[0]
    : undefined;
  const singleSelectionNode = singleSelection
    ? projectedContextMenuNode(input.projection, singleSelection.projectRelativePath)
    : undefined;
  const photoshopEntry = singleSelection?.kind === 'file'
    && singleSelectionNode?.availability.state === 'available'
    ? {
        ...singleSelection,
        sizeBytes: singleSelectionNode.availability.size
      }
    : undefined;
  const pathActions = compactMenuItems([
    explorerItem && resolved.length === 1
      ? action('reveal-in-canvas')
      : undefined,
    action('open-terminal'),
    action('copy-path'),
    action('copy-relative-path'),
    photoshopEntry && isPhotoshopTransferEligible(photoshopEntry)
      ? photoshopSubmenu(
          input.photoshop,
          photoshopPlacementFormatForPath(photoshopEntry.projectRelativePath)!
        )
      : undefined,
    action('reveal-in-system-file-manager', {
      disabled: input.target.invocation.missing === true
    })
  ]);
  const modifyActions = compactMenuItems([
    explorerItem
      && resolved.length === 1
      && resolved[0]!.projectRelativePath === input.target.invocation.projectRelativePath
      ? action('rename')
      : undefined,
    action('delete', { disabled: !projectPathCommandsAvailable(resolved) }),
    action('delete-permanently', { disabled: !projectPathCommandsAvailable(resolved) })
  ]);
  return groupedMenuItems([
    { id: 'inspection', items: inspectionActions },
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

export function isPhotoshopTransferEligible(entry: ProjectPathEntry): boolean {
  if (entry.kind !== 'file'
    || entry.sizeBytes === undefined
    || entry.sizeBytes < 0
    || entry.sizeBytes > PHOTOSHOP_MAX_FILE_BYTES
  ) {
    return false;
  }
  return photoshopPlacementFormatForPath(entry.projectRelativePath) !== undefined;
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
  command: ProjectPathCommand,
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

function photoshopSubmenu(
  state: PhotoshopStateView | undefined,
  format: PhotoshopPlacementFormat
): WorkbenchContextMenuItem | undefined {
  if (state?.status !== 'connected') {
    return undefined;
  }
  const targets = state.sessions.flatMap((session) => {
    const compatible = session.placementMimeTypes.includes(format.mimeType);
    return session.documents.map((document) => ({
      pluginSessionId: session.pluginSessionId,
      documentId: document.documentId,
      title: document.title,
      ...(compatible ? {} : {
        disabled: true,
        ...(format.requirement === undefined ? {} : { requirement: format.requirement })
      })
    }));
  });
  if (targets.length === 0) {
    return undefined;
  }
  return {
    kind: 'photoshop-submenu',
    command: 'send-to-photoshop',
    targets
  };
}

function compactMenuItems(items: Array<WorkbenchContextMenuItem | undefined>): WorkbenchContextMenuItem[] {
  return items.filter((item): item is WorkbenchContextMenuItem => Boolean(item));
}
