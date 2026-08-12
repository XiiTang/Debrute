import React, { useEffect, useState } from 'react';
import type { DebruteGlobalSettingsView, PhotoshopStateView } from '@debrute/app-protocol';
import { StatusPill, Switch, type StatusTone } from '../../ui/index';
import { useI18n, type WorkbenchI18n } from '../../i18n/index';

const TRANSFER_IN_PROGRESS = 'Transfer in progress.';

export function IntegrationsSettingsPage({
  settings,
  photoshop,
  onSettingsChange
}: {
  settings: DebruteGlobalSettingsView['integrations'];
  photoshop: PhotoshopStateView;
  onSettingsChange(input: { operation: 'set-photoshop-integration-enabled'; enabled: boolean }): Promise<void>;
}): React.ReactElement {
  const i18n = useI18n();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setError(undefined);
  }, [photoshop.status, photoshop.transferActive, settings.photoshop.enabled]);

  const save = async (enabled: boolean) => {
    setSaving(true);
    setError(undefined);
    try {
      await onSettingsChange({ operation: 'set-photoshop-integration-enabled', enabled });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };
  const transferMessage = photoshop.transferActive || error === TRANSFER_IN_PROGRESS
    ? TRANSFER_IN_PROGRESS
    : undefined;
  const status = photoshopStatus(photoshop, i18n);

  return (
    <section className="settings-page-body integrations-settings-page">
      <div className="integration-settings-row">
        <div className="integration-settings-row__body">
          <div className="integration-settings-row__header">
            <h3>{i18n.t('settings.integrations.photoshop.title')}</h3>
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
          </div>
          <small className="db-form-help">{i18n.t('settings.integrations.photoshop.description')}</small>
        </div>
        <Switch
          label={i18n.t('settings.integrations.photoshop.enable')}
          checked={settings.photoshop.enabled}
          disabled={saving || transferMessage !== undefined}
          onChange={(event) => void save(event.currentTarget.checked)}
        />
      </div>
      {transferMessage ? (
        <small className="db-form-help" aria-live="polite">{transferMessage}</small>
      ) : error ? (
        <small className="db-form-error" aria-live="polite">
          {i18n.t('settings.integrations.photoshop.saveFailed', { message: error })}
        </small>
      ) : null}
    </section>
  );
}

function photoshopStatus(
  photoshop: PhotoshopStateView,
  i18n: WorkbenchI18n
): { label: string; tone: StatusTone } {
  if (photoshop.status === 'off') {
    return { label: i18n.t('settings.integrations.status.off'), tone: 'neutral' };
  }
  if (photoshop.status === 'waiting') {
    return { label: i18n.t('settings.integrations.status.waiting'), tone: 'loading' };
  }
  if (photoshop.status === 'connected') {
    return {
      label: i18n.t('settings.integrations.status.connected', { count: photoshop.sessions.length }),
      tone: 'info'
    };
  }
  return { label: i18n.t('settings.integrations.status.unavailable'), tone: 'danger' };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
