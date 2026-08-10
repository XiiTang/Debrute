import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CanvasFeedbackDocument,
  type CanvasState
} from '@debrute/app-protocol';
import type { CanvasProjection } from './CanvasScene.js';
import type { CanvasFeedbackBarTarget } from '../shell/floatingBars.js';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import { CanvasEditor } from './CanvasEditor';
import type { CanvasFeedbackCanvasBinding } from './CanvasFeedbackInteraction';
import type { CanvasContentHandoffRequest } from './CanvasDomInteractionAdapter.js';
import { createCanvasOverlayRuntime } from './CanvasOverlayRuntime';
import { createCanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import { CANVAS_PREVIEW_QUALITY_SETTLE_MS } from './CanvasResourceZoom.js';
import { areCanvasNodeShellPropsEqual, type CanvasNodeShellProps } from './CanvasNodeShell';
import {
  CanvasSurface
} from './CanvasSurface';
import {
  canvasActiveVideoPaths,
  canvasFeedbackBarTargetForProjectedNode,
  canvasFeedbackBarTargetForSelection,
  isCanvasPrimaryPointerEvent,
  pointerEventModifiers,
  syncCanvasPerfPointerInteractionSessionState,
  syncCanvasPerfSessionState,
  canvasPreviewResourceInteractionState,
  type CanvasPerfRuntimeSession
} from './canvasSurfaceSupport';
import { createCanvasPerfMonitor } from './CanvasPerfMonitor';
import { CANVAS_CAMERA_IDLE_MS, type CanvasCamera } from './runtime/canvasCamera';
import { createCanvasStageRuntime } from './runtime/CanvasStageRuntime';
import type { CanvasSelection } from './runtime/canvasSelection';
import {
  createCanvasEditorRuntime,
  type CanvasRuntimePointerInteraction
} from './runtime/CanvasEditorRuntime';
import { I18nProvider as WorkbenchI18nProvider } from '../i18n/index.js';
import { DEFAULT_CANVAS_TEXT_RENDER_PROFILE } from './CanvasTextRenderProfile.test-support.js';
import { CanvasTextProjectFontEnvironmentProvider } from './font-subset/CanvasTextProjectFontEnvironment.js';

vi.mock('./CanvasTextRenderProfileContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./CanvasTextRenderProfileContext.js')>();
  const { DEFAULT_CANVAS_TEXT_RENDER_PROFILE } = await import('./CanvasTextRenderProfile.test-support.js');
  return {
    ...actual,
    useCanvasTextRenderProfile: () => DEFAULT_CANVAS_TEXT_RENDER_PROFILE,
    CanvasTextRenderProfileGate: ({ children }: { children: React.ReactNode }) => children
  };
});

function I18nProvider({
  locale,
  children
}: React.ComponentProps<typeof WorkbenchI18nProvider>): React.ReactElement {
  return (
    <CanvasTextProjectFontEnvironmentProvider profile={DEFAULT_CANVAS_TEXT_RENDER_PROFILE}>
      <WorkbenchI18nProvider locale={locale}>{children}</WorkbenchI18nProvider>
    </CanvasTextProjectFontEnvironmentProvider>
  );
}

const emptyCanvasState: CanvasState = {
  expandedDirectories: [],
  nodeStates: {},
  occlusionOrder: []
};

const {
  videoPauseAtSpy,
  videoRestorePersistedTimeSpy,
  videoReadCurrentTimeSecondsSpy,
  videoMockState
} = vi.hoisted(() => ({
  videoPauseAtSpy: vi.fn(),
  videoRestorePersistedTimeSpy: vi.fn(),
  videoReadCurrentTimeSecondsSpy: vi.fn(() => 4.25),
  videoMockState: {
    registerOnMount: true,
    lastPath: undefined as string | undefined,
    lastRegister: undefined as undefined | ((projectRelativePath: string, target: unknown | undefined) => void),
    lastUpdatePlaybackTime: undefined as undefined | ((projectRelativePath: string, currentTimeMs: number) => void | Promise<void>)
  }
}));

vi.mock('./CanvasVideoNodeContent', async () => {
  const ReactModule = await import('react');
  return {
    CanvasVideoNodeContent: ({
      node,
      contentInteractionActive,
      contentHandoffRequest,
      onRegisterVideoTarget,
      onUpdatePlaybackTime
    }: {
      node: CanvasProjection['nodes'][number];
      contentInteractionActive: boolean;
      contentHandoffRequest?: CanvasContentHandoffRequest | undefined;
      onRegisterVideoTarget: (projectRelativePath: string, target: {
        readCurrentTimeSeconds: () => number | undefined;
        pauseAt: (seconds: number) => void;
        restorePersistedTime: (seconds: number) => void;
      } | undefined) => void;
      onUpdatePlaybackTime: (projectRelativePath: string, currentTimeMs: number) => void | Promise<void>;
    }) => {
      ReactModule.useEffect(() => {
        const target = {
          readCurrentTimeSeconds: videoReadCurrentTimeSecondsSpy,
          pauseAt: videoPauseAtSpy,
          restorePersistedTime: videoRestorePersistedTimeSpy
        };
        videoMockState.lastPath = node.projectRelativePath;
        videoMockState.lastRegister = onRegisterVideoTarget as typeof videoMockState.lastRegister;
        videoMockState.lastUpdatePlaybackTime = onUpdatePlaybackTime;
        if (videoMockState.registerOnMount) {
          onRegisterVideoTarget(node.projectRelativePath, target);
        }
        return () => onRegisterVideoTarget(node.projectRelativePath, undefined);
      }, [node.projectRelativePath, onRegisterVideoTarget, onUpdatePlaybackTime]);
      return (
        <div
          data-testid="mock-video-node"
          data-canvas-node-zone="content"
          data-content-active={contentInteractionActive ? 'true' : 'false'}
          data-playback-toggle-request-id={contentHandoffRequest?.kind === 'video-toggle'
            ? contentHandoffRequest.requestId
            : undefined}
          tabIndex={0}
        >
          {node.projectRelativePath}
          <button type="button" data-testid="mock-video-control">Play</button>
        </div>
      );
    }
  };
});

describe('CanvasSurface', () => {
  it('uses platform selection modifiers and reserves macOS Ctrl-click for context menus', () => {
    const event = { button: 0, shiftKey: false, metaKey: true, ctrlKey: true } as React.PointerEvent<Element>;

    expect(pointerEventModifiers(event, 'darwin')).toEqual({
      shiftKey: false,
      metaKey: true,
      ctrlKey: false
    });
    expect(pointerEventModifiers(event, 'win32')).toEqual({
      shiftKey: false,
      metaKey: false,
      ctrlKey: true
    });
    expect(isCanvasPrimaryPointerEvent(event, 'darwin')).toBe(false);
    expect(isCanvasPrimaryPointerEvent(event, 'win32')).toBe(true);
  });

  beforeEach(() => {
    installTextPreviewStyleVariables();
    videoRestorePersistedTimeSpy.mockReset();
    videoMockState.lastUpdatePlaybackTime = undefined;
  });

  afterEach(() => {
    clearTextPreviewStyleVariables();
  });

  it('renders projected nodes without delete controls', () => {
    const projection: CanvasProjection = {
      nodes: [nodeFixture('image-production/cover.png', 120, 80)],
      edges: [],
    };

    const html = renderToStaticMarkup(surface(projection, {
      selection: { kind: 'nodes', projectRelativePaths: ['image-production/cover.png'] }
    }));

    expect(html).toContain('data-canvas-entity="node"');
    expect(html).toContain('data-canvas-node-path="image-production/cover.png"');
    expect(html).toContain('db-canvas-node-frame');
    expect(html).not.toContain('Delete');
  });

  it('resolves an offscreen disclosed source after the Canvas is interaction-idle', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: [{
        ...nodeFixture('flow/a.png', 5000, 5000),
        availability: {
          state: 'resolving',
          size: 4,
          mimeType: 'image/png',
          sourceToken: 'source-a'
        }
      }],
      edges: []
    };
    const resolveCanvasSources = vi.fn(async () => ({
      sources: [{
        sourceToken: 'source-a',
        projectRelativePath: 'flow/a.png',
        availability: {
          state: 'available' as const,
          size: 4,
          mimeType: 'image/png',
          fileUrl: '/raw/flow/a.png?v=sha256%3Aa',
          revision: 'sha256:a'
        }
      }]
    }));

    try {
      await act(async () => {
        root.render(surface(projection, {
          actions: { ...actions, resolveCanvasSources }
        }));
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(resolveCanvasSources).toHaveBeenCalledTimes(1);
      expect(resolveCanvasSources).toHaveBeenCalledWith({
        targets: [{ projectRelativePath: 'flow/a.png', sourceToken: 'source-a' }]
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('uses the Project path tie-break and resolves each source through the serial lane', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: ['b', 'a'].map((name) => ({
        ...nodeFixture(`flow/${name}.png`, 5000, 5000),
        availability: {
          state: 'resolving' as const,
          size: 4,
          mimeType: 'image/png',
          sourceToken: `source-${name}`
        }
      })),
      edges: []
    };
    const resolveCanvasSources = vi.fn(async (request: {
      targets: Array<{ projectRelativePath: string; sourceToken: string }>;
    }) => ({
      sources: request.targets.map(({ projectRelativePath, sourceToken }) => ({
        sourceToken,
        projectRelativePath,
        availability: {
          state: 'available' as const,
          size: 4,
          mimeType: 'image/png',
          fileUrl: `/raw/${projectRelativePath}`,
          revision: `sha256:${projectRelativePath}`
        }
      }))
    }));

    try {
      await act(async () => {
        root.render(surface(projection, {
          actions: { ...actions, resolveCanvasSources }
        }));
      });
      await vi.waitFor(() => expect(resolveCanvasSources).toHaveBeenCalledTimes(2));
      await act(async () => {
        await Promise.resolve();
      });

      expect(resolveCanvasSources.mock.calls.map(([request]) => request.targets[0]?.projectRelativePath)).toEqual([
        'flow/a.png',
        'flow/b.png'
      ]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('keeps source resolution single-flight across repeated interaction endings', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: ['a', 'b'].map((name, index) => ({
        ...nodeFixture(`flow/${name}.png`, index * 100, index * 100),
        availability: {
          state: 'resolving' as const,
          size: 4,
          mimeType: 'image/png',
          sourceToken: `source-${name}`
        }
      })),
      edges: []
    };
    const runtime = canvasRuntimeFixture(projection);
    const firstResolution = deferred<{
      sources: Array<{
        sourceToken: string;
        projectRelativePath: string;
        availability: {
          state: 'available';
          size: number;
          mimeType: string;
          fileUrl: string;
          revision: string;
        };
      }>;
    }>();
    const resolvedSource = (name: string) => ({
      sourceToken: `source-${name}`,
      projectRelativePath: `flow/${name}.png`,
      availability: {
        state: 'available' as const,
        size: 4,
        mimeType: 'image/png',
        fileUrl: `/raw/flow/${name}.png?v=sha256%3A${name}`,
        revision: `sha256:${name}`
      }
    });
    const resolveCanvasSources = vi.fn()
      .mockImplementationOnce(() => firstResolution.promise)
      .mockResolvedValueOnce({ sources: [resolvedSource('b')] });

    try {
      await act(async () => {
        root.render(surface(projection, {
          runtime,
          actions: { ...actions, resolveCanvasSources }
        }));
      });
      await vi.waitFor(() => expect(resolveCanvasSources).toHaveBeenCalledTimes(1));

      await act(async () => {
        runtime.input.beginNodeMove({
          pointerId: 91,
          projectRelativePath: 'flow/a.png',
          screenPoint: { x: 0, y: 0 }
        });
        await runtime.input.finishPointerInteraction({ pointerId: 91 });
        runtime.input.beginNodeMove({
          pointerId: 92,
          projectRelativePath: 'flow/a.png',
          screenPoint: { x: 0, y: 0 }
        });
        await runtime.input.finishPointerInteraction({ pointerId: 92 });
      });
      expect(resolveCanvasSources).toHaveBeenCalledTimes(1);

      await act(async () => {
        const firstPath = resolveCanvasSources.mock.calls[0]![0].targets[0]!.projectRelativePath;
        firstResolution.resolve({
          sources: [resolvedSource(firstPath.endsWith('/a.png') ? 'a' : 'b')]
        });
        await firstResolution.promise;
      });
      await vi.waitFor(() => expect(resolveCanvasSources).toHaveBeenCalledTimes(2));
    } finally {
      runtime.dispose();
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('drops a hidden source failure so redisclosure starts a new attempt', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const node = {
      ...nodeFixture('flow/a.png', 10, 10),
      availability: {
        state: 'resolving' as const,
        size: 4,
        mimeType: 'image/png',
        sourceToken: 'source-a'
      }
    };
    const projection: CanvasProjection = { nodes: [node], edges: [] };
    const runtime = canvasRuntimeFixture(projection);
    const resolveCanvasSources = vi.fn()
      .mockRejectedValueOnce(new Error('first attempt failed'))
      .mockResolvedValueOnce({ sources: [] });

    try {
      await act(async () => {
        root.render(surface(projection, {
          runtime,
          actions: { ...actions, resolveCanvasSources }
        }));
      });
      await vi.waitFor(() => expect(resolveCanvasSources).toHaveBeenCalledTimes(1));

      await act(async () => {
        root.render(surface({ nodes: [], edges: [] }, {
          runtime,
          actions: { ...actions, resolveCanvasSources }
        }));
      });
      await act(async () => {
        root.render(surface(projection, {
          runtime,
          actions: { ...actions, resolveCanvasSources }
        }));
      });

      await vi.waitFor(() => expect(resolveCanvasSources).toHaveBeenCalledTimes(2));
    } finally {
      await act(async () => root.unmount());
      runtime.dispose();
      container.remove();
    }
  });

  it('raises an unchanged selected node again when it is clicked', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: [nodeFixture('flow/a.png', 10, 10)],
      edges: [],
    };
    const runtime = canvasRuntimeFixture(projection, {
      selection: { kind: 'nodes', projectRelativePaths: ['flow/a.png'] }
    });
    const raiseCanvasSelection = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(surface(projection, {
          runtime,
          actions: { ...actions, raiseCanvasSelection }
        }));
      });
      const surfaceElement = container.querySelector<HTMLElement>('[data-testid="canvas-surface"]')!;
      const nodeElement = container.querySelector<HTMLElement>('[data-canvas-node-path="flow/a.png"]')!;
      surfaceElement.setPointerCapture = vi.fn();
      surfaceElement.releasePointerCapture = vi.fn();

      await act(async () => {
        nodeElement.dispatchEvent(pointerEvent('pointerdown', {
          pointerId: 77,
          button: 0,
          clientX: 20,
          clientY: 20
        }));
        nodeElement.dispatchEvent(pointerEvent('pointerup', {
          pointerId: 77,
          button: 0,
          clientX: 20,
          clientY: 20
        }));
      });

      expect(raiseCanvasSelection).toHaveBeenCalledTimes(1);
      expect(raiseCanvasSelection).toHaveBeenCalledWith({
        projectRelativePaths: ['flow/a.png']
      });
    } finally {
      runtime.dispose();
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('does not submit a second Selection Raise after an active Manual Layout drag', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: [nodeFixture('flow/a.png', 10, 10)],
      edges: [],
    };
    const runtime = canvasRuntimeFixture(projection);
    const raiseCanvasSelection = vi.fn(async () => undefined);

    try {
      await act(async () => {
        root.render(surface(projection, {
          runtime,
          actions: { ...actions, raiseCanvasSelection }
        }));
      });

      await act(async () => {
        runtime.input.beginNodeMove({
          pointerId: 78,
          projectRelativePath: 'flow/a.png',
          screenPoint: { x: 0, y: 0 }
        });
        runtime.input.updatePointerInteraction({ pointerId: 78, screenPoint: { x: 20, y: 0 } });
        await runtime.input.finishPointerInteraction({ pointerId: 78, screenPoint: { x: 20, y: 0 } });
      });

      expect(raiseCanvasSelection).not.toHaveBeenCalled();
    } finally {
      runtime.dispose();
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('does not expose a disclosure toggle for the structural Project root', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: [directoryFixture('', 10, 10)],
      edges: [],
    };
    const runtime = canvasRuntimeFixture(projection);
    const setCanvasDirectoryExpanded = vi.fn(async () => undefined);
    const elementFromPointDescriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');

    try {
      await act(async () => {
        root.render(surface(projection, {
          runtime,
          actions: { ...actions, setCanvasDirectoryExpanded },
          canvasState: { expandedDirectories: [], nodeStates: {}, occlusionOrder: [] }
        }));
      });
      const surfaceElement = container.querySelector<HTMLElement>('[data-testid="canvas-surface"]')!;
      const directoryElement = container.querySelector<HTMLElement>('[data-canvas-node-path=""]')!;
      surfaceElement.setPointerCapture = vi.fn();
      surfaceElement.releasePointerCapture = vi.fn();
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: () => directoryElement
      });

      await act(async () => {
        directoryElement.dispatchEvent(pointerEvent('pointerdown', {
          pointerId: 78,
          button: 0,
          clientX: 20,
          clientY: 20
        }));
      });
      expect(runtime.getSnapshot().pointerInteraction).toMatchObject({
        kind: 'move-node',
        phase: 'pending',
        pressedProjectRelativePath: ''
      });
      await act(async () => {
        directoryElement.dispatchEvent(pointerEvent('pointerup', {
          pointerId: 78,
          button: 0,
          clientX: 22,
          clientY: 21
        }));
      });

      expect(setCanvasDirectoryExpanded).not.toHaveBeenCalled();
    } finally {
      if (elementFromPointDescriptor) {
        Object.defineProperty(document, 'elementFromPoint', elementFromPointDescriptor);
      } else {
        Reflect.deleteProperty(document, 'elementFromPoint');
      }
      runtime.dispose();
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('covers Canvas node hit targets only while the camera is moving', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: [nodeFixture('flow/cover.png', 0, 0)],
      edges: [],
    };
    const runtime = canvasRuntimeFixture(projection);

    try {
      await act(async () => {
        root.render(surface(projection, { runtime }));
      });
      const blocker = container.querySelector<HTMLElement>('[data-canvas-hit-test-blocker="true"]');
      expect(blocker?.classList.contains('hidden')).toBe(true);

      await act(async () => {
        runtime.camera.panBy({ x: 20, y: 10 });
      });
      expect(blocker?.classList.contains('hidden')).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CANVAS_CAMERA_IDLE_MS);
      });
      expect(blocker?.classList.contains('hidden')).toBe(true);
    } finally {
      await act(async () => {
        root.unmount();
      });
      runtime.dispose();
      container.remove();
      vi.useRealTimers();
    }
  });

  it('freezes semantic hover and Feedback targeting until one camera-idle reconciliation', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: [
        nodeFixture('flow/a.png', 0, 0),
        nodeFixture('flow/b.png', 240, 0)
      ],
      edges: [],
    };
    const runtime = canvasRuntimeFixture(projection);
    const targetChanges: Array<CanvasFeedbackBarTarget | undefined> = [];
    const suspendHoverTarget = vi.fn();
    const elementFromPointDescriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasSurface
              productPlatform="darwin"
              expandedDirectories={emptyCanvasState.expandedDirectories}
              projection={projection}
              runtime={runtime}
              actions={actions}
              textFileBuffers={{}}
              canvasFeedback={feedbackDocument({})}
              feedbackInteraction={feedbackInteractionFixture({
                handleTargetChange: (target) => targetChanges.push(target),
                suspendHoverTarget
              })}
              textPreviewStyleDependencyKey="dark"
            />
          </I18nProvider>
        );
      });
      const surfaceElement = container.querySelector<HTMLElement>('[data-testid="canvas-surface"]')!;
      const first = container.querySelector<HTMLElement>('[data-canvas-node-path="flow/a.png"]')!;
      const second = container.querySelector<HTMLElement>('[data-canvas-node-path="flow/b.png"]')!;
      Object.defineProperty(surfaceElement, 'getBoundingClientRect', {
        configurable: true,
        value: () => new DOMRect(0, 0, 1280, 720)
      });

      await act(async () => {
        first.dispatchEvent(pointerEvent('pointerover', { pointerId: 1, clientX: 20, clientY: 20 }));
      });
      expect(first.getAttribute('data-canvas-hovered')).toBe('true');
      expect(targetChanges.at(-1)).toMatchObject({ kind: 'node', projectRelativePath: 'flow/a.png' });

      await act(async () => {
        runtime.camera.panBy({ x: 20, y: 0 });
        second.dispatchEvent(pointerEvent('pointerover', { pointerId: 1, clientX: 20, clientY: 20 }));
      });
      expect(first.hasAttribute('data-canvas-hovered')).toBe(false);
      expect(second.hasAttribute('data-canvas-hovered')).toBe(false);
      expect(targetChanges.at(-1)).toMatchObject({ kind: 'node', projectRelativePath: 'flow/a.png' });
      expect(suspendHoverTarget).toHaveBeenCalledTimes(1);

      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: () => second
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CANVAS_CAMERA_IDLE_MS);
      });
      expect(second.getAttribute('data-canvas-hovered')).toBe('true');
      expect(targetChanges.at(-1)).toMatchObject({ kind: 'node', projectRelativePath: 'flow/b.png' });

      await act(async () => {
        runtime.camera.panBy({ x: 20, y: 0 });
      });
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: () => null
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CANVAS_CAMERA_IDLE_MS);
      });
      expect(second.hasAttribute('data-canvas-hovered')).toBe(false);
      expect(targetChanges.at(-1)).toBeUndefined();
      expect(suspendHoverTarget).toHaveBeenCalledTimes(2);
    } finally {
      if (elementFromPointDescriptor) {
        Object.defineProperty(document, 'elementFromPoint', elementFromPointDescriptor);
      } else {
        Reflect.deleteProperty(document, 'elementFromPoint');
      }
      runtime.dispose();
      await act(async () => root.unmount());
      container.remove();
      vi.useRealTimers();
    }
  });

  it('writes selection styling directly and rerenders handles only for the single selected node', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: [
        nodeFixture('flow/a.png', 0, 0),
        nodeFixture('flow/b.png', 240, 0),
        nodeFixture('flow/c.png', 480, 0)
      ],
      edges: [],
    };

    const runtime = canvasRuntimeFixture(projection, {
      selection: { kind: 'nodes', projectRelativePaths: ['flow/a.png', 'flow/b.png'] },
    });

    try {
      await act(async () => {
        root.render(surface(projection, { runtime, cutPaths: ['flow/b.png'] }));
      });

      expect(container.querySelectorAll('.canvas-node-shell[data-canvas-selected="true"]')).toHaveLength(2);
      expect(container.querySelectorAll('.canvas-cut-source')).toHaveLength(1);
      expect(container.querySelectorAll('.canvas-node-resize')).toHaveLength(0);

      await act(async () => {
        runtime.setSelection({ kind: 'nodes', projectRelativePaths: ['flow/a.png'] });
      });

      expect(container.querySelectorAll('.canvas-node-shell[data-canvas-selected="true"]')).toHaveLength(1);
      expect(container.querySelectorAll('[data-canvas-node-path="flow/a.png"] .canvas-node-resize')).toHaveLength(8);
      expect(container.querySelectorAll('[data-canvas-node-path="flow/b.png"] .canvas-node-resize')).toHaveLength(0);
      expect(Number(container.querySelector<HTMLElement>('[data-canvas-node-path="flow/a.png"]')!.style.zIndex))
        .toBeGreaterThan(Number(container.querySelector<HTMLElement>('[data-canvas-node-path="flow/b.png"]')!.style.zIndex));
    } finally {
      await act(async () => root.unmount());
      runtime.dispose();
      container.remove();
    }
  });

  it('owns true-blank pointer capture, renders the Runtime marquee, and restores selection on lost capture', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: [nodeFixture('flow/a.png', 10, 10)],
      edges: [],
    };
    const runtime = canvasRuntimeFixture(projection, {
      selection: { kind: 'nodes', projectRelativePaths: ['flow/a.png'] }
    });

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasSurface
              productPlatform="darwin"
              expandedDirectories={emptyCanvasState.expandedDirectories}
              projection={projection}
              runtime={runtime}
              actions={actions}
              textFileBuffers={{}}
              canvasFeedback={undefined}
              textPreviewStyleDependencyKey="dark"
            />
          </I18nProvider>
        );
      });
      const surfaceElement = container.querySelector<HTMLElement>('[data-testid="canvas-surface"]')!;
      const marqueeElement = container.querySelector<HTMLElement>('[data-testid="canvas-selection-marquee"]')!;
      const setPointerCapture = vi.fn();
      surfaceElement.setPointerCapture = setPointerCapture;
      expect(marqueeElement).not.toBeNull();
      expect(marqueeElement.hidden).toBe(true);

      await act(async () => {
        surfaceElement.dispatchEvent(pointerEvent('pointerdown', {
          pointerId: 7,
          button: 0,
          clientX: 0,
          clientY: 0
        }));
      });
      expect(document.activeElement).toBe(surfaceElement);
      expect(setPointerCapture).toHaveBeenCalledWith(7);
      expect(runtime.getSnapshot().pointerInteraction).toMatchObject({
        kind: 'selection-marquee',
        phase: 'pending'
      });

      await act(async () => {
        surfaceElement.dispatchEvent(pointerEvent('pointermove', {
          pointerId: 7,
          clientX: 80,
          clientY: 80
        }));
      });
      expect(container.querySelector('[data-testid="canvas-selection-marquee"]')).toBe(marqueeElement);
      expect(marqueeElement.hidden).toBe(false);
      expect(marqueeElement.style.transform).toBe('translate3d(0px, 0px, 0px)');
      expect(marqueeElement.style.width).toBe('80px');
      expect(marqueeElement.style.height).toBe('80px');

      await act(async () => {
        surfaceElement.dispatchEvent(pointerEvent('lostpointercapture', { pointerId: 7 }));
      });
      expect(runtime.getSnapshot().pointerInteraction).toBeUndefined();
      expect(runtime.getSnapshot().selection).toEqual({
        kind: 'nodes',
        projectRelativePaths: ['flow/a.png']
      });
      expect(container.querySelector('[data-testid="canvas-selection-marquee"]')).toBe(marqueeElement);
      expect(marqueeElement.hidden).toBe(true);
      await act(async () => {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      });

      const nodeElement = container.querySelector<HTMLElement>('[data-canvas-node-path="flow/a.png"]')!;
      nodeElement.setPointerCapture = vi.fn();
      await act(async () => {
        nodeElement.dispatchEvent(pointerEvent('pointerover', {
          pointerId: 8,
          clientX: 20,
          clientY: 20
        }));
      });
      expect(nodeElement.getAttribute('data-canvas-hovered')).toBe('true');
      await act(async () => {
        nodeElement.dispatchEvent(pointerEvent('pointerdown', {
          pointerId: 8,
          button: 0,
          clientX: 20,
          clientY: 20
        }));
      });
      expect(runtime.getSnapshot().pointerInteraction).toMatchObject({ kind: 'move-node', phase: 'pending' });
      expect(surfaceElement.getAttribute('data-canvas-cursor')).toBe('default');
      expect(nodeElement.getAttribute('data-canvas-hovered')).toBe('true');
      await act(async () => {
        surfaceElement.dispatchEvent(pointerEvent('pointermove', {
          pointerId: 8,
          clientX: 22,
          clientY: 22
        }));
      });
      expect(runtime.getSnapshot().pointerInteraction).toMatchObject({ kind: 'move-node', phase: 'pending' });
      expect(nodeElement.getAttribute('data-canvas-hovered')).toBe('true');
      await act(async () => {
        nodeElement.dispatchEvent(pointerEvent('pointermove', {
          pointerId: 8,
          clientX: 50,
          clientY: 50
        }));
      });
      expect(runtime.getSnapshot().pointerInteraction).toMatchObject({ kind: 'move-node', phase: 'active' });
      expect(surfaceElement.getAttribute('data-canvas-cursor')).toBe('grabbing');
      expect(nodeElement.hasAttribute('data-canvas-hovered')).toBe(false);
      await act(async () => runtime.input.cancelPointerInteraction(8));
      expect(surfaceElement.getAttribute('data-canvas-cursor')).toBe('default');

      await act(async () => {
        surfaceElement.dispatchEvent(pointerEvent('pointerdown', {
          pointerId: 9,
          button: 0,
          clientX: 0,
          clientY: 0
        }));
      });
      expect(runtime.getSnapshot().pointerInteraction).toMatchObject({ kind: 'selection-marquee' });
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasSurface
              productPlatform="darwin"
              expandedDirectories={emptyCanvasState.expandedDirectories}
              projection={projection}
              runtime={runtime}
              actions={actions}
              textFileBuffers={{}}
              canvasFeedback={undefined}
              interactionBlocked
              textPreviewStyleDependencyKey="dark"
            />
          </I18nProvider>
        );
      });
      expect(runtime.getSnapshot().pointerInteraction).toBeUndefined();
      expect(runtime.getSnapshot().selection).toEqual({
        kind: 'nodes',
        projectRelativePaths: ['flow/a.png']
      });
    } finally {
      runtime.dispose();
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('performs one final hit-test only after an active node move ends', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: [nodeFixture('flow/a.png', 10, 10)],
      edges: [],
    };
    const runtime = canvasRuntimeFixture(projection);
    const dismissTarget = vi.fn();
    const targetChanges: Array<CanvasFeedbackBarTarget | undefined> = [];
    const elementFromPointDescriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');

    try {
      await act(async () => {
        root.render(surface(projection, {
          runtime,
          canvasFeedback: feedbackDocument({}),
          feedbackInteraction: feedbackInteractionFixture({
            dismissTarget,
            handleTargetChange: (target) => targetChanges.push(target)
          })
        }));
      });
      const surfaceElement = container.querySelector<HTMLElement>('[data-testid="canvas-surface"]')!;
      const nodeElement = container.querySelector<HTMLElement>('[data-canvas-node-path="flow/a.png"]')!;
      Object.defineProperty(surfaceElement, 'getBoundingClientRect', {
        configurable: true,
        value: () => new DOMRect(0, 0, 1280, 720)
      });
      surfaceElement.setPointerCapture = vi.fn();
      surfaceElement.releasePointerCapture = vi.fn();
      const elementFromPoint = vi.fn(() => nodeElement);
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: elementFromPoint
      });

      await act(async () => {
        nodeElement.dispatchEvent(pointerEvent('pointerover', {
          pointerId: 31,
          clientX: 20,
          clientY: 20
        }));
      });
      await act(async () => {
        nodeElement.dispatchEvent(pointerEvent('pointerdown', {
          pointerId: 31,
          button: 0,
          clientX: 20,
          clientY: 20
        }));
      });
      expect(runtime.getSnapshot().pointerInteraction).toMatchObject({
        kind: 'move-node',
        phase: 'pending'
      });
      expect(dismissTarget).not.toHaveBeenCalled();

      await act(async () => {
        nodeElement.dispatchEvent(pointerEvent('pointermove', {
          pointerId: 31,
          clientX: 22,
          clientY: 22
        }));
      });
      expect(runtime.getSnapshot().pointerInteraction).toMatchObject({
        kind: 'move-node',
        phase: 'pending'
      });
      expect(dismissTarget).not.toHaveBeenCalled();

      await act(async () => {
        nodeElement.dispatchEvent(pointerEvent('pointermove', {
          pointerId: 31,
          clientX: 60,
          clientY: 60
        }));
      });
      expect(runtime.getSnapshot().pointerInteraction).toMatchObject({
        kind: 'move-node',
        phase: 'active'
      });
      expect(runtime.getSnapshot().contentInteractionProjectRelativePath).toBeUndefined();
      expect(nodeElement.hasAttribute('data-canvas-hovered')).toBe(false);
      expect(dismissTarget).toHaveBeenCalledOnce();
      const presentedAfterMove = runtime.scene.getPresentedNodes().get('flow/a.png')!;
      expect(runtime.scene.getRenderSnapshot().nodesByPath.get('flow/a.png')?.x)
        .not.toBe(presentedAfterMove.x);

      await act(async () => {
        nodeElement.dispatchEvent(pointerEvent('pointerup', {
          pointerId: 31,
          button: 0,
          clientX: 60,
          clientY: 60
        }));
        await new Promise((resolve) => window.setTimeout(resolve, 40));
      });

      expect(elementFromPoint).toHaveBeenCalledTimes(1);
      expect(nodeElement.getAttribute('data-canvas-hovered')).toBe('true');
      expect(targetChanges.at(-1)).toMatchObject({
        kind: 'node',
        projectRelativePath: 'flow/a.png',
        anchorRect: {
          x: presentedAfterMove.x,
          y: presentedAfterMove.y,
          width: presentedAfterMove.width,
          height: presentedAfterMove.height
        }
      });
    } finally {
      if (elementFromPointDescriptor) {
        Object.defineProperty(document, 'elementFromPoint', elementFromPointDescriptor);
      } else {
        Reflect.deleteProperty(document, 'elementFromPoint');
      }
      runtime.dispose();
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('dismisses Feedback targeting immediately when node resize begins', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: [nodeFixture('flow/a.png', 10, 10)],
      edges: [],
    };
    const runtime = canvasRuntimeFixture(projection, {
      selection: { kind: 'nodes', projectRelativePaths: ['flow/a.png'] }
    });
    const dismissTarget = vi.fn();

    try {
      await act(async () => {
        root.render(surface(projection, {
          runtime,
          canvasFeedback: feedbackDocument({}),
          feedbackInteraction: feedbackInteractionFixture({ dismissTarget })
        }));
      });
      const resizeHandle = container.querySelector<HTMLButtonElement>('[aria-label="Resize node se"]')!;
      resizeHandle.setPointerCapture = vi.fn();

      await act(async () => {
        resizeHandle.dispatchEvent(pointerEvent('pointerdown', {
          pointerId: 32,
          button: 0,
          clientX: 210,
          clientY: 130
        }));
      });

      expect(runtime.getSnapshot().pointerInteraction).toMatchObject({
        kind: 'resize-node',
        phase: 'active'
      });
      expect(dismissTarget).toHaveBeenCalledOnce();
    } finally {
      runtime.dispose();
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('commits precise text preview activation only on pointerup inside the same preview', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const node = textProjectionNode('flow/readme.md', 0, 0, 'rev-text-activation');
    const projection: CanvasProjection = {
      nodes: [node],
      edges: [],
    };
    const runtime = canvasRuntimeFixture(projection);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasSurface
              productPlatform="darwin"
              expandedDirectories={emptyCanvasState.expandedDirectories}
              projection={projection}
              runtime={runtime}
              actions={actions}
              textFileBuffers={{
                [node.projectRelativePath]: textBufferFixture(node.projectRelativePath, '# Readme', 'rev-text-activation')
              }}
              canvasFeedback={undefined}
              textPreviewStyleDependencyKey="dark"
            />
          </I18nProvider>
        );
      });
      const surfaceElement = container.querySelector<HTMLElement>('[data-testid="canvas-surface"]')!;
      const textPreview = container.querySelector<HTMLElement>('.canvas-text-body')!;
      surfaceElement.setPointerCapture = vi.fn();
      surfaceElement.releasePointerCapture = vi.fn();

      await act(async () => {
        textPreview.dispatchEvent(pointerEvent('pointerdown', {
          pointerId: 21,
          button: 0,
          clientX: 110,
          clientY: 140
        }));
      });
      expect(runtime.getSnapshot().selection).toBeUndefined();

      const finishPointerInteraction = deferred<CanvasRuntimePointerInteraction | undefined>();
      vi.spyOn(runtime.input, 'finishPointerInteraction')
        .mockReturnValueOnce(finishPointerInteraction.promise);
      await act(async () => {
        textPreview.dispatchEvent(pointerEvent('pointerup', {
          pointerId: 21,
          button: 0,
          clientX: 112,
          clientY: 142
        }));
        surfaceElement.dispatchEvent(pointerEvent('lostpointercapture', { pointerId: 21 }));
        finishPointerInteraction.resolve(undefined);
        await finishPointerInteraction.promise;
        await Promise.resolve();
      });
      expect(runtime.getSnapshot().selection).toEqual({
        kind: 'nodes',
        projectRelativePaths: [node.projectRelativePath]
      });
      expect(runtime.getSnapshot().contentInteractionProjectRelativePath).toBe(node.projectRelativePath);

      await act(async () => {
        runtime.setSelection(undefined);
      });
      const restoredTextPreview = container.querySelector<HTMLElement>('.canvas-text-body')!;
      await act(async () => {
        restoredTextPreview.dispatchEvent(pointerEvent('pointerdown', {
          pointerId: 22,
          button: 0,
          clientX: 110,
          clientY: 140
        }));
        surfaceElement.dispatchEvent(pointerEvent('pointerup', {
          pointerId: 22,
          button: 0,
          clientX: 5,
          clientY: 5
        }));
      });
      expect(runtime.getSnapshot().selection).toBeUndefined();
      expect(runtime.getSnapshot().contentInteractionProjectRelativePath).toBeUndefined();
    } finally {
      runtime.dispose();
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('commits one video playback-toggle activation only when pointerup remains inside the inactive Content Region', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const node = videoProjectionNode('media/clip.mp4', 0, 0);
    const projection: CanvasProjection = {
      nodes: [node],
      edges: [],
    };
    const runtime = canvasRuntimeFixture(projection);

    try {
      await act(async () => {
        root.render(surface(projection, { runtime }));
      });
      const surfaceElement = container.querySelector<HTMLElement>('[data-testid="canvas-surface"]')!;
      const videoPreview = container.querySelector<HTMLElement>('[data-testid="mock-video-node"]')!;
      surfaceElement.setPointerCapture = vi.fn();
      surfaceElement.releasePointerCapture = vi.fn();

      await act(async () => {
        videoPreview.dispatchEvent(pointerEvent('pointerdown', {
          pointerId: 23,
          button: 0,
          clientX: 120,
          clientY: 160
        }));
      });
      expect(runtime.getSnapshot().selection).toBeUndefined();

      await act(async () => {
        videoPreview.dispatchEvent(pointerEvent('pointerup', {
          pointerId: 23,
          button: 0,
          clientX: 122,
          clientY: 162
        }));
      });
      expect(runtime.getSnapshot().selection).toEqual({
        kind: 'nodes',
        projectRelativePaths: [node.projectRelativePath]
      });
      expect(container.querySelector('[data-testid="mock-video-node"]')?.getAttribute('data-playback-toggle-request-id')).toBe('1');
    } finally {
      runtime.dispose();
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('keeps a successful mounted content-control click after pointer travel', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const node = videoProjectionNode('media/control.mp4', 0, 0);
    const projection: CanvasProjection = { nodes: [node], edges: [] };
    const runtime = canvasRuntimeFixture(projection);

    try {
      await act(async () => {
        root.render(surface(projection, { runtime }));
      });
      const control = container.querySelector<HTMLElement>('[data-testid="mock-video-control"]')!;

      await act(async () => {
        control.dispatchEvent(pointerEvent('pointerdown', {
          pointerId: 24,
          button: 0,
          clientX: 10,
          clientY: 10
        }));
        control.dispatchEvent(pointerEvent('pointermove', {
          pointerId: 24,
          button: 0,
          clientX: 20,
          clientY: 10
        }));
        control.dispatchEvent(pointerEvent('pointerup', {
          pointerId: 24,
          button: 0,
          clientX: 20,
          clientY: 10
        }));
      });

      expect(runtime.getSnapshot()).toMatchObject({
        selection: {
          kind: 'nodes',
          projectRelativePaths: [node.projectRelativePath]
        },
        contentInteractionProjectRelativePath: node.projectRelativePath
      });
      expect(container.querySelector('[data-testid="mock-video-node"]')?.hasAttribute('data-playback-toggle-request-id')).toBe(false);
    } finally {
      runtime.dispose();
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('suppresses the local action for an additive click on inactive content', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const activeNode = videoProjectionNode('media/active.mp4', 0, 0);
    const targetNode = videoProjectionNode('media/additive.mp4', 240, 0);
    const projection: CanvasProjection = { nodes: [activeNode, targetNode], edges: [] };
    const runtime = canvasRuntimeFixture(projection);
    runtime.activateContent(activeNode.projectRelativePath);

    try {
      await act(async () => {
        root.render(surface(projection, { runtime }));
      });
      const targetControl = container.querySelectorAll<HTMLElement>('[data-testid="mock-video-control"]')[1]!;
      const localAction = vi.fn();
      targetControl.addEventListener('click', localAction);

      await act(async () => {
        targetControl.dispatchEvent(pointerEvent('pointerdown', {
          pointerId: 25,
          button: 0,
          clientX: 10,
          clientY: 10,
          shiftKey: true
        }));
        targetControl.dispatchEvent(pointerEvent('pointerup', {
          pointerId: 25,
          button: 0,
          clientX: 10,
          clientY: 10,
          shiftKey: true
        }));
      });
      const click = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        shiftKey: true
      });
      await act(async () => {
        expect(targetControl.dispatchEvent(click)).toBe(false);
      });

      expect(runtime.getSnapshot()).toMatchObject({
        selection: {
          kind: 'nodes',
          projectRelativePaths: [activeNode.projectRelativePath, targetNode.projectRelativePath]
        },
        contentInteractionProjectRelativePath: undefined
      });
      expect(localAction).not.toHaveBeenCalled();
    } finally {
      runtime.dispose();
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('preserves a selected-node context selection, collapses an unselected invocation, and clears on blank contextmenu', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: [
        nodeFixture('flow/a.png', 0, 0),
        nodeFixture('flow/b.png', 240, 0),
        nodeFixture('flow/c.png', 480, 0)
      ],
      edges: [],
    };
    const runtime = canvasRuntimeFixture(projection, {
      selection: { kind: 'nodes', projectRelativePaths: ['flow/a.png', 'flow/b.png'] }
    });
    const onOpenContextMenu = vi.fn();

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasSurface
              productPlatform="darwin"
              expandedDirectories={emptyCanvasState.expandedDirectories}
              projection={projection}
              runtime={runtime}
              actions={actions}
              textFileBuffers={{}}
              canvasFeedback={undefined}
              onOpenContextMenu={onOpenContextMenu}
              textPreviewStyleDependencyKey="dark"
            />
          </I18nProvider>
        );
      });
      const selectedInvocation = container.querySelector<HTMLElement>('[data-canvas-node-path="flow/b.png"]')!;
      const nodeAction = document.createElement('button');
      nodeAction.type = 'button';
      selectedInvocation.append(nodeAction);
      await act(async () => {
        nodeAction.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });
      expect(onOpenContextMenu).not.toHaveBeenCalled();

      await act(async () => {
        selectedInvocation.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });
      expect(onOpenContextMenu).toHaveBeenLastCalledWith(expect.objectContaining({
        invocationEntry: expect.objectContaining({
          pathEntry: expect.objectContaining({ projectRelativePath: 'flow/b.png' })
        }),
        selectedEntries: [
          expect.objectContaining({
            pathEntry: expect.objectContaining({ projectRelativePath: 'flow/a.png' })
          }),
          expect.objectContaining({
            pathEntry: expect.objectContaining({ projectRelativePath: 'flow/b.png' })
          })
        ]
      }), { x: 0, y: 0 });

      const unselectedInvocation = container.querySelector<HTMLElement>('[data-canvas-node-path="flow/c.png"]')!;
      unselectedInvocation.setPointerCapture = vi.fn();
      await act(async () => {
        unselectedInvocation.dispatchEvent(pointerEvent('pointerdown', {
          pointerId: 9,
          button: 0,
          ctrlKey: true
        }));
      });
      expect(runtime.getSnapshot().pointerInteraction).toBeUndefined();
      expect(runtime.getSnapshot().selection).toEqual({
        kind: 'nodes',
        projectRelativePaths: ['flow/a.png', 'flow/b.png']
      });
      await act(async () => {
        unselectedInvocation.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });
      expect(runtime.getSnapshot().selection).toEqual({
        kind: 'nodes',
        projectRelativePaths: ['flow/c.png']
      });
      expect(onOpenContextMenu).toHaveBeenLastCalledWith(expect.objectContaining({
        invocationEntry: expect.objectContaining({
          pathEntry: expect.objectContaining({ projectRelativePath: 'flow/c.png' })
        }),
        selectedEntries: [expect.objectContaining({
          pathEntry: expect.objectContaining({ projectRelativePath: 'flow/c.png' })
        })]
      }), { x: 0, y: 0 });

      const callCount = onOpenContextMenu.mock.calls.length;
      const blankEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      await act(async () => {
        container.querySelector<HTMLElement>('[data-testid="canvas-surface"]')!.dispatchEvent(blankEvent);
      });
      expect(blankEvent.defaultPrevented).toBe(true);
      expect(runtime.getSnapshot().selection).toBeUndefined();
      expect(onOpenContextMenu).toHaveBeenCalledTimes(callCount);
    } finally {
      runtime.dispose();
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('opens Canvas Project Path Commands with only current available-node size facts', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const node = nodeFixture('data/deep/cover.png', 0, 0);
    if (node.availability.state !== 'available') {
      throw new Error('fixture must be available');
    }
    node.availability = { ...node.availability, size: 12_345 };
    const missingNode = {
      ...nodeFixture('data/deep/missing.png', 260, 0),
      availability: { state: 'missing' as const, message: 'File is missing.' }
    };
    const unreadableNode = {
      ...nodeFixture('data/deep/unreadable.png', 520, 0),
      availability: { state: 'unreadable' as const, message: 'File is unreadable.' }
    };
    const projection: CanvasProjection = {
      nodes: [node, missingNode, unreadableNode],
      edges: [],
    };
    const runtime = canvasRuntimeFixture(projection);
    const onOpenContextMenu = vi.fn();

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasSurface
              productPlatform="darwin"
              expandedDirectories={emptyCanvasState.expandedDirectories}
              projection={projection}
              runtime={runtime}
              actions={actions}
              textFileBuffers={{}}
              canvasFeedback={undefined}
              onOpenContextMenu={onOpenContextMenu}
              textPreviewStyleDependencyKey="dark"
            />
          </I18nProvider>
        );
      });

      const element = await waitForCanvasSurfaceElement(
        container,
        '[data-canvas-node-path="data/deep/cover.png"]'
      );
      await act(async () => {
        element.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 60
        }));
      });

      expect(onOpenContextMenu).toHaveBeenCalledWith({
        source: 'canvas',
        invocationEntry: {
          availability: 'available',
          pathEntry: {
            projectRelativePath: 'data/deep/cover.png',
            kind: 'file',
            sizeBytes: 12_345
          }
        },
        selectedEntries: [{
          availability: 'available',
          pathEntry: {
            projectRelativePath: 'data/deep/cover.png',
            kind: 'file',
            sizeBytes: 12_345
          }
        }]
      }, { x: 40, y: 60 });

      const missingElement = await waitForCanvasSurfaceElement(
        container,
        '[data-canvas-node-path="data/deep/missing.png"]'
      );
      await act(async () => {
        missingElement.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 80,
          clientY: 100
        }));
      });
      expect(onOpenContextMenu).toHaveBeenLastCalledWith({
        source: 'canvas',
        invocationEntry: {
          availability: 'missing',
          pathEntry: {
            projectRelativePath: 'data/deep/missing.png',
            kind: 'file'
          }
        },
        selectedEntries: [{
          availability: 'missing',
          pathEntry: {
            projectRelativePath: 'data/deep/missing.png',
            kind: 'file'
          }
        }]
      }, { x: 80, y: 100 });

      const unreadableElement = await waitForCanvasSurfaceElement(
        container,
        '[data-canvas-node-path="data/deep/unreadable.png"]'
      );
      await act(async () => {
        unreadableElement.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 140
        }));
      });
      expect(onOpenContextMenu).toHaveBeenLastCalledWith({
        source: 'canvas',
        invocationEntry: {
          availability: 'unreadable',
          pathEntry: {
            projectRelativePath: 'data/deep/unreadable.png',
            kind: 'file'
          }
        },
        selectedEntries: [{
          availability: 'unreadable',
          pathEntry: {
            projectRelativePath: 'data/deep/unreadable.png',
            kind: 'file'
          }
        }]
      }, { x: 120, y: 140 });
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('scales generic and unavailable image presentations without scaling intrinsic image pixels', () => {
    const projection: CanvasProjection = {
      nodes: [
        {
          ...nodeFixture('flow/a-intrinsic.png', 0, 0),
          imageDimensions: { width: 200, height: 120 }
        },
        nodeFixture('flow/b-generic.png', 240, 0),
        {
          ...nodeFixture('flow/c-unavailable.jpg', 480, 0),
          availability: {
            state: 'unreadable',
            message: 'Unable to read image metadata.'
          }
        }
      ],
      edges: [],
    };

    const html = renderToStaticMarkup(surface(projection));
    const intrinsicMarkup = html.slice(
      html.indexOf('data-canvas-node-path="flow/a-intrinsic.png"'),
      html.indexOf('data-canvas-node-path="flow/b-generic.png"')
    );
    const genericMarkup = html.slice(
      html.indexOf('data-canvas-node-path="flow/b-generic.png"'),
      html.indexOf('data-canvas-node-path="flow/c-unavailable.jpg"')
    );
    const unavailableMarkup = html.slice(html.indexOf('data-canvas-node-path="flow/c-unavailable.jpg"'));

    expect(intrinsicMarkup).not.toContain('fixed-presentation');
    expect(genericMarkup).toContain('fixed-presentation');
    expect(genericMarkup).toContain('canvas-node-presentation');
    expect(unavailableMarkup).toContain('fixed-presentation');
    expect(unavailableMarkup).toContain('canvas-node-presentation');
    expect(unavailableMarkup).toContain('Unable to read image metadata.');
  });

  it('keeps every current Canvas node mounted regardless of media type or viewport', () => {
    const projection: CanvasProjection = {
      nodes: [
        nodeFixture('flow/visible.png', 0, 0),
        nodeFixture('flow/offscreen.png', 6000, 0),
        {
          ...nodeFixture('flow/offscreen.txt', 8000, 0),
          mediaKind: 'text',
          availability: {
            state: 'available',
            size: 100,
            mimeType: 'text/plain',
            fileUrl: '/api/workbench/bindings/123e4567-e89b-42d3-a456-426614174000/files/raw/flow/offscreen.txt?v=rev-text',
            revision: 'rev-text'
          }
        },
        directoryFixture('flow/offscreen-dir', 9000, 0)
      ],
      edges: [],
    };

    const html = renderToStaticMarkup(surface(projection, {
      textFileBuffers: {
        'flow/offscreen.txt': {
          projectRelativePath: 'flow/offscreen.txt',
          content: 'offscreen text',
          language: 'plaintext',
          wordWrap: false,
          dirty: false,
          saving: false,
          baseRevision: 'rev-text',
          externalChange: false
        }
      }
    }));

    expect(html).toContain('data-canvas-node-path="flow/visible.png"');
    expect(html).toContain('data-canvas-node-path="flow/offscreen.png"');
    expect(html).toContain('data-canvas-node-path="flow/offscreen.txt"');
    expect(html).toContain('data-canvas-node-path="flow/offscreen-dir"');
  });

  it('keeps camera transforms out of React stage markup', () => {
    const projection: CanvasProjection = {
      nodes: [nodeFixture('flow/visible.png', 0, 0)],
      edges: [],
    };

    const html = renderToStaticMarkup(surface(projection, {
      camera: { x: 120, y: 80, z: 0.5 }
    }));

    expect(html).toContain('class="canvas-world-stage"');
    expect(html).not.toContain('transform:translate(120px, 80px) scale(0.5)');
    expect(html).not.toContain('--canvas-zoom:0.5');
  });

  it('retains offscreen text node content so camera movement does not create it later', () => {
    const projection: CanvasProjection = {
      nodes: [
        nodeFixture('flow/visible.png', 0, 0),
        {
          ...nodeFixture('flow/notes/offscreen.md', 6000, 0),
          mediaKind: 'text',
          availability: {
            state: 'available',
            size: 100,
            mimeType: 'text/markdown',
            fileUrl: '/api/workbench/bindings/123e4567-e89b-42d3-a456-426614174000/files/raw/flow/notes/offscreen.md?v=rev-text',
            revision: 'rev-text'
          }
        }
      ],
      edges: [],
    };

    const html = renderToStaticMarkup(surface(projection, {
      textFileBuffers: {
        'flow/notes/offscreen.md': {
          projectRelativePath: 'flow/notes/offscreen.md',
          content: '# Offscreen\n',
          language: 'markdown',
          wordWrap: false,
          dirty: false,
          saving: false,
          baseRevision: 'rev-text',
          externalChange: false
        }
      }
    }));

    expect(html).toContain('data-canvas-node-path="flow/notes/offscreen.md"');
    expect(html).toContain('canvas-text-node');
    expect(html).toContain('canvas-raster-preview-layers');
    expect(html).not.toContain('data-editor-mode="edit"');
    expect(html).not.toContain(`data-editor-mode="${'pre'}${'view'}"`);
  });

  it('keeps selected-only canvas text nodes as inactive preview bodies', () => {
    const projection: CanvasProjection = {
      nodes: [
        textProjectionNode('flow/a.md', 0, 0, 'rev-a'),
        textProjectionNode('flow/b.md', 300, 0, 'rev-b')
      ],
      edges: [],
    };

    const html = renderToStaticMarkup(surface(projection, {
      selection: { kind: 'nodes', projectRelativePaths: ['flow/a.md'] },
      textFileBuffers: {
        'flow/a.md': textBufferFixture('flow/a.md', '# A', 'rev-a'),
        'flow/b.md': textBufferFixture('flow/b.md', '# B', 'rev-b')
      }
    }));

    expect(html.match(/data-editor-mode="edit"/g) ?? []).toHaveLength(0);
    expect(html.match(/canvas-raster-preview-layers/g) ?? []).toHaveLength(2);
    expect(html).not.toContain(`data-editor-mode="${'pre'}${'view'}"`);
  });

  it('loads only content-activated text as a live editor and leaves selected-only text as preview', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: [
        textProjectionNode('flow/selected.md', 0, 0, 'rev-selected'),
        textProjectionNode('flow/inactive.md', 300, 0, 'rev-inactive')
      ],
      edges: [],
    };

    try {
      await act(async () => {
        root.render(surface(projection, {
          selection: { kind: 'nodes', projectRelativePaths: ['flow/selected.md'] },
          contentInteractionProjectRelativePath: 'flow/selected.md',
          textFileBuffers: {
            'flow/selected.md': textBufferFixture('flow/selected.md', '# Selected', 'rev-selected'),
            'flow/inactive.md': textBufferFixture('flow/inactive.md', '# Inactive', 'rev-inactive')
          }
        }));
      });
      await waitForCanvasSurfaceElement(container, '[data-editor-mode="edit"]');
      expect(container.querySelectorAll('[data-editor-mode="edit"]')).toHaveLength(1);
      expect(container.querySelectorAll('.canvas-text-node')).toHaveLength(2);
      expect(container.querySelector('[data-editor-mode="preview"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('renders every text node as a preview when text nodes are multi-selected', () => {
    const projection: CanvasProjection = {
      nodes: [
        textProjectionNode('flow/a.md', 0, 0, 'rev-a'),
        textProjectionNode('flow/b.md', 300, 0, 'rev-b')
      ],
      edges: [],
    };

    const html = renderToStaticMarkup(surface(projection, {
      selection: {
        kind: 'nodes',
        projectRelativePaths: ['flow/a.md', 'flow/b.md']
      },
      textFileBuffers: {
        'flow/a.md': textBufferFixture('flow/a.md', '# A', 'rev-a'),
        'flow/b.md': textBufferFixture('flow/b.md', '# B', 'rev-b')
      }
    }));

    expect(html.match(/data-editor-mode="edit"/g) ?? []).toHaveLength(0);
    expect(html.match(/canvas-raster-preview-layers/g) ?? []).toHaveLength(2);
  });

  it('keeps stable video and audio Content Regions while multi-selection prevents activation', () => {
    const projection: CanvasProjection = {
      nodes: [
        videoProjectionNode('media/clip.mp4', 0, 0),
        audioProjectionNode('media/theme.mp3', 700, 0)
      ],
      edges: [],
    };

    const html = renderToStaticMarkup(surface(projection, {
      selection: {
        kind: 'nodes',
        projectRelativePaths: ['media/clip.mp4', 'media/theme.mp3']
      }
    }));

    expect(html.match(/data-canvas-node-zone="content"/g) ?? []).toHaveLength(2);
  });

  it('restores the durable video position when Runtime rejects persistence', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const videoNode = {
      ...videoProjectionNode('media/clip.mp4', 0, 0),
      videoPlayback: { currentTimeMs: 2_500 }
    };
    const projection: CanvasProjection = {
      nodes: [videoNode],
      edges: [],
    };
    const updateCanvasVideoPlaybackState = vi.fn(async () => {
      throw new Error('persistence failed');
    });

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasSurface
              productPlatform="darwin"
              expandedDirectories={emptyCanvasState.expandedDirectories}
              projection={projection}
              runtime={canvasRuntimeFixture(projection)}
              actions={{ ...actions, updateCanvasVideoPlaybackState }}
              textFileBuffers={{}}
              canvasFeedback={undefined}
              textPreviewStyleDependencyKey="dark"
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        const update = videoMockState.lastUpdatePlaybackTime?.(videoNode.projectRelativePath, 8_250);
        await expect(Promise.resolve(update)).rejects.toThrow('persistence failed');
      });

      expect(updateCanvasVideoPlaybackState).toHaveBeenCalledWith({
        updates: [{ projectRelativePath: videoNode.projectRelativePath, currentTimeMs: 8_250 }]
      });
      expect(videoRestorePersistedTimeSpy).toHaveBeenCalledWith(2_500);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('does not roll back a newer persisted video position when an older request fails', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const videoNode = {
      ...videoProjectionNode('media/clip.mp4', 0, 0),
      videoPlayback: { currentTimeMs: 2_500 }
    };
    const projection: CanvasProjection = {
      nodes: [videoNode],
      edges: [],
    };
    const firstUpdate = deferred<void>();
    const secondUpdate = deferred<void>();
    const updateCanvasVideoPlaybackState = vi.fn()
      .mockImplementationOnce(() => firstUpdate.promise)
      .mockImplementationOnce(() => secondUpdate.promise);

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasSurface
              productPlatform="darwin"
              expandedDirectories={emptyCanvasState.expandedDirectories}
              projection={projection}
              runtime={canvasRuntimeFixture(projection)}
              actions={{ ...actions, updateCanvasVideoPlaybackState }}
              textFileBuffers={{}}
              canvasFeedback={undefined}
              textPreviewStyleDependencyKey="dark"
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        videoMockState.lastUpdatePlaybackTime?.(videoNode.projectRelativePath, 8_250);
        videoMockState.lastUpdatePlaybackTime?.(videoNode.projectRelativePath, 9_500);
        secondUpdate.resolve(undefined);
        await secondUpdate.promise;
        firstUpdate.reject(new Error('older persistence failed'));
        await firstUpdate.promise.catch(() => undefined);
        await Promise.resolve();
      });

      expect(updateCanvasVideoPlaybackState).toHaveBeenNthCalledWith(2, {
        updates: [{ projectRelativePath: videoNode.projectRelativePath, currentTimeMs: 9_500 }]
      });
      expect(videoRestorePersistedTimeSpy).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('refreshes a hovered video feedback target when the video handle registers', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const videoNode = videoProjectionNode('media/clip.mp4', 0, 0);
    const projection: CanvasProjection = {
      nodes: [videoNode],
      edges: [],
    };
    const targetChanges: Array<CanvasFeedbackBarTarget | undefined> = [];
    const runtime = canvasRuntimeFixture(projection);
    videoMockState.registerOnMount = false;
    videoMockState.lastPath = undefined;
    videoMockState.lastRegister = undefined;

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasSurface
              productPlatform="darwin"
              expandedDirectories={emptyCanvasState.expandedDirectories}
              projection={projection}
              runtime={runtime}
              actions={actions}
              textFileBuffers={{}}
              canvasFeedback={feedbackDocument({})}
              feedbackInteraction={{
                localMode: undefined,
                composition: undefined,
                localSpatialItems: [],
                suppressedSpatialItemIds: new Set(),
                focusedCapsuleId: undefined,
                getCurrentTargetProjectRelativePath: () => undefined,
                suspendHoverTarget: vi.fn(),
                dismissTarget: vi.fn(),
                handleTargetChange: (target) => targetChanges.push(target),
                invalidateTarget: vi.fn(),
                handleDraft: vi.fn(),
                activateCapsule: vi.fn()
              }}
              textPreviewStyleDependencyKey="dark"
            />
          </I18nProvider>
        );
      });

      const nodeElement = container.querySelector<HTMLElement>('[data-canvas-node-path="media/clip.mp4"]');
      expect(nodeElement).toBeTruthy();
      await act(async () => {
        nodeElement?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      });

      expect(targetChanges.at(-1)).toMatchObject({
        kind: 'node',
        canStartVideoMomentFeedback: false
      });
      expect(videoMockState.lastPath).toBe(videoNode.projectRelativePath);

      await act(async () => {
        const target = targetChanges.at(-1);
        if (target?.kind === 'node') {
          target.seekToMoment?.(12.5);
        }
      });
      expect(videoPauseAtSpy).not.toHaveBeenCalledWith(12.5);

      await act(async () => {
        videoMockState.lastRegister?.(videoNode.projectRelativePath, {
          readCurrentTimeSeconds: videoReadCurrentTimeSecondsSpy,
          pauseAt: videoPauseAtSpy,
          restorePersistedTime: videoRestorePersistedTimeSpy
        });
      });

      expect(targetChanges.at(-1)).toMatchObject({
        canStartVideoMomentFeedback: true
      });
      expect(videoPauseAtSpy).toHaveBeenCalledWith(12.5);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      videoMockState.registerOnMount = true;
      videoMockState.lastPath = undefined;
      videoMockState.lastRegister = undefined;
    }
  });

  it('starts Canvas-owned text preview scheduled work after StrictMode mount cleanup', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['png']), { status: 200 })));
    const ImageMock = function ImageMock() {
      return {
        decoding: 'auto',
        src: '',
        decode: async () => undefined
      } as HTMLImageElement;
    } as unknown as typeof Image;
    vi.stubGlobal('Image', ImageMock);
    const restoreAnimationFrame = installAnimationFrame();
    const restoreTextBodyMeasurement = installCanvasTextBodyMeasurement({ width: 20, height: 1 });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const node = textProjectionNode('flow/strict.md', 0, 0, 'rev-strict');
    const projection: CanvasProjection = {
      nodes: [node],
      edges: [],
    };
    const readCanvasTextPreviewSources = vi.fn(async (
      input: Parameters<WorkbenchActions['readCanvasTextPreviewSources']>[0]
    ) => canvasTextPreviewSourceAvailabilityResponse(input));
    const runtime = canvasRuntimeFixture(projection);

    try {
      await act(async () => {
        root.render(
          <React.StrictMode>
            <I18nProvider locale="en">
              <CanvasSurface
                productPlatform="darwin"
                expandedDirectories={emptyCanvasState.expandedDirectories}
                projection={projection}
                runtime={runtime}
                actions={{
                  ...actions,
                  readCanvasTextPreviewSources
                }}
                textFileBuffers={{
                  [node.projectRelativePath]: textBufferFixture(node.projectRelativePath, '# Strict', 'rev-strict')
                }}
                canvasFeedback={undefined}
                textPreviewStyleDependencyKey="dark"
              />
            </I18nProvider>
          </React.StrictMode>
        );
      });

      for (let frame = 0; frame < 20; frame += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20);
          await Promise.resolve();
        });
      }
      const previewImage = container.querySelector<HTMLImageElement>(
        'img[data-canvas-raster-preview-kind="text"]'
      );

      expect(readCanvasTextPreviewSources).toHaveBeenCalledWith({
        sources: [expect.objectContaining({ projectRelativePath: node.projectRelativePath })]
      });
      expect(previewImage?.getAttribute('data-preview-width')).toBe('80');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreTextBodyMeasurement();
      restoreAnimationFrame();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('keeps every current structure edge mounted for direct viewport culling', () => {
    const projection: CanvasProjection = {
      nodes: [
        nodeFixture('flow/a.png', 0, 0),
        nodeFixture('flow/b.png', 300, 0),
        nodeFixture('flow/far.png', 5000, 0),
        nodeFixture('flow/left.png', -3000, 300),
        nodeFixture('flow/right.png', 5000, 300),
        nodeFixture('flow/top-a.png', 0, -5000),
        nodeFixture('flow/top-b.png', 5000, -5000)
      ],
      edges: [{
        id: 'edge:both',
        sourceProjectRelativePath: 'flow/a.png',
        targetProjectRelativePath: 'flow/b.png'
      }, {
        id: 'edge:one-endpoint',
        sourceProjectRelativePath: 'flow/a.png',
        targetProjectRelativePath: 'flow/far.png'
      }, {
        id: 'edge:crossing',
        sourceProjectRelativePath: 'flow/left.png',
        targetProjectRelativePath: 'flow/right.png'
      }, {
        id: 'edge:outside',
        sourceProjectRelativePath: 'flow/top-a.png',
        targetProjectRelativePath: 'flow/top-b.png'
      }],
    };

    const html = renderToStaticMarkup(surface(projection));

    expect(html).toContain('data-canvas-edge-ids="edge:both edge:one-endpoint"');
    expect(html).toContain('data-canvas-edge-ids="edge:crossing"');
    expect(html).toContain('data-canvas-edge-ids="edge:outside"');
    expect(html.match(/<svg/g) ?? []).toHaveLength(1);
    expect(html.match(/<path/g) ?? []).toHaveLength(3);
  });

  it('keeps Canvas nodes mounted while omitting the complete edge SVG layer', () => {
    const projection: CanvasProjection = {
      nodes: [
        nodeFixture('flow/a.png', 0, 0),
        nodeFixture('flow/b.png', 300, 0)
      ],
      edges: []
    };

    const html = renderToStaticMarkup(surface(projection));

    expect(html).toContain('data-canvas-node-path="flow/a.png"');
    expect(html).toContain('data-canvas-node-path="flow/b.png"');
    expect(html).not.toContain('class="canvas-edge-layer"');
    expect(html).not.toContain('data-canvas-edge-ids');
  });

  it('passes image feedback entries to image node markup without rendering feedback bars inside nodes', () => {
    const projection: CanvasProjection = {
      nodes: [nodeFixture('flow/cover.png', 120, 80)],
      edges: [],
    };

    const html = renderToStaticMarkup(surface(projection, {
      canvasFeedback: feedbackDocument({
        'flow/cover.png': {
          projectRelativePath: 'flow/cover.png',
          marks: [],
          nextMomentLabel: 1,
          nextSpatialLabel: 2,
          items: [{
            id: 'region-1',
            label: 1,
            kind: 'pin',
            scope: 'node',
            geometry: { type: 'point', x: 0.2, y: 0.3 },
            comment: 'region note hidden',
            createdAt: '2026-05-26T12:00:00.000Z',
            updatedAt: '2026-05-26T12:00:00.000Z'
          }],
          updatedAt: '2026-05-26T12:00:00.000Z'
        }
      })
    }));

    expect(html).toContain('canvas-media-feedback-layer');
    expect(html).toContain('data-canvas-feedback-label="1"');
    expect(html).not.toContain('region note hidden');
    expect(html).not.toContain('class="canvas-feedback-bar"');
  });

  it('omits accepted spatial geometry while its current Working Copy is empty', () => {
    const projection: CanvasProjection = {
      nodes: [nodeFixture('flow/cover.png', 120, 80)],
      edges: [],
    };

    const html = renderToStaticMarkup(surface(projection, {
      canvasFeedback: feedbackDocument({
        'flow/cover.png': {
          projectRelativePath: 'flow/cover.png',
          marks: [],
          nextMomentLabel: 1,
          nextSpatialLabel: 2,
          items: [{
            id: 'region-1',
            label: 1,
            kind: 'pin',
            scope: 'node',
            geometry: { type: 'point', x: 0.2, y: 0.3 },
            comment: 'accepted note',
            createdAt: '2026-05-26T12:00:00.000Z',
            updatedAt: '2026-05-26T12:00:00.000Z'
          }],
          updatedAt: '2026-05-26T12:00:00.000Z'
        }
      }),
      feedbackInteraction: feedbackInteractionFixture({
        suppressedSpatialItemIds: new Set(['region-1'])
      })
    }));

    expect(html).not.toContain('data-canvas-feedback-label="1"');
  });

  it('does not project node-level marks or comments into node chrome', () => {
    const projection: CanvasProjection = {
      nodes: [nodeFixture('flow/cover.png', 120, 80)],
      edges: [],
    };

    const html = renderToStaticMarkup(surface(projection, {
      canvasFeedback: feedbackDocument({
        'flow/cover.png': {
          projectRelativePath: 'flow/cover.png',
          marks: ['like', 'important'],
          nextMomentLabel: 1,
          nextSpatialLabel: 1,
          items: [{
            id: 'comment-1',
            kind: 'comment',
            scope: 'node',
            comment: 'overall direction',
            createdAt: '2026-05-26T12:00:00.000Z',
            updatedAt: '2026-05-26T12:00:00.000Z'
          }, {
            id: 'comment-2',
            kind: 'comment',
            scope: 'node',
            comment: 'second pass',
            createdAt: '2026-05-26T12:00:00.000Z',
            updatedAt: '2026-05-26T12:00:00.000Z'
          }],
          updatedAt: '2026-05-26T12:00:00.000Z'
        }
      })
    }));

    expect(html).not.toContain('overall direction');
    expect(html).not.toContain('second pass');
    expect(html).not.toContain('class="canvas-feedback-bar"');
  });

  it('keeps node-level feedback out of text and video node chrome', () => {
    const projection: CanvasProjection = {
      nodes: [
        textProjectionNode('flow/readme.md', 120, 80, 'rev-a'),
        videoProjectionNode('flow/clip.mp4', 380, 80)
      ],
      edges: [],
    };

    const html = renderToStaticMarkup(surface(projection, {
      canvasFeedback: feedbackDocument({
        'flow/readme.md': {
          projectRelativePath: 'flow/readme.md',
          marks: ['check'],
          nextMomentLabel: 1,
          nextSpatialLabel: 1,
          items: [{
            id: 'comment-1',
            kind: 'comment',
            scope: 'node',
            comment: 'tighten intro',
            createdAt: '2026-05-26T12:00:00.000Z',
            updatedAt: '2026-05-26T12:00:00.000Z'
          }],
          updatedAt: '2026-05-26T12:00:00.000Z'
        },
        'flow/clip.mp4': {
          projectRelativePath: 'flow/clip.mp4',
          marks: ['needs_revision'],
          nextMomentLabel: 1,
          nextSpatialLabel: 1,
          items: [],
          updatedAt: '2026-05-26T12:00:00.000Z'
        }
      })
    }));

    expect(html).toContain('data-canvas-node-path="flow/readme.md"');
    expect(html).toContain('data-canvas-node-path="flow/clip.mp4"');
    expect(html).not.toContain('tighten intro');
    expect(html).not.toContain('class="canvas-feedback-bar"');
  });

  it('keeps node-level feedback out of audio, directory, and unknown node chrome', () => {
    const audioNode: CanvasProjection['nodes'][number] = {
      ...nodeFixture('flow/sound.wav', 120, 80),
      mediaKind: 'audio',
      availability: {
        state: 'available',
        size: 100,
        mimeType: 'audio/wav',
        fileUrl: '/api/workbench/bindings/123e4567-e89b-42d3-a456-426614174000/files/raw/flow/sound.wav?v=rev',
        revision: 'rev'
      }
    };
    const unknownNode: CanvasProjection['nodes'][number] = {
      ...nodeFixture('flow/archive.bin', 380, 80),
      mediaKind: 'unknown',
      availability: {
        state: 'available',
        size: 100,
        mimeType: 'application/octet-stream',
        fileUrl: '/api/workbench/bindings/123e4567-e89b-42d3-a456-426614174000/files/raw/flow/archive.bin?v=rev',
        revision: 'rev'
      }
    };
    const projection: CanvasProjection = {
      nodes: [
        audioNode,
        unknownNode,
        directoryFixture('flow/assets', 640, 80)
      ],
      edges: [],
    };

    const html = renderToStaticMarkup(surface(projection, {
      canvasFeedback: feedbackDocument({
        'flow/sound.wav': {
          projectRelativePath: 'flow/sound.wav',
          marks: ['pending'],
          nextMomentLabel: 1,
          nextSpatialLabel: 1,
          items: [],
          updatedAt: '2026-05-26T12:00:00.000Z'
        },
        'flow/archive.bin': {
          projectRelativePath: 'flow/archive.bin',
          marks: ['cross'],
          nextMomentLabel: 1,
          nextSpatialLabel: 1,
          items: [],
          updatedAt: '2026-05-26T12:00:00.000Z'
        },
        'flow/assets': {
          projectRelativePath: 'flow/assets',
          marks: [],
          nextMomentLabel: 1,
          nextSpatialLabel: 1,
          items: [{
            id: 'comment-1',
            kind: 'comment',
            scope: 'node',
            comment: 'folder note hidden',
            createdAt: '2026-05-26T12:00:00.000Z',
            updatedAt: '2026-05-26T12:00:00.000Z'
          }],
          updatedAt: '2026-05-26T12:00:00.000Z'
        }
      })
    }));

    expect(html).toContain('data-canvas-node-path="flow/sound.wav"');
    expect(html).toContain('data-canvas-node-path="flow/archive.bin"');
    expect(html).toContain('data-canvas-node-path="flow/assets"');
    expect(html).not.toContain('folder note hidden');
  });

  it('builds feedback bar targets for the image that creates a local feedback draft', () => {
    const node = nodeFixture('flow/b.png', 260, 140);

    expect(canvasFeedbackBarTargetForProjectedNode({
      node,
      surfaceRect: { x: 10, y: 20, width: 900, height: 600 },
      camera: { x: 30, y: 40, z: 2 }
    })).toEqual({
      kind: 'node',
      projectRelativePath: 'flow/b.png',
      anchorRect: { x: 260, y: 140, width: 200, height: 120 },
      surfaceRect: { x: 10, y: 20, width: 900, height: 600 },
      camera: { x: 30, y: 40, z: 2 },
      localToolset: 'image',
      canStartVideoMomentFeedback: false
    });
  });

  it('does not render minimap UI inside the Canvas surface layer', () => {
    const projection: CanvasProjection = {
      nodes: [nodeFixture('flow/visible.png', 0, 0)],
      edges: [],
    };

    const html = renderToStaticMarkup(surface(projection));

    expect(html).toContain('class="canvas-surface"');
    expect(html).not.toContain('data-testid="canvas-minimap-bar"');
    expect(html).not.toContain('data-testid="canvas-minimap-panel"');
  });

  it('builds node Feedback targets for directories and the Project root', () => {
    const directory = directoryFixture('image-production', 0, 0);
    const rootNode = directoryFixture('', 240, 0);

    expect(canvasFeedbackBarTargetForProjectedNode({
      node: directory,
      surfaceRect: { x: 0, y: 0, width: 900, height: 600 },
      camera: { x: 0, y: 0, z: 1 }
    })).toMatchObject({
      kind: 'node',
      projectRelativePath: 'image-production',
      localToolset: 'none'
    });
    expect(canvasFeedbackBarTargetForProjectedNode({
      node: rootNode,
      surfaceRect: { x: 0, y: 0, width: 900, height: 600 },
      camera: { x: 0, y: 0, z: 1 }
    })).toMatchObject({
      kind: 'node',
      projectRelativePath: '',
      localToolset: 'none'
    });
  });

  it('emits a single-node Feedback target when the empty-path Project root is hovered', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: [directoryFixture('', 0, 0)],
      edges: [],
    };
    const targetChanges: Array<CanvasFeedbackBarTarget | undefined> = [];

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasSurface
              productPlatform="darwin"
              expandedDirectories={emptyCanvasState.expandedDirectories}
              projection={projection}
              runtime={canvasRuntimeFixture(projection)}
              actions={actions}
              textFileBuffers={{}}
              canvasFeedback={feedbackDocument({})}
              feedbackInteraction={{
                localMode: undefined,
                composition: undefined,
                localSpatialItems: [],
                suppressedSpatialItemIds: new Set(),
                focusedCapsuleId: undefined,
                getCurrentTargetProjectRelativePath: () => undefined,
                suspendHoverTarget: vi.fn(),
                dismissTarget: vi.fn(),
                handleTargetChange: (target) => targetChanges.push(target),
                invalidateTarget: vi.fn(),
                handleDraft: vi.fn(),
                activateCapsule: vi.fn()
              }}
              textPreviewStyleDependencyKey="dark"
            />
          </I18nProvider>
        );
      });

      const rootNode = container.querySelector<HTMLElement>('[data-canvas-node-path=""]');
      expect(rootNode).not.toBeNull();
      await act(async () => {
        rootNode?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      });
      expect(targetChanges.at(-1)).toMatchObject({
        kind: 'node',
        projectRelativePath: '',
        localToolset: 'none'
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('anchors one multi-selection Feedback target to the complete outer selection bounds', () => {
    const selected = [
      directoryFixture('flow/assets', 20, 40),
      nodeFixture('flow/cover.png', 300, 220)
    ];

    expect(canvasFeedbackBarTargetForSelection({
      nodes: selected,
      projectRelativePaths: selected.map((node) => node.projectRelativePath),
      surfaceRect: { x: 10, y: 20, width: 900, height: 600 },
      camera: { x: 30, y: 40, z: 2 }
    })).toEqual({
      kind: 'selection',
      projectRelativePaths: ['flow/assets', 'flow/cover.png'],
      anchorRect: { x: 20, y: 40, width: 480, height: 300 },
      surfaceRect: { x: 10, y: 20, width: 900, height: 600 },
      camera: { x: 30, y: 40, z: 2 }
    });
  });

  it('publishes a changed multi-selection Feedback target without a Canvas React rerender', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: [
        nodeFixture('flow/a.png', 0, 0),
        nodeFixture('flow/b.png', 300, 100)
      ],
      edges: [],
    };
    const runtime = canvasRuntimeFixture(projection);
    const targetChanges: Array<CanvasFeedbackBarTarget | undefined> = [];

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasSurface
              productPlatform="darwin"
              expandedDirectories={emptyCanvasState.expandedDirectories}
              projection={projection}
              runtime={runtime}
              actions={actions}
              textFileBuffers={{}}
              canvasFeedback={feedbackDocument({})}
              feedbackInteraction={feedbackInteractionFixture({
                handleTargetChange: (target) => targetChanges.push(target)
              })}
              textPreviewStyleDependencyKey="dark"
            />
          </I18nProvider>
        );
      });
      const surfaceElement = container.querySelector<HTMLElement>('[data-testid="canvas-surface"]')!;
      Object.defineProperty(surfaceElement, 'getBoundingClientRect', {
        configurable: true,
        value: () => new DOMRect(0, 0, 1280, 720)
      });
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, CANVAS_CAMERA_IDLE_MS + 10));
      });

      await act(async () => {
        runtime.setSelection({
          kind: 'nodes',
          projectRelativePaths: ['flow/a.png', 'flow/b.png']
        });
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      });

      expect(targetChanges.at(-1)).toMatchObject({
        kind: 'selection',
        projectRelativePaths: ['flow/a.png', 'flow/b.png']
      });
    } finally {
      await act(async () => root.unmount());
      runtime.dispose();
      container.remove();
    }
  });

  it('does not eagerly render image src attributes before node-local image state publishes image state', () => {
    const projection: CanvasProjection = {
      nodes: Array.from({ length: 16 }, (_item, index) => ({
        ...nodeFixture(`flow/image-${index}.png`, index * 220, 0),
        width: 2400,
        height: 1200
      })),
      edges: [],
    };

    const html = renderToStaticMarkup(surface(projection, {
      camera: { x: 0, y: 0, z: 0.1 }
    }));

    expect(html).toContain('data-canvas-node-path="flow/image-0.png"');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('/canvas-image-preview?path=flow%2Fimage-0.png');
    expect(html).not.toContain('/files/raw/flow/image-0.png');
  });

  it('replaces the visible image preview after the camera settles at a higher zoom', async () => {
    vi.useFakeTimers();
    const ImageMock = function ImageMock() {
      return {
        decoding: 'auto',
        src: '',
        complete: true,
        naturalWidth: 1,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        decode: async () => undefined
      } as unknown as HTMLImageElement;
    } as unknown as typeof Image;
    vi.stubGlobal('Image', ImageMock);
    const devicePixelRatioDescriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 1
    });
    const restoreAnimationFrame = installAnimationFrame();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const node = largePreviewNodeFixture('flow/large.png');
    const projection: CanvasProjection = {
      nodes: [node],
      edges: [],
    };
    const runtime = canvasRuntimeFixture(projection, {
      camera: { x: 0, y: 0, z: 0.1 },
      selection: { kind: 'nodes', projectRelativePaths: [node.projectRelativePath ] }
    });

    try {
      await act(async () => {
        root.render(
          <React.StrictMode>
            <I18nProvider locale="en">
              <CanvasSurface
                productPlatform="darwin"
                expandedDirectories={emptyCanvasState.expandedDirectories}
                projection={projection}
                runtime={runtime}
                actions={actions}
                textFileBuffers={{}}
                canvasFeedback={undefined}
                textPreviewStyleDependencyKey="dark"
              />
            </I18nProvider>
          </React.StrictMode>
        );
      });
      await settleCanvasImageHandoff();

      expect(canvasVisibleImagePreviewWidth(container)).toBe('300');

      await act(async () => {
        runtime.camera.setCamera({ x: 0, y: 0, z: 1 });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CANVAS_PREVIEW_QUALITY_SETTLE_MS);
      });
      await settleCanvasImageHandoff();

      expect(canvasVisibleImagePreviewWidth(container)).toBe('2400');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      restoreAnimationFrame();
      restorePropertyDescriptor(window, 'devicePixelRatio', devicePixelRatioDescriptor);
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('does not commit the Canvas React tree when preview quality settles without raster consumers', async () => {
    vi.useFakeTimers();
    const restoreAnimationFrame = installAnimationFrame();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: Array.from({ length: 32 }, (_item, index) => (
        directoryFixture(`folder-${index}`, index * 240, 0)
      )),
      edges: []
    };
    const runtime = canvasRuntimeFixture(projection, {
      camera: { x: 0, y: 0, z: 1 }
    });
    const commits = vi.fn();

    try {
      await act(async () => {
        root.render(
          <React.Profiler id="directory-canvas" onRender={commits}>
            <I18nProvider locale="en">
              <CanvasSurface
                productPlatform="darwin"
                expandedDirectories={emptyCanvasState.expandedDirectories}
                projection={projection}
                runtime={runtime}
                actions={actions}
                textFileBuffers={{}}
                canvasFeedback={undefined}
                textPreviewStyleDependencyKey="dark"
              />
            </I18nProvider>
          </React.Profiler>
        );
      });
      commits.mockClear();

      await act(async () => {
        runtime.camera.setCamera({ x: 0, y: 0, z: 2 });
        await vi.advanceTimersByTimeAsync(CANVAS_PREVIEW_QUALITY_SETTLE_MS - 1);
      });
      commits.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(commits).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      runtime.dispose();
      container.remove();
      restoreAnimationFrame();
      vi.useRealTimers();
    }
  });

  it('does not wait for Canvas settings before rendering the Canvas shell', () => {
    const projection: CanvasProjection = {
      nodes: [{ ...nodeFixture('flow/cover.png', 0, 0), width: 2400, height: 1200 }],
      edges: [],
    };
    const html = renderToStaticMarkup(
      <CanvasEditor
        productPlatform="darwin"
        canvas={{
          expandedDirectories: [],
          projection
        }}
        hasProject
        projectOpening={false}
        actions={actions}
        textFileBuffers={{}}
        canvasFeedback={undefined}
        textPreviewStyleDependencyKey="dark"
      />
    );

    expect(html).not.toContain('data-testid="canvas-settings-loading"');
    expect(html).toContain('data-testid="canvas-runtime-loading"');
    expect(html).not.toContain('debrute-canvas-preview://');
    expect(html).not.toContain('debrute-project-file://');
  });

  it('does not move the Feedback Bar to another hovered node while a Capsule owns focus', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: [
        nodeFixture('flow/first.png', 0, 0),
        nodeFixture('flow/second.png', 700, 100)
      ],
      edges: [],
    };
    const overlayRuntime = createCanvasOverlayRuntime();
    const handleTargetChange = vi.fn();
    const feedbackBar = document.createElement('div');
    const releaseFeedbackBar = overlayRuntime.bindFeedbackBar(feedbackBar);
    overlayRuntime.setFeedbackBarPlacement({
      x: 40,
      y: 160,
      width: 300,
      height: 124,
      placement: 'below'
    });

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasSurface
              productPlatform="darwin"
              expandedDirectories={emptyCanvasState.expandedDirectories}
              projection={projection}
              runtime={canvasRuntimeFixture(projection)}
              actions={actions}
              textFileBuffers={{}}
              canvasFeedback={feedbackDocument({})}
              feedbackInteraction={feedbackInteractionFixture({
                focusedCapsuleId: 'feedback-a',
                handleTargetChange
              })}
              textPreviewStyleDependencyKey="dark"
            />
          </I18nProvider>
        );
      });

      const surfaceElement = container.querySelector<HTMLElement>('[data-testid="canvas-surface"]');
      const secondNode = container.querySelector<HTMLElement>('[data-canvas-node-path="flow/second.png"]');
      expect(surfaceElement).toBeTruthy();
      expect(secondNode).toBeTruthy();
      Object.defineProperty(surfaceElement, 'getBoundingClientRect', {
        configurable: true,
        value: () => new DOMRect(0, 0, 1280, 720)
      });

      await act(async () => {
        secondNode?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      });

      expect(handleTargetChange).toHaveBeenLastCalledWith(expect.objectContaining({
        projectRelativePath: 'flow/second.png'
      }));
      expect(feedbackBar.style.left).toBe('40px');
      expect(feedbackBar.style.top).toBe('160px');
    } finally {
      await act(async () => root.unmount());
      releaseFeedbackBar();
      overlayRuntime.dispose();
      container.remove();
    }
  });

  it('invalidates a current Feedback Bar target when the empty-path Project root disappears', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const projection: CanvasProjection = {
      nodes: [],
      edges: [],
    };
    const invalidateTarget = vi.fn();

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasSurface
              productPlatform="darwin"
              expandedDirectories={emptyCanvasState.expandedDirectories}
              projection={projection}
              runtime={canvasRuntimeFixture(projection)}
              actions={actions}
              textFileBuffers={{}}
              canvasFeedback={feedbackDocument({})}
              feedbackInteraction={feedbackInteractionFixture({
                focusedCapsuleId: 'feedback-a',
                getCurrentTargetProjectRelativePath: () => '',
                invalidateTarget
              })}
              textPreviewStyleDependencyKey="dark"
            />
          </I18nProvider>
        );
      });

      expect(invalidateTarget).toHaveBeenCalledWith('');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('keeps image node shell props equal for unused action object changes but not interaction inputs', () => {
    const props = nodeShellProps();

    expect(areCanvasNodeShellPropsEqual(props, {
      ...props,
      actions: { ...props.actions }
    })).toBe(true);

    expect(areCanvasNodeShellPropsEqual(props, {
      ...props,
      onResizePointerDown: () => undefined
    })).toBe(false);

    expect(areCanvasNodeShellPropsEqual(props, {
      ...props,
      contentHandoffRequest: {
        requestId: 1,
        projectRelativePath: props.node.projectRelativePath,
        kind: 'video-toggle'
      }
    })).toBe(false);

    expect(areCanvasNodeShellPropsEqual(props, {
      ...props,
      onContentHandoffConsumed: () => undefined
    })).toBe(false);

  });

  it('tracks active video paths from content activation, playback, and requested mounts', () => {
    const active = canvasActiveVideoPaths({
      nodes: [
        videoProjectionNode('media/selected.mp4', 0, 0),
        videoProjectionNode('media/playing.mp4', 0, 400),
        videoProjectionNode('media/requested.mp4', 0, 800),
        nodeFixture('images/cover.png', 0, 1200)
      ],
      contentActiveProjectRelativePaths: ['media/selected.mp4', 'images/cover.png'],
      playingVideoPaths: new Set(['media/playing.mp4', 'media/missing.mp4']),
      requestedVideoPlayerPath: 'media/requested.mp4'
    });

    expect([...active].sort()).toEqual([
      'media/playing.mp4',
      'media/requested.mp4',
      'media/selected.mp4'
    ]);
  });

  it('updates preview resource scheduler state from camera and pointer interaction', () => {
    const frames: FrameRequestCallback[] = [];
    const started: string[] = [];
    const scheduler = createCanvasPreviewResourceScheduler({
      distanceSquaredForNode: () => 0,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: () => undefined
    });

    scheduler.setInteractionState(canvasPreviewResourceInteractionState({
      cameraState: 'moving',
      pointerInteraction: undefined
    }));
    scheduler.enqueue({
      kind: 'image',
      nodeId: 'cover.png',
      sourceKey: 'source',
      targetWidth: 640,
      isCurrent: () => true,
      run: () => started.push('cover.png')
    });
    expect(frames).toEqual([]);

    scheduler.setInteractionState(canvasPreviewResourceInteractionState({
      cameraState: 'idle',
      pointerInteraction: {
        kind: 'move-node',
        pointerId: 1,
        phase: 'pending',
        startScreen: { x: 0, y: 0 },
        currentScreen: { x: 0, y: 0 },
        start: { x: 0, y: 0 },
        current: { x: 0, y: 0 },
        initialSelection: undefined,
        initialContentInteractionProjectRelativePath: undefined,
        pressedProjectRelativePath: 'cover.png',
        additive: false,
        origins: []
      }
    }));
    expect(frames).toEqual([]);

    scheduler.setInteractionState(canvasPreviewResourceInteractionState({
      cameraState: 'idle',
      pointerInteraction: undefined
    }));
    expect(frames).toHaveLength(1);
    frames[0]?.(16);

    expect(started).toEqual(['cover.png']);
  });

  it('starts and ends a camera session with timestamped counters and explicit final state', () => {
    const monitor = createCanvasPerfMonitor();
    const sessionRef = { current: undefined as CanvasPerfRuntimeSession | undefined };

    syncCanvasPerfSessionState({
      perfMonitor: monitor,
      sessionRef,
      snapshot: { cameraState: 'moving', camera: { x: 0, y: 0, z: 1 } },
      minimapOpen: false
    });
    monitor.recordCounter({ timestamp: 5, source: 'CanvasRenderLifecycle', name: 'render-snapshot-build' });
    monitor.recordCounter({ timestamp: 6, source: 'CanvasRenderLifecycle', name: 'render-snapshot-reuse' });
    monitor.recordCounter({ timestamp: 7, source: 'CanvasStageRuntime', name: 'stage-camera-write' });
    monitor.recordCounter({
      timestamp: 8,
      source: 'CanvasRasterPreviewPresentation',
      name: 'raster-preview-requested'
    });
    syncCanvasPerfSessionState({
      perfMonitor: monitor,
      sessionRef,
      snapshot: { cameraState: 'idle', camera: { x: 0, y: 0, z: 1 } },
      minimapOpen: false,
      getFinalState: () => ({
        mountedNodeCount: 2,
        visibleNodeCount: 1,
        culledNodeCount: 1,
        zoomLevel: 1,
        cameraState: 'idle'
      })
    });

    expect(monitor.getLastSession()).toMatchObject({
      type: 'camera-pan',
      frameIntervalCount: 0,
      mountedNodeCount: 2,
      visibleNodeCount: 1,
      culledNodeCount: 1,
      counters: {
        'render-snapshot-build': 1,
        'render-snapshot-reuse': 1,
        'stage-camera-write': 1,
        'raster-preview-requested': 1
      }
    });
    expect(monitor.getTrace().events.some((event) => event.kind === 'frame-interval')).toBe(false);
  });

  it('does not synthesize per-frame work counters for camera input callbacks', () => {
    const monitor = createCanvasPerfMonitor();
    const sessionRef = { current: undefined as CanvasPerfRuntimeSession | undefined };

    syncCanvasPerfSessionState({
      perfMonitor: monitor,
      sessionRef,
      snapshot: {
        cameraState: 'moving',
        camera: { x: 0, y: 0, z: 1 }
      },
      minimapOpen: false
    });
    syncCanvasPerfSessionState({
      perfMonitor: monitor,
      sessionRef,
      snapshot: { cameraState: 'idle', camera: { x: 0, y: 0, z: 1 } },
      minimapOpen: false
    });

    expect(monitor.getLastSession()?.counters).toEqual({});
    expect(monitor.getTrace().events.map((event) => event.kind)).toEqual(['session-start', 'session-end']);
  });

  it('starts and ends a move drag session with direct render commit counters', () => {
    const monitor = createCanvasPerfMonitor();
    const sessionRef = { current: undefined as CanvasPerfRuntimeSession | undefined };
    const activeNode = nodeFixture('flow/a.png', 0, 0);

    syncCanvasPerfPointerInteractionSessionState({
      perfMonitor: monitor,
      sessionRef,
      pointerInteraction: {
        kind: 'move-node',
        pointerId: 42,
        phase: 'active',
        startScreen: { x: 0, y: 0 },
        currentScreen: { x: 12, y: 8 },
        start: { x: 0, y: 0 },
        current: { x: 12, y: 8 },
        initialSelection: undefined,
        initialContentInteractionProjectRelativePath: undefined,
        pressedProjectRelativePath: activeNode.projectRelativePath,
        additive: false,
        origins: [activeNode]
      },
      snapshot: { cameraState: 'idle', camera: { x: 0, y: 0, z: 1 } }
    });
    monitor.recordCounter({
      timestamp: 1,
      source: 'CanvasSurface',
      sessionTypes: ['pointer-move-node'],
      name: 'react-commit'
    });
    syncCanvasPerfPointerInteractionSessionState({
      perfMonitor: monitor,
      sessionRef,
      pointerInteraction: undefined,
      snapshot: { cameraState: 'idle', camera: { x: 0, y: 0, z: 1 } },
      getFinalState: () => ({
        mountedNodeCount: 1,
        visibleNodeCount: 1,
        culledNodeCount: 0
      })
    });

    expect(monitor.getLastSession()).toMatchObject({
      type: 'pointer-move-node',
      frameIntervalCount: 0,
      mountedNodeCount: 1,
      visibleNodeCount: 1,
      culledNodeCount: 0,
      counters: {
        'react-commit': 1
      }
    });
  });

  it('monitors the full pointer operation and records whether it activated', () => {
    const monitor = createCanvasPerfMonitor();
    const sessionRef = { current: undefined as CanvasPerfRuntimeSession | undefined };
    const pointerInteraction = {
      kind: 'move-node' as const,
      pointerId: 43,
      phase: 'pending' as 'pending' | 'active',
      startScreen: { x: 0, y: 0 },
      currentScreen: { x: 0, y: 0 },
      start: { x: 0, y: 0 },
      initialSelection: undefined,
      initialContentInteractionProjectRelativePath: undefined,
      pressedProjectRelativePath: 'flow/a.png',
      additive: false,
      origins: [nodeFixture('flow/a.png', 0, 0)]
    };

    syncCanvasPerfPointerInteractionSessionState({
      perfMonitor: monitor,
      sessionRef,
      pointerInteraction,
      snapshot: { cameraState: 'idle', camera: { x: 0, y: 0, z: 1 } }
    });
    expect(monitor.getTrace().events.filter((event) => event.kind === 'session-start')).toHaveLength(1);
    expect(sessionRef.current?.pointerInteractionActivated).toBe(false);

    syncCanvasPerfPointerInteractionSessionState({
      perfMonitor: monitor,
      sessionRef,
      pointerInteraction: { ...pointerInteraction, phase: 'active', current: { x: 5, y: 0 } },
      snapshot: { cameraState: 'idle', camera: { x: 0, y: 0, z: 1 } }
    });
    syncCanvasPerfPointerInteractionSessionState({
      perfMonitor: monitor,
      sessionRef,
      pointerInteraction: undefined,
      snapshot: { cameraState: 'idle', camera: { x: 0, y: 0, z: 1 } }
    });

    expect(monitor.getLastSession()).toMatchObject({
      type: 'pointer-move-node',
      detail: { activated: true }
    });

    const pendingOnlyInteraction = { ...pointerInteraction, pointerId: 44 };
    syncCanvasPerfPointerInteractionSessionState({
      perfMonitor: monitor,
      sessionRef,
      pointerInteraction: pendingOnlyInteraction,
      snapshot: { cameraState: 'idle', camera: { x: 0, y: 0, z: 1 } }
    });
    syncCanvasPerfPointerInteractionSessionState({
      perfMonitor: monitor,
      sessionRef,
      pointerInteraction: undefined,
      snapshot: { cameraState: 'idle', camera: { x: 0, y: 0, z: 1 } }
    });

    expect(monitor.getLastSession()).toMatchObject({
      type: 'pointer-move-node',
      detail: { activated: false }
    });
  });
});

function surface(
  projection: CanvasProjection,
  input: {
    selection?: CanvasSelection;
    contentInteractionProjectRelativePath?: string;
    camera?: CanvasCamera;
    cutPaths?: readonly string[];
    textFileBuffers?: Parameters<typeof CanvasSurface>[0]['textFileBuffers'];
    canvasFeedback?: CanvasFeedbackDocument;
    feedbackInteraction?: CanvasFeedbackCanvasBinding;
    runtime?: ReturnType<typeof createCanvasEditorRuntime>;
    actions?: Parameters<typeof CanvasSurface>[0]['actions'];
    canvasState?: CanvasState;
    minimapOpen?: boolean;
  } = {}
): React.ReactElement {
  const runtime = input.runtime ?? canvasRuntimeFixture(projection, input);
  if (input.contentInteractionProjectRelativePath !== undefined) {
    runtime.activateContent(input.contentInteractionProjectRelativePath);
  }
  return (
    <I18nProvider locale="en">
      <CanvasSurface
        productPlatform="darwin"
        expandedDirectories={(input.canvasState ?? emptyCanvasState).expandedDirectories}
        projection={projection}
        runtime={runtime}
        actions={input.actions ?? actions}
        textFileBuffers={input.textFileBuffers ?? {}}
        canvasFeedback={input.canvasFeedback}
        feedbackInteraction={input.feedbackInteraction}
        minimapOpen={input.minimapOpen}
        cutPaths={input.cutPaths}
        textPreviewStyleDependencyKey="dark"
      />
    </I18nProvider>
  );
}

async function waitForCanvasSurfaceElement(
  container: ParentNode,
  selector: string
): Promise<Element> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const element = container.querySelector(selector);
    if (element) {
      return element;
    }
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
  throw new Error(`Expected ${selector}.`);
}

function feedbackInteractionFixture(
  overrides: Partial<CanvasFeedbackCanvasBinding> = {}
): CanvasFeedbackCanvasBinding {
  return {
    localMode: undefined,
    composition: undefined,
    localSpatialItems: [],
    suppressedSpatialItemIds: new Set(),
    focusedCapsuleId: undefined,
    getCurrentTargetProjectRelativePath: () => undefined,
    suspendHoverTarget: vi.fn(),
    dismissTarget: vi.fn(),
    handleTargetChange: vi.fn(),
    invalidateTarget: vi.fn(),
    handleDraft: vi.fn(),
    activateCapsule: vi.fn(),
    ...overrides
  };
}

function canvasRuntimeFixture(
  projection: CanvasProjection,
  input: {
    selection?: CanvasSelection;
    camera?: CanvasCamera;
  } = {}
) {
  return createCanvasEditorRuntime({
    initialProjection: projection,
    submitManualLayout: async () => undefined,
    ...(input.camera ? { camera: input.camera } : {}),
    selection: input.selection
  });
}

function pointerEvent(type: string, init: PointerEventInit): PointerEvent {
  return new PointerEvent(type, { bubbles: true, cancelable: true, ...init });
}

function installTextPreviewStyleVariables(): void {
  document.documentElement.style.setProperty('--db-text', '#ffffff');
  document.documentElement.style.setProperty('--db-text-muted', 'rgb(255 255 255 / 72%)');
}

function clearTextPreviewStyleVariables(): void {
  document.documentElement.style.removeProperty('--db-text');
  document.documentElement.style.removeProperty('--db-text-muted');
}

function nodeFixture(path: string, x: number, y: number): CanvasProjection['nodes'][number] {
  return {
    projectRelativePath: path,
    displayName: path,
    nodeKind: 'file',
    mediaKind: 'image',
    x,
    y,
    width: 200,
    height: 120,
    z: 0,
    availability: {
      state: 'available',
      size: 100,
      mimeType: 'image/png',
      canvasImagePreviewable: true,
      canvasImagePreviewSourceWidth: 200,
      fileUrl: `/api/workbench/bindings/123e4567-e89b-42d3-a456-426614174000/files/raw/${path}?v=rev`,
      revision: 'rev'
    }
  };
}

function textProjectionNode(path: string, x: number, y: number, revision: string): CanvasProjection['nodes'][number] {
  return {
    ...nodeFixture(path, x, y),
    mediaKind: 'text',
    textLanguage: 'markdown',
    availability: {
      state: 'available',
      size: 100,
      mimeType: 'text/markdown',
      fileUrl: `/api/workbench/bindings/123e4567-e89b-42d3-a456-426614174000/files/raw/${path}?v=${revision}`,
      revision
    }
  };
}

function videoProjectionNode(path: string, x: number, y: number): CanvasProjection['nodes'][number] {
  return {
    ...nodeFixture(path, x, y),
    mediaKind: 'video',
    width: 640,
    height: 360,
    availability: {
      state: 'available',
      size: 100,
      mimeType: 'video/mp4',
      fileUrl: `/api/workbench/bindings/123e4567-e89b-42d3-a456-426614174000/files/raw/${path}?v=rev`,
      revision: 'rev'
    },
    videoPresentation: {
      kind: 'video',
      width: 640,
      height: 360,
      textTracks: []
    }
  };
}

function audioProjectionNode(path: string, x: number, y: number): CanvasProjection['nodes'][number] {
  return {
    ...nodeFixture(path, x, y),
    mediaKind: 'audio',
    availability: {
      state: 'available',
      size: 100,
      mimeType: 'audio/mpeg',
      fileUrl: `/api/workbench/bindings/123e4567-e89b-42d3-a456-426614174000/files/raw/${path}?v=rev`,
      revision: 'rev'
    }
  };
}

function textBufferFixture(path: string, content: string, revision: string): TextFileBuffer {
  return {
    projectRelativePath: path,
    content,
    language: 'markdown',
    wordWrap: false,
    dirty: false,
    saving: false,
    baseRevision: revision,
    externalChange: false
  };
}

function canvasTextPreviewSourceAvailabilityResponse(input: { sources: Array<{
  projectRelativePath: string;
  targetIdentity: string;
}> }): { sources: Record<string, { projectRelativePath: string; targetIdentity: string; status: 'available' }> } {
  return {
    sources: Object.fromEntries(input.sources.map((item) => [
      item.projectRelativePath,
      {
        projectRelativePath: item.projectRelativePath,
        targetIdentity: item.targetIdentity,
        status: 'available'
      }
    ]))
  };
}

function installCanvasTextBodyMeasurement(size: { width: number; height: number }): () => void {
  const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('canvas-text-body')
        ? size.width
        : widthDescriptor?.get?.call(this) ?? 0;
    }
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('canvas-text-body')
        ? size.height
        : heightDescriptor?.get?.call(this) ?? 0;
    }
  });
  return () => {
    restorePropertyDescriptor(HTMLElement.prototype, 'clientWidth', widthDescriptor);
    restorePropertyDescriptor(HTMLElement.prototype, 'clientHeight', heightDescriptor);
  };
}

function restorePropertyDescriptor(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
  } else {
    delete (target as Record<string, unknown>)[property];
  }
}

function installAnimationFrame(): () => void {
  const previousRequestAnimationFrame = window.requestAnimationFrame;
  const previousCancelAnimationFrame = window.cancelAnimationFrame;
  window.requestAnimationFrame ??= (callback) => window.setTimeout(() => callback(performance.now()), 0);
  window.cancelAnimationFrame ??= (handle) => window.clearTimeout(handle);
  return () => {
    window.requestAnimationFrame = previousRequestAnimationFrame;
    window.cancelAnimationFrame = previousCancelAnimationFrame;
  };
}

async function settleCanvasImageHandoff(): Promise<void> {
  for (let frame = 0; frame < 4; frame += 1) {
    await act(async () => {
      const pending = document.querySelector<HTMLImageElement>(
        'img[data-canvas-raster-preview-layer="pending"]'
      );
      if (pending) {
        Object.defineProperty(pending, 'decode', {
          configurable: true,
          value: async () => undefined
        });
        pending.dispatchEvent(new Event('load'));
      }
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20);
    });
  }
}

function canvasVisibleImagePreviewWidth(container: HTMLElement): string | null {
  const image = container.querySelector<HTMLImageElement>(
    'img[data-canvas-raster-preview-layer="visible"]'
  );
  return image ? new URL(image.src).searchParams.get('w') : null;
}

function largePreviewNodeFixture(path: string): CanvasProjection['nodes'][number] {
  const node = nodeFixture(path, 0, 0);
  if (node.availability.state !== 'available') {
    throw new Error('Expected an available image fixture.');
  }
  return {
    ...node,
    width: 2400,
    height: 1200,
    availability: {
      ...node.availability,
      canvasImagePreviewSourceWidth: 2400
    }
  };
}

function nodeShellProps(node = nodeFixture('flow/cover.png', 0, 0)): CanvasNodeShellProps {
  return {
    node,
    cut: false,
    showResizeHandles: false,
    contentInteractionActive: false,
    zIndex: node.z,
    stageRuntime: createCanvasStageRuntime(),
    actions,
    textBuffer: undefined,
    onResizePointerDown: () => undefined,
    onVideoPlayerMounted: () => undefined,
    onVideoPlayingChange: () => undefined,
    onContentError: () => undefined,
    onContentHandoffConsumed: () => undefined,
    onRegisterVideoTarget: () => undefined,
    onUpdateTextViewport: () => undefined,
    onUpdateVideoPlaybackTime: () => undefined
  };
}

function directoryFixture(path: string, x: number, y: number): CanvasProjection['nodes'][number] {
  return {
    projectRelativePath: path,
    displayName: path,
    nodeKind: 'directory',
    folderDisclosure: path === '' ? 'disclosed' : 'collapsed',
    x,
    y,
    width: 200,
    height: 120,
    z: 0,
    availability: { state: 'directory' }
  };
}

function feedbackDocument(entries: CanvasFeedbackDocument['entries']): CanvasFeedbackDocument {
  return {
    updatedAt: '2026-05-26T12:00:00.000Z',
    entries
  };
}

const actions: WorkbenchActions = {
  resolveCanvasSources: async () => ({ sources: [] }),
  lookupModelArtifactProvenance: async () => {
    throw new Error('not used');
  },
  readProjectTextFile: async () => {
    throw new Error('not used');
  },
  writeProjectTextFile: async () => {
    throw new Error('not used');
  },
  saveCanvasTextPreviewSource: async () => {
    throw new Error('not used');
  },
  readCanvasTextPreviewSources: async () => ({ sources: {} }),
  probeCanvasVideoPreviewSources: async () => ({ sources: {} }),
  ensureCanvasVideoPreviewSource: async () => ({ status: 'failed', message: 'not used' }),
  ensureTextFileBuffer: async () => undefined,
  updateTextFileBuffer: () => undefined,
  saveTextFileBuffer: async () => undefined,
  discardTextFileBuffer: async () => undefined,
  reloadTextFileBuffer: async () => undefined,
  openTextEditorWindow: () => undefined,
  toggleTextFileWordWrap: () => undefined,
  updateCanvasNodeLayouts: async () => undefined,
  resetCanvasNodeLayouts: async () => {
    throw new Error('not used');
  },
  updateCanvasVideoPlaybackState: async () => undefined,
  updateCanvasTextViewportState: async () => undefined,
  setCanvasDirectoryExpanded: async () => undefined,
  raiseCanvasSelection: async () => undefined,
  openProject: async () => undefined
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
