import React, { useState } from 'react';
import { AudioLines, Cable, Image as ImageIcon, Music, Settings, Video, WandSparkles, Wrench } from '../ui/index.js';
import type {
  AdobeBridgeStateView,
  DebruteGlobalAdobeBridgeSettings,
  DebruteGlobalSettingsView
} from '@debrute/app-protocol';
import type { EventProjection, SettingsResource, WorkbenchActions, WorkbenchState } from '../../types';
import { GeneralSettingsPage } from './general/GeneralSettingsPage';
import { IntegrationsSettingsPage } from './integrations/IntegrationsSettingsPage';
import { AdobeBridgeSettingsPage } from './adobe-bridge/AdobeBridgeSettingsPage';
import { AudioModelSettings, ImageModelSettings, VideoModelSettings } from './MediaModelSettingsPage';
import { SettingsResourcePanel } from './SettingsResourcePanel';
import { useI18n } from '../i18n';

const SETTINGS_NAV_GROUPS = [
  {
    id: 'general',
    items: [
      { id: 'general', labelKey: 'settings.nav.general', icon: Settings }
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
    items: [
      { id: 'integrations', labelKey: 'settings.nav.integrations', icon: Wrench },
      { id: 'adobe-bridge', labelKey: 'settings.nav.adobeBridge', icon: Cable }
    ]
  }
] as const;

type SettingsPageId = typeof SETTINGS_NAV_GROUPS[number]['items'][number]['id'];

export function SettingsPanel({ state, actions }: { state: WorkbenchState; actions: WorkbenchActions }): React.ReactElement {
  const i18n = useI18n();
  const [activePage, setActivePage] = useState<SettingsPageId>('general');
  const adobeBridgePage = adobeBridgeSettingsPageResource(state.globalSettings, state.adobeBridge);
  const retryAdobeBridgePage = state.adobeBridge.status === 'error'
    ? actions.reloadAdobeBridge
    : undefined;
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
          <SettingsResourcePanel
            title={i18n.t('settings.general.title')}
            resource={state.globalSettings}
          >
            {(settings) => (
              <GeneralSettingsPage
                actions={actions}
                product={state.product}
                resolvedTheme={state.resolvedTheme}
                settings={settings}
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
            resource={derivedSettingsResource(state.globalSettings, (settings) => settings.integrations)}
          >
            {(settings) => <IntegrationsSettingsPage settings={settings} actions={actions} />}
          </SettingsResourcePanel>
        ) : activePage === 'adobe-bridge' ? (
          <SettingsResourcePanel
            title={i18n.t('settings.adobeBridge.title')}
            resource={adobeBridgePage}
            {...(retryAdobeBridgePage ? { onRetry: retryAdobeBridgePage } : {})}
          >
            {({ persistedSettings, bridge }) => (
              <AdobeBridgeSettingsPage
                persistedSettings={persistedSettings}
                bridge={bridge}
                projectId={state.projectId}
                actions={actions}
              />
            )}
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
  if (resource.status !== 'ready') {
    return resource;
  }
  return { status: 'ready', value: pick(resource.value) };
}

interface AdobeBridgeSettingsPageValue {
  persistedSettings: DebruteGlobalAdobeBridgeSettings;
  bridge: AdobeBridgeStateView;
}

function adobeBridgeSettingsPageResource(
  globalSettings: EventProjection<DebruteGlobalSettingsView>,
  adobeBridge: SettingsResource<AdobeBridgeStateView>
): SettingsResource<AdobeBridgeSettingsPageValue> {
  if (adobeBridge.status === 'error') {
    return adobeBridge;
  }
  if (globalSettings.status !== 'ready' || adobeBridge.status !== 'ready') {
    return { status: 'loading' };
  }
  return {
    status: 'ready',
    value: {
      persistedSettings: globalSettings.value.adobeBridge,
      bridge: adobeBridge.value
    }
  };
}
