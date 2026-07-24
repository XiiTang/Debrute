import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { dictionaries, I18nProvider, createI18n, useI18n, zhCN } from './index';
import type { WorkbenchDictionary } from './index';

describe('Workbench i18n', () => {
  it('looks up English and Simplified Chinese text', () => {
    expect(createI18n('en').t('settings.general.title')).toBe('General');
    expect(createI18n('zh-CN').t('settings.general.title')).toBe('通用');
  });

  it('interpolates parameters', () => {
    expect(createI18n('zh-CN').t('shell.notifications.projectOpened', { name: 'Demo' })).toBe('已打开项目：Demo');
    expect(createI18n('en').t('shell.notifications.projectViewStateReset', { name: 'Demo' }))
      .toBe('Saved view state for Demo was invalid and has been reset.');
    expect(createI18n('zh-CN').t('shell.notifications.projectViewStateReset', { name: 'Demo' }))
      .toBe('Demo 的已保存视图状态无效，已重置。');
  });

  it('provides field-specific General preference save failures in both locales', () => {
    expect(createI18n('en').t('settings.general.language.saveFailed', { message: 'offline' }))
      .toBe('Failed to save language preference: offline');
    expect(createI18n('en').t('settings.general.defaultFrontend.saveFailed', { message: 'offline' }))
      .toBe('Failed to save default frontend: offline');
    expect(createI18n('zh-CN').t('settings.general.language.saveFailed', { message: '离线' }))
      .toBe('保存语言偏好失败：离线');
    expect(createI18n('zh-CN').t('settings.general.defaultFrontend.saveFailed', { message: '离线' }))
      .toBe('保存默认前端失败：离线');
  });

  it('throws for missing translations instead of falling back to English', () => {
    const incompleteZh = { ...zhCN };
    delete (incompleteZh as Partial<WorkbenchDictionary>)['common.close'];
    const i18n = createI18n('zh-CN', {
      dictionaries: {
        ...dictionaries,
        'zh-CN': incompleteZh as WorkbenchDictionary
      }
    });

    expect(() => i18n.t('common.close')).toThrow('[debrute:i18n] Missing translation for common.close in zh-CN.');
  });

  it('throws for missing interpolation parameters', () => {
    expect(() => createI18n('en').t('shell.notifications.projectOpened')).toThrow(
      '[debrute:i18n] Missing parameter "name" for shell.notifications.projectOpened.'
    );
  });

  it('provides i18n through React context', () => {
    function Probe(): React.ReactElement {
      const i18n = useI18n();
      return <span>{i18n.t('common.close')}</span>;
    }

    expect(renderToStaticMarkup(
      <I18nProvider locale="zh-CN">
        <Probe />
      </I18nProvider>
    )).toContain('关闭');
  });
});
