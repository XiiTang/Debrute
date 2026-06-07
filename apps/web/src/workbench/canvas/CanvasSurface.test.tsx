import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createCanvasDocument, type CanvasFeedbackDocument, type CanvasProjection } from '@debrute/canvas-core';
import type { IntegrationSettingsView } from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import { CanvasEditor } from './CanvasEditor';
import { createCanvasImageAssetRuntime, type CanvasImageAssetRuntime } from './CanvasImageAssetRuntime';
import { CanvasImageAssetProvider } from './CanvasImageResourceContext';
import type { CanvasImageNodeRenderState } from './canvasImageLoading';
import { CanvasNodeContent } from './CanvasNodeContent';
import { createCanvasOverlayRuntime } from './CanvasOverlayRuntime';
import { areCanvasNodeShellPropsEqual, CanvasNodeShell, type CanvasNodeShellProps } from './CanvasNodeShell';
import {
  CanvasSurface,
  createCanvasImageAssetViewportSyncScheduler,
  createCanvasRenderSnapshotScheduler,
  recordCanvasPerfFrame,
  shouldUseEfficientImageResourceZoom,
  syncCanvasPerfDragSessionState,
  syncCanvasMovingCameraFrame,
  syncCanvasPerfSessionState,
  syncCanvasImageResourceZoomForCameraState,
  syncCanvasImageAssetViewport,
  type CanvasPerfRuntimeSession
} from './CanvasSurface';
import { createCanvasPerfMonitor, type CanvasPerfTraceEvent } from './CanvasPerfMonitor';
import type { CanvasCamera } from './runtime/canvasCamera';
import { createCanvasStageRuntime } from './runtime/CanvasStageRuntime';
import type { CanvasSelection } from './runtime/canvasSelection';
import { createCanvasEditorRuntime, type CanvasEditorRuntime } from './runtime/CanvasEditorRuntime';

describe('CanvasSurface', () => {
  it('renders an empty Flowmap node state', () => {
    const canvas = createCanvasDocument({ id: 'empty-canvas', title: 'Empty Canvas' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection));

    expect(html).toContain('data-testid="canvas-empty-state"');
    expect(html).toContain('No Flowmap nodes');
  });

  it('renders projected nodes without delete controls', () => {
    const canvas = createCanvasDocument({ id: 'node-canvas', title: 'Node Canvas' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [nodeFixture('image-production/cover.png', 120, 80)],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection, {
      selection: { kind: 'node', projectRelativePath: 'image-production/cover.png' }
    }));

    expect(html).toContain('data-canvas-entity="node"');
    expect(html).toContain('data-canvas-node-path="image-production/cover.png"');
    expect(html).toContain('class="canvas-node-resize nw"');
    expect(html).not.toContain('Delete');
  });

  it('renders only viewport and selected projected nodes', () => {
    const canvas = createCanvasDocument({ id: 'virtual-nodes', title: 'Virtual Nodes' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [
        nodeFixture('flow/visible.png', 0, 0),
        nodeFixture('flow/offscreen.png', 6000, 0),
        nodeFixture('flow/selected.png', 6000, 6000)
      ],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection, {
      selection: { kind: 'node', projectRelativePath: 'flow/selected.png' }
    }));

    expect(html).toContain('data-canvas-node-path="flow/visible.png"');
    expect(html).toContain('data-canvas-node-path="flow/selected.png"');
    expect(html).not.toContain('data-canvas-node-path="flow/offscreen.png"');
  });

  it('keeps camera transforms out of React stage markup', () => {
    const canvas = createCanvasDocument({ id: 'viewport-canvas', title: 'Viewport Canvas' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [nodeFixture('flow/visible.png', 0, 0)],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection, {
      camera: { x: 120, y: 80, z: 0.5 }
    }));

    expect(html).toContain('class="canvas-world-stage"');
    expect(html).not.toContain('transform:translate(120px, 80px) scale(0.5)');
    expect(html).not.toContain('--canvas-zoom:0.5');
  });

  it('does not render offscreen text node content', () => {
    const canvas = createCanvasDocument({ id: 'virtual-text', title: 'Virtual Text' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [
        nodeFixture('flow/visible.png', 0, 0),
        {
          ...nodeFixture('flow/notes/offscreen.md', 6000, 0),
          mediaKind: 'text',
          availability: {
            state: 'available',
            size: 100,
            mimeType: 'text/markdown',
            fileUrl: 'http://127.0.0.1:17321/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/flow/notes/offscreen.md?v=rev-text',
            revision: 'rev-text'
          }
        }
      ],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection, {
      textFileBuffers: {
        'flow/notes/offscreen.md': {
          projectRelativePath: 'flow/notes/offscreen.md',
          content: '# Offscreen\n',
          language: 'markdown',
          wordWrap: false,
          dirty: false,
          saving: false,
          diskRevision: 'rev-text',
          lastSavedRevision: 'rev-text',
          externalChange: false
        }
      }
    }));

    expect(html).not.toContain('data-canvas-node-path="flow/notes/offscreen.md"');
    expect(html).not.toContain('canvas-text-node');
    expect(html).not.toContain('# Offscreen');
  });

  it('renders structure edges when their segments intersect the virtual viewport', () => {
    const canvas = createCanvasDocument({ id: 'edge-canvas', title: 'Edge Canvas' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
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
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection));

    expect(html).toContain('data-canvas-edge-id="edge:both"');
    expect(html).toContain('data-canvas-edge-id="edge:one-endpoint"');
    expect(html).toContain('data-canvas-edge-id="edge:crossing"');
    expect(html).not.toContain('data-canvas-edge-id="edge:outside"');
    expect(html).toContain('<path');
    expect(html).toContain('d="M 200 60 L 250 60 L 250 60 L 300 60"');
    expect(html).not.toContain('<line');
    expect(html).not.toContain('viewBox="-100000 -100000 200000 200000"');
  });

  it('does not render feedback bars inside Canvas node markup', () => {
    const canvas = createCanvasDocument({ id: 'feedback-canvas', title: 'Feedback Canvas' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [nodeFixture('image-production/cover.png', 120, 80)],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection, {
      canvasFeedback: feedbackDocument({
        'image-production/cover.png': {
          projectRelativePath: 'image-production/cover.png',
          marks: ['like', 'needs_revision'],
          note: 'Needs revision',
          updatedAt: '2026-05-26T12:00:00.000Z'
        }
      })
    }));

    expect(html).toContain('data-canvas-node-path="image-production/cover.png"');
    expect(html).not.toContain('class="canvas-feedback-bar"');
    expect(html).not.toContain('aria-label="Needs revision"');
  });

  it('does not render minimap UI inside the Canvas surface layer', () => {
    const canvas = createCanvasDocument({ id: 'minimap-layer-canvas', title: 'Minimap Layer Canvas' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [nodeFixture('flow/visible.png', 0, 0)],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection));

    expect(html).toContain('class="canvas-surface"');
    expect(html).not.toContain('data-testid="canvas-minimap-bar"');
    expect(html).not.toContain('data-testid="canvas-minimap-panel"');
  });

  it('does not render feedback bars for directory or hidden nodes', () => {
    const canvas = createCanvasDocument({ id: 'feedback-exclusions', title: 'Feedback Exclusions' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [
        directoryFixture('image-production', 0, 0),
        { ...nodeFixture('image-production/hidden.png', 240, 0), visible: false }
      ],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection, {
      canvasFeedback: feedbackDocument({})
    }));

    expect(html).not.toContain('class="canvas-feedback-bar"');
  });

  it('does not eagerly render image src attributes before the image asset runtime publishes image state', () => {
    const canvas = createCanvasDocument({ id: 'resource-previews', title: 'Resource Previews' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: Array.from({ length: 16 }, (_item, index) => ({
        ...nodeFixture(`flow/image-${index}.png`, index * 220, 0),
        width: 2400,
        height: 1200
      })),
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection, {
      camera: { x: 0, y: 0, z: 0.1 },
      canvasSettings: { imagePreviewsEnabled: true }
    }));

    expect(html).toContain('data-canvas-node-path="flow/image-0.png"');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('/canvas-image-preview?path=flow%2Fimage-0.png');
    expect(html).not.toContain('/files/raw/flow/image-0.png');
  });

  it('keeps a placeholder visible while the first next image loads', () => {
    const runtime = createCanvasImageAssetRuntime({
      loadImage: () => new Promise(() => undefined)
    });
    const node = nodeFixture('flow/cover.png', 0, 0);
    runtime.setNodes(new Map([[node.projectRelativePath, node]]));
    runtime.setViewport({
      visibleRect: { x: 0, y: 0, width: 400, height: 300 },
      mountedNodePaths: new Set([node.projectRelativePath]),
      culledNodePaths: new Set(),
      imageResourceZoom: 1,
      devicePixelRatio: 1,
      imagePreviewsEnabled: true,
      cameraState: 'idle'
    });

    const html = renderToStaticMarkup(
      <CanvasImageAssetProvider runtime={runtime}>
        <CanvasNodeShell {...nodeShellProps(node)} />
      </CanvasImageAssetProvider>
    );

    expect(html).toContain('class="canvas-node-placeholder"');
    expect(html).toContain('data-canvas-image-layer="next"');
    expect(html).not.toContain('data-canvas-image-layer="visible"');
    expect(html).toContain('flow/cover.png');
  });

  it('keeps the visible image mounted while the next image is loading', () => {
    const html = renderCanvasSurfaceWithImageState({
      kind: 'image',
      visible: { src: '/preview/low.jpg', loadKey: 'low' },
      next: { src: '/preview/high.jpg', loadKey: 'high' },
      retry: () => undefined
    });

    expect(html).toContain('src="/preview/low.jpg"');
    expect(html).toContain('src="/preview/high.jpg"');
    expect(html).toContain('data-canvas-image-layer="visible"');
    expect(html).toContain('data-canvas-image-layer="next"');
  });

  it('waits for Canvas settings before rendering image nodes', () => {
    const canvas = createCanvasDocument({ id: 'settings-loading-canvas', title: 'Settings Loading Canvas' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [{ ...nodeFixture('flow/cover.png', 0, 0), width: 2400, height: 1200 }],
      edges: [],
      diagnostics: []
    };
    const html = renderToStaticMarkup(
      <CanvasEditor
        canvasId={canvas.id}
        state={workbenchStateFixture(canvas, projection, undefined)}
        actions={actions}
        overlayRuntime={createCanvasOverlayRuntime()}
        feedbackPlacementContext={feedbackPlacementContextFixture()}
      />
    );

    expect(html).toContain('data-testid="canvas-settings-loading"');
    expect(html).not.toContain('debrute-canvas-preview://');
    expect(html).not.toContain('debrute-project-file://');
  });

  it('keeps image node shell props equal for unused action object changes but not event handler changes', () => {
    const props = nodeShellProps();

    expect(areCanvasNodeShellPropsEqual(props, {
      ...props,
      actions: { ...props.actions }
    })).toBe(true);

    expect(areCanvasNodeShellPropsEqual(props, {
      ...props,
      onPointerDown: () => undefined,
      onPointerMove: () => undefined,
      onPointerUp: () => undefined,
      onPointerEnter: () => undefined,
      onPointerLeave: () => undefined,
      onSelectNode: () => undefined,
      onContextMenu: () => undefined,
      onResizePointerDown: () => undefined
    })).toBe(false);

    expect(areCanvasNodeShellPropsEqual(props, {
      ...props,
      hovered: true
    })).toBe(false);
  });

  it('syncs image resources from the live runtime viewport instead of the render snapshot viewport', () => {
    const stale = nodeFixture('flow/stale-visible.png', 0, 0);
    const live = nodeFixture('flow/live-visible.png', 500, 0);
    const viewports: unknown[] = [];

    syncCanvasImageAssetViewport({
      imageAssetRuntime: {
        setViewport: (viewport) => viewports.push(viewport)
      },
      editorRuntime: {
        getSnapshot: () => ({ cameraState: 'moving' }) as ReturnType<CanvasEditorRuntime['getSnapshot']>,
        coordinates: {
          visibleCanvasRect: () => ({ x: 350, y: 0, width: 400, height: 300 })
        } as CanvasEditorRuntime['coordinates']
      },
      nodesByPath: new Map([
        [stale.projectRelativePath, stale],
        [live.projectRelativePath, live]
      ]),
      imageResourceZoom: 1,
      devicePixelRatio: 1,
      imagePreviewsEnabled: true
    });

    expect(viewports).toHaveLength(1);
    expect(viewports[0]).toMatchObject({
      visibleRect: { x: 350, y: 0, width: 400, height: 300 },
      imageResourceZoom: 1,
      devicePixelRatio: 1,
      imagePreviewsEnabled: true,
      cameraState: 'moving'
    });
    expect((viewports[0] as { mountedNodePaths: ReadonlySet<string> }).mountedNodePaths).toEqual(new Set([
      'flow/stale-visible.png',
      'flow/live-visible.png'
    ]));
    expect((viewports[0] as { culledNodePaths: ReadonlySet<string> }).culledNodePaths).toEqual(new Set([
      'flow/stale-visible.png'
    ]));
  });

  it('defers moving image resource viewport sync until an animation frame', () => {
    const frames: FrameRequestCallback[] = [];
    const calls: unknown[] = [];
    const scheduler = createCanvasImageAssetViewportSyncScheduler({
      sync: (cameraState) => calls.push(cameraState),
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: () => undefined
    });

    scheduler.request('moving');
    scheduler.request('moving');

    expect(calls).toEqual([]);
    expect(frames).toHaveLength(1);

    frames[0]?.(0);

    expect(calls).toEqual(['moving']);
  });

  it('flushes idle image resource viewport sync immediately and cancels pending moving work', () => {
    const frames: FrameRequestCallback[] = [];
    const canceled: number[] = [];
    const calls: unknown[] = [];
    const scheduler = createCanvasImageAssetViewportSyncScheduler({
      sync: (cameraState) => calls.push(cameraState),
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: (handle) => canceled.push(handle)
    });

    scheduler.request('moving');
    scheduler.flush('idle');
    frames[0]?.(0);

    expect(canceled).toEqual([1]);
    expect(calls).toEqual(['idle']);
  });

  it('clears pending image resource zoom settlement when the camera starts moving', () => {
    const timerRef = { current: 7 };
    const cleared: number[] = [];
    const updates: number[] = [];

    syncCanvasImageResourceZoomForCameraState({
      cameraState: 'moving',
      imagePreviewsEnabled: true,
      useEfficientImageResourceZoom: true,
      currentImageResourceZoom: 1,
      liveCameraZoom: 2,
      timerRef,
      setImageResourceZoom: (zoom) => updates.push(zoom),
      setTimeout: () => {
        throw new Error('moving camera must not schedule image resource zoom work');
      },
      clearTimeout: (handle) => cleared.push(handle)
    });

    expect(cleared).toEqual([7]);
    expect(timerRef.current).toBeUndefined();
    expect(updates).toEqual([]);
  });

  it('keeps image resource zoom stable while a large preview canvas is moving', () => {
    const timerRef = { current: undefined as number | undefined };
    const updates: number[] = [];

    syncCanvasImageResourceZoomForCameraState({
      cameraState: 'moving',
      imagePreviewsEnabled: true,
      useEfficientImageResourceZoom: true,
      currentImageResourceZoom: 1,
      liveCameraZoom: 2,
      timerRef,
      setImageResourceZoom: (zoom) => updates.push(zoom),
      setTimeout: () => {
        throw new Error('moving camera must not schedule image zoom settlement');
      },
      clearTimeout: () => undefined
    });

    expect(updates).toEqual([]);
    expect(timerRef.current).toBeUndefined();
  });

  it('updates image resource zoom immediately for small canvases', () => {
    const timerRef = { current: 11 };
    const cleared: number[] = [];
    const updates: number[] = [];

    syncCanvasImageResourceZoomForCameraState({
      cameraState: 'moving',
      imagePreviewsEnabled: true,
      useEfficientImageResourceZoom: false,
      currentImageResourceZoom: 1,
      liveCameraZoom: 2,
      timerRef,
      setImageResourceZoom: (zoom) => updates.push(zoom),
      setTimeout: () => {
        throw new Error('small canvas must not debounce image resource zoom');
      },
      clearTimeout: (handle) => cleared.push(handle)
    });

    expect(cleared).toEqual([11]);
    expect(timerRef.current).toBeUndefined();
    expect(updates).toEqual([2]);
  });

  it('settles efficient image resource zoom after idle', () => {
    const timerRef = { current: undefined as number | undefined };
    const updates: number[] = [];
    const timers: Array<() => void> = [];

    syncCanvasImageResourceZoomForCameraState({
      cameraState: 'idle',
      imagePreviewsEnabled: true,
      useEfficientImageResourceZoom: true,
      currentImageResourceZoom: 1,
      liveCameraZoom: 2,
      timerRef,
      setImageResourceZoom: (zoom) => updates.push(zoom),
      setTimeout: (callback) => {
        timers.push(callback);
        return 17;
      },
      clearTimeout: () => undefined,
      settleMs: 500
    });

    expect(timerRef.current).toBe(17);
    expect(updates).toEqual([]);

    timers[0]?.();

    expect(timerRef.current).toBeUndefined();
    expect(updates).toEqual([2]);
  });

  it('uses efficient image resource zoom only when previews are enabled and the canvas is large', () => {
    expect(shouldUseEfficientImageResourceZoom({
      imagePreviewsEnabled: true,
      nodeCount: 501
    })).toBe(true);
    expect(shouldUseEfficientImageResourceZoom({
      imagePreviewsEnabled: true,
      nodeCount: 500
    })).toBe(false);
    expect(shouldUseEfficientImageResourceZoom({
      imagePreviewsEnabled: false,
      nodeCount: 1000
    })).toBe(false);
  });

  it('does not schedule idle image resource zoom settlement when zoom is already current', () => {
    const timerRef = { current: 11 };
    const cleared: number[] = [];
    const updates: number[] = [];

    syncCanvasImageResourceZoomForCameraState({
      cameraState: 'idle',
      imagePreviewsEnabled: true,
      useEfficientImageResourceZoom: true,
      currentImageResourceZoom: 1.5,
      liveCameraZoom: 1.5,
      timerRef,
      setImageResourceZoom: (zoom) => updates.push(zoom),
      setTimeout: () => {
        throw new Error('matching resource zoom must not schedule a settle timer');
      },
      clearTimeout: (handle) => cleared.push(handle)
    });

    expect(cleared).toEqual([11]);
    expect(timerRef.current).toBeUndefined();
    expect(updates).toEqual([]);
  });

  it('coalesces moving render snapshot refreshes onto one animation frame', () => {
    const frames: FrameRequestCallback[] = [];
    const commits: unknown[] = [];
    const scheduler = createCanvasRenderSnapshotScheduler({
      commit: (input) => commits.push(input),
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: () => undefined
    });

    scheduler.requestMoving({ camera: { x: 1, y: 0, z: 1 } });
    scheduler.requestMoving({ camera: { x: 2, y: 0, z: 1 } });

    expect(commits).toEqual([]);
    expect(frames).toHaveLength(1);

    frames[0]?.(0);

    expect(commits).toEqual([{ camera: { x: 2, y: 0, z: 1 } }]);
  });

  it('flushes idle render snapshot refreshes immediately and cancels pending moving refreshes', () => {
    const frames: FrameRequestCallback[] = [];
    const canceled: number[] = [];
    const commits: unknown[] = [];
    const scheduler = createCanvasRenderSnapshotScheduler({
      commit: (input) => commits.push(input),
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: (handle) => canceled.push(handle)
    });

    scheduler.requestMoving({ camera: { x: 1, y: 0, z: 1 } });
    scheduler.flush({ camera: { x: 5, y: 0, z: 1 } });
    frames[0]?.(0);

    expect(canceled).toEqual([1]);
    expect(commits).toEqual([{ camera: { x: 5, y: 0, z: 1 } }]);
  });

  it('coalesces moving image viewport sync separately from render refreshes', () => {
    const renderFrames: FrameRequestCallback[] = [];
    const renderCommits: unknown[] = [];
    const imageFrames: FrameRequestCallback[] = [];
    const imageCalls: unknown[] = [];
    const renderScheduler = createCanvasRenderSnapshotScheduler({
      commit: (input) => renderCommits.push(input),
      requestFrame: (callback) => {
        renderFrames.push(callback);
        return renderFrames.length;
      },
      cancelFrame: () => undefined
    });
    const imageScheduler = createCanvasImageAssetViewportSyncScheduler({
      sync: (cameraState) => imageCalls.push(cameraState),
      requestFrame: (callback) => {
        imageFrames.push(callback);
        return imageFrames.length;
      },
      cancelFrame: () => undefined
    });

    renderScheduler.requestMoving({ cameraState: 'moving' });
    imageScheduler.request('moving');

    expect(renderCommits).toEqual([]);
    expect(imageCalls).toEqual([]);
    expect(renderFrames).toHaveLength(1);
    expect(imageFrames).toHaveLength(1);

    renderFrames[0]?.(0);
    imageFrames[0]?.(0);

    expect(renderCommits).toEqual([{ cameraState: 'moving' }]);
    expect(imageCalls).toEqual(['moving']);
  });

  it('keeps moving camera sync visibility work out of the live camera callback and queues image viewport sync', () => {
    const cameras: unknown[] = [];
    const renderInputs: unknown[] = [];
    const imageCameraStates: unknown[] = [];

    syncCanvasMovingCameraFrame({
      liveCamera: { x: -350, y: 0, z: 1 },
      stageRuntime: {
        setCamera: (camera) => cameras.push(camera)
      },
      runtime: {
        getSnapshot: () => ({ cameraState: 'moving' }) as ReturnType<CanvasEditorRuntime['getSnapshot']>
      },
      surfaceSize: { width: 400, height: 300 },
      selection: { kind: 'node', projectRelativePath: 'flow/live-visible.png' },
      activeNodePaths: ['flow/live-visible.png'],
      renderSnapshotScheduler: {
        requestMoving: (input) => renderInputs.push(input)
      },
      imageAssetViewportScheduler: {
        request: (cameraState) => imageCameraStates.push(cameraState)
      },
      syncImageResourceZoom: () => undefined
    });

    expect(cameras).toEqual([{ x: -350, y: 0, z: 1 }]);
    expect(imageCameraStates).toEqual(['moving']);
    expect(renderInputs).toEqual([{
      camera: { x: -350, y: 0, z: 1 },
      cameraState: 'moving',
      surfaceSize: { width: 400, height: 300 },
      selection: { kind: 'node', projectRelativePath: 'flow/live-visible.png' },
      activeNodePaths: ['flow/live-visible.png']
    }]);
  });

  it('passes the live moving snapshot to image resource zoom sync', () => {
    const zoomSnapshots: unknown[] = [];

    syncCanvasMovingCameraFrame({
      liveCamera: { x: 0, y: 0, z: 2 },
      stageRuntime: {
        setCamera: () => undefined
      },
      runtime: {
        getSnapshot: () => ({
          cameraState: 'moving',
          camera: { x: 0, y: 0, z: 2 },
          imageResourceZoom: 1
        }) as ReturnType<CanvasEditorRuntime['getSnapshot']>
      },
      surfaceSize: { width: 400, height: 300 },
      selection: undefined,
      activeNodePaths: [],
      renderSnapshotScheduler: {
        requestMoving: () => undefined
      },
      imageAssetViewportScheduler: {
        request: () => undefined
      },
      syncImageResourceZoom: (snapshot) => zoomSnapshots.push({
        cameraState: snapshot.cameraState,
        camera: snapshot.camera,
        imageResourceZoom: snapshot.imageResourceZoom
      })
    });

    expect(zoomSnapshots).toEqual([{
      cameraState: 'moving',
      camera: { x: 0, y: 0, z: 2 },
      imageResourceZoom: 1
    }]);
  });

  it('records render and image scheduler counters separately', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const renderFrames: FrameRequestCallback[] = [];
    const imageFrames: FrameRequestCallback[] = [];
    const renderScheduler = createCanvasRenderSnapshotScheduler({
      perfMonitor: monitor,
      commit: () => undefined,
      requestFrame: (callback) => {
        renderFrames.push(callback);
        return renderFrames.length;
      },
      cancelFrame: () => undefined
    });
    const imageScheduler = createCanvasImageAssetViewportSyncScheduler({
      perfMonitor: monitor,
      sync: () => undefined,
      requestFrame: (callback) => {
        imageFrames.push(callback);
        return imageFrames.length;
      },
      cancelFrame: () => undefined
    });

    renderScheduler.requestMoving({ cameraState: 'moving' });
    renderScheduler.requestMoving({ cameraState: 'moving' });
    imageScheduler.request('moving');
    imageScheduler.request('moving');
    renderFrames[0]?.(0);
    imageFrames[0]?.(0);
    renderScheduler.flush({ cameraState: 'idle' });
    imageScheduler.flush('idle');

    expect(counterNames(monitor.getTrace().events)).toEqual([
      'render-moving-queued',
      'image-moving-queued',
      'render-idle-flush',
      'image-idle-flush'
    ]);
  });

  it('starts, frames, and ends a camera session from camera state changes', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const sessionRef = { current: undefined as CanvasPerfRuntimeSession | undefined };
    const reactCommitCountRef = { current: 0 };

    syncCanvasPerfSessionState({
      enabled: true,
      perfMonitor: monitor,
      sessionRef,
      reactCommitCountRef,
      snapshot: { cameraState: 'moving', camera: { x: 0, y: 0, z: 1 } },
      minimapOpen: false
    });
    monitor.recordCounter({ timestamp: 5, source: 'CanvasRenderCoordinator', name: 'render-snapshot-build' });
    monitor.recordCounter({ timestamp: 6, source: 'CanvasRenderCoordinator', name: 'render-snapshot-reuse' });
    monitor.recordCounter({ timestamp: 7, source: 'CanvasStageRuntime', name: 'stage-camera-write' });
    monitor.recordCounter({ timestamp: 8, source: 'CanvasImageAssetRuntime', name: 'image-plan-rebuild' });
    reactCommitCountRef.current = 1;
    recordCanvasPerfFrame({
      enabled: true,
      perfMonitor: monitor,
      sessionRef,
      cameraState: 'moving',
      renderSnapshot: {
        nodesByPath: new Map([
          ['flow/a.png', nodeFixture('flow/a.png', 0, 0)],
          ['flow/b.png', nodeFixture('flow/b.png', 5000, 0)]
        ]),
        culledNodePaths: new Set(['flow/b.png']),
        visibleRect: { x: 0, y: 0, width: 400, height: 300 },
        virtualRect: { x: -768, y: -768, width: 1936, height: 1836 },
        nodeLayers: new Map(),
        edges: [],
        svgBounds: { x: 0, y: 0, width: 400, height: 300 },
        svgViewBox: '0 0 400 300'
      },
      imageAssetRuntime: { stats: () => ({ activeLoadCount: 1, pendingImageCount: 2, decodedImageCount: 3 }) },
      reactCommitCountRef
    });
    syncCanvasPerfSessionState({
      enabled: true,
      perfMonitor: monitor,
      sessionRef,
      reactCommitCountRef,
      snapshot: { cameraState: 'idle', camera: { x: 0, y: 0, z: 1 } },
      minimapOpen: false
    });

    expect(monitor.getLastSession()).toMatchObject({
      type: 'camera-pan',
      frameCount: 1,
      mountedNodeCount: 2,
      visibleNodeCount: 1,
      culledNodeCount: 1,
      activeImageLoadCount: 1,
      pendingImageCount: 2,
      decodedImageCount: 3
    });
    expect(monitor.getTrace().events.find((event) => event.kind === 'frame')).toMatchObject({
      kind: 'frame',
      renderSnapshotBuildCount: 1,
      renderSnapshotReuseCount: 1,
      stageWriteCount: 1,
      imageRuntimeWorkCount: 1
    });
  });

  it('records moving camera frames without image runtime work when image viewport sync is unchanged', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const sessionRef = { current: undefined as CanvasPerfRuntimeSession | undefined };
    const reactCommitCountRef = { current: 0 };

    syncCanvasPerfSessionState({
      enabled: true,
      perfMonitor: monitor,
      sessionRef,
      reactCommitCountRef,
      snapshot: {
        cameraState: 'moving',
        camera: { x: 0, y: 0, z: 1 }
      },
      minimapOpen: false
    });
    recordCanvasPerfFrame({
      enabled: true,
      perfMonitor: monitor,
      sessionRef,
      cameraState: 'moving',
      renderSnapshot: {
        nodesByPath: new Map([
          ['flow/a.png', nodeFixture('flow/a.png', 0, 0)]
        ]),
        culledNodePaths: new Set(),
        visibleRect: { x: 0, y: 0, width: 400, height: 300 },
        virtualRect: { x: -100, y: -100, width: 600, height: 500 },
        nodeLayers: new Map(),
        edges: [],
        svgBounds: { x: 0, y: 0, width: 1, height: 1 },
        svgViewBox: '0 0 1 1'
      },
      imageAssetRuntime: {
        stats: () => ({
          activeLoadCount: 0,
          pendingImageCount: 0,
          decodedImageCount: 1
        })
      },
      reactCommitCountRef
    });

    expect(monitor.getTrace().events.find((event) => event.kind === 'frame')).toMatchObject({
      kind: 'frame',
      cameraState: 'moving',
      reactCommitCount: 0,
      renderSnapshotBuildCount: 0,
      imageRuntimeWorkCount: 0
    });
  });

  it('does not count moving image viewport queue signals as image runtime work', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const sessionRef = { current: undefined as CanvasPerfRuntimeSession | undefined };
    const reactCommitCountRef = { current: 0 };

    syncCanvasPerfSessionState({
      enabled: true,
      perfMonitor: monitor,
      sessionRef,
      reactCommitCountRef,
      snapshot: {
        cameraState: 'moving',
        camera: { x: 0, y: 0, z: 1 }
      },
      minimapOpen: false
    });
    monitor.recordCounter({
      timestamp: 5,
      source: 'CanvasImageAssetViewportScheduler',
      name: 'image-moving-queued'
    });
    recordCanvasPerfFrame({
      enabled: true,
      perfMonitor: monitor,
      sessionRef,
      cameraState: 'moving',
      renderSnapshot: {
        nodesByPath: new Map([
          ['flow/a.png', nodeFixture('flow/a.png', 0, 0)]
        ]),
        culledNodePaths: new Set(),
        visibleRect: { x: 0, y: 0, width: 400, height: 300 },
        virtualRect: { x: -100, y: -100, width: 600, height: 500 },
        nodeLayers: new Map(),
        edges: [],
        svgBounds: { x: 0, y: 0, width: 1, height: 1 },
        svgViewBox: '0 0 1 1'
      },
      imageAssetRuntime: {
        stats: () => ({
          activeLoadCount: 0,
          pendingImageCount: 0,
          decodedImageCount: 1
        })
      },
      reactCommitCountRef
    });

    expect(monitor.getTrace().events.find((event) => event.kind === 'frame')).toMatchObject({
      kind: 'frame',
      imageRuntimeWorkCount: 0
    });
  });

  it('starts, frames, and ends a drag session with stage counters', () => {
    const monitor = createCanvasPerfMonitor({ enabled: true });
    const sessionRef = { current: undefined as CanvasPerfRuntimeSession | undefined };
    const reactCommitCountRef = { current: 0 };
    const activeNode = nodeFixture('flow/a.png', 0, 0);

    syncCanvasPerfDragSessionState({
      enabled: true,
      perfMonitor: monitor,
      sessionRef,
      reactCommitCountRef,
      dragState: {
        kind: 'move-node',
        pointerId: 42,
        start: { x: 0, y: 0 },
        current: { x: 12, y: 8 },
        origins: [activeNode]
      },
      snapshot: { cameraState: 'idle', camera: { x: 0, y: 0, z: 1 } }
    });
    monitor.recordCounter({
      timestamp: 10,
      source: 'CanvasStageRuntime',
      name: 'stage-drag-preview-write'
    });
    reactCommitCountRef.current = 1;
    recordCanvasPerfFrame({
      enabled: true,
      perfMonitor: monitor,
      sessionRef,
      cameraState: 'idle',
      renderSnapshot: {
        nodesByPath: new Map([[activeNode.projectRelativePath, activeNode]]),
        culledNodePaths: new Set(),
        visibleRect: { x: 0, y: 0, width: 400, height: 300 },
        virtualRect: { x: -768, y: -768, width: 1936, height: 1836 },
        nodeLayers: new Map(),
        edges: [],
        svgBounds: { x: 0, y: 0, width: 400, height: 300 },
        svgViewBox: '0 0 400 300'
      },
      imageAssetRuntime: { stats: () => ({ activeLoadCount: 0, pendingImageCount: 0, decodedImageCount: 1 }) },
      reactCommitCountRef
    });
    syncCanvasPerfDragSessionState({
      enabled: true,
      perfMonitor: monitor,
      sessionRef,
      reactCommitCountRef,
      dragState: undefined,
      snapshot: { cameraState: 'idle', camera: { x: 0, y: 0, z: 1 } }
    });

    expect(monitor.getLastSession()).toMatchObject({
      type: 'drag-move-node',
      frameCount: 1,
      mountedNodeCount: 1,
      visibleNodeCount: 1,
      culledNodeCount: 0,
      decodedImageCount: 1,
      counters: {
        'stage-drag-preview-write': 1,
        'react-commit': 1
      }
    });
    expect(monitor.getTrace().events.find((event) => event.kind === 'frame')).toMatchObject({
      kind: 'frame',
      cameraState: 'idle'
    });
  });
});

function counterNames(events: readonly CanvasPerfTraceEvent[]): string[] {
  return events
    .filter((event) => event.kind === 'counter')
    .map((event) => event.name);
}

function surface(
  canvas: ReturnType<typeof createCanvasDocument>,
  projection: CanvasProjection,
  input: {
    selection?: CanvasSelection;
    camera?: CanvasCamera;
    textFileBuffers?: Parameters<typeof CanvasSurface>[0]['textFileBuffers'];
    canvasFeedback?: CanvasFeedbackDocument;
    canvasSettings?: Parameters<typeof CanvasSurface>[0]['canvasSettings'];
  } = {}
): React.ReactElement {
  const runtime = createCanvasEditorRuntime({
    ...(input.camera ? { camera: input.camera } : {}),
    selection: input.selection
  });
  return (
    <CanvasSurface
      canvas={canvas}
      projection={projection}
      runtime={runtime}
      actions={actions}
      textFileBuffers={input.textFileBuffers ?? {}}
      canvasFeedback={input.canvasFeedback}
      canvasSettings={input.canvasSettings ?? { imagePreviewsEnabled: true }}
      imageAssetRuntime={createCanvasImageAssetRuntime()}
      overlayRuntime={createCanvasOverlayRuntime()}
      feedbackPlacementContext={feedbackPlacementContextFixture()}
    />
  );
}

function feedbackPlacementContextFixture(): Parameters<typeof CanvasSurface>[0]['feedbackPlacementContext'] {
  return {
    viewportRect: { x: 0, y: 0, width: 1280, height: 720 },
    reservedRects: []
  };
}

function renderCanvasSurfaceWithImageState(imageState: CanvasImageNodeRenderState): string {
  const runtime = {
    setNodes: () => undefined,
    setViewport: () => undefined,
    getNodeState: () => imageState,
    subscribeNode: () => () => undefined,
    resolvePending: () => undefined,
    rejectPending: () => undefined,
    retry: () => undefined,
    stats: () => ({ activeLoadCount: 0, pendingImageCount: 0, decodedImageCount: 0 }),
    dispose: () => undefined
  } satisfies CanvasImageAssetRuntime;

  return renderToStaticMarkup(
    <CanvasImageAssetProvider runtime={runtime}>
      <CanvasNodeContent
        node={nodeFixture('flow/a.png', 0, 0)}
        selected={false}
        actions={actions}
        textBuffer={undefined}
        onSelectNode={() => undefined}
        onTitlePointerDown={() => undefined}
        onTitlePointerMove={() => undefined}
        onTitlePointerUp={() => undefined}
      />
    </CanvasImageAssetProvider>
  );
}

function nodeFixture(path: string, x: number, y: number): CanvasProjection['nodes'][number] {
  return {
    projectRelativePath: path,
    nodeKind: 'file',
    mediaKind: 'image',
    x,
    y,
    width: 200,
    height: 120,
    z: 0,
    visible: true,
    locked: false,
    availability: {
      state: 'available',
      size: 100,
      mimeType: 'image/png',
      canvasImagePreviewable: true,
      canvasImagePreviewSourceWidth: 200,
      fileUrl: `http://127.0.0.1:17321/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/${path}?v=rev`,
      revision: 'rev'
    }
  };
}

function nodeShellProps(node = nodeFixture('flow/cover.png', 0, 0)): CanvasNodeShellProps {
  return {
    node,
    selected: false,
    hovered: false,
    zIndex: node.z,
    stageRuntime: createCanvasStageRuntime(),
    actions,
    textBuffer: undefined,
    onPointerDown: () => undefined,
    onPointerMove: () => undefined,
    onPointerUp: () => undefined,
    onPointerEnter: () => undefined,
    onPointerLeave: () => undefined,
    onSelectNode: () => undefined,
    onContextMenu: () => undefined,
    onResizePointerDown: () => undefined
  };
}

function directoryFixture(path: string, x: number, y: number): CanvasProjection['nodes'][number] {
  return {
    projectRelativePath: path,
    nodeKind: 'directory',
    x,
    y,
    width: 200,
    height: 120,
    z: 0,
    visible: true,
    locked: false,
    availability: {
      state: 'available',
      size: 0,
      mimeType: 'inode/directory',
      fileUrl: '',
      revision: 'rev'
    }
  };
}

function feedbackDocument(entries: CanvasFeedbackDocument['entries']): CanvasFeedbackDocument {
  return {
    schemaVersion: 1,
    updatedAt: '2026-05-26T12:00:00.000Z',
    entries
  };
}

function workbenchStateFixture(
  canvas: ReturnType<typeof createCanvasDocument>,
  projection: CanvasProjection,
  canvasSettings: WorkbenchState['canvasSettings']
): WorkbenchState {
	  return {
	    snapshot: {
	      metadata: {
        schemaVersion: 1,
        project: {
          id: 'project',
          name: 'Project',
          createdAt: '2026-05-26T00:00:00.000Z',
          updatedAt: '2026-05-26T00:00:00.000Z'
        }
      },
      files: [],
      canvases: [canvas],
      projections: [projection],
      diagnostics: [],
      health: {
        projectName: 'Project',
        canvasCount: 1,
        diagnosticCounts: { errors: 0, warnings: 0, infos: 0 },
        runtimeDataLocation: '/runtime',
        checkedAt: '2026-05-26T00:00:00.000Z'
      }
    },
    explorerSelection: undefined,
    llmSettings: undefined,
    imageModelSettings: undefined,
    videoModelSettings: undefined,
    integrationsSettings: undefined,
    canvasSettings,
	    canvasFeedback: undefined,
	    textFileBuffers: {},
	    textEditorWindows: {},
	    notifications: []
	  };
	}

const actions: WorkbenchActions = {
  selectExplorerPath: () => undefined,
  saveLlmProviderSetting: async () => undefined,
  deleteLlmProviderSetting: async () => undefined,
  setDefaultLlmModelKey: async () => undefined,
  discoverLlmProviderModels: async () => ({ endpoint: '', models: [], modelsCount: 0, supportsDiscovery: false }),
  saveImageModelSetting: async () => undefined,
  saveVideoModelSetting: async () => undefined,
  rescanIntegrations: async () => emptyIntegrationsSettings,
  lookupGeneratedAssetMetadata: async () => {
    throw new Error('not used');
  },
  readGeneratedAsset: async () => {
    throw new Error('not used');
  },
  readProjectTextFile: async () => {
    throw new Error('not used');
  },
  writeProjectTextFile: async () => {
    throw new Error('not used');
  },
  createProjectFile: async () => {
    throw new Error('not used');
  },
  createProjectDirectory: async () => {
    throw new Error('not used');
  },
  renameProjectPath: async () => {
    throw new Error('not used');
  },
  copyProjectPath: async () => {
    throw new Error('not used');
  },
  moveProjectPath: async () => {
    throw new Error('not used');
  },
  copyProjectAbsolutePath: async () => {
    throw new Error('not used');
  },
  trashProjectPath: async () => {
    throw new Error('not used');
  },
  deleteProjectPathPermanently: async () => {
    throw new Error('not used');
  },
  revealProjectPathInSystemFileManager: async () => {
    throw new Error('not used');
  },
  ensureTextFileBuffer: async () => undefined,
  updateTextFileBuffer: () => undefined,
  saveTextFileBuffer: async () => undefined,
  reloadTextFileBuffer: async () => undefined,
  openTextEditorWindow: () => undefined,
  toggleTextFileWordWrap: () => undefined,
  updateCanvasNodeLayouts: async () => undefined,
  updateCanvasNodeLayers: async () => undefined,
	  updateCanvasFeedbackEntry: async () => undefined,
	  saveCanvasSettings: async () => undefined,
	  openProject: async () => undefined
	};

const emptyIntegrationsSettings: IntegrationSettingsView = {
  integrations: [],
  backends: []
};
