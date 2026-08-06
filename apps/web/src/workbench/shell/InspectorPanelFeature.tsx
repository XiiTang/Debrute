import type { WorkbenchLocale } from '@debrute/app-protocol';
import '../styles/inspector.css';
import type { WorkbenchActions, WorkbenchState } from '../../types.js';
import type { CanvasEditorRuntime } from '../canvas/runtime/CanvasEditorRuntime.js';
import { I18nProvider } from '../i18n/index.js';
import { Inspector } from './Inspector.js';

export function WorkbenchInspectorPanelFeature({
  locale,
  state,
  canvasRuntime,
  actions
}: {
  locale: WorkbenchLocale;
  state: WorkbenchState;
  canvasRuntime: CanvasEditorRuntime | undefined;
  actions: WorkbenchActions;
}): React.ReactElement {
  return (
    <I18nProvider locale={locale}>
      <Inspector
        state={state}
        selection={canvasRuntime?.getSnapshot().selection}
        actions={actions}
      />
    </I18nProvider>
  );
}
