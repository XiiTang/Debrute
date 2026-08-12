import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DebruteGlobalFeedbackSettings,
  MutateDebruteGlobalSettingsInput
} from '@debrute/app-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/index';
import { installDialogTestAdapter } from '../../ui/Modal.test-support';
import { FeedbackSettingsPage } from './FeedbackSettingsPage';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(async () => {
  while (mounted.length > 0) {
    const probe = mounted.pop();
    if (!probe) continue;
    await act(async () => probe.root.unmount());
    probe.container.remove();
  }
});

describe('FeedbackSettingsPage', { tags: ['settings'] }, () => {
  it('renders the exact image Feedback Bar without separate local-tool framing', async () => {
    const { container } = await renderPage({
      catalog: [{ name: 'like', icon: 'heart' }],
      actionBar: ['like']
    });

    const bar = container.querySelector('[data-feedback-settings-bar="true"]');
    expect(bar).not.toBeNull();
    expect(bar?.querySelector('button[aria-label="like"]')).not.toBeNull();
    expect(bar?.querySelectorAll('.canvas-feedback-local-mode button')).toHaveLength(2);
    expect(bar?.querySelector('.canvas-feedback-local-mode')?.getAttribute('role')).toBe('group');
    expect(bar?.textContent).toContain('Comment');
    expect(container.querySelector('input[aria-label="Search catalog"]')).toBeNull();
    expect(container.querySelector('.settings-group small')).toBeNull();
  });

  it('creates an exact multilingual name only after icon selection and blur', async () => {
    const mutate = vi.fn(async () => undefined);
    const { container } = await renderPage({ catalog: [], actionBar: [] }, mutate, 'zh-CN');

    const blank = container.querySelector<HTMLButtonElement>(
      'button[aria-label="选择图标以创建 Feedback"]'
    );
    expect(blank?.textContent).toBe('');
    expect(container.querySelector('input[aria-label="反馈的精确名称"]')).toBeNull();
    await act(async () => blank?.click());

    const picker = container.querySelector('.feedback-icon-picker');
    expect(picker?.querySelector('input')).toBeNull();
    expect(picker?.querySelector('button')?.textContent).toBe('');
    expect([...picker?.querySelectorAll('button') ?? []]
      .some((button) => button.textContent?.includes('关闭'))).toBe(false);
    const iconButton = picker?.querySelector<HTMLButtonElement>('.feedback-icon-picker__cell button');
    const chosenIcon = iconButton?.getAttribute('aria-label');
    if (!iconButton || !chosenIcon) throw new Error('Expected a selectable Feedback icon.');
    await act(async () => iconButton.click());

    const name = container.querySelector<HTMLInputElement>('input[aria-label="反馈的精确名称"]');
    if (!name) throw new Error('Expected Feedback name input after choosing an icon.');
    expect(document.activeElement).toBe(name);
    await act(async () => setInputValue(name, '  喜欢👍  '));
    await act(async () => {
      name.blur();
      await Promise.resolve();
    });

    expect(mutate).toHaveBeenCalledWith({
      operation: 'create-feedback-mark',
      name: '  喜欢👍  ',
      icon: chosenIcon
    });
    expect(container.querySelector('input[aria-label="反馈的精确名称"]')).toBeNull();
  });

  it('discards an empty draft and preserves an exact Runtime-rejected draft', async () => {
    const rejection = 'Feedback name must contain 1–32 Unicode grapheme clusters.';
    const mutate = vi.fn(async () => { throw new Error(rejection); });
    const { container } = await renderPage({ catalog: [], actionBar: [] }, mutate);

    await chooseFirstIcon(container);
    let name = container.querySelector<HTMLInputElement>('input[aria-label="Exact feedback name"]');
    if (!name) throw new Error('Expected Feedback name input.');
    const emptyName = name;
    await act(async () => emptyName.blur());
    expect(mutate).not.toHaveBeenCalled();
    expect(container.querySelector('input[aria-label="Exact feedback name"]')).toBeNull();

    await chooseFirstIcon(container);
    name = container.querySelector<HTMLInputElement>('input[aria-label="Exact feedback name"]');
    if (!name) throw new Error('Expected Feedback name input.');
    const rejectedName = '👨‍👩‍👧‍👦'.repeat(33);
    await act(async () => setInputValue(name!, rejectedName));
    await act(async () => {
      name!.blur();
      await Promise.resolve();
    });

    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'create-feedback-mark',
      name: rejectedName
    }));
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Exact feedback name"]')?.value)
      .toBe(rejectedName);
    expect(container.textContent).toContain(rejection);
  });

  it('keeps the submitted draft locked until Runtime accepts or rejects it', async () => {
    let rejectMutation: ((cause: Error) => void) | undefined;
    const pendingMutation = new Promise<void>((_resolve, reject) => {
      rejectMutation = reject;
    });
    const mutate = vi.fn(() => pendingMutation);
    const { container } = await renderPage({ catalog: [], actionBar: [] }, mutate);

    await chooseFirstIcon(container);
    const name = container.querySelector<HTMLInputElement>('input[aria-label="Exact feedback name"]');
    if (!name) throw new Error('Expected Feedback name input.');
    await act(async () => setInputValue(name, 'kept draft'));
    await act(async () => {
      name.blur();
      await Promise.resolve();
    });

    const pendingBlank = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Choose an icon to create Feedback"]'
    );
    expect(pendingBlank?.disabled).toBe(true);
    expect(container.querySelector('input[aria-label="Exact feedback name"]')).toBeNull();

    await act(async () => {
      rejectMutation?.(new Error('Runtime rejected the draft.'));
      await pendingMutation.catch(() => undefined);
    });
    const restoredName = container.querySelector<HTMLInputElement>(
      'input[aria-label="Exact feedback name"]'
    );
    expect(restoredName?.value).toBe('kept draft');
    expect(restoredName?.disabled).toBe(false);
    expect(container.textContent).toContain('Runtime rejected the draft.');
  });

  it('adds, reorders, restores, and removes bar items with pointer dragging', async () => {
    const mutate = vi.fn(async () => undefined);
    const { container } = await renderPage({
      catalog: [
        { name: 'like', icon: 'heart' },
        { name: 'dislike', icon: 'thumbs-down' },
        { name: 'maybe', icon: 'question-mark' }
      ],
      actionBar: ['like', 'maybe']
    }, mutate);
    const page = container.querySelector<HTMLElement>('.feedback-settings-page');
    const bar = container.querySelector<HTMLElement>('[data-feedback-settings-bar="true"]');
    const like = container.querySelector<HTMLElement>('[data-feedback-action-name="like"]');
    const maybe = container.querySelector<HTMLElement>('[data-feedback-action-name="maybe"]');
    const dislikeCard = container.querySelector<HTMLElement>('[data-feedback-catalog-name="dislike"]');
    if (!page || !bar || !like || !maybe || !dislikeCard) throw new Error('Expected drag fixtures.');
    stubRect(bar, { left: 0, top: 0, width: 180, height: 70 });
    stubRect(like, { left: 8, top: 8, width: 28, height: 28 });
    stubRect(maybe, { left: 40, top: 8, width: 28, height: 28 });
    stubRect(dislikeCard, { left: 0, top: 100, width: 100, height: 48 });

    await act(async () => {
      dispatchPointer(dislikeCard, 'pointerdown', 10, 110);
      dispatchPointer(page, 'pointermove', 52, 20);
      dispatchPointer(page, 'pointerup', 52, 20);
      await Promise.resolve();
    });
    expect(mutate).toHaveBeenLastCalledWith({
      operation: 'set-feedback-action-bar',
      names: ['like', 'dislike', 'maybe']
    });

    mutate.mockClear();
    await act(async () => {
      dispatchPointer(maybe, 'pointerdown', 54, 20, 2);
      dispatchPointer(page, 'pointermove', 6, 20, 2);
      dispatchPointer(page, 'pointerup', 6, 20, 2);
      await Promise.resolve();
    });
    expect(mutate).toHaveBeenLastCalledWith({
      operation: 'set-feedback-action-bar',
      names: ['maybe', 'like']
    });

    mutate.mockClear();
    await act(async () => {
      dispatchPointer(like, 'pointerdown', 22, 20, 3);
      dispatchPointer(page, 'pointermove', 22, 100, 3);
    });
    expect(container.querySelector('[data-feedback-action-name="like"]')).toBeNull();
    await act(async () => dispatchPointer(page, 'pointermove', 22, 20, 3));
    expect(container.querySelector('[data-feedback-action-name="like"]')).not.toBeNull();
    await act(async () => {
      dispatchPointer(page, 'pointermove', 22, 100, 3);
      dispatchPointer(page, 'pointerup', 22, 100, 3);
      await Promise.resolve();
    });
    expect(mutate).toHaveBeenLastCalledWith({
      operation: 'set-feedback-action-bar',
      names: ['maybe']
    });
  });

  it('keeps the drag ghost centered on an off-center Bar grab point', async () => {
    const { container } = await renderPage({
      catalog: [{ name: 'like', icon: 'heart' }],
      actionBar: ['like']
    });
    const page = container.querySelector<HTMLElement>('.feedback-settings-page');
    const bar = container.querySelector<HTMLElement>('[data-feedback-settings-bar="true"]');
    const like = container.querySelector<HTMLElement>('[data-feedback-action-name="like"]');
    if (!page || !bar || !like) throw new Error('Expected drag fixtures.');
    stubRect(bar, { left: 0, top: 0, width: 180, height: 70 });
    stubRect(like, { left: 8, top: 8, width: 28, height: 28 });

    await act(async () => {
      dispatchPointer(like, 'pointerdown', 8, 8);
      dispatchPointer(page, 'pointermove', -6, 6);
    });

    expect(container.querySelector<HTMLElement>('.feedback-settings-drag-ghost')?.style.transform)
      .toBe('translate3d(-6px, 6px, 0)');
  });

  it('refuses a ninth placeholder but lets an existing member be repositioned', async () => {
    const mutate = vi.fn(async () => undefined);
    const names = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
    const { container } = await renderPage({
      catalog: [...names, 'nine'].map((name) => ({ name, icon: 'question-mark' })),
      actionBar: names
    }, mutate);
    const page = container.querySelector<HTMLElement>('.feedback-settings-page');
    const bar = container.querySelector<HTMLElement>('[data-feedback-settings-bar="true"]');
    const ninth = container.querySelector<HTMLElement>('[data-feedback-catalog-name="nine"]');
    if (!page || !bar || !ninth) throw new Error('Expected full action bar.');
    stubRect(bar, { left: 0, top: 0, width: 360, height: 70 });
    for (const [index, item] of [...container.querySelectorAll<HTMLElement>('[data-feedback-action-name]')].entries()) {
      stubRect(item, { left: 8 + index * 32, top: 8, width: 28, height: 28 });
    }
    stubRect(ninth, { left: 0, top: 100, width: 90, height: 48 });

    await act(async () => {
      dispatchPointer(ninth, 'pointerdown', 10, 110);
      dispatchPointer(page, 'pointermove', 20, 20);
    });
    expect(container.querySelector('[data-feedback-action-name="nine"]')).toBeNull();
    expect(container.querySelector('.feedback-settings-drag-ghost.is-rejected')).not.toBeNull();
    await act(async () => dispatchPointer(page, 'pointerup', 20, 20));
    expect(mutate).not.toHaveBeenCalled();

    const eightCard = container.querySelector<HTMLElement>('[data-feedback-catalog-name="eight"]');
    if (!eightCard) throw new Error('Expected existing catalog member.');
    stubRect(eightCard, { left: 100, top: 100, width: 90, height: 48 });
    await act(async () => {
      dispatchPointer(eightCard, 'pointerdown', 110, 110, 2);
      dispatchPointer(page, 'pointermove', 5, 20, 2);
      dispatchPointer(page, 'pointerup', 5, 20, 2);
      await Promise.resolve();
    });
    expect(mutate).toHaveBeenCalledWith({
      operation: 'set-feedback-action-bar',
      names: ['eight', 'one', 'two', 'three', 'four', 'five', 'six', 'seven']
    });
  });

  it('uses an in-product confirmation and cascades Catalog deletion to the bar', async () => {
    const restoreDialog = installDialogTestAdapter();
    const mutate = vi.fn<(input: MutateDebruteGlobalSettingsInput) => Promise<void>>();
    try {
      const { container } = await renderHarness({
        catalog: [{ name: 'like', icon: 'heart' }],
        actionBar: ['like']
      }, mutate, 'zh-CN');
      const deleteButton = container.querySelector<HTMLButtonElement>('button[aria-label="删除: like"]');
      await act(async () => deleteButton?.click());

      const dialog = document.querySelector<HTMLDialogElement>(
        '[aria-labelledby="feedback-catalog-delete-title"]'
      );
      expect(dialog?.textContent).toContain('不会修改任何项目');
      expect(dialog?.textContent).toContain('未知图标');
      const confirm = [...dialog?.querySelectorAll('button') ?? []]
        .find((button) => button.textContent === '删除');
      await act(async () => {
        confirm?.click();
        await Promise.resolve();
      });

      expect(mutate).toHaveBeenCalledWith({ operation: 'delete-feedback-mark', name: 'like' });
      expect(container.querySelector('[data-feedback-action-name="like"]')).toBeNull();
      expect(container.querySelector('[data-feedback-catalog-name="like"]')).toBeNull();
    } finally {
      restoreDialog();
    }
  });
});

async function renderPage(
  settings: DebruteGlobalFeedbackSettings,
  mutate: (input: MutateDebruteGlobalSettingsInput) => Promise<void> = vi.fn(async () => undefined),
  locale: 'en' | 'zh-CN' = 'en'
): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <I18nProvider locale={locale}>
        <FeedbackSettingsPage settings={settings} mutate={mutate} />
      </I18nProvider>
    );
  });
  return { container, root };
}

async function renderHarness(
  initial: DebruteGlobalFeedbackSettings,
  mutate: ReturnType<typeof vi.fn<(input: MutateDebruteGlobalSettingsInput) => Promise<void>>>,
  locale: 'en' | 'zh-CN' = 'en'
): Promise<{ container: HTMLElement; root: Root }> {
  function Harness(): React.ReactElement {
    const [settings, setSettings] = useState(initial);
    const apply = async (input: MutateDebruteGlobalSettingsInput) => {
      mutate(input);
      if (input.operation === 'delete-feedback-mark') {
        setSettings((current) => ({
          catalog: current.catalog.filter((entry) => entry.name !== input.name),
          actionBar: current.actionBar.filter((name) => name !== input.name)
        }));
      }
    };
    return <FeedbackSettingsPage settings={settings} mutate={apply} />;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(<I18nProvider locale={locale}><Harness /></I18nProvider>);
  });
  return { container, root };
}

async function chooseFirstIcon(container: HTMLElement): Promise<void> {
  const blank = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Choose an icon to create Feedback"]'
  );
  await act(async () => blank?.click());
  const icon = container.querySelector<HTMLButtonElement>('.feedback-icon-picker__cell button');
  if (!icon) throw new Error('Expected a selectable Feedback icon.');
  await act(async () => icon.click());
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function stubRect(
  element: HTMLElement,
  rect: { left: number; top: number; width: number; height: number }
): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({})
  } as DOMRect);
}

function dispatchPointer(
  element: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
  clientY: number,
  pointerId = 1
): void {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  element.dispatchEvent(event);
}
