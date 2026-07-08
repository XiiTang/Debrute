import React from 'react';
import { RefreshCw } from 'lucide-react';
import type { SettingsResource } from '../../types';
import { Button, Card } from '../ui';
import { useI18n } from '../i18n';

export function SettingsResourcePanel<T>({
  title,
  resource,
  onRetry,
  children
}: {
  title: string;
  resource: SettingsResource<T>;
  onRetry: () => Promise<void>;
  children: (value: T) => React.ReactElement;
}): React.ReactElement {
  const i18n = useI18n();
  if (resource.status === 'ready') {
    return children(resource.value);
  }
  return (
    <section className="db-settings-section">
      <header className="db-settings-section__header">
        <h2>{title}</h2>
      </header>
      {resource.status === 'loading' ? (
        <Card className="db-settings-resource-state db-settings-resource-state--loading" aria-busy="true">
          <small>{i18n.t('settings.resource.loading')}</small>
        </Card>
      ) : (
        <Card className="db-settings-resource-state db-settings-resource-state--error" role="alert">
          <small>{i18n.t('settings.resource.loadFailed', { message: resource.message })}</small>
          <Button type="button" iconStart={<RefreshCw size={14} />} onClick={() => void onRetry()}>
            {i18n.t('settings.resource.retry')}
          </Button>
        </Card>
      )}
    </section>
  );
}
