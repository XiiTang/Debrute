import React, { createContext, useContext, useMemo } from 'react';
import { createI18n } from './i18n';
import type { WorkbenchI18n, WorkbenchLocale } from './types';

const I18nContext = createContext<WorkbenchI18n | undefined>(undefined);

export function I18nProvider({
  locale,
  children
}: {
  locale: WorkbenchLocale;
  children: React.ReactNode;
}): React.ReactElement {
  const value = useMemo(() => createI18n(locale), [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): WorkbenchI18n {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error('useI18n must be used inside I18nProvider.');
  }
  return value;
}
