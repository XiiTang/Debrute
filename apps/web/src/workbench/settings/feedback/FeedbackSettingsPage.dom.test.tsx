import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/index.js';
import { FeedbackSettingsPage } from './FeedbackSettingsPage.js';

describe('FeedbackSettingsPage', { tags: ['settings'] }, () => {
  it('creates an exact multilingual name and confirms local-only deletion', async () => {
    const mutate = vi.fn(async () => undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="zh-CN">
            <FeedbackSettingsPage
              settings={{
                catalog: [{ name: 'like', icon: 'heart' }],
                actionBar: ['like']
              }}
              mutate={mutate}
            />
          </I18nProvider>
        );
      });
      const name = container.querySelector('input[aria-label="反馈的精确名称"]');
      if (!(name instanceof HTMLInputElement)) throw new Error('Expected Feedback name input.');
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(name, '  喜欢👍  ');
        name.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const create = [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('创建'));
      await act(async () => { create?.click(); });
      expect(mutate).toHaveBeenCalledWith({
        operation: 'create-feedback-mark',
        name: '  喜欢👍  ',
        icon: 'circle'
      });

      const deleteButton = container.querySelector('button[aria-label="删除: like"]');
      await act(async () => { (deleteButton as HTMLButtonElement | null)?.click(); });
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('不会修改任何项目'));
      expect(mutate).toHaveBeenCalledWith({ operation: 'delete-feedback-mark', name: 'like' });
    } finally {
      confirm.mockRestore();
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('submits Unicode constraints to Runtime and keeps the exact rejected draft', async () => {
    const rejection = 'Feedback name must contain 1–32 Unicode grapheme clusters.';
    const mutate = vi.fn(async () => { throw new Error(rejection); });
    const rejectedName = '👨‍👩‍👧‍👦'.repeat(33);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <FeedbackSettingsPage settings={{ catalog: [], actionBar: [] }} mutate={mutate} />
          </I18nProvider>
        );
      });
      const name = container.querySelector('input[aria-label="Exact feedback name"]');
      if (!(name instanceof HTMLInputElement)) throw new Error('Expected Feedback name input.');
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(name, rejectedName);
        name.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const create = [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Create'));
      await act(async () => { create?.click(); });

      expect(mutate).toHaveBeenCalledWith({
        operation: 'create-feedback-mark',
        name: rejectedName,
        icon: 'circle'
      });
      expect(name.value).toBe(rejectedName);
      expect(container.textContent).toContain(rejection);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('adds catalog Feedback by dragging it into the floating bar configuration', async () => {
    const mutate = vi.fn(async () => undefined);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <FeedbackSettingsPage
              settings={{
                catalog: [
                  { name: 'like', icon: 'heart' },
                  { name: 'dislike', icon: 'thumbs-down' }
                ],
                actionBar: ['like']
              }}
              mutate={mutate}
            />
          </I18nProvider>
        );
      });

      expect(container.textContent).not.toContain('Include in Action Bar');
      expect(container.querySelector('.feedback-action-bar-add')).toBeNull();
      expect(container.querySelector('button[aria-label="“like” is already in the Floating Feedback Bar"]')
        ?.getAttribute('aria-disabled')).toBe('true');
      const dislike = [...container.querySelectorAll('.feedback-catalog-row')]
        .find((row) => row.textContent?.includes('dislike'));
      const configuration = container.querySelector('.feedback-action-bar-preview');
      expect(dislike?.getAttribute('draggable')).toBe('true');
      const dislikeAction = dislike?.querySelector('.feedback-catalog-row__identity');
      expect(dislikeAction?.getAttribute('aria-disabled')).toBe('false');
      if (!(dislike instanceof HTMLElement) || !(configuration instanceof HTMLElement)) {
        throw new Error('Expected draggable catalog Feedback and floating bar configuration.');
      }

      await act(async () => {
        dislike.dispatchEvent(new Event('dragstart', { bubbles: true }));
        configuration.dispatchEvent(new Event('drop', { bubbles: true }));
      });

      expect(mutate).toHaveBeenCalledWith({
        operation: 'set-feedback-action-bar',
        names: ['like', 'dislike']
      });

      for (const key of ['Enter', ' ']) {
        mutate.mockClear();
        await act(async () => {
          dislikeAction?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        });
        expect(mutate).toHaveBeenCalledWith({
          operation: 'set-feedback-action-bar',
          names: ['like', 'dislike']
        });
      }

      mutate.mockClear();
      await act(async () => { (dislikeAction as HTMLButtonElement | null)?.click(); });
      expect(mutate).toHaveBeenCalledWith({
        operation: 'set-feedback-action-bar',
        names: ['like', 'dislike']
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('reorders the floating bar by drag and refuses a ninth item', async () => {
    const mutate = vi.fn(async () => undefined);
    const names = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <I18nProvider locale="en">
            <FeedbackSettingsPage
              settings={{
                catalog: [...names, 'nine'].map((entry) => ({ name: entry, icon: 'question' })),
                actionBar: names
              }}
              mutate={mutate}
            />
          </I18nProvider>
        );
      });

      const barItems = container.querySelectorAll('.feedback-action-bar-preview__item');
      await act(async () => {
        barItems[7]?.dispatchEvent(new Event('dragstart', { bubbles: true }));
        barItems[0]?.dispatchEvent(new Event('drop', { bubbles: true }));
      });
      expect(mutate).toHaveBeenLastCalledWith({
        operation: 'set-feedback-action-bar',
        names: ['eight', 'one', 'two', 'three', 'four', 'five', 'six', 'seven']
      });

      mutate.mockClear();
      await act(async () => {
        barItems[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      });
      expect(mutate).toHaveBeenCalledWith({
        operation: 'set-feedback-action-bar',
        names: ['two', 'one', 'three', 'four', 'five', 'six', 'seven', 'eight']
      });

      mutate.mockClear();
      const ninth = [...container.querySelectorAll('.feedback-catalog-row')]
        .find((row) => row.textContent?.includes('nine'));
      const ninthAction = container.querySelector('button[aria-label="Cannot add “nine”; the Floating Feedback Bar is full"]');
      expect(ninthAction?.getAttribute('aria-disabled')).toBe('true');
      expect(ninth?.getAttribute('draggable')).toBe('false');
      const configuration = container.querySelector('.feedback-action-bar-preview');
      await act(async () => {
        ninth?.dispatchEvent(new Event('dragstart', { bubbles: true }));
        configuration?.dispatchEvent(new Event('drop', { bubbles: true }));
        (ninthAction as HTMLButtonElement | null)?.click();
      });
      expect(mutate).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
