import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKBENCH_WINDOW_ORDER,
  closeWorkbenchWindow,
  focusWorkbenchWindow,
  panelWindowIdentity,
  syncOpenWorkbenchWindows,
  textEditorWindowIdentity,
  workbenchWindowKey,
  workbenchWindowZIndex,
  type WorkbenchWindowOrderState
} from './workbenchWindowOrder';

describe('workbench window order', () => {
  it('does not focus a panel before the user opens one', () => {
    expect(DEFAULT_WORKBENCH_WINDOW_ORDER).toEqual({
      orderBackToFront: []
    });
  });

  it('focuses a window by moving it to the front', () => {
    const state: WorkbenchWindowOrderState = {
      orderBackToFront: [
        panelWindowIdentity('explorer'),
        panelWindowIdentity('inspector'),
        textEditorWindowIdentity('drafts/page.md')
      ],
      focusedWindow: textEditorWindowIdentity('drafts/page.md')
    };

    const next = focusWorkbenchWindow(state, panelWindowIdentity('explorer'));

    expect(next.orderBackToFront).toEqual([
      panelWindowIdentity('inspector'),
      textEditorWindowIdentity('drafts/page.md'),
      panelWindowIdentity('explorer')
    ]);
    expect(next.focusedWindow).toEqual(panelWindowIdentity('explorer'));
  });

  it('closes a focused window and focuses the next frontmost window', () => {
    const next = closeWorkbenchWindow({
      orderBackToFront: [
        panelWindowIdentity('explorer'),
        panelWindowIdentity('settings')
      ],
      focusedWindow: panelWindowIdentity('settings')
    }, panelWindowIdentity('settings'));

    expect(next.orderBackToFront).toEqual([panelWindowIdentity('explorer')]);
    expect(next.focusedWindow).toEqual(panelWindowIdentity('explorer'));
  });

  it('syncs the order to the current open windows while preserving known relative order', () => {
    const synced = syncOpenWorkbenchWindows({
      orderBackToFront: [
        panelWindowIdentity('explorer'),
        textEditorWindowIdentity('drafts/a.md'),
        panelWindowIdentity('settings')
      ],
      focusedWindow: panelWindowIdentity('settings')
    }, [
      panelWindowIdentity('explorer'),
      panelWindowIdentity('terminal'),
      textEditorWindowIdentity('drafts/a.md')
    ]);

    expect(synced.orderBackToFront).toEqual([
      panelWindowIdentity('explorer'),
      textEditorWindowIdentity('drafts/a.md'),
      panelWindowIdentity('terminal')
    ]);
    expect(synced.focusedWindow).toEqual(panelWindowIdentity('terminal'));
  });

  it('appends newly opened windows to the front in render order', () => {
    const synced = syncOpenWorkbenchWindows({
      orderBackToFront: [panelWindowIdentity('explorer')],
      focusedWindow: panelWindowIdentity('explorer')
    }, [
      panelWindowIdentity('explorer'),
      panelWindowIdentity('settings'),
      textEditorWindowIdentity('notes/story.md')
    ]);

    expect(synced.orderBackToFront).toEqual([
      panelWindowIdentity('explorer'),
      panelWindowIdentity('settings'),
      textEditorWindowIdentity('notes/story.md')
    ]);
    expect(synced.focusedWindow).toEqual(panelWindowIdentity('explorer'));
  });

  it('derives child z-index from back-to-front order', () => {
    const state: WorkbenchWindowOrderState = {
      orderBackToFront: [
        panelWindowIdentity('explorer'),
        textEditorWindowIdentity('drafts/a.md')
      ],
      focusedWindow: textEditorWindowIdentity('drafts/a.md')
    };

    expect(workbenchWindowZIndex(state, panelWindowIdentity('explorer'))).toBe(1);
    expect(workbenchWindowZIndex(state, textEditorWindowIdentity('drafts/a.md'))).toBe(2);
    expect(workbenchWindowZIndex(state, panelWindowIdentity('settings'))).toBe(0);
  });

  it('creates stable identity keys', () => {
    expect(workbenchWindowKey(panelWindowIdentity('settings'))).toBe('panel:settings');
    expect(workbenchWindowKey(textEditorWindowIdentity('drafts/a.md'))).toBe('text-editor:drafts/a.md');
  });
});
