export type CanvasDomNodeInteractionZone =
  | 'passive'
  | 'move'
  | 'activate'
  | 'action'
  | 'interaction-island'
  | 'resize'
  | 'feedback';

export type CanvasDomInteractionTarget =
  | { kind: 'outside' }
  | { kind: 'blank' }
  | { kind: 'blocked' }
  | { kind: 'canvas-ui' }
  | {
      kind: 'node';
      projectRelativePath: string;
      mediaKind?: string | undefined;
      zone: CanvasDomNodeInteractionZone;
    };

export interface CanvasPreviewActivationRequest {
  requestId: number;
  projectRelativePath: string;
  mediaKind: 'text' | 'video';
  clientX: number;
  clientY: number;
}

const CANVAS_NODE_ZONES = new Set<CanvasDomNodeInteractionZone>([
  'passive',
  'move',
  'activate',
  'action',
  'interaction-island',
  'resize',
  'feedback'
]);

const NATIVE_ACTION_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  'a[href]',
  'summary',
  '[role="button"]'
].join(',');

export function resolveCanvasDomInteractionTarget(
  surface: HTMLElement,
  target: EventTarget | null
): CanvasDomInteractionTarget {
  if (!(target instanceof Element) || !surface.contains(target)) {
    return { kind: 'outside' };
  }
  if (target.closest('[data-canvas-hit-test-blocker="true"]')) {
    return { kind: 'blocked' };
  }

  const node = target.closest<HTMLElement>('[data-canvas-entity="node"]');
  if (!node || !surface.contains(node)) {
    return target.closest(NATIVE_ACTION_SELECTOR)
      ? { kind: 'canvas-ui' }
      : { kind: 'blank' };
  }

  const projectRelativePath = node.dataset.canvasNodePath;
  if (projectRelativePath === undefined) {
    return { kind: 'canvas-ui' };
  }

  return {
    kind: 'node',
    projectRelativePath,
    ...(node.dataset.canvasMediaKind === undefined ? {} : { mediaKind: node.dataset.canvasMediaKind }),
    zone: canvasNodeInteractionZone(target, node)
  };
}

function canvasNodeInteractionZone(target: Element, node: HTMLElement): CanvasDomNodeInteractionZone {
  const explicitZoneElement = target.closest<HTMLElement>('[data-canvas-node-zone]');
  const explicitZone = explicitZoneElement?.dataset.canvasNodeZone as CanvasDomNodeInteractionZone | undefined;
  if (
    explicitZoneElement
    && node.contains(explicitZoneElement)
    && (explicitZone === 'feedback' || explicitZone === 'resize')
  ) {
    return explicitZone;
  }

  const interactionIsland = target.closest('[data-canvas-interaction-island="true"]');
  if (interactionIsland && node.contains(interactionIsland)) {
    return 'interaction-island';
  }

  const nativeAction = target.closest(NATIVE_ACTION_SELECTOR);
  if (nativeAction && node.contains(nativeAction)) {
    return 'action';
  }

  if (explicitZoneElement && node.contains(explicitZoneElement)) {
    if (explicitZone && CANVAS_NODE_ZONES.has(explicitZone)) {
      return explicitZone;
    }
  }

  const defaultZone = node.dataset.canvasNodeDefaultZone as CanvasDomNodeInteractionZone | undefined;
  return defaultZone && CANVAS_NODE_ZONES.has(defaultZone) ? defaultZone : 'passive';
}
