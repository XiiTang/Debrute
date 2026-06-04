import type { FloatingPanelId } from './floatingPanels';

export type WorkbenchWindowKind = 'panel' | 'text-editor';

export interface WorkbenchWindowIdentity {
  kind: WorkbenchWindowKind;
  id: string;
}

export interface WorkbenchWindowOrderState {
  orderBackToFront: WorkbenchWindowIdentity[];
  focusedWindow?: WorkbenchWindowIdentity;
}

export const DEFAULT_WORKBENCH_WINDOW_ORDER: WorkbenchWindowOrderState = {
  orderBackToFront: [panelWindowIdentity('explorer')],
  focusedWindow: panelWindowIdentity('explorer')
};

export function panelWindowIdentity(panelId: FloatingPanelId): WorkbenchWindowIdentity {
  return { kind: 'panel', id: panelId };
}

export function textEditorWindowIdentity(projectRelativePath: string): WorkbenchWindowIdentity {
  return { kind: 'text-editor', id: projectRelativePath };
}

export function workbenchWindowKey(identity: WorkbenchWindowIdentity): string {
  return `${identity.kind}:${identity.id}`;
}

export function sameWorkbenchWindow(
  a: WorkbenchWindowIdentity | undefined,
  b: WorkbenchWindowIdentity | undefined
): boolean {
  return Boolean(a && b && a.kind === b.kind && a.id === b.id);
}

export function focusWorkbenchWindow(
  state: WorkbenchWindowOrderState,
  identity: WorkbenchWindowIdentity
): WorkbenchWindowOrderState {
  return {
    orderBackToFront: [
      ...state.orderBackToFront.filter((item) => !sameWorkbenchWindow(item, identity)),
      identity
    ],
    focusedWindow: identity
  };
}

export function closeWorkbenchWindow(
  state: WorkbenchWindowOrderState,
  identity: WorkbenchWindowIdentity
): WorkbenchWindowOrderState {
  const orderBackToFront = state.orderBackToFront.filter((item) => !sameWorkbenchWindow(item, identity));
  const focusedWindow = orderBackToFront.at(-1);
  return {
    orderBackToFront,
    ...(focusedWindow ? { focusedWindow } : {})
  };
}

export function syncOpenWorkbenchWindows(
  state: WorkbenchWindowOrderState,
  openWindows: WorkbenchWindowIdentity[]
): WorkbenchWindowOrderState {
  const openKeys = new Set(openWindows.map(workbenchWindowKey));
  const knownKeys = new Set(state.orderBackToFront.map(workbenchWindowKey));
  const preserved = state.orderBackToFront.filter((item) => openKeys.has(workbenchWindowKey(item)));
  const appended = openWindows.filter((item) => !knownKeys.has(workbenchWindowKey(item)));
  const orderBackToFront = [...preserved, ...appended];
  const focusedWindow = orderBackToFront.some((item) => sameWorkbenchWindow(item, state.focusedWindow))
    ? state.focusedWindow
    : orderBackToFront.at(-1);

  return {
    orderBackToFront,
    ...(focusedWindow ? { focusedWindow } : {})
  };
}

export function workbenchWindowZIndex(
  state: WorkbenchWindowOrderState,
  identity: WorkbenchWindowIdentity
): number {
  const index = state.orderBackToFront.findIndex((item) => sameWorkbenchWindow(item, identity));
  return index >= 0 ? index + 1 : 0;
}
