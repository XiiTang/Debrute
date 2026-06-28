import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { dictionaries, I18nProvider, createI18n, parseWorkbenchLocale, useI18n, zhCN } from './index';
import type { WorkbenchDictionary } from './index';

describe('Workbench i18n', () => {
  it('accepts supported locales and rejects unsupported values', () => {
    expect(parseWorkbenchLocale('en')).toBe('en');
    expect(parseWorkbenchLocale('zh-CN')).toBe('zh-CN');
    expect(() => parseWorkbenchLocale('fr-FR')).toThrow('Workbench locale must be "en" or "zh-CN".');
    expect(() => parseWorkbenchLocale(undefined)).toThrow('Workbench locale must be "en" or "zh-CN".');
  });

  it('looks up English and Simplified Chinese text', () => {
    expect(createI18n('en').t('settings.general.title')).toBe('General');
    expect(createI18n('zh-CN').t('settings.general.title')).toBe('通用');
  });

  it('interpolates parameters', () => {
    expect(createI18n('zh-CN').t('shell.notifications.projectOpened', { name: 'Demo' })).toBe('已打开项目：Demo');
  });

  it('throws for missing translations instead of falling back to English', () => {
    const incompleteZh = { ...zhCN };
    delete (incompleteZh as Partial<WorkbenchDictionary>)['common.save'];
    const i18n = createI18n('zh-CN', {
      dictionaries: {
        ...dictionaries,
        'zh-CN': incompleteZh as WorkbenchDictionary
      }
    });

    expect(() => i18n.t('common.save')).toThrow('[debrute:i18n] Missing translation for common.save in zh-CN.');
  });

  it('throws for missing interpolation parameters', () => {
    expect(() => createI18n('en').t('shell.notifications.projectOpened')).toThrow(
      '[debrute:i18n] Missing parameter "name" for shell.notifications.projectOpened.'
    );
  });

  it('provides i18n through React context', () => {
    function Probe(): React.ReactElement {
      const i18n = useI18n();
      return <span>{i18n.t('common.delete')}</span>;
    }

    expect(renderToStaticMarkup(
      <I18nProvider locale="zh-CN">
        <Probe />
      </I18nProvider>
    )).toContain('删除');
  });
});
