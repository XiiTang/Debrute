import React, { createContext, useContext, useSyncExternalStore } from 'react';
import type { CanvasImageNodeRenderState } from './canvasImageLoading';
import type { CanvasImageResourceController } from './CanvasImageResourceController';

const CanvasImageResourceContext = createContext<CanvasImageResourceController | undefined>(undefined);
const SERVER_IMAGE_PLACEHOLDER_STATE: CanvasImageNodeRenderState = { kind: 'placeholder' };

export function CanvasImageResourceProvider({
  controller,
  children
}: {
  controller: CanvasImageResourceController;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <CanvasImageResourceContext.Provider value={controller}>
      {children}
    </CanvasImageResourceContext.Provider>
  );
}

export function useCanvasImageResource(projectRelativePath: string): CanvasImageNodeRenderState {
  const controller = useContext(CanvasImageResourceContext);
  if (!controller) {
    throw new Error('CanvasImageResourceProvider is required.');
  }
  return useSyncExternalStore(
    (listener) => controller.subscribeNode(projectRelativePath, listener),
    () => controller.getNodeState(projectRelativePath),
    () => SERVER_IMAGE_PLACEHOLDER_STATE
  );
}
