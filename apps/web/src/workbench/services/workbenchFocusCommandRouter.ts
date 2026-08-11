import {
  workbenchCommandShortcutMatches,
  type DebruteProductPlatform
} from '@debrute/app-protocol';
import type { CanvasProjection } from '../canvas/CanvasScene';
import type { CanvasEditorRuntime } from '../canvas/runtime/CanvasEditorRuntime';
import { canvasNodeSelection, selectedNodeProjectRelativePaths } from '../canvas/runtime/canvasSelection';
import type { ProjectExplorerController } from '../project-explorer/useProjectExplorerController';
import type { ProjectPathCommandRouter } from './projectPathCommandRouter';
import {
  projectPathCommandEntryForCanvasNode,
  resolveProjectPathCommandTarget
} from './projectPathCommandTarget';
import type { WorkbenchMenuCommandId } from '../shell/workbenchTitleBarState';

export type WorkbenchFocusCommand =
  | 'escape'
  | 'select-all'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'trash'
  | 'delete-permanently';

export type WorkbenchBehaviorOwner = 'canvas' | 'other';

export interface WorkbenchFocusCommandRouter {
  captureOwner(): WorkbenchBehaviorOwner;
  dispatch(command: WorkbenchFocusCommand, owner?: WorkbenchBehaviorOwner): boolean;
}

export function createWorkbenchFocusCommandRouter(input: {
  getRuntime(): CanvasEditorRuntime | undefined;
  getProjection(): CanvasProjection | undefined;
  getCanvasRoot(): HTMLElement | null;
  getProjectPathRouter(): ProjectPathCommandRouter | undefined;
  getExplorerController(): Pick<ProjectExplorerController, 'fileClipboard' | 'clearCut'> | undefined;
}): WorkbenchFocusCommandRouter {
  const captureOwner = (): WorkbenchBehaviorOwner => (
    document.activeElement === input.getCanvasRoot() ? 'canvas' : 'other'
  );
  return {
    captureOwner,
    dispatch(command, owner = captureOwner()) {
      const runtime = input.getRuntime();
      const pointerInteraction = runtime?.getSnapshot().pointerInteraction;
      if (command === 'escape' && pointerInteraction) {
        runtime?.input.cancelPointerInteraction(pointerInteraction.pointerId);
        return true;
      }
      if (command === 'escape' && runtime?.getSnapshot().contentInteractionProjectRelativePath) {
        runtime.endContentActivation();
        return true;
      }
      if (owner !== 'canvas' || !runtime) {
        return false;
      }
      if (command === 'escape') {
        const explorer = input.getExplorerController();
        if (explorer?.fileClipboard?.operation === 'cut') {
          explorer.clearCut();
          return true;
        }
        if (runtime.getSnapshot().selection?.kind === 'nodes') {
          runtime.setSelection(undefined);
        }
        return true;
      }
      const projection = input.getProjection();
      if (command === 'select-all') {
        runtime.setSelection(canvasNodeSelection(projection?.nodes.map((node) => node.projectRelativePath) ?? []));
        return true;
      }
      const target = canvasCommandTarget(runtime, projection);
      if (!target) {
        return true;
      }
      const router = input.getProjectPathRouter();
      if (!router) {
        return true;
      }
      const resolvedTarget = resolveProjectPathCommandTarget(target);
      if (command === 'paste' && (
        resolvedTarget.selectionEntries.length !== 1
        || resolvedTarget.selectionEntries[0]?.kind !== 'directory'
      )) {
        return true;
      }
      const projectPathCommand = command === 'trash'
        ? 'delete'
        : command;
      router.run(projectPathCommand, { target, position: { x: 0, y: 0 } });
      return true;
    }
  };
}

export function workbenchFocusCommandFromKeyboardEvent(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  platform: DebruteProductPlatform
): WorkbenchFocusCommand | undefined {
  if (event.key === 'Escape') {
    return 'escape';
  }
  if (workbenchCommandShortcutMatches('edit.delete-permanently', event, platform)) {
    return 'delete-permanently';
  }
  const commandIds = [
    'edit.select-all',
    'edit.copy',
    'edit.cut',
    'edit.paste',
    'edit.delete'
  ] as const;
  const commandId = commandIds.find((candidate) => (
    workbenchCommandShortcutMatches(candidate, event, platform)
  ));
  return commandId
    ? workbenchFocusCommandFromMenuCommandId(commandId)
    : undefined;
}

export function workbenchFocusCommandFromMenuCommandId(
  commandId: WorkbenchMenuCommandId
): WorkbenchFocusCommand | undefined {
  switch (commandId) {
    case 'edit.select-all': return 'select-all';
    case 'edit.copy': return 'copy';
    case 'edit.cut': return 'cut';
    case 'edit.paste': return 'paste';
    case 'edit.delete': return 'trash';
    default: return undefined;
  }
}

function canvasCommandTarget(runtime: CanvasEditorRuntime, projection: CanvasProjection | undefined) {
  const selectedPaths = selectedNodeProjectRelativePaths(runtime.getSnapshot().selection);
  const nodesByPath = new Map(projection?.nodes.map((node) => [node.projectRelativePath, node]) ?? []);
  const selectedEntries = selectedPaths.flatMap((path) => {
    const node = nodesByPath.get(path);
    return node ? [projectPathCommandEntryForCanvasNode(node)] : [];
  });
  if (selectedEntries.length === 0) {
    return undefined;
  }
  return {
    source: 'canvas' as const,
    invocationEntry: selectedEntries[0]!,
    selectedEntries
  };
}
