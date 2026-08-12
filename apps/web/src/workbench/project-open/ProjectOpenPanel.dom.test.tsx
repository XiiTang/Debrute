import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { ProjectOpenPanel } from './ProjectOpenPanel';

describe('ProjectOpenPanel responsive Recent paths', () => {
  let container: HTMLDivElement;
  let root: Root;
  let resizeCallback: ResizeObserverCallback;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('uses the compact middle-ellipsis path only when the full path overflows', async () => {
    await act(async () => {
      root.render(
        <I18nProvider locale="en">
          <ProjectOpenPanel
            opening={false}
            platform="darwin"
            recentProjectRoots={['/Users/tester/Clients/Acme/Website']}
            userHome="/Users/tester"
            onOpenProject={() => undefined}
            onOpenRecentProject={() => undefined}
          />
        </I18nProvider>
      );
    });

    const path = container.querySelector<HTMLElement>('.project-open-panel__recent-project-path');
    const value = container.querySelector<HTMLElement>('.project-open-panel__recent-project-path-value');
    const measurements = container.querySelectorAll<HTMLElement>('.project-open-panel__recent-project-path-measure');
    const fullMeasurement = measurements.item(0);
    const compactMeasurement = measurements.item(1);
    if (!path || !value || !fullMeasurement || !compactMeasurement) {
      throw new Error('Expected a responsive Recent Project path.');
    }

    let availableWidth = 120;
    Object.defineProperty(path, 'clientWidth', {
      configurable: true,
      get: () => availableWidth
    });
    fullMeasurement.getBoundingClientRect = () => ({ width: 180 } as DOMRect);
    compactMeasurement.getBoundingClientRect = () => ({ width: 90 } as DOMRect);

    await act(async () => resizeCallback([], {} as ResizeObserver));
    expect(value.textContent).toBe('~/…/Acme');

    availableWidth = 220;
    await act(async () => resizeCallback([], {} as ResizeObserver));
    expect(value.textContent).toBe('~/Clients/Acme');

    availableWidth = 70;
    await act(async () => resizeCallback([], {} as ResizeObserver));
    expect(value.textContent).toBe('');
  });
});
