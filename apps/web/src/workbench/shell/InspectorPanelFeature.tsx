import type { WorkbenchLocale } from '@debrute/app-protocol';
import '../styles/inspector.css';
import type { WorkbenchActions, WorkbenchState } from '../../types.js';
import type { CanvasEditorRuntime } from '../canvas/runtime/CanvasEditorRuntime.js';
import { I18nProvider } from '../i18n/index.js';
import { Inspector } from './Inspector.js';

export function WorkbenchInspectorPanelFeature({
  locale,
  state,
  activeCanvasId,
  activeCanvasRuntime,
  actions
}: {
  locale: WorkbenchLocale;
  state: WorkbenchState;
  activeCanvasId: string | undefined;
  activeCanvasRuntime: CanvasEditorRuntime | undefined;
  actions: WorkbenchActions;
}): React.ReactElement {
  return (
    <I18nProvider locale={locale}>
      <Inspector
        state={state}
        activeCanvasId={activeCanvasId}
        selection={activeCanvasRuntime?.getSnapshot().selection}
        actions={actions}
      />
    </I18nProvider>
  );
}
