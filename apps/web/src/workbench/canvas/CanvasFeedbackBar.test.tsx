import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CanvasFeedbackBar } from './CanvasFeedbackBar';
import { createCanvasOverlayRuntime } from './CanvasOverlayRuntime';
import { I18nProvider } from '../i18n';

const canvasFeedbackBarSource = readFileSync(fileURLToPath(new URL('./CanvasFeedbackBar.tsx', import.meta.url)), 'utf8');

function renderStaticWithI18n(element: React.ReactElement): string {
  return renderStaticWithProvider(element, I18nProvider);
}

function renderStaticWithProvider(
  element: React.ReactElement,
  Provider: typeof I18nProvider
): string {
  return renderToStaticMarkup(
    <Provider locale="en">
      {element}
    </Provider>
  );
}

describe('CanvasFeedbackBar', () => {
  it('renders the persistent first-row file comment creator without an empty second row', () => {
    const html = renderStaticWithI18n(
      <CanvasFeedbackBar
        projectRelativePath="flow/cover.png"
        entry={undefined}
        onUpdate={async () => true}
        overlayRuntime={createCanvasOverlayRuntime()}
      />
    );

    expect(html).toContain('db-floating-bar canvas-feedback-bar');
    expect(html).toContain('canvas-feedback-primary-row');
    expect(html).toContain('canvas-feedback-comment-creator');
    expect(html).toContain('aria-label="New file-level comment for flow/cover.png"');
    expect(html).toContain('placeholder="Comment"');
    expect(html).toContain('--db-comment-pill-min-width:90px');
    expect(html).toContain('--db-comment-pill-max-width:90px');
    expect(html).not.toContain('Clear draft comment for flow/cover.png');
    expect(html).toContain('data-canvas-local-wheel="focus"');
    expect(html).not.toContain('data-canvas-local-wheel="true"');
    expect(html).not.toContain('canvas-feedback-comment-strip');
  });

  it('uses the first-row creator for a pending annotation comment without rendering a second-row input', () => {
    const html = renderStaticWithI18n(
      <CanvasFeedbackBar
        projectRelativePath="flow/cover.png"
        entry={undefined}
        onUpdate={async () => true}
        overlayRuntime={createCanvasOverlayRuntime()}
        localFeedbackMode="pin"
        onLocalFeedbackModeChange={() => undefined}
        pendingRegionLabel={3}
        pendingRegionComment="new annotation"
        onPendingRegionCommentChange={() => undefined}
        onSavePendingRegion={() => undefined}
        onCancelPendingRegion={() => undefined}
      />
    );

    expect(html).toContain('canvas-feedback-comment-creator');
    expect(html).toContain('aria-label="New annotation comment for flow/cover.png"');
    expect(html).toContain('value="new annotation"');
    expect(html).toContain('--db-comment-pill-min-width:90px');
    expect(html).toContain('--db-comment-pill-max-width:90px');
    expect(html).toContain('autofocus=""');
    expect(html).not.toContain('canvas-feedback-comment-strip');
    expect(html).not.toContain('canvas-feedback-comment-pill--pending');
  });

  it('defers pending annotation focus until after the confirming pointer event', () => {
    expect(canvasFeedbackBarSource).toContain('pendingRegionFocusTimerRef');
    expect(canvasFeedbackBarSource).toContain('window.setTimeout(() => {');
    expect(canvasFeedbackBarSource).toContain('creatorInputRef.current?.focus();');
    expect(canvasFeedbackBarSource).toContain('window.clearTimeout(pendingRegionFocusTimerRef.current);');
  });

  it('renders saved file comments before saved annotation comments', () => {
    const html = renderStaticWithI18n(
      <CanvasFeedbackBar
        projectRelativePath="flow/cover.png"
        entry={{
          projectRelativePath: 'flow/cover.png',
          marks: [],
          comments: [{
            id: 'comment-1',
            comment: 'overall direction',
            createdAt: '2026-05-26T12:00:00.000Z',
            updatedAt: '2026-05-26T12:00:00.000Z'
          }],
          nextRegionLabel: 2,
          regions: [{
            id: 'region-1',
            label: 1,
            kind: 'pin',
            geometry: { type: 'point', x: 0.2, y: 0.3 },
            comment: 'face is blurry',
            createdAt: '2026-05-26T12:00:00.000Z',
            updatedAt: '2026-05-26T12:00:00.000Z'
          }],
          updatedAt: '2026-05-26T12:00:00.000Z'
        }}
        onUpdate={async () => true}
        overlayRuntime={createCanvasOverlayRuntime()}
        localFeedbackMode="pin"
        onLocalFeedbackModeChange={() => undefined}
      />
    );

    expect(html).toContain('canvas-feedback-comment-strip');
    expect(html).toContain('canvas-feedback-comment-pill--file');
    expect(html).toContain('canvas-feedback-comment-pill--region');
    expect(html.indexOf('overall direction')).toBeLessThan(html.indexOf('face is blurry'));
    expect(html).not.toContain('canvas-feedback-comment-pill--pending');
    expect(html).not.toContain('aria-label="Edit file-level comment for flow/cover.png"');
    expect(html).toContain('aria-label="Delete file-level comment for flow/cover.png"');
    expect(html).toContain('aria-label="Delete feedback region 1"');
    expect(html).not.toContain('value="overall direction"');
  });

  it('saves creator text as a new file-level comment', async () => {
    const commentInputs: Array<{
      value?: string;
      onClose?: () => void;
      onChange?: (event: { currentTarget: { value: string } }) => void;
      onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
      onBlur?: () => void;
    }> = [];
    vi.resetModules();
    vi.doMock('../ui', () => ({
      CommentPillInput: (props: {
        value?: string;
        onClose?: () => void;
        onChange?: (event: { currentTarget: { value: string } }) => void;
        onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
        onBlur?: () => void;
      }) => {
        commentInputs.push(props);
        return React.createElement('input', { value: props.value, readOnly: true });
      },
      IconButton: (props: { label: string; onClick?: () => void }) => (
        React.createElement('button', { type: 'button', onClick: props.onClick }, props.label)
      )
    }));

    try {
      const { CanvasFeedbackBar: MockedCanvasFeedbackBar } = await import('./CanvasFeedbackBar');
      const { I18nProvider: MockedI18nProvider } = await import('../i18n');
      const updates: unknown[] = [];

      renderStaticWithProvider(
        <MockedCanvasFeedbackBar
          projectRelativePath="flow/cover.png"
          entry={undefined}
          onUpdate={async (input) => {
            updates.push(input);
            return true;
          }}
          overlayRuntime={createCanvasOverlayRuntime()}
        />,
        MockedI18nProvider
      );

      expect(commentInputs[0]!.onClose).toBeUndefined();
      commentInputs[0]!.onChange?.({ currentTarget: { value: '  overall direction  ' } });
      commentInputs[0]!.onKeyDown?.({ key: 'Enter', preventDefault: () => undefined });

      expect(updates.at(-1)).toEqual({
        operation: 'add-comment',
        projectRelativePath: 'flow/cover.png',
        comment: 'overall direction'
      });
    } finally {
      vi.doUnmock('../ui');
      vi.resetModules();
    }
  });

  it('saves pending annotation text from the first-row creator', async () => {
    const commentInputs: Array<{
      value?: string;
      onClose?: () => void;
      onChange?: (event: { currentTarget: { value: string } }) => void;
      onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
      onBlur?: () => void;
    }> = [];
    vi.resetModules();
    vi.doMock('../ui', () => ({
      CommentPillInput: (props: {
        value?: string;
        onClose?: () => void;
        onChange?: (event: { currentTarget: { value: string } }) => void;
        onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
        onBlur?: () => void;
      }) => {
        commentInputs.push(props);
        return React.createElement('input', { value: props.value, readOnly: true });
      },
      IconButton: (props: { label: string; onClick?: () => void }) => (
        React.createElement('button', { type: 'button', onClick: props.onClick }, props.label)
      )
    }));

    try {
      const { CanvasFeedbackBar: MockedCanvasFeedbackBar } = await import('./CanvasFeedbackBar');
      const { I18nProvider: MockedI18nProvider } = await import('../i18n');
      const onPendingRegionCommentChange = vi.fn();
      const onSavePendingRegion = vi.fn();

      renderStaticWithProvider(
        <MockedCanvasFeedbackBar
          projectRelativePath="flow/cover.png"
          entry={undefined}
          onUpdate={async () => true}
          overlayRuntime={createCanvasOverlayRuntime()}
          localFeedbackMode="pin"
          onLocalFeedbackModeChange={() => undefined}
          pendingRegionLabel={3}
          pendingRegionComment="new annotation"
          onPendingRegionCommentChange={onPendingRegionCommentChange}
          onSavePendingRegion={onSavePendingRegion}
          onCancelPendingRegion={() => undefined}
        />,
        MockedI18nProvider
      );

      expect(commentInputs).toHaveLength(1);
      expect(commentInputs[0]!.value).toBe('new annotation');
      expect(commentInputs[0]!.onClose).toBeUndefined();
      commentInputs[0]!.onChange?.({ currentTarget: { value: ' sharper face ' } });
      commentInputs[0]!.onKeyDown?.({ key: 'Enter', preventDefault: () => undefined });

      expect(onPendingRegionCommentChange).toHaveBeenCalledWith(' sharper face ');
      expect(onSavePendingRegion).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('../ui');
      vi.resetModules();
    }
  });

  it('cancels pending annotation text without saving it on a following blur', async () => {
    const commentInputs: Array<{
      value?: string;
      onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
      onBlur?: () => void;
    }> = [];
    vi.resetModules();
    vi.doMock('../ui', () => ({
      CommentPillInput: (props: {
        value?: string;
        onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
        onBlur?: () => void;
      }) => {
        commentInputs.push(props);
        return React.createElement('input', { value: props.value, readOnly: true });
      },
      IconButton: (props: { label: string; onClick?: () => void }) => (
        React.createElement('button', { type: 'button', onClick: props.onClick }, props.label)
      )
    }));

    try {
      const { CanvasFeedbackBar: MockedCanvasFeedbackBar } = await import('./CanvasFeedbackBar');
      const { I18nProvider: MockedI18nProvider } = await import('../i18n');
      const onCancelPendingRegion = vi.fn();
      const onSavePendingRegion = vi.fn();

      renderStaticWithProvider(
        <MockedCanvasFeedbackBar
          projectRelativePath="flow/cover.png"
          entry={undefined}
          onUpdate={async () => true}
          overlayRuntime={createCanvasOverlayRuntime()}
          localFeedbackMode="pin"
          onLocalFeedbackModeChange={() => undefined}
          pendingRegionLabel={3}
          pendingRegionComment="new annotation"
          onPendingRegionCommentChange={() => undefined}
          onSavePendingRegion={onSavePendingRegion}
          onCancelPendingRegion={onCancelPendingRegion}
        />,
        MockedI18nProvider
      );

      commentInputs[0]!.onKeyDown?.({ key: 'Escape', preventDefault: () => undefined });
      commentInputs[0]!.onBlur?.();

      expect(onCancelPendingRegion).toHaveBeenCalledTimes(1);
      expect(onSavePendingRegion).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../ui');
      vi.resetModules();
    }
  });

  it('updates marks without carrying creator draft text', async () => {
    const iconButtons: Array<{ label: string; onClick?: () => void }> = [];
    const commentInputs: Array<{
      value?: string;
      onChange?: (event: { currentTarget: { value: string } }) => void;
    }> = [];
    vi.resetModules();
    vi.doMock('../ui', () => ({
      CommentPillInput: (props: {
        value?: string;
        onChange?: (event: { currentTarget: { value: string } }) => void;
      }) => {
        commentInputs.push(props);
        return React.createElement('input', { value: props.value, readOnly: true });
      },
      IconButton: (props: { label: string; onClick?: () => void }) => {
        iconButtons.push(props);
        return React.createElement('button', { type: 'button' }, props.label);
      }
    }));

    try {
      const { CanvasFeedbackBar: MockedCanvasFeedbackBar } = await import('./CanvasFeedbackBar');
      const { I18nProvider: MockedI18nProvider } = await import('../i18n');
      const updates: unknown[] = [];

      renderStaticWithProvider(
        <MockedCanvasFeedbackBar
          projectRelativePath="flow/cover.png"
          entry={undefined}
          onUpdate={async (input) => {
            updates.push(input);
            return true;
          }}
          overlayRuntime={createCanvasOverlayRuntime()}
        />,
        MockedI18nProvider
      );

      commentInputs[0]!.onChange?.({ currentTarget: { value: 'draft comment' } });
      iconButtons.find((button) => button.label === 'Check')!.onClick?.();

      expect(updates.at(-1)).toEqual({
        operation: 'set-marks',
        projectRelativePath: 'flow/cover.png',
        marks: ['check']
      });
    } finally {
      vi.doUnmock('../ui');
      vi.resetModules();
    }
  });

  it('does not route saved comments through second-row input props', async () => {
    const commentInputs: Array<{ value?: string }> = [];
    vi.resetModules();
    vi.doMock('../ui', () => ({
      CommentPillInput: (props: { value?: string }) => {
        commentInputs.push(props);
        return React.createElement('input', { value: props.value, readOnly: true });
      },
      IconButton: (props: { label: string; onClick?: () => void }) => (
        React.createElement('button', { type: 'button', onClick: props.onClick }, props.label)
      )
    }));

    try {
      const { CanvasFeedbackBar: MockedCanvasFeedbackBar } = await import('./CanvasFeedbackBar');
      const { I18nProvider: MockedI18nProvider } = await import('../i18n');

      renderStaticWithProvider(
        <MockedCanvasFeedbackBar
          projectRelativePath="flow/cover.png"
          entry={{
            projectRelativePath: 'flow/cover.png',
            marks: [],
            comments: [{
              id: 'comment-1',
              comment: 'old comment',
              createdAt: '2026-05-26T12:00:00.000Z',
              updatedAt: '2026-05-26T12:00:00.000Z'
            }],
            nextRegionLabel: 1,
            regions: [],
            updatedAt: '2026-05-26T12:00:00.000Z'
          }}
          onUpdate={async () => true}
          overlayRuntime={createCanvasOverlayRuntime()}
        />,
        MockedI18nProvider
      );

      expect(commentInputs).toHaveLength(1);
      expect(commentInputs[0]!.value).toBe('');
    } finally {
      vi.doUnmock('../ui');
      vi.resetModules();
    }
  });

  it('deletes saved file-level comments when their display close button is activated', async () => {
    const buttons: Array<{ label: string; onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void }> = [];
    vi.resetModules();
    vi.doMock('../ui', () => ({
      CommentPillInput: (props: { value?: string }) => React.createElement('input', { value: props.value, readOnly: true }),
      IconButton: (props: { label: string; onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void }) => {
        buttons.push(props);
        return React.createElement('button', { type: 'button' }, props.label);
      }
    }));

    try {
      const { CanvasFeedbackBar: MockedCanvasFeedbackBar } = await import('./CanvasFeedbackBar');
      const { I18nProvider: MockedI18nProvider } = await import('../i18n');
      const updates: unknown[] = [];

      renderStaticWithProvider(
        <MockedCanvasFeedbackBar
          projectRelativePath="flow/cover.png"
          entry={{
            projectRelativePath: 'flow/cover.png',
            marks: [],
            comments: [{
              id: 'comment-1',
              comment: 'old comment',
              createdAt: '2026-05-26T12:00:00.000Z',
              updatedAt: '2026-05-26T12:00:00.000Z'
            }],
            nextRegionLabel: 1,
            regions: [],
            updatedAt: '2026-05-26T12:00:00.000Z'
          }}
          onUpdate={async (input) => {
            updates.push(input);
            return true;
          }}
          overlayRuntime={createCanvasOverlayRuntime()}
        />,
        MockedI18nProvider
      );

      buttons.find((button) => button.label === 'Delete file-level comment for flow/cover.png')!.onClick?.({
        preventDefault: () => undefined,
        stopPropagation: () => undefined
      } as React.MouseEvent<HTMLButtonElement>);

      expect(updates).toEqual([{
        operation: 'delete-comment',
        projectRelativePath: 'flow/cover.png',
        commentId: 'comment-1'
      }]);
    } finally {
      vi.doUnmock('../ui');
      vi.resetModules();
    }
  });
});
