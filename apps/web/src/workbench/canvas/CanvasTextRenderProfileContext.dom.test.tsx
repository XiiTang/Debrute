import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CanvasTextRenderProfile } from './CanvasTextRenderProfile.js';
import {
  CanvasTextRenderProfileGate,
  CanvasTextRenderProfileProvider,
  useCanvasTextRenderProfile
} from './CanvasTextRenderProfileContext.js';
import { DEFAULT_CANVAS_TEXT_RENDER_PROFILE } from './DefaultCanvasTextRenderProfile.js';

describe('CanvasTextRenderProfileGate', { tags: ['canvas-text'] }, () => {
  it('publishes a profile only after its font resource is ready', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const preparation = deferred<void>();
    const profile = profileWithPreparation(preparation.promise);

    try {
      await act(async () => {
        root.render(
          <CanvasTextRenderProfileGate profile={profile} pending={<span>loading</span>}>
            <ProfileProbe />
          </CanvasTextRenderProfileGate>
        );
      });
      expect(container.textContent).toBe('loading');

      await act(async () => preparation.resolve());
      expect(container.textContent).toBe('12px');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('fails closed when font preparation rejects', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const profile = profileWithPreparation(Promise.reject(new Error('broken font asset')));

    try {
      await act(async () => {
        root.render(
          <CanvasTextRenderProfileGate profile={profile} pending={<span>loading</span>}>
            <ProfileProbe />
          </CanvasTextRenderProfileGate>
        );
      });
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('broken font asset');
      expect(container.textContent).not.toContain('12px');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('keeps the active exact profile until a replacement font resource is ready', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const replacementPreparation = deferred<void>();
    const initial = profileWithPreparation(Promise.resolve(), '12px');
    const replacement = profileWithPreparation(replacementPreparation.promise, '18px');

    try {
      await act(async () => {
        root.render(
          <CanvasTextRenderProfileGate profile={initial} pending={<span>loading</span>}>
            <ProfileProbe />
          </CanvasTextRenderProfileGate>
        );
      });
      expect(container.textContent).toBe('12px');

      await act(async () => {
        root.render(
          <CanvasTextRenderProfileGate profile={replacement} pending={<span>loading</span>}>
            <ProfileProbe />
          </CanvasTextRenderProfileGate>
        );
      });
      expect(container.textContent).toBe('12px');

      await act(async () => replacementPreparation.resolve());
      expect(container.textContent).toBe('18px');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('keeps the active profile object when a replacement has the same render identity', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const initial = profileWithPreparation(Promise.resolve(), '12px');
    const replacementPrepare = vi.fn(async () => ({ identity: 'test-font', faces: [] }));
    const replacement = {
      ...initial,
      prepare: replacementPrepare
    };
    const observed: CanvasTextRenderProfile[] = [];

    try {
      await act(async () => {
        root.render(
          <CanvasTextRenderProfileGate profile={initial} pending={<span>loading</span>}>
            <ProfileObjectProbe onProfile={(profile) => {
              observed.push(profile);
            }} />
          </CanvasTextRenderProfileGate>
        );
      });
      expect(observed.at(-1)).toBe(initial);

      await act(async () => {
        root.render(
          <CanvasTextRenderProfileGate profile={replacement} pending={<span>loading</span>}>
            <ProfileObjectProbe onProfile={(profile) => {
              observed.push(profile);
            }} />
          </CanvasTextRenderProfileGate>
        );
      });

      expect(replacementPrepare).not.toHaveBeenCalled();
      expect(observed.at(-1)).toBe(initial);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('inherits an outer active profile while a nested replacement prepares', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const replacementPreparation = deferred<void>();
    const initial = profileWithPreparation(Promise.resolve(), '12px');
    const replacement = profileWithPreparation(replacementPreparation.promise, '18px');

    try {
      await act(async () => {
        root.render(
          <CanvasTextRenderProfileGate profile={initial} pending={<span>booting</span>}>
            <CanvasTextRenderProfileGate profile={replacement} pending={<span>loading</span>}>
              <ProfileProbe />
            </CanvasTextRenderProfileGate>
          </CanvasTextRenderProfileGate>
        );
      });
      expect(container.textContent).toBe('12px');

      await act(async () => replacementPreparation.resolve());
      expect(container.textContent).toBe('18px');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('provides a profile without preparing its font resources', () => {
    const prepare = vi.fn(DEFAULT_CANVAS_TEXT_RENDER_PROFILE.prepare);
    const profile = { ...DEFAULT_CANVAS_TEXT_RENDER_PROFILE, prepare };

    expect(renderToStaticMarkup(
      <CanvasTextRenderProfileProvider profile={profile}>
        <ProfileProbe />
      </CanvasTextRenderProfileProvider>
    )).toContain(profile.resolvedTypography.fontSize);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('requires a render profile provider', () => {
    expect(() => renderToStaticMarkup(<ProfileProbe />)).toThrow(
      'CanvasTextRenderProfileProvider is required.'
    );
  });
});

function ProfileProbe(): React.ReactElement {
  const profile = useCanvasTextRenderProfile();
  return <span>{profile.resolvedTypography.fontSize}</span>;
}

function ProfileObjectProbe({
  onProfile
}: {
  onProfile(profile: CanvasTextRenderProfile): void;
}): React.ReactElement {
  const profile = useCanvasTextRenderProfile();
  React.useEffect(() => onProfile(profile), [onProfile, profile]);
  return <span>{profile.resolvedTypography.fontSize}</span>;
}

function profileWithPreparation(
  preparation: Promise<void>,
  fontSize = '12px'
): CanvasTextRenderProfile {
  return {
    ...DEFAULT_CANVAS_TEXT_RENDER_PROFILE,
    identity: `${DEFAULT_CANVAS_TEXT_RENDER_PROFILE.identity}:${fontSize}`,
    resolvedTypography: {
      ...DEFAULT_CANVAS_TEXT_RENDER_PROFILE.resolvedTypography,
      fontSize
    },
    prepare: async () => {
      await preparation;
      return { identity: 'test-font', faces: [] };
    }
  };
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
