import { useLayoutEffect } from 'react';
import '../styles/settings.css';
import type { HttpWorkbenchApiClient } from '../../api/httpWorkbenchApiClient';
import type { WorkbenchResolvedTheme } from '../services/workbenchTheme';
import type { WorkbenchLocale } from '@debrute/app-protocol';
import { I18nProvider } from '../i18n/index';
import { SettingsPanel } from './SettingsPanel';
import {
  useWorkbenchSettingsController,
  type WorkbenchSettingsController
} from './useWorkbenchSettingsController';
import type { WorkbenchGlobalSettingsController } from '../services/useWorkbenchGlobalSettingsController';

export function WorkbenchSettingsFeatureHost({
  api,
  globalSettingsController,
  onProductRemovalAccepted,
  onController
}: {
  api: HttpWorkbenchApiClient;
  globalSettingsController: WorkbenchGlobalSettingsController;
  onProductRemovalAccepted(): void;
  onController(controller: WorkbenchSettingsController): void;
}): null {
  const controller = useWorkbenchSettingsController({
    api,
    globalProjection: api.globalProjection,
    globalSettingsController,
    onProductRemovalAccepted
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
    photoshop: controller.photoshop,
    product: controller.product,
    resolvedTheme
  };
  return (
    <I18nProvider locale={locale}>
      <SettingsPanel state={state} actions={controller.actions} />
    </I18nProvider>
  );
}
