import { describe, expect, it } from 'vitest';
import { shouldWorkbenchClickEndCanvasContentActivation } from './WorkbenchApp.js';

describe('Workbench Canvas Content Activation boundary', () => {
  it('ends activation only for completed primary clicks outside CanvasSurface', () => {
    const shell = document.createElement('main');
    const surface = document.createElement('div');
    surface.dataset.canvasSurface = 'true';
    const canvasContent = document.createElement('button');
    const floatingPanel = document.createElement('button');
    const contentIsland = document.createElement('div');
    contentIsland.dataset.canvasNodeZone = 'content-island';
    contentIsland.dataset.canvasNodePath = 'notes/readme.md';
    const islandButton = document.createElement('button');
    contentIsland.append(islandButton);
    surface.append(canvasContent);
    shell.append(surface, floatingPanel, contentIsland);

    expect(shouldWorkbenchClickEndCanvasContentActivation(0, canvasContent)).toBe(false);
    expect(shouldWorkbenchClickEndCanvasContentActivation(0, surface)).toBe(false);
    expect(shouldWorkbenchClickEndCanvasContentActivation(0, floatingPanel)).toBe(true);
    expect(shouldWorkbenchClickEndCanvasContentActivation(0, islandButton, 'notes/readme.md')).toBe(false);
    expect(shouldWorkbenchClickEndCanvasContentActivation(0, islandButton, 'notes/other.md')).toBe(true);
    expect(shouldWorkbenchClickEndCanvasContentActivation(2, floatingPanel)).toBe(false);
    expect(shouldWorkbenchClickEndCanvasContentActivation(0, window)).toBe(false);
  });
});
