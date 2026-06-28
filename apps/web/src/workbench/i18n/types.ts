import type { WorkbenchLocale } from '@debrute/app-protocol';
import type { WorkbenchTranslationKey } from './dictionaries';

export type { WorkbenchLocale };

export type WorkbenchTranslationParams = Record<string, string | number | boolean>;

export interface WorkbenchI18n {
  locale: WorkbenchLocale;
  t(key: WorkbenchTranslationKey, params?: WorkbenchTranslationParams): string;
}
