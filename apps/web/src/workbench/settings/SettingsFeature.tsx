import { useLayoutEffect } from 'react';
import '../styles/settings.css';
import '../styles/integrations.css';
import type { WorkbenchActions } from '../../types.js';
import type { HttpWorkbenchApiClient } from '../../api/httpWorkbenchApiClient.js';
import type { WorkbenchResolvedTheme } from '../services/workbenchTheme.js';
import type { WorkbenchLocale } from '@debrute/app-protocol';
import { I18nProvider } from '../i18n/index.js';
import { SettingsPanel } from './SettingsPanel.js';
import {
  useWorkbenchSettingsController,
  type WorkbenchSettingsController,
  type WorkbenchSettingsControllerInput
} from './useWorkbenchSettingsController.js';

export function WorkbenchSettingsFeatureHost({
  api,
  notify,
  getCurrentI18n,
  onController
}: {
  api: HttpWorkbenchApiClient;
  notify(message: string): void;
  getCurrentI18n: WorkbenchSettingsControllerInput['getCurrentI18n'];
  onController(controller: WorkbenchSettingsController): void;
}): null {
  const controller = useWorkbenchSettingsController({
    api,
    globalProjection: api.globalProjection,
    notify,
    getCurrentI18n
  });
  useLayoutEffect(() => {
    onController(controller);
  }, [controller, onController]);
  return null;
}

export function WorkbenchSettingsPanelFeature({
  controller,
  locale,
  resolvedTheme,
  actions
}: {
  controller: WorkbenchSettingsController;
  locale: WorkbenchLocale;
  resolvedTheme: WorkbenchResolvedTheme;
  actions: WorkbenchActions;
}): React.ReactElement {
  const state = {
    globalSettings: controller.globalSettings,
    integrations: controller.integrations,
    product: controller.product,
    resolvedTheme
  };
  return (
    <I18nProvider locale={locale}>
      <SettingsPanel state={state} actions={actions} />
    </I18nProvider>
  );
}
