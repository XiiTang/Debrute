import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { WorkbenchState } from '../types';
import type { CanvasFeedbackBarTarget, CanvasLocalFeedbackDraft } from './shell/floatingBars';
import { chooseInitialActiveCanvasId } from './canvas/canvasCardBarState';
import { sameCanvasFeedbackBarTarget } from './shell/floatingBars';

describe('WorkbenchApp feedback bar target equality', () => {
  it('requires local feedback drafts to carry the confirming image feedback target', () => {
    expectTypeOf<CanvasLocalFeedbackDraft['feedbackBarTarget']>().toEqualTypeOf<CanvasFeedbackBarTarget>();
  });

  it('treats equal feedback bar targets as unchanged', () => {
    const target = feedbackTarget();

    expect(sameCanvasFeedbackBarTarget(target, {
      ...target,
      nodeRect: { ...target.nodeRect },
      surfaceRect: { ...target.surfaceRect },
      camera: { ...target.camera },
      entry: target.entry ? {
        ...target.entry,
        marks: [...target.entry.marks],
        items: [...target.entry.items]
      } : undefined
    })).toBe(true);
  });

  it('detects feedback bar target camera changes', () => {
    const target = feedbackTarget();

    expect(sameCanvasFeedbackBarTarget(target, {
      ...target,
      camera: { ...target.camera, z: 0.5 }
    })).toBe(false);
  });

  it('detects feedback bar target local toolset changes', () => {
    const target = feedbackTarget();

    expect(sameCanvasFeedbackBarTarget(target, {
      ...target,
      localToolset: 'none'
    })).toBe(false);
  });

  it('carries the confirming target on local feedback drafts', () => {
    const draftTarget = feedbackTarget('flow/b.png');
    const draft: CanvasLocalFeedbackDraft = {
      projectRelativePath: 'flow/b.png',
      kind: 'pin',
      scope: 'file',
      geometry: { type: 'point', x: 0.4, y: 0.5 },
      feedbackBarTarget: draftTarget
    };

    expect(draft.feedbackBarTarget).toBe(draftTarget);
  });
});

describe('WorkbenchApp canvas registry integration helpers', () => {
  it('restores the stored active canvas for the current project when present', () => {
    expect(chooseInitialActiveCanvasId({
      storedActiveCanvasId: 'canvas-2',
      canvasOrder: ['canvas-1', 'canvas-2']
    })).toBe('canvas-2');
  });
});

describe('WorkbenchApp title bar contracts', () => {
  it('keeps title-bar state in WorkbenchState', () => {
    type HasTitleBarState = WorkbenchState extends { titleBarState: unknown } ? true : false;
    const check: HasTitleBarState = true;
    expect(check).toBe(true);
  });

  it('does not locally rebuild enabled title-bar menus when runtime state is unavailable', () => {
    const source = readFileSync(join(process.cwd(), 'apps/web/src/workbench/WorkbenchApp.tsx'), 'utf8');

    expect(source).not.toContain("useState<NodeJS.Platform>('linux')");
    expect(source).not.toContain('titleBarState ?? buildWorkbenchTitleBarState');
    expect(source).not.toContain('setTitleBarState(buildWorkbenchTitleBarState');
  });

  it('keeps title-bar request failures inside title-bar refresh', () => {
    const source = readFileSync(join(process.cwd(), 'apps/web/src/workbench/WorkbenchApp.tsx'), 'utf8');
    const refreshBody = source.slice(
      source.indexOf('const refreshTitleBarState = useCallback'),
      source.indexOf('const chooseActiveCanvasForProject')
    );

    expect(refreshBody).toContain('setTitleBarState(unavailableWorkbenchTitleBarState())');
    expect(refreshBody).toContain('shell.notifications.titleBarStateFailed');
    expect(source).not.toContain('void refreshTitleBarState().catch');
  });

  it('keeps explicit route loading copy scoped to opening a project', () => {
    const source = readFileSync(join(process.cwd(), 'apps/web/src/workbench/WorkbenchApp.tsx'), 'utf8');

    expect(source).not.toContain('Opening Debrute workbench');
    expect(source).not.toContain('Opening Explorer');
    expect(source).toContain('shell.boot.openingProject');
  });
});

describe('WorkbenchApp appearance theme contracts', () => {
  it('keeps resolved theme in WorkbenchState', () => {
    type HasResolvedTheme = WorkbenchState extends { resolvedTheme: 'dark' | 'light' } ? true : false;
    const check: HasResolvedTheme = true;
    expect(check).toBe(true);
  });

  it('does not hard-code dark theme on the Workbench shell', () => {
    const source = readFileSync(join(process.cwd(), 'apps/web/src/workbench/WorkbenchApp.tsx'), 'utf8');

    expect(source).not.toContain('data-theme="dark"');
    expect(source).toContain('data-theme={resolvedTheme}');
    expect(source).toContain('setDocumentTheme(resolvedTheme)');
    expect(source).toContain('resolvedTheme={resolvedTheme}');
  });

  it('handles full Workbench preferences instead of locale-only state', () => {
    const source = readFileSync(join(process.cwd(), 'apps/web/src/workbench/WorkbenchApp.tsx'), 'utf8');

    expect(source).toContain('parseWorkbenchThemePreference(preferences.themePreference)');
    expect(source).toContain('setThemePreference(nextThemePreference)');
    expect(source).toContain('subscribeSystemThemeChanges(setResolvedTheme)');
    expect(source).not.toContain('setWorkbenchPreferences({ locale: nextLocale })');
  });
});

function feedbackTarget(projectRelativePath = 'flow/a.png'): CanvasFeedbackBarTarget {
  return {
    projectRelativePath,
    nodeRect: { x: 10, y: 20, width: 300, height: 180 },
    surfaceRect: { x: 0, y: 0, width: 1280, height: 720 },
    camera: { x: 12, y: 24, z: 1 },
    localToolset: 'image',
    canStartVideoMomentFeedback: false,
    entry: {
      projectRelativePath,
      marks: ['needs_revision'],
      nextMomentLabel: 1,
      nextSpatialLabel: 1,
      items: [{
        id: 'comment-1',
        kind: 'comment',
        scope: 'file',
        comment: 'Needs revision',
        createdAt: '2026-06-08T00:00:00.000Z',
        updatedAt: '2026-06-08T00:00:00.000Z'
      }],
      updatedAt: '2026-06-08T00:00:00.000Z'
    }
  };
}
