import type { CanvasInteractionPolicyNodeZone } from './CanvasInteractionPolicy.js';

export type CanvasDomNodeInteractionZone = CanvasInteractionPolicyNodeZone;

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
      directManipulation: boolean;
      contentControl: boolean;
    };

export type CanvasContentHandoffRequest =
  | {
      kind: 'text-caret';
      requestId: number;
      projectRelativePath: string;
      clientX: number;
      clientY: number;
    }
  | {
      kind: 'video-toggle';
      requestId: number;
      projectRelativePath: string;
    };

const CANVAS_NODE_ZONES = new Set<CanvasDomNodeInteractionZone>([
  'content',
  'manipulation',
  'action',
  'content-island',
  'resize',
  'feedback'
]);

const NATIVE_ACTION_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  'video',
  'a[href]',
  'summary',
  '[role="button"]',
  'media-controller',
  'media-play-button',
  'media-mute-button',
  'media-captions-button',
  'media-pip-button',
  'media-fullscreen-button',
  'media-playback-rate-button'
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

  const zone = canvasNodeInteractionZone(target, node);
  return {
    kind: 'node',
    projectRelativePath,
    ...(node.dataset.canvasMediaKind === undefined ? {} : { mediaKind: node.dataset.canvasMediaKind }),
    zone,
    directManipulation: node.contains(target.closest('[data-canvas-direct-manipulation="true"]')),
    contentControl: zone === 'content'
      && node.contains(target.closest(NATIVE_ACTION_SELECTOR))
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

  const contentIsland = target.closest('[data-canvas-node-zone="content-island"]');
  if (contentIsland && node.contains(contentIsland)) {
    return 'content-island';
  }

  const content = target.closest('[data-canvas-node-zone="content"]');
  if (content && node.contains(content)) {
    return 'content';
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

  return 'manipulation';
}
