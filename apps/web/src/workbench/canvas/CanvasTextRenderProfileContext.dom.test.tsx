import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasTextRenderProfile } from './CanvasTextRenderProfile.js';
import {
  CanvasTextRenderProfileGate,
  CanvasTextRenderProfileProvider,
  useCanvasTextRenderProfile
} from './CanvasTextRenderProfileContext.js';
import { DEFAULT_CANVAS_TEXT_RENDER_PROFILE } from './CanvasTextRenderProfile.test-support.js';

const environmentMock = vi.hoisted(() => ({
  prepareInteractive: vi.fn(),
  preparations: new WeakMap<object, Promise<void>>(),
  activeProfile: undefined as CanvasTextRenderProfile | undefined,
  environment: undefined as unknown as {
    prepareInteractive: ReturnType<typeof vi.fn>;
    readonly activeInteractiveProfile: CanvasTextRenderProfile | undefined;
  }
}));
environmentMock.environment = {
  prepareInteractive: environmentMock.prepareInteractive,
  get activeInteractiveProfile() {
    return environmentMock.activeProfile;
  }
};

vi.mock('./font-subset/CanvasTextProjectFontEnvironment.js', () => ({
  useCanvasTextProjectFontEnvironment: () => environmentMock.environment
}));

beforeEach(() => {
  environmentMock.prepareInteractive.mockReset();
  environmentMock.activeProfile = undefined;
  environmentMock.prepareInteractive.mockImplementation((profile: object) => (
    environmentMock.preparations.get(profile) ?? Promise.resolve()
  ));
});

describe('CanvasTextRenderProfileGate', { tags: ['canvas-text'] }, () => {
  it('does not treat a profile-only provider as an interactive font readiness gate', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const profile = profileWithPreparation(Promise.resolve());
    try {
      await act(async () => {
        root.render(
          <CanvasTextRenderProfileProvider profile={profile}>
            <CanvasTextRenderProfileGate profile={profile} pending={<span>loading</span>}>
              <ProfileProbe />
            </CanvasTextRenderProfileGate>
          </CanvasTextRenderProfileProvider>
        );
      });

      expect(environmentMock.prepareInteractive).toHaveBeenCalledWith(profile);
      expect(container.textContent).toBe('12px');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('publishes a profile only after its font resource is ready', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const preparation = deferred<void>();
    const profile = profileWithPreparation(preparation.promise);
    const onReady = vi.fn();

    try {
      await act(async () => {
        root.render(
          <CanvasTextRenderProfileGate
            profile={profile}
            pending={<span>loading</span>}
            onReady={onReady}
          >
            <ProfileProbe />
          </CanvasTextRenderProfileGate>
        );
      });
      expect(container.textContent).toBe('loading');
      expect(onReady).not.toHaveBeenCalled();

      await act(async () => preparation.resolve());
      expect(container.textContent).toBe('12px');
      expect(onReady).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('fails closed when font preparation rejects', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const failure = new Error('broken font asset');
    const profile = profileWithPreparation(Promise.reject(failure));
    const onError = vi.fn();

    try {
      await act(async () => {
        root.render(
          <CanvasTextRenderProfileGate
            profile={profile}
            pending={<span>loading</span>}
            onError={onError}
          >
            <ProfileProbe />
          </CanvasTextRenderProfileGate>
        );
      });
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('broken font asset');
      expect(container.textContent).not.toContain('12px');
      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(failure);
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

  it('keeps the project active profile for a newly mounted gate when replacement fails', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const initial = profileWithPreparation(Promise.resolve(), '12px');
    const replacement = profileWithPreparation(
      Promise.reject(new Error('replacement failed')),
      '18px'
    );
    environmentMock.activeProfile = initial;
    const onError = vi.fn();

    try {
      await act(async () => {
        root.render(
          <CanvasTextRenderProfileGate
            profile={replacement}
            pending={<span>loading</span>}
            onError={onError}
          >
            <ProfileProbe />
          </CanvasTextRenderProfileGate>
        );
      });

      expect(container.textContent).toBe('12px');
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('keeps children pending until the exact requested profile is ready when required', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const preparation = deferred<void>();
    const initial = profileWithPreparation(Promise.resolve(), '12px');
    const replacement = profileWithPreparation(preparation.promise, '18px');
    environmentMock.activeProfile = initial;
    const onReady = vi.fn();

    try {
      await act(async () => {
        root.render(
          <CanvasTextRenderProfileGate
            profile={replacement}
            pending={<span>loading</span>}
            requireExactProfile
            onReady={onReady}
          >
            <ProfileProbe />
          </CanvasTextRenderProfileGate>
        );
      });

      expect(container.textContent).toBe('loading');
      expect(onReady).not.toHaveBeenCalled();

      await act(async () => preparation.resolve());

      expect(container.textContent).toBe('18px');
      expect(onReady).toHaveBeenCalledOnce();
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
    const replacement = {
      ...initial
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

      expect(environmentMock.prepareInteractive).toHaveBeenCalledTimes(1);
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
    const profile = DEFAULT_CANVAS_TEXT_RENDER_PROFILE;

    expect(renderToStaticMarkup(
      <CanvasTextRenderProfileProvider profile={profile}>
        <ProfileProbe />
      </CanvasTextRenderProfileProvider>
    )).toContain(profile.resolvedTypography.fontSize);
    expect(environmentMock.prepareInteractive).not.toHaveBeenCalled();
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
  const profile: CanvasTextRenderProfile = {
    ...DEFAULT_CANVAS_TEXT_RENDER_PROFILE,
    identity: `${DEFAULT_CANVAS_TEXT_RENDER_PROFILE.identity}:${fontSize}`,
    resolvedTypography: {
      ...DEFAULT_CANVAS_TEXT_RENDER_PROFILE.resolvedTypography,
      fontSize
    }
  };
  environmentMock.preparations.set(profile, preparation);
  return profile;
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
