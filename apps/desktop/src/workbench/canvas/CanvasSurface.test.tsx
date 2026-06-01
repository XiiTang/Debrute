import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createCanvasDocument, type CanvasFeedbackDocument, type CanvasProjection } from '@axis/canvas-core';
import type { IntegrationSettingsView } from '@axis/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import { CanvasEditor } from './CanvasEditor';
import { areCanvasNodeElementViewPropsEqual, type CanvasNodeElementViewProps } from './CanvasNodeElementView';
import { CanvasSurface } from './CanvasSurface';

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
    const canvas = {
      ...createCanvasDocument({ id: 'viewport-canvas', title: 'Viewport Canvas' }),
      viewport: { x: 120, y: 80, zoom: 0.5 }
    };
    const projection: CanvasProjection = {
      canvasId: canvas.id,
      nodes: [nodeFixture('flow/visible.png', 0, 0)],
      edges: [],
      diagnostics: []
    };

    const html = renderToStaticMarkup(surface(canvas, projection));

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
            fileUrl: 'axis-project-file://project/flow/notes/offscreen.md',
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

  it('renders low-zoom image nodes with preview URLs while previews are enabled', () => {
    const canvas = {
      ...createCanvasDocument({ id: 'low-zoom-previews', title: 'Low Zoom Previews' }),
      viewport: { x: 0, y: 0, zoom: 0.1 }
    };
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
      canvasSettings: { imagePreviewsEnabled: true }
    }));

    expect(html).toContain('axis-canvas-preview://project/flow/image-0.png');
    expect(html).toContain('w=256');
    expect(html).not.toContain('loading="lazy"');
    expect(html).not.toContain('decoding="async"');
    expect(html).not.toContain('src="axis-project-file://project/flow/image-0.png');
  });

  it('waits for Canvas settings before rendering image nodes', () => {
    const canvas = {
      ...createCanvasDocument({ id: 'settings-loading-canvas', title: 'Settings Loading Canvas' }),
      viewport: { x: 0, y: 0, zoom: 0.1 }
    };
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
      />
    );

    expect(html).toContain('data-testid="canvas-settings-loading"');
    expect(html).not.toContain('axis-canvas-preview://');
    expect(html).not.toContain('axis-project-file://');
  });

  it('keeps image node props equal when only event callback identities change', () => {
    const props = nodeElementProps();

    expect(areCanvasNodeElementViewPropsEqual(props, {
      ...props,
      actions: { ...props.actions },
      onPointerDown: () => undefined,
      onPointerMove: () => undefined,
      onPointerUp: () => undefined,
      onPointerEnter: () => undefined,
      onPointerLeave: () => undefined,
      onContextMenu: () => undefined,
      onResizePointerDown: () => undefined
    })).toBe(true);

    expect(areCanvasNodeElementViewPropsEqual(props, {
      ...props,
      onPointerDown: () => undefined,
      onPointerMove: () => undefined,
      onPointerUp: () => undefined,
      onPointerEnter: () => undefined,
      onPointerLeave: () => undefined,
      onContextMenu: () => undefined,
      onResizePointerDown: () => undefined
    })).toBe(true);

    expect(areCanvasNodeElementViewPropsEqual(props, {
      ...props,
      viewportZoom: 0.3
    })).toBe(false);
  });
});

function surface(
  canvas: ReturnType<typeof createCanvasDocument>,
  projection: CanvasProjection,
  input: {
    selection?: Parameters<typeof CanvasSurface>[0]['selection'];
    textFileBuffers?: Parameters<typeof CanvasSurface>[0]['textFileBuffers'];
    canvasFeedback?: CanvasFeedbackDocument;
    canvasSettings?: Parameters<typeof CanvasSurface>[0]['canvasSettings'];
  } = {}
): React.ReactElement {
  return (
    <CanvasSurface
      canvas={canvas}
      projection={projection}
      actions={actions}
      selection={input.selection}
      textFileBuffers={input.textFileBuffers ?? {}}
      textEditorWindows={{}}
      canvasFeedback={input.canvasFeedback}
      canvasSettings={input.canvasSettings ?? { imagePreviewsEnabled: true }}
    />
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
      fileUrl: `axis-project-file://project/${path}`,
      revision: 'rev'
    }
  };
}

function nodeElementProps(): CanvasNodeElementViewProps {
  const node = nodeFixture('flow/cover.png', 0, 0);
  return {
    node,
    selected: false,
    hovered: false,
    viewportZoom: 0.2,
    imagePreviewsEnabled: true,
    devicePixelRatio: 1,
    actions,
    textBuffer: undefined,
    onPointerDown: () => undefined,
    onPointerMove: () => undefined,
    onPointerUp: () => undefined,
    onPointerEnter: () => undefined,
    onPointerLeave: () => undefined,
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
      projectRoot: '/project',
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
    selection: undefined,
    explorerSelection: undefined,
    llmSettings: undefined,
    imageModelSettings: undefined,
    videoModelSettings: undefined,
    integrationsSettings: undefined,
    canvasSettings,
    canvasFeedback: undefined,
    textFileBuffers: {},
    textEditorWindows: {},
    notifications: [],
    updateState: undefined,
    axisCliStatus: undefined,
    setupCompleted: true
  };
}

const actions: WorkbenchActions = {
  selectExplorerPath: () => undefined,
  selectCanvasEntity: () => undefined,
  saveLlmProviderSetting: async () => undefined,
  deleteLlmProviderSetting: async () => undefined,
  setDefaultLlmModelKey: async () => undefined,
  discoverLlmProviderModels: async () => ({ endpoint: '', models: [], modelsCount: 0, supportsDiscovery: false }),
  saveImageModelSetting: async () => undefined,
  saveVideoModelSetting: async () => undefined,
  refreshIntegrationsStatus: async () => emptyIntegrationsSettings,
  rescanIntegrations: async () => emptyIntegrationsSettings,
  lookupGeneratedAssetMetadata: async () => {
    throw new Error('not used');
  },
  readProjectTextFile: async () => {
    throw new Error('not used');
  },
  writeProjectTextFile: async () => {
    throw new Error('not used');
  },
  resolveProjectAbsolutePath: async () => {
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
  updateCanvasViewport: async () => undefined,
  updateCanvasFeedbackEntry: async () => undefined,
  saveCanvasSettings: async () => undefined,
  openProject: async () => undefined,
  updateNow: async () => undefined,
  refreshAxisCliStatus: async () => emptyAxisCliStatus(),
  installAxisCli: async () => emptyAxisCliStatus(),
  updateAxisCli: async () => emptyAxisCliStatus(),
  repairAxisCli: async () => emptyAxisCliStatus(),
  uninstallAxisCli: async () => emptyAxisCliStatus(),
  refreshAxisCliDevelopmentLink: async () => emptyAxisCliStatus(),
  completeSetup: async () => undefined
};

const emptyIntegrationsSettings: IntegrationSettingsView = {
  integrations: [],
  backends: [],
  operationRunning: false
};

function emptyAxisCliStatus() {
  return {
    mode: 'missing' as const,
    managed: false,
    updateAvailable: false,
    commandPath: '/home/user/.axis/bin/axis',
    binDir: '/home/user/.axis/bin',
    installRoot: '/home/user/.axis/cli',
    pathState: 'not-configured' as const
  };
}
