import { dictionaries as defaultDictionaries } from './dictionaries';
import type { WorkbenchDictionary, WorkbenchTranslationKey } from './dictionaries';
import type { WorkbenchI18n, WorkbenchLocale, WorkbenchTranslationParams } from './types';

export function parseWorkbenchLocale(value: unknown): WorkbenchLocale {
  if (value === 'zh-CN' || value === 'en') {
    return value;
  }
  throw new Error('Workbench locale must be "en" or "zh-CN".');
}

export function createI18n(
  locale: WorkbenchLocale,
  options: {
    dictionaries?: Record<WorkbenchLocale, WorkbenchDictionary>;
  } = {}
): WorkbenchI18n {
  const dictionaries = options.dictionaries ?? defaultDictionaries;
  return {
    locale,
    t(key, params) {
      const localized = dictionaries[locale][key];
      if (localized === undefined) {
        throw new Error(`[debrute:i18n] Missing translation for ${key} in ${locale}.`);
      }
      return interpolate(key, localized, params);
    }
  };
}

function interpolate(translationKey: WorkbenchTranslationKey, template: string, params: WorkbenchTranslationParams = {}): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, paramKey: string) => {
    if (!(paramKey in params)) {
      throw new Error(`[debrute:i18n] Missing parameter "${paramKey}" for ${translationKey}.`);
    }
    return String(params[paramKey]);
  });
}
