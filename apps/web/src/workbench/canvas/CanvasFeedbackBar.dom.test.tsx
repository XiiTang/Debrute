import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { CanvasFeedbackMark } from '@debrute/canvas-core';
import { CanvasFeedbackBar } from './CanvasFeedbackBar';
import { createCanvasOverlayRuntime } from './CanvasOverlayRuntime';
import type { CanvasFeedbackCapsule } from './CanvasFeedbackInteraction';
import { I18nProvider } from '../i18n';

const canvasStyles = readFileSync('apps/web/src/workbench/styles/canvas.css', 'utf8');

describe('CanvasFeedbackBar', () => {
  it('keeps creators out of the action row and always renders the trailing Comment action', async () => {
    const view = await renderBar({ capsules: [] });

    expect(view.container.querySelector('.canvas-feedback-primary-row textarea')).toBeNull();
    expect(view.container.querySelector('.canvas-feedback-comment-strip')).not.toBeNull();
    expect(view.commentButton.textContent).toBe('Comment');
    await view.unmount();
  });

  it('keeps a Capsule focused so Shift + Enter can insert multiline text', async () => {
    const onCapsuleChange = vi.fn();
    const onCapsuleBlur = vi.fn(async () => undefined);
    const view = await renderBar({
      capsules: [capsule('feedback-a', 'First'), capsule('feedback-b', 'Second')],
      onCapsuleChange,
      onCapsuleBlur
    });
    const textareas = [...view.container.querySelectorAll('textarea')];

    expect(textareas.map((textarea) => textarea.value)).toEqual(['First', 'Second']);
    await act(async () => {
      textareas[0]!.focus();
      textareas[0]!.value = 'First\ncontinued';
      textareas[0]!.dispatchEvent(new Event('input', { bubbles: true }));
      textareas[0]!.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true
      }));
    });
    expect(onCapsuleChange).toHaveBeenCalledWith('feedback-a', 'First\ncontinued');
    expect(onCapsuleBlur).not.toHaveBeenCalled();

    await act(async () => textareas[0]!.blur());
    expect(onCapsuleBlur).toHaveBeenCalledWith('feedback-a');
    await view.unmount();
  });

  it('confirms a Capsule through the same focus-loss path when Enter is pressed', async () => {
    const onCapsuleBlur = vi.fn(async () => undefined);
    const view = await renderBar({
      capsules: [capsule('feedback-a', 'Confirm me')],
      onCapsuleBlur
    });
    const textarea = view.container.querySelector('textarea')!;
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true
    });

    await act(async () => {
      textarea.focus();
      textarea.dispatchEvent(enter);
    });

    expect(enter.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(textarea);
    expect(onCapsuleBlur).toHaveBeenCalledWith('feedback-a');
    await view.unmount();
  });

  it('turns Comment into a focused local capsule and restores Comment after blur', async () => {
    let capsules: CanvasFeedbackCapsule[] = [];
    let focusedCapsuleId: string | undefined;
    let authoringItemId: string | undefined;
    const view = await renderBar({
      get capsules() { return capsules; },
      get focusedCapsuleId() { return focusedCapsuleId; },
      get authoringItemId() { return authoringItemId; },
      onCreateFileCapsule: () => {
        capsules = [capsule('feedback-new', '', { isNew: true })];
        focusedCapsuleId = 'feedback-new';
        authoringItemId = 'feedback-new';
        return 'feedback-new';
      },
      onCapsuleBlur: async () => {
        focusedCapsuleId = undefined;
        authoringItemId = undefined;
      }
    });

    await act(async () => view.commentButton.click());
    await view.rerender();
    const textarea = view.container.querySelector('textarea')!;
    expect(document.activeElement).toBe(textarea);
    expect(view.container.querySelector('[data-canvas-feedback-add-comment]')).toBeNull();

    await act(async () => textarea.blur());
    await view.rerender();
    expect(view.commentButton.textContent).toBe('Comment');
    await view.unmount();
  });

  it('returns empty authoring sizing to the Comment placeholder without fixed widths', async () => {
    const view = await renderBar({
      capsules: [capsule('feedback-new', '', { isNew: true })],
      focusedCapsuleId: 'feedback-new',
      authoringItemId: 'feedback-new'
    });
    const authoringCapsule = view.container.querySelector('[data-canvas-feedback-item-id="feedback-new"]')!;
    const textarea = authoringCapsule.querySelector('textarea')!;

    expect(canvasStyles).not.toContain('--canvas-feedback-empty-comment-width');
    expect(cssRule('.canvas-feedback-comment-pill--authoring')).toContain('padding-inline: 12px;');
    expect(cssRule('.canvas-feedback-comment-textarea')).toContain('field-sizing: content;');
    expect(cssRule('.canvas-feedback-add-comment')).not.toMatch(/\b(?:min-)?width:/);
    expect(cssRule('.canvas-feedback-add-comment')).toContain('padding: 0 12px;');
    expect(cssRule('.canvas-feedback-comment-strip:empty')).toContain('padding-right: 0;');

    expect(authoringCapsule.classList.contains('canvas-feedback-comment-pill--authoring')).toBe(true);
    expect(textarea.style.width).toBe('');
    expect(textarea.style.height).toBe('');
    await view.unmount();
  });

  it('keeps the empty Comment label on the same vertical center across activation', () => {
    const rowRule = cssRule('.canvas-feedback-comment-row');
    const stripRule = cssRule('.canvas-feedback-comment-strip');
    const addCommentRule = cssRule('.canvas-feedback-add-comment');
    const authoringTextareaRule = cssRule(
      '.canvas-feedback-comment-pill--authoring .canvas-feedback-comment-textarea'
    );

    expect(rowRule).toContain('top: -2px;');
    expect(stripRule).toContain('padding: 5px 5px 3px 0;');
    expect(addCommentRule).toContain('margin-top: 5px;');
    expect(addCommentRule).toContain('line-height: 18px;');
    expect(authoringTextareaRule).toContain('transform: none;');
  });

  it('exposes an unsynchronized current value without adding status text', async () => {
    const view = await renderBar({
      capsules: [capsule('feedback-a', 'Current value', { unsynchronized: true })]
    });
    const capsuleElement = view.container.querySelector('[data-canvas-feedback-item-id="feedback-a"]')!;

    expect(capsuleElement.getAttribute('data-unsynchronized')).toBe('true');
    expect(capsuleElement.classList.contains('canvas-feedback-comment-pill--active-surface')).toBe(true);
    expect(view.container.textContent).not.toMatch(/unsync|retry/i);
    await view.unmount();
  });

  it('uses the Capsule surface instead of a rectangular textarea focus outline', () => {
    expect(canvasStyles).not.toContain('.canvas-feedback-comment-textarea:focus');
  });

  it('keeps the complete comment Capsule surface stable while editing', () => {
    const capsuleRule = cssRule('.canvas-feedback-comment-pill');
    const editingRule = cssRule('.canvas-feedback-comment-pill:focus-within');

    expect(capsuleRule).toContain(
      'box-shadow: var(--canvas-feedback-comment-underlayer);'
    );
    expect(editingRule).toBe('');
  });

  it('lets the comment row use its content height instead of the maximum reserved height', () => {
    expect(canvasStyles).toContain('grid-template-rows: 30px minmax(36px, auto);');
  });

  it('centers a one-line textarea on the Capsule midline', () => {
    expect(canvasStyles).toMatch(
      /\.canvas-feedback-comment-pill\s*\{[^}]*\balign-items:\s*center;/s
    );
  });

  it('optically centers Capsule text above the geometric textarea midpoint', () => {
    expect(canvasStyles).toMatch(
      /\.canvas-feedback-comment-textarea\s*\{[^}]*\btransform:\s*translateY\(-0\.5px\);/s
    );
  });

  it('lets CSS size every Capsule input from 24px through the 240px maximum', async () => {
    const view = await renderBar({ capsules: [capsule('feedback-a', 'A')] });
    const textarea = view.container.querySelector('textarea')!;
    const textareaRule = cssRule('.canvas-feedback-comment-textarea');

    expect(textareaRule).toContain('field-sizing: content;');
    expect(textareaRule).toContain('min-width: 24px;');
    expect(textareaRule).toContain('max-width: 240px;');
    expect(textareaRule).toContain('min-height: 18px;');
    expect(textareaRule).toContain('max-height: 72px;');

    await act(async () => {
      textarea.value = 'A much longer feedback comment';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(textarea.style.width).toBe('');
    expect(textarea.style.height).toBe('');
    await view.unmount();
  });

  it('keeps the trailing Comment action when a failed local Capsule is focused again', async () => {
    const view = await renderBar({
      capsules: [capsule('feedback-local', 'Still local', { isNew: true, unsynchronized: true })],
      focusedCapsuleId: 'feedback-local',
      authoringItemId: undefined
    });

    expect(view.commentButton.textContent).toBe('Comment');
    await view.unmount();
  });

  it('keeps accepted Marks displayed until the Runtime result is projected', async () => {
    const onSetMarks = vi.fn();
    const view = await renderBar({ marks: [], onSetMarks });
    const important = view.container.querySelector('[aria-label="Important"]') as HTMLButtonElement;

    await act(async () => important.click());

    expect(onSetMarks).toHaveBeenCalledWith(['important']);
    expect(important.getAttribute('aria-pressed')).toBe('false');
    await view.unmount();
  });

  it('lets close intent win over same-click blur', async () => {
    const onCapsuleBlur = vi.fn(async () => undefined);
    const onCapsuleDelete = vi.fn(async () => undefined);
    const view = await renderBar({
      capsules: [capsule('feedback-a', 'Remove me')],
      focusedCapsuleId: 'feedback-a',
      onCapsuleBlur,
      onCapsuleDelete
    });
    const textarea = view.container.querySelector('textarea')!;
    const close = view.container.querySelector('.canvas-feedback-comment-pill-close') as HTMLButtonElement;

    await act(async () => textarea.focus());
    await act(async () => {
      close.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      close.click();
    });
    expect(onCapsuleDelete).toHaveBeenCalledWith('feedback-a');
    expect(onCapsuleBlur).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('slightly shrinks and insets only the visible Comment close control while preserving its hit area', () => {
    const closeRule = cssRule('.canvas-feedback-comment-pill-close.db-workbench-close-button');
    const visibleControlRule = cssRule(
      '.canvas-feedback-comment-pill-close.db-workbench-close-button .db-icon-button__icon'
    );
    const visibleIconRule = cssRule(
      '.canvas-feedback-comment-pill-close.db-workbench-close-button .db-icon-button__icon svg'
    );

    expect(closeRule).toContain('top: -3px;');
    expect(closeRule).toContain('right: -3px;');
    expect(closeRule).not.toMatch(/\b(?:width|height):/);
    expect(visibleControlRule).toContain('width: 10px;');
    expect(visibleControlRule).toContain('height: 10px;');
    expect(visibleIconRule).toContain('width: 8px;');
    expect(visibleIconRule).toContain('height: 8px;');
  });

  it('keeps a spatial Feedback label unclipped and optically centers its number', async () => {
    const view = await renderBar({
      capsules: [capsule('feedback-pin', 'Pinned detail', { kind: 'pin', label: 7 })]
    });
    const badge = view.container.querySelector('.canvas-feedback-comment-pill-badge');
    const stripRule = cssRule('.canvas-feedback-comment-strip');
    const mediaLabelRule = cssRule('.canvas-media-feedback-label');
    const numberRule = cssRule('.canvas-feedback-label-number');

    expect(badge?.textContent).toBe('7');
    expect(badge?.querySelector('.canvas-feedback-label-number')).not.toBeNull();
    expect(stripRule).toContain('padding: 5px 5px 3px 0;');
    expect(mediaLabelRule).not.toContain('--canvas-feedback-label-number-offset');
    expect(numberRule).toContain('display: block;');
    expect(numberRule).toContain('text-box: trim-both cap alphabetic;');
    expect(numberRule).not.toContain('transform:');
    await view.unmount();
  });

  it('keeps the trailing Comment action beside rather than over the scrolling comments', async () => {
    const view = await renderBar({
      capsules: [capsule('feedback-a', 'First'), capsule('feedback-b', 'A much longer comment')]
    });
    const row = view.container.querySelector('.canvas-feedback-comment-row')!;
    const strip = view.container.querySelector('.canvas-feedback-comment-strip')!;
    const stripRule = cssRule('.canvas-feedback-comment-strip');
    const rowRule = cssRule('.canvas-feedback-comment-row');

    expect(row.contains(strip)).toBe(true);
    expect(row.contains(view.commentButton)).toBe(true);
    expect(strip.contains(view.commentButton)).toBe(false);
    expect(rowRule).toContain('display: flex;');
    expect(stripRule).toContain('overflow-x: auto;');
    expect(stripRule).toContain('flex: 0 1 auto;');
    await view.unmount();
  });

  it('renders image and video toolsets in the action row', async () => {
    const image = await renderBar({ localToolset: 'image' });
    expect(image.container.querySelector('[aria-label="Image region feedback tools"]')).not.toBeNull();
    await image.unmount();

    const video = await renderBar({ localToolset: 'video', canStartVideoMomentFeedback: true });
    expect(video.container.querySelector('[aria-label="Video moment feedback tools"]')).not.toBeNull();
    expect(video.container.querySelector('[aria-label="Add moment comment"]')).not.toBeNull();
    await video.unmount();
  });
});

function cssRule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return canvasStyles.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`, 's'))?.[0] ?? '';
}

type BarOptions = {
  capsules?: CanvasFeedbackCapsule[];
  marks?: CanvasFeedbackMark[];
  focusedCapsuleId?: string | undefined;
  authoringItemId?: string | undefined;
  localToolset?: 'none' | 'image' | 'video';
  canStartVideoMomentFeedback?: boolean;
  onCreateFileCapsule?: () => string;
  onCapsuleChange?: (itemId: string, value: string) => void;
  onCapsuleFocus?: (itemId: string) => void;
  onCapsuleBlur?: (itemId: string) => Promise<void>;
  onCapsuleDelete?: (itemId: string) => Promise<void>;
  onSetMarks?: (marks: CanvasFeedbackMark[]) => void;
};

async function renderBar(options: BarOptions): Promise<{
  container: HTMLDivElement;
  readonly commentButton: HTMLButtonElement;
  rerender(): Promise<void>;
  unmount(): Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const overlayRuntime = createCanvasOverlayRuntime();
  const render = async () => {
    await act(async () => {
      root.render(
        <I18nProvider locale="en">
          <CanvasFeedbackBar
            projectRelativePath="flow/cover.png"
            capsules={options.capsules ?? []}
            focusedCapsuleId={options.focusedCapsuleId}
            authoringItemId={options.authoringItemId}
            marks={options.marks ?? []}
            onSetMarks={options.onSetMarks ?? (() => undefined)}
            overlayRuntime={overlayRuntime}
            localToolset={options.localToolset}
            canStartVideoMomentFeedback={options.canStartVideoMomentFeedback}
            onCreateFileCapsule={options.onCreateFileCapsule ?? (() => 'feedback-new')}
            onCapsuleChange={options.onCapsuleChange ?? (() => undefined)}
            onCapsuleFocus={options.onCapsuleFocus ?? (() => undefined)}
            onCapsuleBlur={options.onCapsuleBlur ?? (async () => undefined)}
            onCapsuleDelete={options.onCapsuleDelete ?? (async () => undefined)}
          />
        </I18nProvider>
      );
    });
  };
  await render();
  return {
    container,
    get commentButton() {
      return container.querySelector('[data-canvas-feedback-add-comment]') as HTMLButtonElement;
    },
    rerender: render,
    async unmount() {
      await act(async () => root.unmount());
      overlayRuntime.dispose();
      container.remove();
    }
  };
}

function capsule(
  itemId: string,
  comment: string,
  overrides: Partial<CanvasFeedbackCapsule> = {}
): CanvasFeedbackCapsule {
  return {
    itemId,
    createdAt: '2026-07-23T00:00:00.000Z',
    projectRelativePath: 'flow/cover.png',
    kind: 'comment',
    scope: 'file',
    comment,
    isNew: false,
    unsynchronized: false,
    ...overrides
  };
}
