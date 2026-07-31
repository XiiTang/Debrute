import React, { useState } from 'react';
import { AudioLines, Eye, Image as ImageIcon, Music, Settings, Video, WandSparkles, Wrench } from '../ui/index.js';
import type {
  DebruteGlobalSettingsView,
  DebruteProductState,
  IntegrationSettingsView
} from '@debrute/app-protocol';
import type { EventProjection, SettingsResource } from '../../types.js';
import { GeneralSettingsPage } from './general/GeneralSettingsPage.js';
import { AppearanceSettingsPage } from './appearance/AppearanceSettingsPage.js';
import { IntegrationsSettingsPage } from './integrations/IntegrationsSettingsPage.js';
import { AudioModelSettings, ImageModelSettings, VideoModelSettings } from './MediaModelSettingsPage.js';
import { SettingsResourcePanel } from './SettingsResourcePanel.js';
import { useI18n } from '../i18n/index.js';
import type { WorkbenchResolvedTheme } from '../services/workbenchTheme.js';
import type { WorkbenchSettingsActions } from './useWorkbenchSettingsController.js';

const SETTINGS_NAV_GROUPS = [
  {
    id: 'general',
    items: [
      { id: 'general', labelKey: 'settings.nav.general', icon: Settings },
      { id: 'appearance', labelKey: 'settings.nav.appearance', icon: Eye }
    ]
  },
  {
    id: 'models',
    labelKey: 'settings.nav.modelsGroup',
    items: [
      { id: 'image-models', labelKey: 'settings.nav.imageModels', icon: ImageIcon },
      { id: 'video-models', labelKey: 'settings.nav.videoModels', icon: Video },
      { id: 'tts-models', labelKey: 'settings.nav.ttsModels', icon: AudioLines },
      { id: 'music-models', labelKey: 'settings.nav.musicModels', icon: Music },
      { id: 'sfx-models', labelKey: 'settings.nav.sfxModels', icon: WandSparkles }
    ]
  },
  {
    id: 'integrations',
    labelKey: 'settings.nav.integrationsGroup',
    items: [{ id: 'integrations', labelKey: 'settings.nav.integrations', icon: Wrench }]
  }
] as const;

type SettingsPageId = typeof SETTINGS_NAV_GROUPS[number]['items'][number]['id'];

export interface SettingsPanelState {
  globalSettings: EventProjection<DebruteGlobalSettingsView>;
  integrations: SettingsResource<IntegrationSettingsView>;
  product: EventProjection<DebruteProductState | null>;
  resolvedTheme: WorkbenchResolvedTheme;
}

export function SettingsPanel({
  state,
  actions
}: {
  state: SettingsPanelState;
  actions: WorkbenchSettingsActions;
}): React.ReactElement {
  const i18n = useI18n();
  const [activePage, setActivePage] = useState<SettingsPageId>('general');
  return (
    <div className="settings-panel">
      <nav className="settings-directory" aria-label={i18n.t('settings.nav.sections')}>
        {SETTINGS_NAV_GROUPS.map((group) => (
          <div className="settings-directory-group" key={group.id}>
            {'labelKey' in group ? (
              <span className="settings-directory-group__label">{i18n.t(group.labelKey)}</span>
            ) : null}
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={activePage === item.id ? 'db-nav-row db-nav-row--active' : 'db-nav-row'}
                  aria-pressed={activePage === item.id}
                  onClick={() => setActivePage(item.id)}
                >
                  <span className="db-nav-row__icon"><Icon size={15} /></span>
                  <strong>{i18n.t(item.labelKey)}</strong>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="settings-page">
        {activePage === 'general' ? (
          <SettingsResourcePanel title={i18n.t('settings.general.title')} resource={state.globalSettings}>
            {(settings) => (
              <GeneralSettingsPage
                actions={actions}
                product={state.product}
                settings={settings}
                onSettingsChange={actions.saveGlobalSettings}
              />
            )}
          </SettingsResourcePanel>
        ) : activePage === 'appearance' ? (
          <SettingsResourcePanel title={i18n.t('settings.appearance.title')} resource={state.globalSettings}>
            {(settings) => (
              <AppearanceSettingsPage
                settings={settings}
                resolvedTheme={state.resolvedTheme}
                onSettingsChange={actions.saveGlobalSettings}
              />
            )}
          </SettingsResourcePanel>
        ) : activePage === 'image-models' ? (
          <SettingsResourcePanel
            title={i18n.t('settings.models.imageTitle')}
            resource={derivedSettingsResource(state.globalSettings, (settings) => settings.models.image)}
          >
            {(settings) => <ImageModelSettings settings={settings} actions={actions} />}
          </SettingsResourcePanel>
        ) : activePage === 'video-models' ? (
          <SettingsResourcePanel
            title={i18n.t('settings.models.videoTitle')}
            resource={derivedSettingsResource(state.globalSettings, (settings) => settings.models.video)}
          >
            {(settings) => <VideoModelSettings settings={settings} actions={actions} />}
          </SettingsResourcePanel>
        ) : activePage === 'tts-models' ? (
          <SettingsResourcePanel
            title={i18n.t('settings.models.ttsTitle')}
            resource={derivedSettingsResource(state.globalSettings, (settings) => settings.models.audio)}
          >
            {(settings) => <AudioModelSettings settings={settings} actions={actions} kind="tts" />}
          </SettingsResourcePanel>
        ) : activePage === 'music-models' ? (
          <SettingsResourcePanel
            title={i18n.t('settings.models.musicTitle')}
            resource={derivedSettingsResource(state.globalSettings, (settings) => settings.models.audio)}
          >
            {(settings) => <AudioModelSettings settings={settings} actions={actions} kind="music" />}
          </SettingsResourcePanel>
        ) : activePage === 'sfx-models' ? (
          <SettingsResourcePanel
            title={i18n.t('settings.models.sfxTitle')}
            resource={derivedSettingsResource(state.globalSettings, (settings) => settings.models.audio)}
          >
            {(settings) => <AudioModelSettings settings={settings} actions={actions} kind="sound-effect" />}
          </SettingsResourcePanel>
        ) : activePage === 'integrations' ? (
          <SettingsResourcePanel
            title={i18n.t('settings.integrations.title')}
            resource={state.integrations}
            {...(state.integrations.status === 'error' ? { onRetry: actions.rescanIntegrations } : {})}
          >
            {(settings) => <IntegrationsSettingsPage settings={settings} actions={actions} />}
          </SettingsResourcePanel>
        ) : null}
      </div>
    </div>
  );
}

function derivedSettingsResource<T>(
  resource: EventProjection<DebruteGlobalSettingsView>,
  pick: (settings: DebruteGlobalSettingsView) => T
): EventProjection<T> {
  return resource.status === 'ready' ? { status: 'ready', value: pick(resource.value) } : resource;
}
