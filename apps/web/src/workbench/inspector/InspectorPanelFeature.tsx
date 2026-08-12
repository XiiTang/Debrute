import { useSyncExternalStore } from 'react';
import type { WorkbenchLocale } from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import { I18nProvider } from '../i18n/index';
import '../styles/inspector.css';
import { Inspector } from './Inspector';
import type { InspectionTargetStore } from './inspectionTarget';

export function WorkbenchInspectorPanelFeature({
  locale,
  state,
  targetStore,
  actions
}: {
  locale: WorkbenchLocale;
  state: WorkbenchState;
  targetStore: InspectionTargetStore;
  actions: WorkbenchActions;
}): React.ReactElement {
  const target = useSyncExternalStore(
    targetStore.subscribe,
    targetStore.getSnapshot,
    targetStore.getSnapshot
  );
  return (
    <I18nProvider locale={locale}>
      <Inspector target={target} state={state} actions={actions} />
    </I18nProvider>
  );
}
