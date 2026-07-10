import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CanvasFeedbackEntry } from '@debrute/canvas-core';
import { CanvasFeedbackBar } from './CanvasFeedbackBar';
import { createCanvasOverlayRuntime } from './CanvasOverlayRuntime';
import { I18nProvider } from '../i18n';

const NOW = '2026-05-26T12:00:00.000Z';

function renderStaticWithI18n(element: React.ReactElement): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en">
      {element}
    </I18nProvider>
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
    expect(html).not.toContain('canvas-feedback-comment-strip');
  });

  it('renders image and video local toolsets from the same bar component', () => {
    const imageHtml = renderStaticWithI18n(
      <CanvasFeedbackBar
        projectRelativePath="flow/cover.png"
        entry={undefined}
        onUpdate={async () => true}
        overlayRuntime={createCanvasOverlayRuntime()}
        localToolset="image"
        localFeedbackMode="pin"
        onLocalFeedbackModeChange={() => undefined}
      />
    );
    const videoHtml = renderStaticWithI18n(
      <CanvasFeedbackBar
        projectRelativePath="flow/shot.mp4"
        entry={undefined}
        onUpdate={async () => true}
        overlayRuntime={createCanvasOverlayRuntime()}
        localToolset="video"
        canStartVideoMomentFeedback
        onStartVideoMomentFeedback={() => undefined}
      />
    );

    expect(imageHtml).toContain('aria-label="Image region feedback tools"');
    expect(videoHtml).toContain('aria-label="Video moment feedback tools"');
    expect(videoHtml).toContain('aria-label="Add moment comment"');
  });

  it('uses the first-row creator for a pending feedback item', () => {
    const html = renderStaticWithI18n(
      <CanvasFeedbackBar
        projectRelativePath="flow/cover.png"
        entry={undefined}
        onUpdate={async () => true}
        overlayRuntime={createCanvasOverlayRuntime()}
        localToolset="image"
        localFeedbackMode="pin"
        onLocalFeedbackModeChange={() => undefined}
        pendingItemLabel={3}
        pendingItemComment="new annotation"
        onPendingItemCommentChange={() => undefined}
        onSavePendingItem={() => undefined}
        onCancelPendingItem={() => undefined}
      />
    );

    expect(html).toContain('canvas-feedback-comment-creator');
    expect(html).toContain('aria-label="New annotation comment for flow/cover.png"');
    expect(html).toContain('value="new annotation"');
    expect(html).toContain('autofocus=""');
    expect(html).not.toContain('canvas-feedback-comment-strip');
  });

  it('keeps spatial tools in placement mode until geometry is ready for a comment', () => {
    const html = renderStaticWithI18n(
      <CanvasFeedbackBar
        projectRelativePath="flow/shot.mp4"
        entry={undefined}
        onUpdate={async () => true}
        overlayRuntime={createCanvasOverlayRuntime()}
        localToolset="video"
        localFeedbackMode="pin"
        canStartVideoMomentFeedback
        pendingItemLabel={3}
        pendingItemComment="new annotation"
        pendingItemReadyForComment={false}
        onPendingItemCommentChange={() => undefined}
        onSavePendingItem={() => undefined}
        onCancelPendingItem={() => undefined}
      />
    );

    expect(html).toContain('aria-label="New file-level comment for flow/shot.mp4"');
    expect(html).not.toContain('aria-label="New annotation comment for flow/shot.mp4"');
    expect(html).not.toContain('value="new annotation"');
    expect(html).not.toContain('autofocus=""');
  });

  it('renders one pill per saved feedback item with moment coloring and spatial labels', () => {
    const html = renderStaticWithI18n(
      <CanvasFeedbackBar
        projectRelativePath="flow/shot.mp4"
        entry={entryFixture()}
        onUpdate={async () => true}
        overlayRuntime={createCanvasOverlayRuntime()}
        localToolset="video"
        canStartVideoMomentFeedback
      />
    );

    expect(html).toContain('canvas-feedback-comment-strip');
    expect(html).toContain('overall direction');
    expect(html).toContain('face is blurry');
    expect(html).toContain('pause here');
    expect(html).toContain('data-canvas-feedback-region-label="1"');
    expect(html).toContain('data-canvas-feedback-moment="M1"');
    expect(html).toContain('--canvas-feedback-moment-color:#2563eb');
    expect(html).toContain('db-workbench-close-button');
    expect(html).toContain('canvas-feedback-comment-pill-close');
  });

  it('saves creator text as a new file-level item', async () => {
    const commentInputs: Array<{
      value?: string;
      onChange?: (event: { currentTarget: { value: string } }) => void;
      onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
    }> = [];
    vi.resetModules();
    vi.doMock('../ui', () => ({
      CommentPillInput: (props: {
        value?: string;
        onChange?: (event: { currentTarget: { value: string } }) => void;
        onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
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

      renderToStaticMarkup(
        <MockedI18nProvider locale="en">
          <MockedCanvasFeedbackBar
            projectRelativePath="flow/cover.png"
            entry={undefined}
            onUpdate={async (input) => {
              updates.push(input);
              return true;
            }}
            overlayRuntime={createCanvasOverlayRuntime()}
          />
        </MockedI18nProvider>
      );

      commentInputs[0]!.onChange?.({ currentTarget: { value: '  overall direction  ' } });
      commentInputs[0]!.onKeyDown?.({ key: 'Enter', preventDefault: () => undefined });

      expect(updates.at(-1)).toEqual({
        operation: 'add-item',
        projectRelativePath: 'flow/cover.png',
        item: {
          kind: 'comment',
          scope: 'file',
          comment: 'overall direction'
        }
      });
    } finally {
      vi.doUnmock('../ui');
      vi.resetModules();
    }
  });

  it('saves pending item text through the pending item callback', async () => {
    const commentInputs: Array<{
      value?: string;
      onChange?: (event: { currentTarget: { value: string } }) => void;
      onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
    }> = [];
    vi.resetModules();
    vi.doMock('../ui', () => ({
      CommentPillInput: (props: {
        value?: string;
        onChange?: (event: { currentTarget: { value: string } }) => void;
        onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
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
      const onPendingItemCommentChange = vi.fn();
      const onSavePendingItem = vi.fn();

      renderToStaticMarkup(
        <MockedI18nProvider locale="en">
          <MockedCanvasFeedbackBar
            projectRelativePath="flow/cover.png"
            entry={undefined}
            onUpdate={async () => true}
            overlayRuntime={createCanvasOverlayRuntime()}
            pendingItemLabel={3}
            pendingItemComment="new annotation"
            onPendingItemCommentChange={onPendingItemCommentChange}
            onSavePendingItem={onSavePendingItem}
            onCancelPendingItem={() => undefined}
          />
        </MockedI18nProvider>
      );

      commentInputs[0]!.onChange?.({ currentTarget: { value: ' sharper face ' } });
      commentInputs[0]!.onKeyDown?.({ key: 'Enter', preventDefault: () => undefined });

      expect(onPendingItemCommentChange).toHaveBeenCalledWith(' sharper face ');
      expect(onSavePendingItem).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('../ui');
      vi.resetModules();
    }
  });

  it('does not submit the same pending item text twice before the save resolves', async () => {
    const commentInputs: Array<{
      value?: string;
      onChange?: (event: { currentTarget: { value: string } }) => void;
      onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
      onBlur?: () => void;
    }> = [];
    vi.resetModules();
    vi.doMock('../ui', () => ({
      CommentPillInput: (props: {
        value?: string;
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
      let resolveSave: (saved: boolean) => void = () => undefined;
      const pendingSave = new Promise<boolean>((resolve) => {
        resolveSave = resolve;
      });
      const onSavePendingItem = vi.fn(() => pendingSave);

      renderToStaticMarkup(
        <MockedI18nProvider locale="en">
          <MockedCanvasFeedbackBar
            projectRelativePath="flow/cover.png"
            entry={undefined}
            onUpdate={async () => true}
            overlayRuntime={createCanvasOverlayRuntime()}
            pendingItemLabel={3}
            pendingItemComment="new annotation"
            onPendingItemCommentChange={() => undefined}
            onSavePendingItem={onSavePendingItem}
            onCancelPendingItem={() => undefined}
          />
        </MockedI18nProvider>
      );

      commentInputs[0]!.onKeyDown?.({ key: 'Enter', preventDefault: () => undefined });
      commentInputs[0]!.onBlur?.();

      expect(onSavePendingItem).toHaveBeenCalledTimes(1);

      resolveSave(true);
      await pendingSave;
    } finally {
      vi.doUnmock('../ui');
      vi.resetModules();
    }
  });

  it('deletes saved feedback items by item id', async () => {
    const buttons: Array<{ label: string; onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void }> = [];
    vi.resetModules();
    vi.doMock('../ui', () => ({
      CommentPillInput: (props: { value?: string }) => React.createElement('input', { value: props.value, readOnly: true }),
      IconButton: (props: { label: string; onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void }) => (
        React.createElement('button', { type: 'button', onClick: props.onClick }, props.label)
      ),
      CloseButton: (props: { label: string; onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void }) => {
        buttons.push(props);
        return React.createElement('button', { type: 'button' }, props.label);
      }
    }));

    try {
      const { CanvasFeedbackBar: MockedCanvasFeedbackBar } = await import('./CanvasFeedbackBar');
      const { I18nProvider: MockedI18nProvider } = await import('../i18n');
      const updates: unknown[] = [];

      renderToStaticMarkup(
        <MockedI18nProvider locale="en">
          <MockedCanvasFeedbackBar
            projectRelativePath="flow/shot.mp4"
            entry={entryFixture()}
            onUpdate={async (input) => {
              updates.push(input);
              return true;
            }}
            overlayRuntime={createCanvasOverlayRuntime()}
          />
        </MockedI18nProvider>
      );

      buttons.find((button) => button.label === 'Delete feedback item')!.onClick?.({
        preventDefault: () => undefined,
        stopPropagation: () => undefined
      } as React.MouseEvent<HTMLButtonElement>);

      expect(updates).toEqual([{
        operation: 'delete-item',
        projectRelativePath: 'flow/shot.mp4',
        itemId: 'comment-1'
      }]);
    } finally {
      vi.doUnmock('../ui');
      vi.resetModules();
    }
  });
});

function entryFixture(): CanvasFeedbackEntry {
  return {
    projectRelativePath: 'flow/shot.mp4',
    marks: [],
    nextMomentLabel: 2,
    nextSpatialLabel: 2,
    items: [{
      id: 'comment-1',
      kind: 'comment',
      scope: 'file',
      comment: 'overall direction',
      createdAt: NOW,
      updatedAt: NOW
    }, {
      id: 'region-1',
      label: 1,
      kind: 'pin',
      scope: 'moment',
      moment: { label: 'M1', currentTimeSeconds: 12.345 },
      geometry: { type: 'point', x: 0.2, y: 0.3 },
      comment: 'face is blurry',
      createdAt: NOW,
      updatedAt: NOW
    }, {
      id: 'comment-2',
      kind: 'comment',
      scope: 'moment',
      moment: { label: 'M1', currentTimeSeconds: 12.345 },
      comment: 'pause here',
      createdAt: NOW,
      updatedAt: NOW
    }],
    updatedAt: NOW
  };
}
