import type { FloatingTextEditorWindowState } from '../../types';
import {
  constrainOpenFloatingPanelsToViewport,
  type FloatingPanelState
} from '../shell/floatingPanels';
import {
  sameWindowRect,
  type WorkbenchViewportRect
} from '../shell/windowBounds';
import { constrainOpenTextEditorWindowsToViewport } from './textEditorWindows';

type WorkbenchStateSetter<T> = (value: T | ((current: T) => T)) => void;

export interface WorkbenchViewportLayoutController {
  viewportRef: { current: WorkbenchViewportRect };
  setViewportRect: WorkbenchStateSetter<WorkbenchViewportRect>;
  setFloatingPanels: WorkbenchStateSetter<FloatingPanelState>;
  setTextEditorWindows: WorkbenchStateSetter<Record<string, FloatingTextEditorWindowState>>;
}

export function reconcileWorkbenchViewportLayout(
  controller: WorkbenchViewportLayoutController,
  viewport: WorkbenchViewportRect
): void {
  controller.viewportRef.current = viewport;
  controller.setViewportRect((current) => (
    sameWindowRect(current, viewport) ? current : viewport
  ));
  controller.setFloatingPanels((current) => constrainOpenFloatingPanelsToViewport(current, viewport));
  controller.setTextEditorWindows((current) => constrainOpenTextEditorWindowsToViewport(current, viewport));
}
