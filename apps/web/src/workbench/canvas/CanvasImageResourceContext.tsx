import React, { createContext, useContext, useSyncExternalStore } from 'react';
import type { CanvasImageNodeRenderState } from './canvasImageLoading';
import type { CanvasImageAssetRuntime } from './CanvasImageAssetRuntime';

const CanvasImageAssetContext = createContext<CanvasImageAssetRuntime | undefined>(undefined);
export function CanvasImageAssetProvider({
  runtime,
  children
}: {
  runtime: CanvasImageAssetRuntime;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <CanvasImageAssetContext.Provider value={runtime}>
      {children}
    </CanvasImageAssetContext.Provider>
  );
}

export function useCanvasImageAsset(projectRelativePath: string): CanvasImageNodeRenderState {
  const runtime = useCanvasImageAssetRuntime();
  return useSyncExternalStore(
    (listener) => runtime.subscribeNode(projectRelativePath, listener),
    () => runtime.getNodeState(projectRelativePath),
    () => runtime.getNodeState(projectRelativePath)
  );
}

export function useCanvasImageAssetRuntime(): CanvasImageAssetRuntime {
  const runtime = useContext(CanvasImageAssetContext);
  if (!runtime) {
    throw new Error('CanvasImageAssetProvider is required.');
  }
  return runtime;
}
