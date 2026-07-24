import React from 'react';
import { RefreshCw } from 'lucide-react';
import type { SettingsResource } from '../../types';
import { Button } from '../ui';
import { useI18n } from '../i18n';

export function SettingsResourcePanel<T>({
  title,
  resource,
  onRetry,
  children
}: {
  title: string;
  resource: SettingsResource<T>;
  onRetry?: () => Promise<void>;
  children: (value: T) => React.ReactElement;
}): React.ReactElement {
  const i18n = useI18n();
  return (
    <section className="settings-content-page">
      <header className="db-surface-header">
        <h2>{title}</h2>
      </header>
      <div className="settings-content-page__body">
        {resource.status === 'ready' ? children(resource.value) : resource.status === 'loading' ? (
          <div className="settings-resource-state" aria-busy="true">
            <small>{i18n.t('settings.resource.loading')}</small>
          </div>
        ) : (
          <div className="settings-resource-state settings-resource-state--error" role="alert">
            <small>{i18n.t('settings.resource.loadFailed', { message: resource.message })}</small>
            {onRetry ? (
              <Button type="button" iconStart={<RefreshCw size={14} />} onClick={() => void onRetry()}>
                {i18n.t('settings.resource.retry')}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
