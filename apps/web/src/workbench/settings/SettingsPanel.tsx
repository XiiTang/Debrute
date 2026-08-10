import React, { useState } from 'react';
import { AudioLines, Cable, Eye, Heart, Image as ImageIcon, Info, Music, Settings, Video, WandSparkles } from '../ui/index.js';
import type {
  DebruteGlobalSettingsView,
  DebruteProductState,
  PhotoshopStateView
} from '@debrute/app-protocol';
import type { EventProjection } from '../../types.js';
import { GeneralSettingsPage } from './general/GeneralSettingsPage.js';
import { AppearanceSettingsPage } from './appearance/AppearanceSettingsPage.js';
import { PluginsSettingsPage } from './plugins/PluginsSettingsPage.js';
import { AudioModelSettings, ImageModelSettings, VideoModelSettings } from './MediaModelSettingsPage.js';
import { SettingsResourcePanel } from './SettingsResourcePanel.js';
import { FeedbackSettingsPage } from './feedback/FeedbackSettingsPage.js';
import { useI18n } from '../i18n/index.js';
import type { WorkbenchResolvedTheme } from '../services/workbenchTheme.js';
import type { WorkbenchSettingsActions } from './useWorkbenchSettingsController.js';

const SETTINGS_NAV_GROUPS = [
  {
    id: 'general',
    items: [
      { id: 'general', labelKey: 'settings.nav.general', icon: Settings },
      { id: 'appearance', labelKey: 'settings.nav.appearance', icon: Eye },
      { id: 'feedback', labelKey: 'settings.nav.feedback', icon: Heart }
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
    id: 'plugins',
    labelKey: 'settings.nav.pluginsGroup',
    items: [{ id: 'plugins', labelKey: 'settings.nav.plugins', icon: Cable }]
  },
  {
    id: 'system',
    labelKey: 'settings.nav.systemGroup',
    items: [{ id: 'about-updates', labelKey: 'settings.nav.aboutUpdates', icon: Info }]
  }
] as const;

type SettingsPageId = typeof SETTINGS_NAV_GROUPS[number]['items'][number]['id'];

export interface SettingsPanelState {
  globalSettings: EventProjection<DebruteGlobalSettingsView>;
  photoshop: EventProjection<PhotoshopStateView>;
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
                onSettingsChange={actions.mutateGlobalSettings}
              />
            )}
          </SettingsResourcePanel>
        ) : activePage === 'appearance' ? (
          <SettingsResourcePanel title={i18n.t('settings.appearance.title')} resource={state.globalSettings}>
            {(settings) => (
              <AppearanceSettingsPage
                settings={settings}
                resolvedTheme={state.resolvedTheme}
                onSettingsChange={actions.mutateGlobalSettings}
              />
            )}
          </SettingsResourcePanel>
        ) : activePage === 'feedback' ? (
          <SettingsResourcePanel title={i18n.t('settings.feedback.title')} resource={state.globalSettings}>
            {(settings) => (
              <FeedbackSettingsPage
                settings={settings.feedback}
                mutate={actions.mutateGlobalSettings}
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
        ) : activePage === 'plugins' ? (
          <SettingsResourcePanel
            title={i18n.t('settings.plugins.title')}
            resource={pluginsResource(state.globalSettings, state.photoshop)}
          >
            {(resource) => (
              <PluginsSettingsPage
                settings={resource.settings.plugins}
                photoshop={resource.photoshop}
                onSettingsChange={actions.mutateGlobalSettings}
              />
            )}
          </SettingsResourcePanel>
        ) : activePage === 'about-updates' ? (
          <SettingsResourcePanel title={i18n.t('settings.about.title')} resource={state.globalSettings}>
            {(settings) => (
              <GeneralSettingsPage
                actions={actions}
                product={state.product}
                settings={settings}
                section="about"
                onSettingsChange={actions.mutateGlobalSettings}
              />
            )}
          </SettingsResourcePanel>
        ) : null}
      </div>
    </div>
  );
}

function pluginsResource(
  settings: EventProjection<DebruteGlobalSettingsView>,
  photoshop: EventProjection<PhotoshopStateView>
): EventProjection<{ settings: DebruteGlobalSettingsView; photoshop: PhotoshopStateView }> {
  if (settings.status === 'loading' || photoshop.status === 'loading') {
    return { status: 'loading' };
  }
  return { status: 'ready', value: { settings: settings.value, photoshop: photoshop.value } };
}

function derivedSettingsResource<T>(
  resource: EventProjection<DebruteGlobalSettingsView>,
  pick: (settings: DebruteGlobalSettingsView) => T
): EventProjection<T> {
  return resource.status === 'ready' ? { status: 'ready', value: pick(resource.value) } : resource;
}
