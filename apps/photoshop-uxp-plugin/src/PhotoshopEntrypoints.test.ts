import { describe, expect, it, vi } from 'vitest';
import { installPhotoshopEntrypoints } from './PhotoshopEntrypoints.js';

describe('installPhotoshopEntrypoints', () => {
  it('starts the Runtime with the plugin and mounts the view when the panel is shown', () => {
    const setup = vi.fn();
    const runtime = { start: vi.fn(), stop: vi.fn() };
    const view = { attach: vi.fn(), detach: vi.fn() };
    const root = {} as HTMLElement;

    installPhotoshopEntrypoints({ entrypoints: { setup }, runtime, view, root });

    const registration = setup.mock.calls[0]?.[0];
    registration.plugin.create();
    expect(runtime.start).toHaveBeenCalledOnce();

    const panelNode = { appendChild: vi.fn() };
    registration.panels.debrutePhotoshopPanel.show({ node: panelNode });
    expect(panelNode.appendChild).toHaveBeenCalledWith(root);
    expect(view.attach).toHaveBeenCalledOnce();
  });

  it('keeps the Runtime alive when only the panel is destroyed', () => {
    const setup = vi.fn();
    const runtime = { start: vi.fn(), stop: vi.fn() };
    const view = { attach: vi.fn(), detach: vi.fn() };

    installPhotoshopEntrypoints({
      entrypoints: { setup },
      runtime,
      view,
      root: {} as HTMLElement
    });

    const registration = setup.mock.calls[0]?.[0];
    registration.panels.debrutePhotoshopPanel.destroy();
    expect(view.detach).toHaveBeenCalledOnce();
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it('uses the main Photoshop HTML document when the host omits a panel node', () => {
    const setup = vi.fn();
    const runtime = { start: vi.fn(), stop: vi.fn() };
    const view = { attach: vi.fn(), detach: vi.fn() };

    installPhotoshopEntrypoints({
      entrypoints: { setup },
      runtime,
      view,
      root: {} as HTMLElement
    });

    const registration = setup.mock.calls[0]?.[0];
    expect(() => registration.panels.debrutePhotoshopPanel.show()).not.toThrow();
    expect(view.attach).toHaveBeenCalledOnce();
  });

  it('stops the Runtime only when Photoshop unloads the plugin', () => {
    const setup = vi.fn();
    const runtime = { start: vi.fn(), stop: vi.fn() };
    const view = { attach: vi.fn(), detach: vi.fn() };

    installPhotoshopEntrypoints({
      entrypoints: { setup },
      runtime,
      view,
      root: {} as HTMLElement
    });

    const registration = setup.mock.calls[0]?.[0];
    registration.plugin.destroy();
    expect(view.detach).toHaveBeenCalledOnce();
    expect(runtime.stop).toHaveBeenCalledOnce();
  });
});
