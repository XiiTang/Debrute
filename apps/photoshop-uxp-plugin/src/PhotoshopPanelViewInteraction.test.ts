import { describe, expect, it, vi } from 'vitest';
import { PhotoshopPanelView } from './PhotoshopPanelView.js';
import type { PhotoshopPluginRuntime, PhotoshopPluginSnapshot } from './PhotoshopPluginRuntime.js';

describe('PhotoshopPanelView interaction', () => {
  it('renders a semantic nested tree and activates the complete destination row', () => {
    const runtime = new FakePanelRuntime({
      ...snapshotFixture(),
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 2 }],
      directoryTrees: [{
        canonicalRoot: 'project-1',
        projectRevision: 2,
        status: 'loaded',
        directories: ['', 'data', 'data/shopify', 'exports']
      }],
      expandedDirectories: [
        { canonicalRoot: 'project-1', directory: '' },
        { canonicalRoot: 'project-1', directory: 'data' }
      ],
      destination: {
        canonicalRoot: 'project-1',
        projectName: 'Poster',
        projectRevision: 2,
        directory: 'data'
      }
    });
    const root = document.createElement('div');
    const view = new PhotoshopPanelView(root, runtime as unknown as PhotoshopPluginRuntime);
    view.attach();

    const tree = root.querySelector<HTMLElement>('[role="tree"]');
    const project = root.querySelector<HTMLElement>('[role="treeitem"][data-canonical-root="project-1"][data-directory=""]');
    const data = root.querySelector<HTMLElement>('[role="treeitem"][data-directory="data"]');
    const shopify = root.querySelector<HTMLElement>('[role="treeitem"][data-directory="data/shopify"]');
    expect(tree?.getAttribute('aria-label')).toBe('Debrute Project directories');
    expect(project?.getAttribute('aria-expanded')).toBe('true');
    expect(project?.nextElementSibling?.getAttribute('role')).toBe('group');
    expect(project?.getAttribute('aria-owns')).toBe(project?.nextElementSibling?.id);
    expect(data?.getAttribute('aria-selected')).toBe('true');
    expect(shopify?.closest('[role="group"]')).not.toBeNull();
    expect(root.querySelector('.photoshop-panel__tree-disclosure')).toBeNull();
    expect(project?.style.getPropertyValue('--tree-indent')).toBe('0px');
    expect(data?.style.getPropertyValue('--tree-indent')).toBe('14px');
    expect(shopify?.style.getPropertyValue('--tree-indent')).toBe('28px');
    expect([...shopify?.querySelectorAll<HTMLElement>('.photoshop-panel__tree-guide') ?? []]
      .map((guide) => guide.style.left)).toEqual(['14px', '28px']);
    expect(project?.querySelector('svg[data-debrute-icon="folder-open"]')?.getAttribute('viewBox'))
      .toBe('0 0 20 20');
    expect(shopify?.querySelector('svg[data-debrute-icon="folder"] path')?.getAttribute('d'))
      .toBe('M1 4h7l2 2h9v12H1V4Z');

    shopify?.click();
    expect(runtime.activateDestination).toHaveBeenCalledWith('project-1', 'data/shopify');
  });

  it('uses Explorer keyboard navigation without triggering Send', () => {
    const runtime = new FakePanelRuntime({
      ...snapshotFixture(),
      directoryTrees: [{
        canonicalRoot: 'project-1',
        projectRevision: 2,
        status: 'loaded',
        directories: ['', 'data', 'data/shopify', 'exports']
      }],
      expandedDirectories: [
        { canonicalRoot: 'project-1', directory: '' },
        { canonicalRoot: 'project-1', directory: 'data' }
      ],
      destination: {
        canonicalRoot: 'project-1',
        projectName: 'Poster',
        projectRevision: 2,
        directory: 'data'
      }
    });
    const root = document.createElement('div');
    const view = new PhotoshopPanelView(root, runtime as unknown as PhotoshopPluginRuntime);
    view.attach();
    const data = root.querySelector<HTMLElement>('[role="treeitem"][data-directory="data"]');

    data?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(runtime.selectDestination).toHaveBeenLastCalledWith('project-1', 'data/shopify');
    data?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(runtime.selectDestination).toHaveBeenLastCalledWith('project-1', 'data/shopify');
    data?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(runtime.collapseDestination).toHaveBeenCalledWith('project-1', 'data');
    data?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(runtime.activateDestination).toHaveBeenLastCalledWith('project-1', 'data');
    data?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(runtime.activateDestination).toHaveBeenLastCalledWith('project-1', 'data');
    expect(runtime.sendSelection).not.toHaveBeenCalled();
  });

  it('covers collapsed-row, parent, boundary, and empty-selection keyboard navigation', () => {
    const runtime = new FakePanelRuntime({
      ...snapshotFixture(),
      directoryTrees: [{
        canonicalRoot: 'project-1',
        projectRevision: 2,
        status: 'loaded',
        directories: ['', 'data', 'data/shopify', 'exports']
      }],
      expandedDirectories: [{ canonicalRoot: 'project-1', directory: '' }],
      destination: {
        canonicalRoot: 'project-1',
        projectName: 'Poster',
        projectRevision: 2,
        directory: 'data'
      }
    });
    const root = document.createElement('div');
    const view = new PhotoshopPanelView(root, runtime as unknown as PhotoshopPluginRuntime);
    view.attach();

    const data = root.querySelector<HTMLElement>('[role="treeitem"][data-directory="data"]');
    data?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(runtime.selectDestination).toHaveBeenLastCalledWith('project-1', '');
    data?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(runtime.expandDestination).toHaveBeenLastCalledWith('project-1', 'data');

    runtime.publish({
      ...runtime.snapshot(),
      expandedDirectories: [
        { canonicalRoot: 'project-1', directory: '' },
        { canonicalRoot: 'project-1', directory: 'data' }
      ],
      destination: {
        canonicalRoot: 'project-1',
        projectName: 'Poster',
        projectRevision: 2,
        directory: 'data/shopify'
      }
    });
    const shopify = root.querySelector<HTMLElement>('[role="treeitem"][data-directory="data/shopify"]');
    shopify?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(runtime.selectDestination).toHaveBeenLastCalledWith('project-1', 'data');

    runtime.publish({ ...runtime.snapshot(), destination: null });
    const tree = root.querySelector<HTMLElement>('[role="tree"]');
    tree?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(runtime.selectDestination).toHaveBeenLastCalledWith('project-1', '');
    tree?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(runtime.selectDestination).toHaveBeenLastCalledWith('project-1', 'exports');
    expect(runtime.sendSelection).not.toHaveBeenCalled();
  });

  it('selects Project and directory rows directly without a second confirmation', () => {
    const runtime = new FakePanelRuntime(snapshotFixture());
    const root = document.createElement('div');
    document.body.append(root);
    const view = new PhotoshopPanelView(root, runtime as unknown as PhotoshopPluginRuntime);
    view.attach();

    expect(root.querySelector('select')).toBeNull();
    expect(root.textContent).not.toContain('Hero');
    const projectRow = root.querySelector<HTMLElement>('[data-canonical-root="project-1"]');
    expect(projectRow?.tagName).toBe('DIV');
    expect(projectRow?.getAttribute('role')).toBe('treeitem');
    expect(root.querySelector<HTMLElement>('[role="tree"]')?.tabIndex).toBe(0);
    expect(projectRow?.tabIndex).toBe(-1);
    projectRow?.focus();
    expect(document.activeElement).toBe(projectRow);
    projectRow?.click();
    expect(runtime.activateDestination).toHaveBeenCalledWith('project-1', '');

    runtime.publish({
      ...runtime.snapshot(),
      directoryTrees: [{
        canonicalRoot: 'project-1',
        projectRevision: 2,
        status: 'loaded',
        directories: ['', 'data', 'data/shopify', 'exports']
      }],
      expandedDirectories: [{ canonicalRoot: 'project-1', directory: '' }],
      destination: {
        canonicalRoot: 'project-1',
        projectName: 'Poster',
        projectRevision: 2,
        directory: ''
      }
    });
    root.querySelector<HTMLButtonElement>('[data-directory="data"]')?.click();

    expect(runtime.activateDestination).toHaveBeenCalledWith('project-1', 'data');
    expect(root.textContent).not.toContain('Select this directory');
    root.remove();
  });

  it('renders the Runtime-owned destination again after panel detach and attach', () => {
    const runtime = new FakePanelRuntime({
      ...snapshotFixture(),
      directoryTrees: [{
        canonicalRoot: 'project-1',
        projectRevision: 2,
        status: 'loaded',
        directories: ['', 'exports']
      }],
      expandedDirectories: [{ canonicalRoot: 'project-1', directory: '' }],
      destination: {
        canonicalRoot: 'project-1',
        projectName: 'Poster',
        projectRevision: 2,
        directory: 'exports'
      }
    });
    const root = document.createElement('div');
    const view = new PhotoshopPanelView(root, runtime as unknown as PhotoshopPluginRuntime);

    view.attach();
    expect(root.querySelector('.photoshop-panel__destination-path')?.textContent).toContain('Poster / exports');
    expect(root.querySelector('[role="treeitem"][data-directory="exports"]')?.getAttribute('aria-selected')).toBe('true');
    view.detach();
    expect(root.childElementCount).toBe(0);
    view.attach();
    expect(root.querySelector('.photoshop-panel__destination-path')?.textContent).toContain('Poster / exports');
    expect(root.querySelector('[role="treeitem"][data-directory="exports"]')?.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the tree focusable and reveals a retained destination after its snapshot loads', () => {
    const runtime = new FakePanelRuntime({
      ...snapshotFixture(),
      projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 3 }],
      directoryTrees: [{
        canonicalRoot: 'project-1',
        projectRevision: 3,
        status: 'loading',
        directories: []
      }],
      expandedDirectories: [
        { canonicalRoot: 'project-1', directory: '' },
        { canonicalRoot: 'project-1', directory: 'data' }
      ],
      destination: {
        canonicalRoot: 'project-1',
        projectName: 'Poster',
        projectRevision: 2,
        directory: 'data/shopify'
      }
    });
    const root = document.createElement('div');
    const view = new PhotoshopPanelView(root, runtime as unknown as PhotoshopPluginRuntime);
    const scrollIntoViewIfNeeded = vi.fn();
    const prototype = HTMLElement.prototype as typeof HTMLElement.prototype & {
      scrollIntoViewIfNeeded?: () => void;
    };
    const originalScrollIntoViewIfNeeded = prototype.scrollIntoViewIfNeeded;
    Object.defineProperty(prototype, 'scrollIntoViewIfNeeded', {
      configurable: true,
      value: scrollIntoViewIfNeeded
    });

    try {
      view.attach();
      expect(root.querySelector<HTMLElement>('[role="tree"]')?.tabIndex).toBe(0);
      expect(scrollIntoViewIfNeeded).not.toHaveBeenCalled();

      runtime.publish({
        ...runtime.snapshot(),
        directoryTrees: [{
          canonicalRoot: 'project-1',
          projectRevision: 3,
          status: 'loaded',
          directories: ['', 'data', 'data/shopify']
        }],
        destination: {
          canonicalRoot: 'project-1',
          projectName: 'Poster',
          projectRevision: 3,
          directory: 'data/shopify'
        }
      });

      expect(root.querySelector<HTMLElement>('[role="tree"]')?.hasAttribute('tabindex')).toBe(false);
      expect(root.querySelector('[role="treeitem"][data-directory="data/shopify"]')?.getAttribute('aria-selected')).toBe('true');
      expect(scrollIntoViewIfNeeded).toHaveBeenCalledOnce();
    } finally {
      if (originalScrollIntoViewIfNeeded === undefined) {
        Reflect.deleteProperty(prototype, 'scrollIntoViewIfNeeded');
      } else {
        Object.defineProperty(prototype, 'scrollIntoViewIfNeeded', {
          configurable: true,
          value: originalScrollIntoViewIfNeeded
        });
      }
    }
  });

  it('keeps destination rows usable while Send is busy', () => {
    const runtime = new FakePanelRuntime({
      ...snapshotFixture(),
      directoryTrees: [{
        canonicalRoot: 'project-1',
        projectRevision: 2,
        status: 'loaded',
        directories: ['', 'data', 'exports']
      }],
      expandedDirectories: [{ canonicalRoot: 'project-1', directory: '' }],
      destination: {
        canonicalRoot: 'project-1',
        projectName: 'Poster',
        projectRevision: 2,
        directory: ''
      },
      activeExport: { itemCount: 3, destinationLabel: 'Poster / exports' },
      busy: true
    });
    const root = document.createElement('div');
    const view = new PhotoshopPanelView(root, runtime as unknown as PhotoshopPluginRuntime);
    view.attach();

    expect(root.querySelector<HTMLButtonElement>('[data-action="send"]')?.disabled).toBe(true);
    const directory = root.querySelector<HTMLElement>('[data-directory="data"]');
    expect(directory?.tagName).toBe('DIV');
    expect(directory?.hasAttribute('aria-disabled')).toBe(false);
    directory?.click();
    expect(runtime.activateDestination).toHaveBeenCalledWith('project-1', 'data');
    expect(root.textContent).toContain('Sending 3 files to Poster / exports…');
  });
});

class FakePanelRuntime {
  readonly activateDestination = vi.fn();
  readonly selectDestination = vi.fn();
  readonly expandDestination = vi.fn();
  readonly collapseDestination = vi.fn();
  readonly sendSelection = vi.fn(async () => undefined);
  private subscriber: ((snapshot: PhotoshopPluginSnapshot) => void) | undefined;

  constructor(private snapshotValue: PhotoshopPluginSnapshot) {}

  snapshot(): PhotoshopPluginSnapshot {
    return this.snapshotValue;
  }

  subscribe(subscriber: (snapshot: PhotoshopPluginSnapshot) => void): () => void {
    this.subscriber = subscriber;
    subscriber(this.snapshotValue);
    return () => { this.subscriber = undefined; };
  }

  publish(snapshot: PhotoshopPluginSnapshot): void {
    this.snapshotValue = snapshot;
    this.subscriber?.(snapshot);
  }
}

function snapshotFixture(): PhotoshopPluginSnapshot {
  return {
    connection: { status: 'ready', runtimeInstanceId: 'runtime-1', pluginSessionId: 'session-1' },
    selection: {
      documentId: 4,
      documentTitle: 'Poster.psd',
      items: [{ layerId: 8, name: 'Hero', kind: 'layer' }]
    },
    projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 2 }],
    directoryTrees: [],
    expandedDirectories: [],
    destination: null,
    activeExport: null,
    busy: false,
    result: null
  };
}
