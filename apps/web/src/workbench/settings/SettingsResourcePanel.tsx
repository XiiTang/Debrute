import React from 'react';
import type { EventProjection } from '../../types';
import { useI18n } from '../i18n/index';

export function SettingsResourcePanel<T>({
  title,
  resource,
  children
}: {
  title: string;
  resource: EventProjection<T>;
  children: (value: T) => React.ReactElement;
}): React.ReactElement {
  const i18n = useI18n();
  return (
    <section className="settings-content-page">
      <header className="db-surface-header">
        <h2>{title}</h2>
      </header>
      <div className="settings-content-page__body">
        {resource.status === 'ready' ? children(resource.value) : (
          <div className="settings-resource-state" aria-busy="true">
            <small>{i18n.t('settings.resource.loading')}</small>
          </div>
        )}
      </div>
    </section>
  );
}
