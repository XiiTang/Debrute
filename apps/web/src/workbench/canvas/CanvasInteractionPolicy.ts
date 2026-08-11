import type { CanvasSelection } from './runtime/canvasSelection';
import {
  canvasNodeSelection,
  isCanvasNodeSelected,
  toggleCanvasNodeSelection,
  unionCanvasNodeSelection
} from './runtime/canvasSelection';

export const CANVAS_POINTER_ACTIVATION_DISTANCE = 4;

export type CanvasInteractionPolicyNodeZone =
  | 'content'
  | 'manipulation'
  | 'action'
  | 'content-island'
  | 'resize'
  | 'feedback';

export type CanvasInteractionPolicyTarget =
  | { readonly kind: 'workbench' }
  | { readonly kind: 'blank' }
  | {
      readonly kind: 'node';
      readonly projectRelativePath: string;
      readonly mediaKind?: string | undefined;
      readonly zone: CanvasInteractionPolicyNodeZone;
      readonly contentControl?: boolean | undefined;
    };

export type CanvasInteractionPolicyEvent =
  | 'completed-click'
  | 'manipulation-threshold'
  | 'resize-start'
  | 'content-direct-manipulation-start';

export type CanvasInteractionStateCommand =
  | { readonly kind: 'preserve' }
  | { readonly kind: 'end-content-activation' }
  | {
      readonly kind: 'set-selection-and-end-content-activation';
      readonly selection: CanvasSelection | undefined;
    }
  | {
      readonly kind: 'activate-content';
      readonly projectRelativePath: string;
    };

export interface CanvasInteractionPolicyDecision {
  readonly state: CanvasInteractionStateCommand;
  readonly gesture: 'none' | 'move' | 'resize' | 'marquee';
  readonly handoff: 'none' | 'text-caret' | 'video-toggle';
}

export function decideCanvasInteraction(input: {
  readonly event: CanvasInteractionPolicyEvent;
  readonly target: CanvasInteractionPolicyTarget;
  readonly selection: CanvasSelection | undefined;
  readonly contentActivationProjectRelativePath: string | undefined;
  readonly additive: boolean;
}): CanvasInteractionPolicyDecision {
  if (input.target.kind === 'workbench') {
    return {
      state: { kind: 'end-content-activation' },
      gesture: 'none',
      handoff: 'none'
    };
  }
  if (input.target.kind === 'blank') {
    if (input.event === 'manipulation-threshold') {
      return {
        state: { kind: 'end-content-activation' },
        gesture: 'marquee',
        handoff: 'none'
      };
    }
    if (input.event !== 'completed-click') {
      return preserveDecision();
    }
    return {
      state: {
        kind: 'set-selection-and-end-content-activation',
        selection: input.additive ? input.selection : undefined
      },
      gesture: 'none',
      handoff: 'none'
    };
  }

  const target = input.target;
  const sameActiveContent = input.contentActivationProjectRelativePath === target.projectRelativePath;
  if (target.zone === 'content-island') {
    return sameActiveContent
      ? preserveDecision()
      : {
          state: { kind: 'end-content-activation' },
          gesture: 'none',
          handoff: 'none'
        };
  }
  if (target.zone === 'feedback') {
    return preserveDecision();
  }
  if (input.event === 'resize-start' || target.zone === 'resize') {
    return {
      state: selectNodeAndEnd(target.projectRelativePath),
      gesture: 'resize',
      handoff: 'none'
    };
  }
  if (input.event === 'manipulation-threshold') {
    return {
      state: selectNodeForManipulation(input.selection, target.projectRelativePath, input.additive),
      gesture: 'move',
      handoff: 'none'
    };
  }
  if (input.event === 'content-direct-manipulation-start') {
    return isContentCapable(target.mediaKind)
      ? {
          state: { kind: 'activate-content', projectRelativePath: target.projectRelativePath },
          gesture: 'none',
          handoff: 'none'
        }
      : preserveDecision();
  }
  if (input.event !== 'completed-click') {
    return preserveDecision();
  }

  if (target.zone === 'content') {
    if (sameActiveContent) {
      return preserveDecision();
    }
    if (input.additive || !isContentCapable(target.mediaKind)) {
      return {
        state: selectNodeForCanvas(input.selection, target.projectRelativePath, input.additive),
        gesture: 'none',
        handoff: 'none'
      };
    }
    return {
      state: { kind: 'activate-content', projectRelativePath: target.projectRelativePath },
      gesture: 'none',
      handoff: target.contentControl
        ? 'none'
        : target.mediaKind === 'text'
          ? 'text-caret'
          : target.mediaKind === 'video'
            ? 'video-toggle'
            : 'none'
    };
  }

  return {
    state: selectNodeForCanvas(input.selection, target.projectRelativePath, input.additive),
    gesture: 'none',
    handoff: 'none'
  };
}

function preserveDecision(
  gesture: CanvasInteractionPolicyDecision['gesture'] = 'none'
): CanvasInteractionPolicyDecision {
  return {
    state: { kind: 'preserve' },
    gesture,
    handoff: 'none'
  };
}

function selectNodeAndEnd(projectRelativePath: string): CanvasInteractionStateCommand {
  return {
    kind: 'set-selection-and-end-content-activation',
    selection: canvasNodeSelection([projectRelativePath])
  };
}

function selectNodeForCanvas(
  selection: CanvasSelection | undefined,
  projectRelativePath: string,
  additive: boolean
): CanvasInteractionStateCommand {
  return {
    kind: 'set-selection-and-end-content-activation',
    selection: additive
      ? toggleCanvasNodeSelection(selection, projectRelativePath)
      : canvasNodeSelection([projectRelativePath])
  };
}

function selectNodeForManipulation(
  selection: CanvasSelection | undefined,
  projectRelativePath: string,
  additive: boolean
): CanvasInteractionStateCommand {
  return {
    kind: 'set-selection-and-end-content-activation',
    selection: additive
      ? unionCanvasNodeSelection(selection, [projectRelativePath])
      : isCanvasNodeSelected(selection, projectRelativePath)
        ? selection
        : canvasNodeSelection([projectRelativePath])
  };
}

function isContentCapable(mediaKind: string | undefined): boolean {
  return mediaKind === 'text' || mediaKind === 'video' || mediaKind === 'audio';
}
