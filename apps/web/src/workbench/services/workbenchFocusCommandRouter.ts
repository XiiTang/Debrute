import {
  workbenchCommandShortcutMatches,
  type DebruteProductPlatform
} from '@debrute/app-protocol';
import type { CanvasProjection } from '../canvas/CanvasScene';
import type { CanvasEditorRuntime } from '../canvas/runtime/CanvasEditorRuntime';
import { canvasNodeSelection, selectedNodeProjectRelativePaths } from '../canvas/runtime/canvasSelection';
import type {
  ProjectExplorerController,
  ProjectExplorerEditCommand
} from '../project-explorer/useProjectExplorerController';
import type { ProjectPathCommandRouter } from './projectPathCommandRouter';
import { projectPathCommandEntryForCanvasNode } from './projectPathCommandTarget';
import type { WorkbenchMenuCommandId } from '../shell/workbenchTitleBarState';

export type WorkbenchFocusCommand = ProjectExplorerEditCommand;

export type WorkbenchBehaviorOwner = 'canvas' | 'explorer' | 'other';

export interface WorkbenchFocusCommandRouter {
  captureOwner(): WorkbenchBehaviorOwner;
  dispatch(command: WorkbenchFocusCommand, owner?: WorkbenchBehaviorOwner): boolean;
}

export function createWorkbenchFocusCommandRouter(input: {
  getRuntime(): CanvasEditorRuntime | undefined;
  getProjection(): CanvasProjection | undefined;
  getCanvasRoot(): HTMLElement | null;
  getExplorerRoot(): HTMLElement | null;
  getProjectPathRouter(): ProjectPathCommandRouter | undefined;
  getExplorerController(): ProjectExplorerController | undefined;
}): WorkbenchFocusCommandRouter {
  const captureOwner = (): WorkbenchBehaviorOwner => {
    const active = document.activeElement;
    if (active === input.getCanvasRoot()) {
      return 'canvas';
    }
    if (active === input.getExplorerRoot()) {
      return 'explorer';
    }
    return 'other';
  };
  return {
    captureOwner,
    dispatch(command, owner = captureOwner()) {
      if (owner === 'explorer') {
        const explorer = input.getExplorerController();
        explorer?.handleEditCommand(command);
        return true;
      }
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
        if (runtime.getSnapshot().selection) {
          runtime.setSelection(undefined);
        }
        return true;
      }
      const projection = input.getProjection();
      if (command === 'select-all') {
        runtime.setSelection(canvasNodeSelection(projection?.nodes.map((node) => node.projectRelativePath) ?? []));
        return true;
      }
      const selectedPaths = selectedNodeProjectRelativePaths(runtime.getSnapshot().selection);
      const nodesByPath = new Map(projection?.nodes.map((node) => [node.projectRelativePath, node]) ?? []);
      const selection = selectedPaths.flatMap((path) => {
        const node = nodesByPath.get(path);
        return node ? [projectPathCommandEntryForCanvasNode(node)] : [];
      });
      if (selection.length === 0) {
        return true;
      }
      const router = input.getProjectPathRouter();
      if (!router) {
        return true;
      }
      const target = { source: 'canvas' as const, invocation: selection[0]!, selection };
      router.run(command === 'trash' ? 'delete' : command, {
        target,
        position: { x: 0, y: 0 }
      });
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
  return commandId ? workbenchFocusCommandFromMenuCommandId(commandId) : undefined;
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
