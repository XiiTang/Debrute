import { describe, expect, it, vi } from 'vitest';
import { createCanvasEditorRuntime } from '../canvas/runtime/CanvasEditorRuntime.js';
import {
  createWorkbenchFocusCommandRouter,
  workbenchFocusCommandFromKeyboardEvent
} from './workbenchFocusCommandRouter.js';

describe('workbench focus command router', () => {
  it('maps platform edit keys without claiming plain text keys', () => {
    expect(workbenchFocusCommandFromKeyboardEvent(key('a', { metaKey: true }), 'darwin')).toBe('select-all');
    expect(workbenchFocusCommandFromKeyboardEvent(key('Backspace', { metaKey: true }), 'darwin')).toBe('trash');
    expect(workbenchFocusCommandFromKeyboardEvent(key('Backspace', { metaKey: true, altKey: true }), 'darwin')).toBe('delete-permanently');
    expect(workbenchFocusCommandFromKeyboardEvent(key('Delete', { shiftKey: true }), 'win32')).toBe('delete-permanently');
    expect(workbenchFocusCommandFromKeyboardEvent(key('c'), 'darwin')).toBeUndefined();
  });

  it('uses Escape priority: pointer interaction, Content Activation, Cut, then node selection', () => {
    const projection = {
      nodes: [textNode('a.md'), node('b.png')],
      edges: []
    };
    const runtime = createCanvasEditorRuntime({
      initialProjection: projection,
      submitManualLayout: async () => undefined,
      selection: { kind: 'nodes', projectRelativePaths: ['a.md'] }
    });
    const clearCut = vi.fn();
    const explorer = { fileClipboard: { operation: 'cut' as const, entries: [{ projectRelativePath: 'a.md', kind: 'file' as const }] }, clearCut };
    const router = createWorkbenchFocusCommandRouter({
      getRuntime: () => runtime,
      getProjection: () => projection,
      getCanvasRoot: () => null,
      getProjectPathRouter: () => undefined,
      getExplorerController: () => explorer
    });

    runtime.activateContent('a.md');
    runtime.input.beginSelectionMarquee({
      pointerId: 1,
      screenPoint: { x: 0, y: 0 },
      modifiers: { shiftKey: false }
    });
    expect(router.dispatch('escape', 'other')).toBe(true);
    expect(runtime.getSnapshot().pointerInteraction).toBeUndefined();
    expect(runtime.getSnapshot().contentInteractionProjectRelativePath).toBe('a.md');
    expect(clearCut).not.toHaveBeenCalled();
    expect(router.dispatch('escape', 'other')).toBe(true);
    expect(runtime.getSnapshot().contentInteractionProjectRelativePath).toBeUndefined();
    expect(runtime.getSnapshot().selection).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['a.md']
    });
    expect(clearCut).not.toHaveBeenCalled();
    router.dispatch('escape', 'canvas');
    expect(clearCut).toHaveBeenCalledOnce();
    explorer.fileClipboard = undefined as never;
    router.dispatch('escape', 'canvas');
    expect(runtime.getSnapshot().selection).toBeUndefined();

    runtime.dispose();
  });

  it('consumes Canvas commands even when selection makes them unavailable', () => {
    const projection = { nodes: [], edges: [] };
    const runtime = createCanvasEditorRuntime({
      initialProjection: projection,
      submitManualLayout: async () => undefined
    });
    const router = createWorkbenchFocusCommandRouter({
      getRuntime: () => runtime,
      getProjection: () => projection,
      getCanvasRoot: () => null,
      getProjectPathRouter: () => undefined,
      getExplorerController: () => undefined
    });
    expect(router.dispatch('copy', 'canvas')).toBe(true);
    expect(router.dispatch('copy', 'other')).toBe(false);
    runtime.dispose();
  });

  it('selects every current Projection node and routes file commands through one Canvas target', () => {
    const projection = {
      nodes: [node('b.png'), directoryNode('assets')],
      edges: []
    };
    const runtime = createCanvasEditorRuntime({
      initialProjection: projection,
      submitManualLayout: async () => undefined
    });
    const run = vi.fn();
    const router = createWorkbenchFocusCommandRouter({
      getRuntime: () => runtime,
      getProjection: () => projection,
      getCanvasRoot: () => null,
      getProjectPathRouter: () => ({ contextMenuItems: vi.fn(), run }),
      getExplorerController: () => undefined
    });

    expect(router.dispatch('select-all', 'canvas')).toBe(true);
    expect(runtime.getSnapshot().selection).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['assets', 'b.png']
    });

    router.dispatch('copy', 'canvas');
    expect(run).toHaveBeenLastCalledWith('copy', {
      target: {
        source: 'canvas',
        invocationEntry: expect.objectContaining({
          pathEntry: expect.objectContaining({ projectRelativePath: 'assets' })
        }),
        selectedEntries: [
          expect.objectContaining({
            pathEntry: expect.objectContaining({ projectRelativePath: 'assets', kind: 'directory' })
          }),
          expect.objectContaining({
            pathEntry: expect.objectContaining({ projectRelativePath: 'b.png', kind: 'file' })
          })
        ]
      },
      position: { x: 0, y: 0 }
    });

    router.dispatch('paste', 'canvas');
    expect(run).toHaveBeenCalledTimes(1);
    runtime.setSelection({ kind: 'nodes', projectRelativePaths: ['assets'] });
    router.dispatch('paste', 'canvas');
    expect(run).toHaveBeenLastCalledWith('paste', expect.objectContaining({
      target: expect.objectContaining({
        invocationEntry: expect.objectContaining({
          pathEntry: expect.objectContaining({ projectRelativePath: 'assets' })
        })
      })
    }));

    runtime.dispose();
  });
});

function key(keyValue: string, overrides: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>> = {}) {
  return { key: keyValue, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides };
}

function node(path: string) {
  return {
    projectRelativePath: path,
    displayName: path,
    nodeKind: 'file' as const,
    mediaKind: 'image' as const,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    z: 0,
    availability: {
      state: 'available' as const,
      size: 10,
      mimeType: 'image/png',
      fileUrl: `/files/${path}`,
      revision: 'rev'
    }
  };
}

function textNode(path: string) {
  return {
    ...node(path),
    mediaKind: 'text' as const,
    availability: {
      state: 'available' as const,
      size: 10,
      mimeType: 'text/markdown',
      fileUrl: `/files/${path}`,
      revision: 'rev'
    }
  };
}

function directoryNode(path: string) {
  const { mediaKind: _mediaKind, ...base } = node(path);
  return { ...base, nodeKind: 'directory' as const };
}
