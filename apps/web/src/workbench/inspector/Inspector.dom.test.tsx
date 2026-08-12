import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  ModelArtifactProvenanceLookup,
  ProjectPathInspection
} from '@debrute/app-protocol';
import type { WorkbenchActions, WorkbenchState } from '../../types';
import { I18nProvider } from '../i18n';
import { Inspector } from './Inspector';
import type { InspectionTargetSnapshot } from './inspectionTarget';

describe('Inspector', () => {
  it('shows only the empty state when nothing is selected', () => {
    const html = renderStatic(target({ kind: 'empty' }), actions());

    expect(html).toContain('Select a Project path or Canvas node.');
    expect(html).not.toContain('Diagnostics');
    expect(html).not.toContain('AI Generation Record');
  });

  it('shows only the selection count for multiple selections', () => {
    const html = renderStatic(target({ kind: 'multiple', count: 3 }), actions());

    expect(html).toContain('3 selected');
    expect(html).not.toContain('<dl');
    expect(html).not.toContain('Files');
    expect(html).not.toContain('Manual Layout');
  });

  it('progressively shows file information without Canvas or MIME fields', async () => {
    const api = actions({
      inspectProjectPath: vi.fn(async (): Promise<ProjectPathInspection> => ({
        kind: 'file',
        projectRelativePath: 'media/cover.final.png',
        sizeBytes: 1_436_221,
        createdAtMs: Date.UTC(2026, 0, 2, 3, 4, 5),
        modifiedAtMs: Date.UTC(2026, 1, 3, 4, 5, 6),
        media: { kind: 'image', dimensions: { width: 1920, height: 1080 } }
      }))
    });
    const rendered = await render(target({
      kind: 'single',
      projectRelativePath: 'media/cover.final.png'
    }), api);

    try {
      expect(rendered.container.textContent).toContain('cover.final.png');
      expect(rendered.container.textContent).toContain('File Information');
      expect(rendered.container.textContent).toContain('media/cover.final.png');
      expect(rendered.container.textContent).toContain('PNG');
      expect(rendered.container.textContent).toContain('1.37 MiB (1,436,221 bytes)');
      expect(rendered.container.textContent).toContain('1920 × 1080 px');
      expect(rendered.container.textContent).toContain('AI Generation Record');
      expect(rendered.container.textContent).not.toContain('MIME');
      expect(rendered.container.textContent).not.toContain('Position');
      expect(rendered.container.textContent).not.toContain('Diagnostics');
    } finally {
      await rendered.unmount();
    }
  });

  it('keeps a late result from replacing the current target', async () => {
    let resolveFirst: ((value: ProjectPathInspection) => void) | undefined;
    const inspectProjectPath = vi.fn((input: { projectRelativePath: string }) => (
      input.projectRelativePath === 'first.mov'
        ? new Promise<ProjectPathInspection>((resolve) => { resolveFirst = resolve; })
        : Promise.resolve<ProjectPathInspection>({
            kind: 'file',
            projectRelativePath: 'second.wav',
            sizeBytes: 20,
            media: { kind: 'other' }
          })
    ));
    const rendered = await render(target({
      kind: 'single',
      projectRelativePath: 'first.mov'
    }), actions({ inspectProjectPath }));

    try {
      await rendered.rerender(target({
        kind: 'single',
        projectRelativePath: 'second.wav'
      }, 2));
      expect(rendered.container.textContent).toContain('second.wav');
      expect(rendered.container.textContent).not.toContain('first.mov');

      await act(async () => {
        resolveFirst?.({
          kind: 'file',
          projectRelativePath: 'first.mov',
          sizeBytes: 999,
          media: { kind: 'video', sourceToken: 'first' }
        });
        await Promise.resolve();
      });
      expect(rendered.container.textContent).toContain('second.wav');
      expect(rendered.container.textContent).not.toContain('999');
    } finally {
      await rendered.unmount();
    }
  });

  it('loads AI Generation Record only while its disclosure is open', async () => {
    const lookupModelArtifactProvenance = vi.fn(async () => ({
      sha256: 'sha256-current',
      record: null
    }));
    const rendered = await render(target({
      kind: 'single',
      projectRelativePath: 'generated/output.png'
    }), actions({ lookupModelArtifactProvenance }));

    try {
      expect(lookupModelArtifactProvenance).not.toHaveBeenCalled();
      const disclosure = rendered.container.querySelector('details');
      expect(disclosure).toBeInstanceOf(HTMLDetailsElement);
      await act(async () => {
        disclosure!.open = true;
        disclosure!.dispatchEvent(new Event('toggle'));
        await Promise.resolve();
      });
      expect(lookupModelArtifactProvenance).toHaveBeenCalledWith(
        { projectRelativePath: 'generated/output.png' },
        expect.any(AbortSignal)
      );
      expect(rendered.container.textContent).not.toContain('sha256-current');
      expect(rendered.container.textContent).not.toContain('No matching generation record');

      await act(async () => {
        disclosure!.open = false;
        disclosure!.dispatchEvent(new Event('toggle'));
        await Promise.resolve();
      });
      expect(rendered.container.textContent).not.toContain('sha256-current');
    } finally {
      await rendered.unmount();
    }
  });

  it('does not restore a lookup result that finishes as the disclosure closes', async () => {
    let resolveLookup: ((value: ModelArtifactProvenanceLookup) => void) | undefined;
    const lookupModelArtifactProvenance = vi.fn(() => (
      new Promise<ModelArtifactProvenanceLookup>((resolve) => { resolveLookup = resolve; })
    ));
    const rendered = await render(target({
      kind: 'single',
      projectRelativePath: 'generated/output.png'
    }), actions({ lookupModelArtifactProvenance }));

    try {
      const disclosure = rendered.container.querySelector('details');
      expect(disclosure).toBeInstanceOf(HTMLDetailsElement);
      await act(async () => {
        disclosure!.open = true;
        disclosure!.dispatchEvent(new Event('toggle'));
        await Promise.resolve();
      });

      await act(async () => {
        disclosure!.open = false;
        disclosure!.dispatchEvent(new Event('toggle'));
        resolveLookup?.({
          sha256: 'late-sha256',
          record: {
            operationId: 'operation',
            itemIndex: 0,
            artifactIndex: 0,
            outputPath: 'generated/output.png',
            createdAt: '2026-01-01T00:00:00.000Z',
            mimeType: 'image/png',
            request: {},
            response: { output: {}, trace: [] }
          }
        });
        await Promise.resolve();
      });

      expect(rendered.container.textContent).not.toContain('late-sha256');
    } finally {
      await rendered.unmount();
    }
  });

  it('does not let an old same-path lookup clear the reopened loading state', async () => {
    const resolvers: Array<(value: ModelArtifactProvenanceLookup) => void> = [];
    const lookupModelArtifactProvenance = vi.fn(() => (
      new Promise<ModelArtifactProvenanceLookup>((resolve) => { resolvers.push(resolve); })
    ));
    const rendered = await render(target({
      kind: 'single',
      projectRelativePath: 'generated/output.png'
    }), actions({ lookupModelArtifactProvenance }));

    try {
      const disclosure = rendered.container.querySelector('details');
      expect(disclosure).toBeInstanceOf(HTMLDetailsElement);
      await toggleDisclosure(disclosure!, true);
      expect(rendered.container.textContent).toContain('Loading');

      await toggleDisclosure(disclosure!, false);
      await toggleDisclosure(disclosure!, true);
      expect(lookupModelArtifactProvenance).toHaveBeenCalledTimes(2);
      expect(rendered.container.textContent).toContain('Loading');

      await act(async () => {
        resolvers[0]?.({ sha256: 'old', record: null });
        await Promise.resolve();
      });
      expect(rendered.container.textContent).toContain('Loading');

      await act(async () => {
        resolvers[1]?.({ sha256: 'current', record: null });
        await Promise.resolve();
      });
      expect(rendered.container.textContent).not.toContain('Loading');
    } finally {
      await rendered.unmount();
    }
  });
});

async function toggleDisclosure(disclosure: HTMLDetailsElement, open: boolean): Promise<void> {
  await act(async () => {
    disclosure.open = open;
    disclosure.dispatchEvent(new Event('toggle'));
    await Promise.resolve();
  });
}

function target(
  value: InspectionTargetSnapshot['target'],
  version = 1
): InspectionTargetSnapshot {
  return { target: value, version };
}

function state(): WorkbenchState {
  return {
    snapshot: {
      canonicalRoot: '/project',
      projectTree: [],
      canvasWorkspace: { status: 'unavailable', code: 'canvas_workspace_invalid', message: '' },
      diagnostics: [],
      health: {
        projectName: 'Example Project',
        diagnosticCounts: { errors: 0, warnings: 0 },
        checkedAt: '2026-01-01T00:00:00.000Z'
      }
    }
  } as unknown as WorkbenchState;
}

function actions(overrides: Partial<WorkbenchActions> = {}): WorkbenchActions {
  return {
    inspectProjectPath: async ({ projectRelativePath }) => ({
      kind: 'file',
      projectRelativePath,
      sizeBytes: 1,
      media: { kind: 'other' }
    }),
    resolveProjectFileSource: async ({ projectRelativePath }) => ({
      projectRelativePath,
      sourceRevision: 'revision',
      fileUrl: '/file'
    }),
    lookupModelArtifactProvenance: async () => ({ sha256: 'hash', record: null }),
    ...overrides
  } as WorkbenchActions;
}

function renderStatic(
  inspectionTarget: InspectionTargetSnapshot,
  workbenchActions: WorkbenchActions
): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en">
      <Inspector target={inspectionTarget} state={state()} actions={workbenchActions} />
    </I18nProvider>
  );
}

async function render(
  inspectionTarget: InspectionTargetSnapshot,
  workbenchActions: WorkbenchActions
): Promise<{
  container: HTMLDivElement;
  rerender(nextTarget: InspectionTargetSnapshot): Promise<void>;
  unmount(): Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const renderTarget = async (nextTarget: InspectionTargetSnapshot) => {
    await act(async () => {
      root.render(
        <I18nProvider locale="en">
          <Inspector target={nextTarget} state={state()} actions={workbenchActions} />
        </I18nProvider>
      );
      await Promise.resolve();
    });
  };
  await renderTarget(inspectionTarget);
  return {
    container,
    rerender: renderTarget,
    unmount: async () => unmount(root, container)
  };
}

async function unmount(root: Root, container: HTMLElement): Promise<void> {
  await act(async () => root.unmount());
  container.remove();
}
