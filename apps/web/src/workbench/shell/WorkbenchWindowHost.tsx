import React from 'react';
import { restoreProjectViewState, saveProjectViewState } from '../services/projectViewState';
import { FloatingDock } from './FloatingDock';
import { WorkbenchFloatingPanelShell } from './FloatingPanel';
import {
  DEFAULT_FLOATING_PANEL_STATE,
  FLOATING_PANEL_IDS,
  closeFloatingPanel,
  commitFloatingPanelRect,
  constrainOpenFloatingPanelsToViewport,
  openFloatingPanel,
  resolveFloatingPanelGestureRect,
  toggleFloatingPanel,
  type FloatingPanelId,
  type FloatingPanelState
} from './floatingPanels';
import type { FloatingWindowGesture } from './floatingWindowGesture';
import type { WorkbenchWindowRect } from './windowBounds';
import {
  DEFAULT_WORKBENCH_WINDOW_ORDER,
  closeWorkbenchWindow,
  focusWorkbenchWindow,
  panelWindowIdentity,
  syncOpenWorkbenchWindows,
  workbenchWindowZIndex,
  type WorkbenchWindowIdentity,
  type WorkbenchWindowOrderState
} from './workbenchWindowOrder';

export interface WorkbenchWindowHostHandle {
  openPanel(panelId: FloatingPanelId): void;
}

interface WorkbenchWindowContextValue {
  orderState: WorkbenchWindowOrderState;
  focusWindow(identity: WorkbenchWindowIdentity): void;
  registerWindow(identity: WorkbenchWindowIdentity): () => void;
}

const WorkbenchWindowContext = React.createContext<WorkbenchWindowContextValue | undefined>(undefined);

export const WorkbenchWindowHost = React.forwardRef<WorkbenchWindowHostHandle, {
  canonicalRoot?: string | undefined;
  viewportRect: WorkbenchWindowRect;
  interactionBlocked: boolean;
  disabledPanelIds: readonly FloatingPanelId[];
  onPanelIntent(panelId: FloatingPanelId): void;
  renderPanelBody(panelId: FloatingPanelId): React.ReactElement;
  children?: React.ReactNode;
}>(function WorkbenchWindowHost({
  canonicalRoot,
  viewportRect,
  interactionBlocked,
  disabledPanelIds,
  onPanelIntent,
  renderPanelBody,
  children
}, ref): React.ReactElement {
  const [floatingPanels, setFloatingPanels] = React.useState<FloatingPanelState>(() => (
    initialFloatingPanelState(canonicalRoot, viewportRect, disabledPanelIds)
  ));
  const [windowOrder, setWindowOrder] = React.useState<WorkbenchWindowOrderState>(() => (
    syncOpenWorkbenchWindows(
      DEFAULT_WORKBENCH_WINDOW_ORDER,
      openPanelWindowIdentities(floatingPanels)
    )
  ));
  const onPanelIntentRef = React.useRef(onPanelIntent);
  onPanelIntentRef.current = onPanelIntent;
  const initialPanelIntents = React.useRef(
    FLOATING_PANEL_IDS.filter((panelId) => floatingPanels.panels[panelId].open)
  ).current;
  const disabledPanels = React.useMemo(() => new Set(disabledPanelIds), [disabledPanelIds]);

  const focusWindow = React.useCallback((identity: WorkbenchWindowIdentity) => {
    setWindowOrder((current) => focusWorkbenchWindow(current, identity));
  }, []);
  const registerWindow = React.useCallback((identity: WorkbenchWindowIdentity) => {
    setWindowOrder((current) => focusWorkbenchWindow(current, identity));
    return () => {
      setWindowOrder((current) => closeWorkbenchWindow(current, identity));
    };
  }, []);

  const openPanel = React.useCallback((panelId: FloatingPanelId) => {
    if (disabledPanels.has(panelId)) {
      return;
    }
    onPanelIntentRef.current(panelId);
    setFloatingPanels((current) => openFloatingPanel(current, panelId, viewportRect));
    focusWindow(panelWindowIdentity(panelId));
  }, [disabledPanels, focusWindow, viewportRect]);

  React.useImperativeHandle(ref, () => ({ openPanel }), [openPanel]);

  React.useEffect(() => {
    for (const panelId of initialPanelIntents) {
      onPanelIntentRef.current(panelId);
    }
  }, [initialPanelIntents]);

  React.useEffect(() => {
    setFloatingPanels((current) => constrainOpenFloatingPanelsToViewport(current, viewportRect));
  }, [viewportRect]);

  React.useEffect(() => {
    if (disabledPanelIds.length === 0) {
      return;
    }
    setFloatingPanels((current) => {
      let next = current;
      for (const panelId of disabledPanelIds) {
        if (next.panels[panelId].open) {
          next = closeFloatingPanel(next, panelId);
        }
      }
      return next;
    });
    setWindowOrder((current) => disabledPanelIds.reduce(
      (next, panelId) => closeWorkbenchWindow(next, panelWindowIdentity(panelId)),
      current
    ));
  }, [disabledPanelIds]);

  React.useEffect(() => {
    if (!canonicalRoot) {
      return;
    }
    saveProjectViewState({
      storage: window.sessionStorage,
      canonicalRoot,
      state: { floatingPanels }
    });
  }, [canonicalRoot, floatingPanels]);

  const togglePanel = React.useCallback((panelId: FloatingPanelId) => {
    if (disabledPanels.has(panelId)) {
      return;
    }
    const isOpen = floatingPanels.panels[panelId].open;
    if (isOpen) {
      setFloatingPanels((current) => closeFloatingPanel(current, panelId));
      setWindowOrder((current) => closeWorkbenchWindow(current, panelWindowIdentity(panelId)));
      return;
    }
    onPanelIntentRef.current(panelId);
    setFloatingPanels((current) => toggleFloatingPanel(current, panelId, viewportRect));
    focusWindow(panelWindowIdentity(panelId));
  }, [disabledPanels, floatingPanels, focusWindow, viewportRect]);

  const contextValue = React.useMemo<WorkbenchWindowContextValue>(() => ({
    orderState: windowOrder,
    focusWindow,
    registerWindow
  }), [focusWindow, registerWindow, windowOrder]);

  return (
    <WorkbenchWindowContext.Provider value={contextValue}>
      <div
        className="workbench-dock-layer"
        data-testid="workbench-dock-layer"
        inert={interactionBlocked}
      >
        <FloatingDock
          panelState={floatingPanels}
          disabledPanelIds={disabledPanelIds}
          onToggle={togglePanel}
        />
      </div>
      <div
        className="workbench-window-layer"
        data-testid="workbench-window-layer"
        inert={interactionBlocked}
      >
        {FLOATING_PANEL_IDS.map((panelId) => {
          const layout = floatingPanels.panels[panelId];
          const identity = panelWindowIdentity(panelId);
          return layout.open ? (
            <WorkbenchFloatingPanelShell
              key={panelId}
              panelId={panelId}
              layout={layout}
              zIndex={workbenchWindowZIndex(windowOrder, identity)}
              onClose={() => {
                setFloatingPanels((current) => closeFloatingPanel(current, panelId));
                setWindowOrder((current) => closeWorkbenchWindow(current, identity));
              }}
              onFocus={() => focusWindow(identity)}
              resolveRect={(candidate: WorkbenchWindowRect, gesture: FloatingWindowGesture) => (
                resolveFloatingPanelGestureRect(panelId, candidate, gesture, viewportRect)
              )}
              onCommitRect={(rect) => {
                setFloatingPanels((current) => commitFloatingPanelRect(current, panelId, rect));
              }}
            >
              {renderPanelBody(panelId)}
            </WorkbenchFloatingPanelShell>
          ) : null;
        })}
        {children}
        <div className="workbench-window-gesture-shield" aria-hidden="true" />
      </div>
    </WorkbenchWindowContext.Provider>
  );
});

export function useWorkbenchWindow(identity: WorkbenchWindowIdentity): {
  zIndex: number;
  onFocus(): void;
} {
  const context = React.useContext(WorkbenchWindowContext);
  if (!context) {
    throw new Error('Workbench floating windows must be rendered inside WorkbenchWindowHost.');
  }
  const { kind, id } = identity;
  const stableIdentity = React.useMemo<WorkbenchWindowIdentity>(
    () => ({ kind, id }),
    [id, kind]
  );
  React.useLayoutEffect(
    () => context.registerWindow(stableIdentity),
    [context.registerWindow, stableIdentity]
  );
  return {
    zIndex: workbenchWindowZIndex(context.orderState, stableIdentity),
    onFocus: () => context.focusWindow(stableIdentity)
  };
}

function initialFloatingPanelState(
  canonicalRoot: string | undefined,
  viewportRect: WorkbenchWindowRect,
  disabledPanelIds: readonly FloatingPanelId[]
): FloatingPanelState {
  let state = DEFAULT_FLOATING_PANEL_STATE;
  if (canonicalRoot) {
    const restored = restoreProjectViewState({
      storage: window.sessionStorage,
      canonicalRoot
    });
    state = restored?.floatingPanels ?? DEFAULT_FLOATING_PANEL_STATE;
  }
  state = constrainOpenFloatingPanelsToViewport(state, viewportRect);
  return disabledPanelIds.reduce(
    (current, panelId) => closeFloatingPanel(current, panelId),
    state
  );
}

function openPanelWindowIdentities(state: FloatingPanelState): WorkbenchWindowIdentity[] {
  return FLOATING_PANEL_IDS
    .filter((panelId) => state.panels[panelId].open)
    .map(panelWindowIdentity);
}
