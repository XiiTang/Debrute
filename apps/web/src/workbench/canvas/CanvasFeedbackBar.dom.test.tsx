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
    expect(view.commentButton.textContent).toBe('+ Comment');
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
    expect(view.commentButton.textContent).toBe('+ Comment');
    await view.unmount();
  });

  it('expresses an unsynchronized current value through capsule styling without status text', async () => {
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

  it('sizes the Capsule input from 24px through the 240px maximum', async () => {
    const view = await renderBar({ capsules: [capsule('feedback-a', 'A')] });
    const textarea = view.container.querySelector('textarea')!;
    let measuredWidth = 8;
    Object.defineProperty(textarea, 'scrollWidth', {
      configurable: true,
      get: () => measuredWidth
    });

    await act(async () => {
      textarea.value = 'A';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(textarea.style.width).toBe('24px');

    measuredWidth = 500;
    await act(async () => {
      textarea.value = 'A much longer feedback comment';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(textarea.style.width).toBe('240px');
    await view.unmount();
  });

  it('keeps the trailing Comment action when a failed local Capsule is focused again', async () => {
    const view = await renderBar({
      capsules: [capsule('feedback-local', 'Still local', { isNew: true, unsynchronized: true })],
      focusedCapsuleId: 'feedback-local',
      authoringItemId: undefined
    });

    expect(view.commentButton.textContent).toBe('+ Comment');
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
