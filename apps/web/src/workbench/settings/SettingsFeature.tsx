import { useLayoutEffect } from 'react';
import '../styles/settings.css';
import '../styles/integrations.css';
import type { HttpWorkbenchApiClient } from '../../api/httpWorkbenchApiClient.js';
import type { WorkbenchResolvedTheme } from '../services/workbenchTheme.js';
import type { WorkbenchLocale } from '@debrute/app-protocol';
import { I18nProvider } from '../i18n/index.js';
import { SettingsPanel } from './SettingsPanel.js';
import {
  useWorkbenchSettingsController,
  type WorkbenchSettingsController
} from './useWorkbenchSettingsController.js';

export function WorkbenchSettingsFeatureHost({
  api,
  onController
}: {
  api: HttpWorkbenchApiClient;
  onController(controller: WorkbenchSettingsController): void;
}): null {
  const controller = useWorkbenchSettingsController({
    api,
    globalProjection: api.globalProjection
  });
  useLayoutEffect(() => {
    onController(controller);
  }, [controller, onController]);
  return null;
}

export function WorkbenchSettingsPanelFeature({
  controller,
  locale,
  resolvedTheme
}: {
  controller: WorkbenchSettingsController;
  locale: WorkbenchLocale;
  resolvedTheme: WorkbenchResolvedTheme;
}): React.ReactElement {
  const state = {
    globalSettings: controller.globalSettings,
    integrations: controller.integrations,
    product: controller.product,
    resolvedTheme
  };
  return (
    <I18nProvider locale={locale}>
      <SettingsPanel state={state} actions={controller.actions} />
    </I18nProvider>
  );
}
