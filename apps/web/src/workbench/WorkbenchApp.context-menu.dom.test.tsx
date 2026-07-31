import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from './i18n/index.js';
import type { CanvasEditorRuntime, CanvasRuntimeSnapshot } from './canvas/runtime/CanvasEditorRuntime.js';
import type { ProjectPathCommandRouter } from './services/projectPathCommandRouter.js';
import { ProjectPathContextMenuHost } from './WorkbenchApp.js';

describe('ProjectPathContextMenuHost', () => {
  it('isolates Canvas surface readiness updates inside the open menu host', async () => {
    let snapshot = runtimeSnapshot(undefined);
    const surfaceListeners = new Set<() => void>();
    const runtime = {
      getSnapshot: () => snapshot,
      subscribeSurfaceSize: (listener: () => void) => {
        surfaceListeners.add(listener);
        return () => {
          surfaceListeners.delete(listener);
        };
      }
    } as CanvasEditorRuntime;
    const contextMenuItems = vi.fn((_target, canRevealInCanvas: boolean) => [{
      kind: 'action' as const,
      command: 'reveal-in-canvas' as const,
      disabled: !canRevealInCanvas
    }]);
    const router = {
      contextMenuItems,
      run: vi.fn()
    } satisfies ProjectPathCommandRouter;
    const contextMenu = {
      target: {
        source: 'explorer' as const,
        targetKind: 'item' as const,
        paths: [{ projectRelativePath: 'brief.md', kind: 'file' as const }],
        primaryPath: 'brief.md',
        targetDirectoryPath: ''
      },
      position: { x: 12, y: 16 }
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(
      <I18nProvider locale="en">
        <ProjectPathContextMenuHost
          contextMenu={contextMenu}
        router={router}
          runtime={runtime}
          productPlatform="darwin"
          onClose={() => undefined}
        />
      </I18nProvider>
    ));
    expect(container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
    expect(contextMenuItems).toHaveBeenCalledTimes(1);

    snapshot = runtimeSnapshot(undefined, { x: 24, y: 12, z: 1 });
    await act(async () => surfaceListeners.forEach((listener) => listener()));
    expect(contextMenuItems).toHaveBeenCalledTimes(1);

    snapshot = runtimeSnapshot({ width: 800, height: 600 });
    await act(async () => surfaceListeners.forEach((listener) => listener()));
    expect(container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
    expect(contextMenuItems).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
    container.remove();
    expect(surfaceListeners.size).toBe(0);
  });
});

function runtimeSnapshot(
  surfaceSize: CanvasRuntimeSnapshot['surfaceSize'],
  camera: CanvasRuntimeSnapshot['camera'] = { x: 0, y: 0, z: 1 }
): CanvasRuntimeSnapshot {
  return {
    camera,
    cameraState: 'idle',
    selection: undefined,
    dragState: undefined,
    surfaceSize
  };
}
