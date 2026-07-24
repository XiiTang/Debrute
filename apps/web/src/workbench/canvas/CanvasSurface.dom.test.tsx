import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CanvasDocument,
  type CanvasFeedbackDocument,
  type CanvasProjection
} from '@debrute/canvas-core';
import { buildWorkbenchTitleBarState } from '../shell/workbenchTitleBarState';
import type { TextFileBuffer, WorkbenchActions, WorkbenchState } from '../../types';
import { CanvasEditor } from './CanvasEditor';
import { preloadCanvasImageForHandoff, scheduleCanvasImageHandoffAfterPaint } from './CanvasMediaHandoff';
import { createCanvasOverlayRuntime } from './CanvasOverlayRuntime';
import { createCanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import { areCanvasNodeShellPropsEqual, type CanvasNodeShellProps } from './CanvasNodeShell';
import {
  CanvasSurface
} from './CanvasSurface';
import {
  canvasActiveVideoPaths,
  canvasFeedbackBarTargetForProjectedNode,
  isCanvasMapProjectTreeDragOver,
  canvasMapProjectTreeDropEntry,
  canvasMapProjectTreeDropInput,
  createCanvasRenderSnapshotScheduler,
  recordCanvasPerfFrame,
  syncCanvasPerfDragSessionState,
  syncCanvasMovingCameraFrame,
  syncCanvasPerfSessionState,
  syncCanvasPreviewResourceSchedulerForInteraction,
  shouldClearFeedbackBarPlacementForFeedbackTarget,
  type CanvasPerfRuntimeSession
} from './canvasSurfaceSupport';
import { createCanvasPerfMonitor, type CanvasPerfTraceEvent } from './CanvasPerfMonitor';
import { CANVAS_CAMERA_IDLE_MS, type CanvasCamera } from './runtime/canvasCamera';
import { createCanvasStageRuntime } from './runtime/CanvasStageRuntime';
import type { CanvasSelection } from './runtime/canvasSelection';
import { createCanvasEditorRuntime } from './runtime/CanvasEditorRuntime';
import { I18nProvider } from '../i18n';

const {
  videoTogglePlaybackSpy,
  videoPauseAtSpy,
  videoRestorePersistedTimeSpy,
  videoReadCurrentTimeSecondsSpy,
  videoMockState
} = vi.hoisted(() => ({
  videoTogglePlaybackSpy: vi.fn(),
  videoPauseAtSpy: vi.fn(),
  videoRestorePersistedTimeSpy: vi.fn(),
  videoReadCurrentTimeSecondsSpy: vi.fn(() => 4.25),
  videoMockState: {
    registerOnMount: true,
    lastPath: undefined as string | undefined,
    lastRegister: undefined as undefined | ((projectRelativePath: string, target: unknown | undefined) => void),
    lastUpdatePlaybackTime: undefined as undefined | ((projectRelativePath: string, currentTimeSeconds: number) => void | Promise<void>)
  }
}));

function createCanvasDocument(input: { id: string }): CanvasDocument {
  return {
    id: input.id,
    name: input.id,
    nodeElements: [],
    annotations: [],
    preferences: { showDiagnostics: true }
  };
}

vi.mock('./CanvasVideoNodeContent', async () => {
  const ReactModule = await import('react');
  return {
    CanvasVideoNodeContent: ({ node, onRegisterVideoTarget, onUpdatePlaybackTime }: {
      node: CanvasProjection['nodes'][number];
      onRegisterVideoTarget: (projectRelativePath: string, target: {
        togglePlayback: () => void;
        seekBy: (seconds: number) => void;
        toggleMuted: () => void;
        adjustPlaybackRate: (delta: number) => void;
        toggleCaptions: () => void;
        enterFullscreen: () => void;
        togglePictureInPicture: () => void;
        readCurrentTimeSeconds: () => number | undefined;
        pauseAt: (seconds: number) => void;
        restorePersistedTime: (seconds: number) => void;
      } | undefined) => void;
      onUpdatePlaybackTime: (projectRelativePath: string, currentTimeSeconds: number) => void | Promise<void>;
    }) => {
      ReactModule.useEffect(() => {
        const target = {
          togglePlayback: videoTogglePlaybackSpy,
          seekBy: vi.fn(),
          toggleMuted: vi.fn(),
          adjustPlaybackRate: vi.fn(),
          toggleCaptions: vi.fn(),
          enterFullscreen: vi.fn(),
          togglePictureInPicture: vi.fn(),
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
      return <div data-testid="mock-video-node">{node.projectRelativePath}</div>;
    }
  };
});

describe('CanvasSurface', () => {
  beforeEach(() => {
    installTextPreviewStyleVariables();
    videoRestorePersistedTimeSpy.mockReset();
    videoMockState.lastUpdatePlaybackTime = undefined;
  });

  afterEach(() => {
    clearTextPreviewStyleVariables();
  });

  it('renders an empty Canvas Map node state', () => {
    const canvas = createCanvasDocument({ id: 'empty-canvas' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection));

    expect(html).toContain('data-testid="canvas-empty-state"');
    expect(html).toContain('No Canvas Map nodes');
  });

  it('accepts exactly one project tree entry for Canvas Map drops', () => {
    expect(canvasMapProjectTreeDropEntry(projectTreeDragDataTransfer([
      { kind: 'file', projectRelativePath: 'outputs/gpt/cover.png' }
    ]))?.projectRelativePath).toBe('outputs/gpt/cover.png');
    expect(canvasMapProjectTreeDropEntry(projectTreeDragDataTransfer([]))).toBeUndefined();
    expect(canvasMapProjectTreeDropEntry(projectTreeDragDataTransfer([
      { kind: 'file', projectRelativePath: 'outputs/gpt/a.png' },
      { kind: 'file', projectRelativePath: 'outputs/gpt/b.png' }
    ]))).toBeUndefined();
  });

  it('builds Canvas Map drop input without drop coordinates', () => {
    expect(canvasMapProjectTreeDropInput('canvas-1', projectTreeDragDataTransfer([
      { kind: 'file', projectRelativePath: 'outputs/gpt/cover.png' }
    ]))).toEqual({
      canvasId: 'canvas-1',
      projectRelativePath: 'outputs/gpt/cover.png'
    });
    expect(canvasMapProjectTreeDropInput('canvas-1', projectTreeDragDataTransfer([
      { kind: 'file', projectRelativePath: 'outputs/gpt/a.png' },
      { kind: 'file', projectRelativePath: 'outputs/gpt/b.png' }
    ]))).toBeUndefined();
  });

  it('accepts Canvas Map dragover from project tree MIME without reading drag payload', () => {
    const dataTransfer = {
      types: ['application/x-debrute-project-tree-paths'],
      getData: vi.fn(() => '')
    };

    expect(isCanvasMapProjectTreeDragOver(dataTransfer)).toBe(true);
    expect(dataTransfer.getData).not.toHaveBeenCalled();
  });

  it('renders projected nodes without delete controls', () => {
    const canvas = createCanvasDocument({ id: 'node-canvas' });
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
    expect(html).toContain('db-canvas-node-frame');
    expect(html).toContain('class="canvas-node-resize nw"');
    expect(html).not.toContain('Delete');
  });

  it('uses the fixed Canvas presentation for unavailable image text without scaling available image pixels', () => {
    const canvas = createCanvasDocument({ id: 'image-availability-presentation' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [
        nodeFixture('flow/available.png', 0, 0),
        {
          ...nodeFixture('flow/unavailable.jpg', 240, 0),
          availability: {
            state: 'unreadable',
            message: 'Unable to read image metadata.'
          }
        }
      ],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection));
    const availableMarkup = html.slice(
      html.indexOf('data-canvas-node-path="flow/available.png"'),
      html.indexOf('data-canvas-node-path="flow/unavailable.jpg"')
    );
    const unavailableMarkup = html.slice(html.indexOf('data-canvas-node-path="flow/unavailable.jpg"'));

    expect(availableMarkup).not.toContain('fixed-presentation');
    expect(availableMarkup).not.toContain('canvas-node-presentation');
    expect(unavailableMarkup).toContain('fixed-presentation');
    expect(unavailableMarkup).toContain('canvas-node-presentation');
    expect(unavailableMarkup).toContain('Unable to read image metadata.');
  });

  it('keeps image and text nodes mounted while still virtualizing other offscreen nodes', () => {
    const canvas = createCanvasDocument({ id: 'virtual-nodes' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
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
            fileUrl: '/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/flow/offscreen.txt?v=rev-text',
            revision: 'rev-text'
          }
        },
        directoryFixture('flow/offscreen-dir', 9000, 0)
      ],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection, {
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
    expect(html).not.toContain('data-canvas-node-path="flow/offscreen-dir"');
  });

  it('keeps camera transforms out of React stage markup', () => {
    const canvas = createCanvasDocument({ id: 'viewport-canvas' });
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

  it('retains offscreen text node content so camera movement does not create it later', () => {
    const canvas = createCanvasDocument({ id: 'retained-text' });
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
            fileUrl: '/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/flow/notes/offscreen.md?v=rev-text',
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
          baseRevision: 'rev-text',
          externalChange: false
        }
      }
    }));

    expect(html).toContain('data-canvas-node-path="flow/notes/offscreen.md"');
    expect(html).toContain('canvas-text-node');
    expect(html).toContain('canvas-text-preview-empty');
    expect(html).not.toContain('data-editor-mode="edit"');
    expect(html).not.toContain(`data-editor-mode="${'pre'}${'view'}"`);
  });

  it('renders visible canvas text nodes as inactive preview bodies by default', () => {
    const canvas = createCanvasDocument({ id: 'text-editor-canvas' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [
        textProjectionNode('flow/a.md', 0, 0, 'rev-a'),
        textProjectionNode('flow/b.md', 300, 0, 'rev-b')
      ],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection, {
      textFileBuffers: {
        'flow/a.md': textBufferFixture('flow/a.md', '# A', 'rev-a'),
        'flow/b.md': textBufferFixture('flow/b.md', '# B', 'rev-b')
      }
    }));

    expect(html.match(/data-editor-mode="edit"/g) ?? []).toHaveLength(0);
    expect(html.match(/canvas-text-preview-empty/g) ?? []).toHaveLength(2);
    expect(html).not.toContain(`data-editor-mode="${'pre'}${'view'}"`);
  });

  it('renders selected text nodes as live editors and leaves inactive text as preview bodies', () => {
    const canvas = createCanvasDocument({ id: 'selected-text-canvas' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [
        textProjectionNode('flow/selected.md', 0, 0, 'rev-selected'),
        textProjectionNode('flow/inactive.md', 300, 0, 'rev-inactive')
      ],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection, {
      selection: { kind: 'node', projectRelativePath: 'flow/selected.md' },
      textFileBuffers: {
        'flow/selected.md': textBufferFixture('flow/selected.md', '# Selected', 'rev-selected'),
        'flow/inactive.md': textBufferFixture('flow/inactive.md', '# Inactive', 'rev-inactive')
      }
    }));

    expect(html.match(/data-editor-mode="edit"/g) ?? []).toHaveLength(1);
    expect(html.match(/canvas-text-preview-empty/g) ?? []).toHaveLength(1);
    expect(html).not.toContain(`data-editor-mode="${'pre'}${'view'}"`);
  });

  it('renders every text node as a preview when text nodes are multi-selected', () => {
    const canvas = createCanvasDocument({ id: 'multi-selected-text-canvas' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [
        textProjectionNode('flow/a.md', 0, 0, 'rev-a'),
        textProjectionNode('flow/b.md', 300, 0, 'rev-b')
      ],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection, {
      selection: {
        kind: 'multi',
        items: [
          { kind: 'node', projectRelativePath: 'flow/a.md' },
          { kind: 'node', projectRelativePath: 'flow/b.md' }
        ]
      },
      textFileBuffers: {
        'flow/a.md': textBufferFixture('flow/a.md', '# A', 'rev-a'),
        'flow/b.md': textBufferFixture('flow/b.md', '# B', 'rev-b')
      }
    }));

    expect(html.match(/data-editor-mode="edit"/g) ?? []).toHaveLength(0);
    expect(html.match(/canvas-text-preview-empty/g) ?? []).toHaveLength(2);
    expect(html.match(/canvas-node-shell[^\"]*selected/g) ?? []).toHaveLength(2);
  });

  it('routes video shortcuts to the selected video node only', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const canvas = createCanvasDocument({ id: 'video-hotkeys' });
    const videoNode = videoProjectionNode('media/clip.mp4', 0, 0);
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [videoNode],
      edges: [],
      diagnostics: []
    };
    const runtime = canvasRuntimeFixture(projection, {
      selection: { kind: 'node', projectRelativePath: videoNode.projectRelativePath }
    });

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasSurface
              canvas={canvas}
              projection={projection}
              runtime={runtime}
              actions={actions}
              textFileBuffers={{}}
              canvasFeedback={undefined}
              overlayRuntime={createCanvasOverlayRuntime()}
              feedbackPlacementContext={feedbackPlacementContextFixture()}
              textPreviewStyleDependencyKey="dark"
            />
          </I18nProvider>
        );
      });

      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));

      expect(videoTogglePlaybackSpy).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      videoTogglePlaybackSpy.mockClear();
    }
  });

  it('restores the durable video position when Runtime rejects persistence', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const canvas = createCanvasDocument({ id: 'video-persistence-failure' });
    const videoNode = {
      ...videoProjectionNode('media/clip.mp4', 0, 0),
      videoPlayback: { currentTimeSeconds: 2.5 }
    };
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [videoNode],
      edges: [],
      diagnostics: []
    };
    const updateCanvasVideoPlaybackState = vi.fn(async () => {
      throw new Error('persistence failed');
    });

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasSurface
              canvas={canvas}
              projection={projection}
              runtime={canvasRuntimeFixture(projection)}
              actions={{ ...actions, updateCanvasVideoPlaybackState }}
              textFileBuffers={{}}
              canvasFeedback={undefined}
              overlayRuntime={createCanvasOverlayRuntime()}
              feedbackPlacementContext={feedbackPlacementContextFixture()}
              textPreviewStyleDependencyKey="dark"
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        videoMockState.lastUpdatePlaybackTime?.(videoNode.projectRelativePath, 8.25);
        await Promise.resolve();
      });

      expect(updateCanvasVideoPlaybackState).toHaveBeenCalledWith(canvas.id, {
        updates: [{ projectRelativePath: videoNode.projectRelativePath, currentTimeSeconds: 8.25 }]
      });
      expect(videoRestorePersistedTimeSpy).toHaveBeenCalledWith(2.5);
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
    const canvas = createCanvasDocument({ id: 'video-persistence-order' });
    const videoNode = {
      ...videoProjectionNode('media/clip.mp4', 0, 0),
      videoPlayback: { currentTimeSeconds: 2.5 }
    };
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [videoNode],
      edges: [],
      diagnostics: []
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
              canvas={canvas}
              projection={projection}
              runtime={canvasRuntimeFixture(projection)}
              actions={{ ...actions, updateCanvasVideoPlaybackState }}
              textFileBuffers={{}}
              canvasFeedback={undefined}
              overlayRuntime={createCanvasOverlayRuntime()}
              feedbackPlacementContext={feedbackPlacementContextFixture()}
              textPreviewStyleDependencyKey="dark"
            />
          </I18nProvider>
        );
      });

      await act(async () => {
        videoMockState.lastUpdatePlaybackTime?.(videoNode.projectRelativePath, 8.25);
        videoMockState.lastUpdatePlaybackTime?.(videoNode.projectRelativePath, 9.5);
        secondUpdate.resolve(undefined);
        await secondUpdate.promise;
        firstUpdate.reject(new Error('older persistence failed'));
        await firstUpdate.promise.catch(() => undefined);
        await Promise.resolve();
      });

      expect(updateCanvasVideoPlaybackState).toHaveBeenNthCalledWith(2, canvas.id, {
        updates: [{ projectRelativePath: videoNode.projectRelativePath, currentTimeSeconds: 9.5 }]
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
    const canvas = createCanvasDocument({ id: 'video-feedback-target' });
    const videoNode = videoProjectionNode('media/clip.mp4', 0, 0);
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [videoNode],
      edges: [],
      diagnostics: []
    };
    const targetChanges: Array<{ canStartVideoMomentFeedback: boolean } | undefined> = [];
    const runtime = canvasRuntimeFixture(projection);
    videoMockState.registerOnMount = false;
    videoMockState.lastPath = undefined;
    videoMockState.lastRegister = undefined;

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasSurface
              canvas={canvas}
              projection={projection}
              runtime={runtime}
              actions={actions}
              textFileBuffers={{}}
              canvasFeedback={feedbackDocument({})}
              overlayRuntime={createCanvasOverlayRuntime()}
              feedbackPlacementContext={feedbackPlacementContextFixture()}
              onFeedbackBarTargetChange={(target) => targetChanges.push(target)}
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
        canStartVideoMomentFeedback: false
      });
      expect(videoMockState.lastPath).toBe(videoNode.projectRelativePath);

      await act(async () => {
        videoMockState.lastRegister?.(videoNode.projectRelativePath, {
          togglePlayback: videoTogglePlaybackSpy,
          seekBy: vi.fn(),
          toggleMuted: vi.fn(),
          adjustPlaybackRate: vi.fn(),
          toggleCaptions: vi.fn(),
          enterFullscreen: vi.fn(),
          togglePictureInPicture: vi.fn(),
          readCurrentTimeSeconds: videoReadCurrentTimeSecondsSpy,
          pauseAt: videoPauseAtSpy,
          restorePersistedTime: videoRestorePersistedTimeSpy
        });
      });

      expect(targetChanges.at(-1)).toMatchObject({
        canStartVideoMomentFeedback: true
      });
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
    const restoreTextBodyMeasurement = installCanvasTextBodyMeasurement({ width: 420, height: 260 });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const canvas = createCanvasDocument({ id: 'strict-text-preview' });
    const node = textProjectionNode('flow/strict.md', 0, 0, 'rev-strict');
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [node],
      edges: [],
      diagnostics: []
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
                canvas={canvas}
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
                overlayRuntime={createCanvasOverlayRuntime()}
                feedbackPlacementContext={feedbackPlacementContextFixture()}
                textPreviewStyleDependencyKey="dark"
              />
            </I18nProvider>
          </React.StrictMode>
        );
      });

      for (let frame = 0; frame < 5; frame += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20);
          await Promise.resolve();
        });
      }
      const previewImage = container.querySelector<HTMLImageElement>('img.canvas-text-preview-image');

      expect(readCanvasTextPreviewSources).toHaveBeenCalledWith({
        canvasId: canvas.id,
        sources: [expect.objectContaining({ projectRelativePath: node.projectRelativePath })]
      });
      expect(previewImage?.getAttribute('data-preview-width')).toBe('210');
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

  it('renders structure edges when their segments intersect the virtual viewport', () => {
    const canvas = createCanvasDocument({ id: 'edge-canvas' });
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
  });

  it('passes image feedback entries to image node markup without rendering feedback bars inside nodes', () => {
    const canvas = createCanvasDocument({ id: 'image-feedback-layer' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [nodeFixture('flow/cover.png', 120, 80)],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection, {
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
            scope: 'file',
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
    expect(html).toContain('data-canvas-feedback-frame="true"');
    expect(html).toContain('data-canvas-feedback-frame-kinds="regions"');
    expect(html).not.toContain('region note hidden');
    expect(html).not.toContain('class="canvas-feedback-bar"');
  });

  it('renders persistent feedback frames for file-level marks and comments without comment text', () => {
    const canvas = createCanvasDocument({ id: 'file-feedback-frame' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [nodeFixture('flow/cover.png', 120, 80)],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection, {
      canvasFeedback: feedbackDocument({
        'flow/cover.png': {
          projectRelativePath: 'flow/cover.png',
          marks: ['like', 'important'],
          nextMomentLabel: 1,
          nextSpatialLabel: 1,
          items: [{
            id: 'comment-1',
            kind: 'comment',
            scope: 'file',
            comment: 'overall direction',
            createdAt: '2026-05-26T12:00:00.000Z',
            updatedAt: '2026-05-26T12:00:00.000Z'
          }, {
            id: 'comment-2',
            kind: 'comment',
            scope: 'file',
            comment: 'second pass',
            createdAt: '2026-05-26T12:00:00.000Z',
            updatedAt: '2026-05-26T12:00:00.000Z'
          }],
          updatedAt: '2026-05-26T12:00:00.000Z'
        }
      })
    }));

    expect(html).toContain('canvas-node-has-feedback');
    expect(html).toContain('data-canvas-feedback-frame="true"');
    expect(html).toContain('data-canvas-feedback-frame-kinds="like important comments"');
    expect(html).not.toContain('overall direction');
    expect(html).not.toContain('second pass');
    expect(html).not.toContain('class="canvas-feedback-bar"');
  });

  it('does not render persistent feedback frames for empty feedback entries', () => {
    const canvas = createCanvasDocument({ id: 'empty-feedback-frame' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [nodeFixture('flow/cover.png', 120, 80)],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection, {
      canvasFeedback: feedbackDocument({
        'flow/cover.png': {
          projectRelativePath: 'flow/cover.png',
          marks: [],
          nextMomentLabel: 1,
          nextSpatialLabel: 1,
          items: [],
          updatedAt: '2026-05-26T12:00:00.000Z'
        }
      })
    }));

    expect(html).not.toContain('canvas-node-has-feedback');
    expect(html).not.toContain('data-canvas-feedback-frame="true"');
  });

  it('renders persistent feedback frames for text and video nodes', () => {
    const canvas = createCanvasDocument({ id: 'text-video-feedback-frame' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [
        textProjectionNode('flow/readme.md', 120, 80, 'rev-a'),
        videoProjectionNode('flow/clip.mp4', 380, 80)
      ],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection, {
      canvasFeedback: feedbackDocument({
        'flow/readme.md': {
          projectRelativePath: 'flow/readme.md',
          marks: ['check'],
          nextMomentLabel: 1,
          nextSpatialLabel: 1,
          items: [{
            id: 'comment-1',
            kind: 'comment',
            scope: 'file',
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
    expect(html.match(/data-canvas-feedback-frame="true"/g) ?? []).toHaveLength(2);
    expect(html).toContain('data-canvas-feedback-frame-kinds="check comments"');
    expect(html).toContain('data-canvas-feedback-frame-kinds="needs_revision"');
    expect(html).not.toContain('tighten intro');
    expect(html).not.toContain('class="canvas-feedback-bar"');
  });

  it('renders persistent feedback frames for audio, directory, and unknown-file nodes', () => {
    const canvas = createCanvasDocument({ id: 'other-node-kind-feedback-frame' });
    const audioNode: CanvasProjection['nodes'][number] = {
      ...nodeFixture('flow/sound.wav', 120, 80),
      mediaKind: 'audio',
      availability: {
        state: 'available',
        size: 100,
        mimeType: 'audio/wav',
        fileUrl: '/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/flow/sound.wav?v=rev',
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
        fileUrl: '/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/flow/archive.bin?v=rev',
        revision: 'rev'
      }
    };
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [
        audioNode,
        unknownNode,
        directoryFixture('flow/assets', 640, 80)
      ],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection, {
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
            scope: 'file',
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
    expect(html.match(/data-canvas-feedback-frame="true"/g) ?? []).toHaveLength(3);
    expect(html).toContain('data-canvas-feedback-frame-kinds="pending"');
    expect(html).toContain('data-canvas-feedback-frame-kinds="cross"');
    expect(html).toContain('data-canvas-feedback-frame-kinds="comments"');
    expect(html).not.toContain('folder note hidden');
  });

  it('builds feedback bar targets for the image that creates a local feedback draft', () => {
    const node = nodeFixture('flow/b.png', 260, 140);
    const entry = feedbackDocument({}).entries['flow/b.png'];

    expect(canvasFeedbackBarTargetForProjectedNode({
      node,
      surfaceRect: { x: 10, y: 20, width: 900, height: 600 },
      camera: { x: 30, y: 40, z: 2 },
      entry
    })).toEqual({
      projectRelativePath: 'flow/b.png',
      nodeRect: { x: 260, y: 140, width: 200, height: 120 },
      surfaceRect: { x: 10, y: 20, width: 900, height: 600 },
      camera: { x: 30, y: 40, z: 2 },
      entry,
      localToolset: 'image',
      canStartVideoMomentFeedback: false
    });
  });

  it('does not render minimap UI inside the Canvas surface layer', () => {
    const canvas = createCanvasDocument({ id: 'minimap-layer-canvas' });
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

  it('does not render feedback bars for directory nodes', () => {
    const canvas = createCanvasDocument({ id: 'feedback-exclusions' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [
        directoryFixture('image-production', 0, 0)
      ],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection, {
      canvasFeedback: feedbackDocument({})
    }));

    expect(html).not.toContain('class="canvas-feedback-bar"');
  });

  it('does not eagerly render image src attributes before node-local image state publishes image state', () => {
    const canvas = createCanvasDocument({ id: 'resource-previews' });
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
    const canvas = createCanvasDocument({ id: 'image-preview-zoom' });
    const node = largePreviewNodeFixture('flow/large.png');
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [node],
      edges: [],
      diagnostics: []
    };
    const runtime = canvasRuntimeFixture(projection, {
      camera: { x: 0, y: 0, z: 0.1 },
      selection: { kind: 'node', projectRelativePath: node.projectRelativePath }
    });

    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <CanvasSurface
              canvas={canvas}
              projection={projection}
              runtime={runtime}
              actions={actions}
              textFileBuffers={{}}
              canvasFeedback={undefined}
              overlayRuntime={createCanvasOverlayRuntime()}
              feedbackPlacementContext={feedbackPlacementContextFixture()}
              textPreviewStyleDependencyKey="dark"
            />
          </I18nProvider>
        );
      });
      await settleCanvasImageHandoff();

      expect(canvasVisibleImagePreviewWidth(container)).toBe('300');

      await act(async () => {
        runtime.camera.setCamera({ x: 0, y: 0, z: 1 });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CANVAS_CAMERA_IDLE_MS);
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

  it('resolves a loaded next image only after a paint opportunity', () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const resolve = vi.fn();

    scheduleCanvasImageHandoffAfterPaint(resolve, {
      requestFrame: (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelFrame: () => undefined
    });

    expect(resolve).not.toHaveBeenCalled();
    frameCallbacks.shift()?.(16);
    expect(resolve).not.toHaveBeenCalled();
    frameCallbacks.shift()?.(32);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('preloads next images off-DOM before scheduling handoff', async () => {
    const image = fakePreloadImage();
    const frameCallbacks: FrameRequestCallback[] = [];
    const resolveLoaded = vi.fn();
    const rejectLoaded = vi.fn();

    preloadCanvasImageForHandoff({
      image: { src: '/preview/high.jpg', loadKey: 'next', previewWidth: 2100 },
      resolveLoaded,
      rejectLoaded,
      createImage: () => image.element as HTMLImageElement,
      scheduler: {
        requestFrame: (callback) => {
          frameCallbacks.push(callback);
          return frameCallbacks.length;
        },
        cancelFrame: () => undefined
      }
    });

    expect(image.element.decoding).toBe('async');
    expect(image.element.src).toBe('/preview/high.jpg');
    image.element.naturalWidth = 2100;
    image.emit('load');
    await Promise.resolve();

    expect(resolveLoaded).not.toHaveBeenCalled();
    frameCallbacks.shift()?.(16);
    expect(resolveLoaded).not.toHaveBeenCalled();
    frameCallbacks.shift()?.(32);
    expect(resolveLoaded).toHaveBeenCalledWith('next');
    expect(rejectLoaded).not.toHaveBeenCalled();
  });

  it('does not wait for Canvas settings before rendering the Canvas shell', () => {
    const canvas = createCanvasDocument({ id: 'settings-loading-canvas' });
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [{ ...nodeFixture('flow/cover.png', 0, 0), width: 2400, height: 1200 }],
      edges: [],
      diagnostics: []
    };
    const html = renderToStaticMarkup(
      <CanvasEditor
        canvasId={canvas.id}
        state={workbenchStateFixture(canvas, projection)}
        actions={actions}
        overlayRuntime={createCanvasOverlayRuntime()}
        feedbackPlacementContext={feedbackPlacementContextFixture()}
      />
    );

    expect(html).not.toContain('data-testid="canvas-settings-loading"');
    expect(html).toContain('data-testid="canvas-runtime-loading"');
    expect(html).not.toContain('debrute-canvas-preview://');
    expect(html).not.toContain('debrute-project-file://');
  });

  it('keeps feedback bar placement while node hover transfers to the floating bar', () => {
    expect(shouldClearFeedbackBarPlacementForFeedbackTarget({
      hasFeedbackTargetHandler: true,
      hasCanvasFeedback: true,
      hoveredNodePath: undefined,
      hasRenderableFeedbackTarget: false
    })).toBe(false);
  });

  it('clears feedback bar placement when the feedback target cannot remain valid', () => {
    expect(shouldClearFeedbackBarPlacementForFeedbackTarget({
      hasFeedbackTargetHandler: false,
      hasCanvasFeedback: true,
      hoveredNodePath: undefined,
      hasRenderableFeedbackTarget: false
    })).toBe(true);

    expect(shouldClearFeedbackBarPlacementForFeedbackTarget({
      hasFeedbackTargetHandler: true,
      hasCanvasFeedback: false,
      hoveredNodePath: 'flow/cover.png',
      hasRenderableFeedbackTarget: false
    })).toBe(true);

    expect(shouldClearFeedbackBarPlacementForFeedbackTarget({
      hasFeedbackTargetHandler: true,
      hasCanvasFeedback: true,
      hoveredNodePath: 'flow/cover.png',
      hasRenderableFeedbackTarget: false
    })).toBe(true);
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

  it('tracks active video paths from selection, playback, and requested mounts', () => {
    const active = canvasActiveVideoPaths({
      nodes: [
        videoProjectionNode('media/selected.mp4', 0, 0),
        videoProjectionNode('media/playing.mp4', 0, 400),
        videoProjectionNode('media/requested.mp4', 0, 800),
        nodeFixture('images/cover.png', 0, 1200)
      ],
      selectedProjectRelativePaths: ['media/selected.mp4', 'images/cover.png'],
      playingVideoPaths: new Set(['media/playing.mp4', 'media/missing.mp4']),
      requestedVideoPlayerPath: 'media/requested.mp4'
    });

    expect([...active].sort()).toEqual([
      'media/playing.mp4',
      'media/requested.mp4',
      'media/selected.mp4'
    ]);
  });

  it('updates preview resource scheduler interaction state from camera and drag state', () => {
    const frames: FrameRequestCallback[] = [];
    const started: string[] = [];
    const scheduler = createCanvasPreviewResourceScheduler({
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: () => undefined
    });

    syncCanvasPreviewResourceSchedulerForInteraction({
      scheduler,
      cameraState: 'moving',
      dragState: undefined
    });
    scheduler.enqueue({
      kind: 'image',
      nodeId: 'cover.png',
      sourceKey: 'source',
      targetWidth: 640,
      isCurrent: () => true,
      isCulled: () => false,
      run: () => started.push('cover.png')
    });
    expect(frames).toEqual([]);

    syncCanvasPreviewResourceSchedulerForInteraction({
      scheduler,
      cameraState: 'idle',
      dragState: {
        kind: 'move-node',
        pointerId: 1,
        start: { x: 0, y: 0 },
        origins: []
      }
    });
    expect(frames).toEqual([]);

    syncCanvasPreviewResourceSchedulerForInteraction({
      scheduler,
      cameraState: 'idle',
      dragState: undefined
    });
    expect(frames).toHaveLength(1);
    frames[0]?.(16);

    expect(started).toEqual(['cover.png']);
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

  it('keeps moving camera sync limited to stage transform and render scheduling', () => {
    const cameras: unknown[] = [];
    const renderInputs: unknown[] = [];

    syncCanvasMovingCameraFrame({
      liveCamera: { x: -350, y: 0, z: 1 },
      stageRuntime: {
        setCamera: (camera) => cameras.push(camera)
      },
      surfaceSize: { width: 400, height: 300 },
      selection: { kind: 'node', projectRelativePath: 'flow/live-visible.png' },
      activeNodePaths: ['flow/live-visible.png'],
      renderSnapshotScheduler: {
        requestMoving: (input) => renderInputs.push(input)
      }
    });

    expect(cameras).toEqual([{ x: -350, y: 0, z: 1 }]);
    expect(renderInputs).toEqual([{
      camera: { x: -350, y: 0, z: 1 },
      cameraState: 'moving',
      surfaceSize: { width: 400, height: 300 },
      selection: { kind: 'node', projectRelativePath: 'flow/live-visible.png' },
      activeNodePaths: ['flow/live-visible.png']
    }]);
  });

  it('records render scheduler counters', () => {
    const monitor = createCanvasPerfMonitor();
    const renderFrames: FrameRequestCallback[] = [];
    const renderScheduler = createCanvasRenderSnapshotScheduler({
      perfMonitor: monitor,
      commit: () => undefined,
      requestFrame: (callback) => {
        renderFrames.push(callback);
        return renderFrames.length;
      },
      cancelFrame: () => undefined
    });

    renderScheduler.requestMoving({ cameraState: 'moving' });
    renderScheduler.requestMoving({ cameraState: 'moving' });
    renderFrames[0]?.(0);
    renderScheduler.flush({ cameraState: 'idle' });

    expect(counterNames(monitor.getTrace().events)).toEqual([
      'render-moving-queued',
      'render-idle-flush'
    ]);
  });

  it('starts, frames, and ends a camera session from camera state changes', () => {
    const monitor = createCanvasPerfMonitor();
    const sessionRef = { current: undefined as CanvasPerfRuntimeSession | undefined };
    const reactCommitCountRef = { current: 0 };

    syncCanvasPerfSessionState({
      perfMonitor: monitor,
      sessionRef,
      reactCommitCountRef,
      snapshot: { cameraState: 'moving', camera: { x: 0, y: 0, z: 1 } },
      minimapOpen: false
    });
    monitor.recordCounter({ timestamp: 5, source: 'CanvasRenderCoordinator', name: 'render-snapshot-build' });
    monitor.recordCounter({ timestamp: 6, source: 'CanvasRenderCoordinator', name: 'render-snapshot-reuse' });
    monitor.recordCounter({ timestamp: 7, source: 'CanvasStageRuntime', name: 'stage-camera-write' });
    monitor.recordCounter({ timestamp: 8, source: 'CanvasImageNodeAsset', name: 'image-node-url-resolve' });
    reactCommitCountRef.current = 1;
    recordCanvasPerfFrame({
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
        nodeRenderOrder: new Map(),
        edges: []
      },
      reactCommitCountRef
    });
    syncCanvasPerfSessionState({
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
      culledNodeCount: 1
    });
    expect(monitor.getTrace().events.find((event) => event.kind === 'frame')).toMatchObject({
      kind: 'frame',
      renderSnapshotBuildCount: 1,
      renderSnapshotReuseCount: 1,
      stageWriteCount: 1,
      imageNodeWorkCount: 1
    });
  });

  it('records moving camera frames without image node work when no image node counter fired', () => {
    const monitor = createCanvasPerfMonitor();
    const sessionRef = { current: undefined as CanvasPerfRuntimeSession | undefined };
    const reactCommitCountRef = { current: 0 };

    syncCanvasPerfSessionState({
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
        nodeRenderOrder: new Map(),
        edges: []
      },
      reactCommitCountRef
    });

    expect(monitor.getTrace().events.find((event) => event.kind === 'frame')).toMatchObject({
      kind: 'frame',
      cameraState: 'moving',
      reactCommitCount: 0,
      renderSnapshotBuildCount: 0,
      imageNodeWorkCount: 0
    });
  });

  it('starts, frames, and ends a move drag session with render commits', () => {
    const monitor = createCanvasPerfMonitor();
    const sessionRef = { current: undefined as CanvasPerfRuntimeSession | undefined };
    const reactCommitCountRef = { current: 0 };
    const activeNode = nodeFixture('flow/a.png', 0, 0);

    syncCanvasPerfDragSessionState({
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
    reactCommitCountRef.current = 1;
    recordCanvasPerfFrame({
      perfMonitor: monitor,
      sessionRef,
      cameraState: 'idle',
      renderSnapshot: {
        nodesByPath: new Map([[activeNode.projectRelativePath, activeNode]]),
        culledNodePaths: new Set(),
        visibleRect: { x: 0, y: 0, width: 400, height: 300 },
        virtualRect: { x: -768, y: -768, width: 1936, height: 1836 },
        nodeRenderOrder: new Map(),
        edges: []
      },
      reactCommitCountRef
    });
    syncCanvasPerfDragSessionState({
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
      counters: {
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
  } = {}
): React.ReactElement {
  const runtime = canvasRuntimeFixture(projection, input);
  return (
    <I18nProvider locale="en">
      <CanvasSurface
        canvas={canvas}
        projection={projection}
        runtime={runtime}
        actions={actions}
        textFileBuffers={input.textFileBuffers ?? {}}
        canvasFeedback={input.canvasFeedback}
        overlayRuntime={createCanvasOverlayRuntime()}
        feedbackPlacementContext={feedbackPlacementContextFixture()}
        textPreviewStyleDependencyKey="dark"
      />
    </I18nProvider>
  );
}

function canvasRuntimeFixture(
  projection: CanvasProjection,
  input: {
    selection?: CanvasSelection;
    camera?: CanvasCamera;
  } = {}
) {
  return createCanvasEditorRuntime({
    canvasId: projection.canvasId,
    initialProjection: projection,
    submitManualLayout: async () => undefined,
    ...(input.camera ? { camera: input.camera } : {}),
    selection: input.selection
  });
}

function feedbackPlacementContextFixture(): Parameters<typeof CanvasSurface>[0]['feedbackPlacementContext'] {
  return {
    viewportRect: { x: 0, y: 0, width: 1280, height: 720 },
    reservedRects: []
  };
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
      fileUrl: `/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/${path}?v=rev`,
      revision: 'rev'
    }
  };
}

function textProjectionNode(path: string, x: number, y: number, revision: string): CanvasProjection['nodes'][number] {
  return {
    ...nodeFixture(path, x, y),
    mediaKind: 'text',
    availability: {
      state: 'available',
      size: 100,
      mimeType: 'text/markdown',
      fileUrl: `/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/${path}?v=${revision}`,
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
      fileUrl: `/api/projects/123e4567-e89b-42d3-a456-426614174000/files/raw/${path}?v=rev`,
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
  fingerprint: string;
}> }): { sources: Record<string, { projectRelativePath: string; fingerprint: string; status: 'available' }> } {
  return {
    sources: Object.fromEntries(input.sources.map((item) => [
      item.projectRelativePath,
      {
        projectRelativePath: item.projectRelativePath,
        fingerprint: item.fingerprint,
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
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20);
    });
  }
}

function canvasVisibleImagePreviewWidth(container: HTMLElement): string | null {
  const image = container.querySelector<HTMLImageElement>('img[data-canvas-image-layer="visible"]');
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
    selected: false,
    textEditorActive: false,
    hovered: false,
    culled: false,
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
    onResizePointerDown: () => undefined,
    onVideoPlayerMounted: () => undefined,
    onVideoPlayingChange: () => undefined,
    onRegisterVideoTarget: () => undefined,
    onUpdateTextViewport: () => undefined,
    onUpdateVideoPlaybackTime: () => undefined
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
    updatedAt: '2026-05-26T12:00:00.000Z',
    entries
  };
}

function workbenchStateFixture(
  canvas: ReturnType<typeof createCanvasDocument>,
  projection: CanvasProjection
): WorkbenchState {
  return {
    snapshot: {
      metadata: {
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
      canvasRegistry: {
        status: 'ready',
        canvasOrder: [canvas.id]
      },
      health: {
        projectName: 'Project',
        canvasCount: 1,
        diagnosticCounts: { errors: 0, warnings: 0 },
        checkedAt: '2026-05-26T00:00:00.000Z'
      }
    },
    titleBarState: buildWorkbenchTitleBarState({
      platform: 'win32',
      host: 'web', locale: 'en',
      projectTitle: 'Project',
      recentProjectRoots: []
    }),
    projectOpen: {
      opening: false
    },
    explorerSelection: { selectedPaths: [], focusedPath: null, anchorPath: null },
    globalSettings: {
      status: 'ready',
      value: {
        workbench: { locale: 'en', themePreference: 'system', defaultFrontend: 'desktop' },
        chrome: { recentProjects: [] },
        models: {
          image: [],
          video: [],
          audio: []
        },
        integrations: { integrations: [], backends: [] },
        adobeBridge: { enabled: true }
      }
    },
    product: { status: 'ready', value: productState() },
    adobeBridge: { status: 'ready', value: { settings: { enabled: true, discoveryStatus: 'available' }, pairedPlugins: [], clients: [], projects: [], links: [], transfers: [] } },
    resolvedTheme: 'dark',
    canvasFeedback: undefined,
    textFileBuffers: {},
    textEditorWindows: {},
    notifications: []
  };
}

const actions: WorkbenchActions = {
  checkProductUpdate: async () => undefined,
  applyProductUpdate: async () => undefined,
  reloadAdobeBridge: async () => undefined,
  saveGlobalSettings: async () => undefined,
  revealModelApiKey: async () => {
    throw new Error('not used');
  },
  rescanIntegrations: async () => undefined,
  runIntegrationOperation: async (input) => ({
    ok: true,
    integrationId: input.integrationId,
    operation: input.operation
  }),
  createAdobeBridgePairing: async () => ({ pairingId: 'pairing-1', code: '123456', expiresAt: '2026-07-17T00:00:00Z' }),
  cancelAdobeBridgePairing: async () => undefined,
  removeAdobeBridgePairing: async () => undefined,
  linkAdobeBridgePhotoshop: async () => undefined,
  unlinkAdobeBridgePhotoshop: async () => undefined,
  sendProjectFileToPhotoshop: async () => {
    throw new Error('not used');
  },
  openSendToPhotoshopPicker: () => undefined,
  lookupGeneratedAssetMetadata: async () => {
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
  readCanvasVideoPreviewSources: async () => ({ sources: {} }),
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
  bringCanvasNodeToFront: async () => undefined,
  updateCanvasVideoPlaybackState: async () => undefined,
  updateCanvasTextViewportState: async () => undefined,
  updateCanvasFeedbackEntry: async () => true,
  addProjectPathToCanvasMap: async () => undefined,
  createCanvas: async () => {
    throw new Error('not used');
  },
  renameCanvas: async () => {
    throw new Error('not used');
  },
  deleteCanvas: async () => {
    throw new Error('not used');
  },
  reorderCanvases: async () => {
    throw new Error('not used');
  },
  repairCanvasIndex: async () => {
    throw new Error('not used');
  },
  openProject: async () => undefined,
  openTerminalPanel: () => undefined
};

function productState() {
  return {
    productVersion: '0.2.0',
    platform: 'win32' as const,
    cli: {
      status: 'ready' as const,
      version: '0.2.0',
      path: '/home/me/.debrute/bin/debrute',
      skillsVersion: '0.2.0',
      skillsRoot: '/home/me/.agents/skills'
    },
    update: {
      type: 'idle' as const,
      currentVersion: '0.2.0',
      updateAvailable: false as const
    }
  };
}

function projectTreeDragDataTransfer(entries: Array<{ kind: 'file' | 'directory'; projectRelativePath: string }>): Pick<DataTransfer, 'getData'> {
  return {
    getData: () => JSON.stringify(entries)
  };
}

function fakePreloadImage(): {
  element: FakePreloadImageElement;
  emit: (type: 'load' | 'error') => void;
} {
  const listeners = new Map<string, Set<EventListener>>();
  const element = {
    complete: false,
    naturalWidth: 0,
    decoding: 'auto',
    src: '',
    decode: vi.fn(async () => undefined),
    addEventListener: (type: string, listener: EventListener) => {
      const current = listeners.get(type) ?? new Set<EventListener>();
      current.add(listener);
      listeners.set(type, current);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    }
  } as unknown as FakePreloadImageElement;
  return {
    element,
    emit: (type) => {
      element.complete = true;
      for (const listener of listeners.get(type) ?? []) {
        listener(new Event(type));
      }
    }
  };
}

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

type FakePreloadImageElement = Omit<HTMLImageElement, 'complete' | 'naturalWidth'> & {
  complete: boolean;
  naturalWidth: number;
};
