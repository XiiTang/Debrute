import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createCanvasDocument, type CanvasProjection } from '@axis/canvas-core';
import { CanvasToolbar } from './CanvasToolbar';
import { createCanvasEditorRuntime } from './runtime/CanvasEditorRuntime';

describe('CanvasToolbar', () => {
  it('routes Fit through the active Canvas runtime camera', () => {
    const canvas = createCanvasDocument({ id: 'canvas', title: 'Canvas' });
    const runtime = createCanvasEditorRuntime({ camera: { x: 120, y: 80, z: 0.5 } });
    runtime.bindSurface({
      surface: fakeElement({ width: 1000, height: 600 }) as unknown as HTMLElement
    });
    const setCamera = vi.spyOn(runtime.camera, 'setCamera');

    const button = toolbarButton(CanvasToolbar({
      canvas,
      projection: projectionFixture(canvas.id, [{
        projectRelativePath: 'flow/a.png',
        x: 100,
        y: 80,
        width: 200,
        height: 120
      }]),
      runtime,
      runtimeSnapshot: runtime.getSnapshot()
    }));

    expect(button.props.disabled).toBe(false);
    button.props.onClick();
    expect(setCamera).toHaveBeenCalledOnce();
    expect(setCamera.mock.calls[0]?.[0]).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      z: expect.any(Number)
    });
    expect(runtime.camera.getCamera()).toEqual(setCamera.mock.calls[0]?.[0]);
    expect(runtime.camera.getCamera()).not.toEqual({ x: 120, y: 80, z: 0.5 });
  });

  it('disables Fit until the active Canvas runtime is available', () => {
    const canvas = createCanvasDocument({ id: 'canvas', title: 'Canvas' });

    const button = toolbarButton(CanvasToolbar({
      canvas,
      projection: projectionFixture(canvas.id),
      runtime: undefined,
      runtimeSnapshot: undefined
    }));

    expect(button.props.disabled).toBe(true);
  });
});

function toolbarButton(element: React.ReactElement | null): React.ReactElement<{
  disabled?: boolean;
  onClick: () => void;
}> {
  if (!element) {
    throw new Error('Expected CanvasToolbar to render.');
  }
  const children = React.Children.toArray((element.props as { children?: React.ReactNode }).children);
  const button = children.find((child): child is React.ReactElement<{
    'data-testid'?: string;
    disabled?: boolean;
    onClick: () => void;
  }> => (
    React.isValidElement(child)
    && (child.props as { 'data-testid'?: string })['data-testid'] === 'fit-active-canvas'
  ));
  if (!button) {
    throw new Error('Expected CanvasToolbar Fit button.');
  }
  return button;
}

function projectionFixture(
  canvasId: string,
  nodes: Array<Pick<CanvasProjection['nodes'][number], 'projectRelativePath' | 'x' | 'y' | 'width' | 'height'>> = []
): CanvasProjection {
  return {
    canvasId,
    nodes: nodes.map((node) => ({
      nodeKind: 'file',
      mediaKind: 'image',
      z: 0,
      visible: true,
      locked: false,
      availability: {
        state: 'available',
        size: 1,
        mimeType: 'image/png',
        fileUrl: '',
        revision: 'rev'
      },
      ...node
    })),
    edges: [],
    diagnostics: []
  };
}

function fakeElement(rect = { width: 1, height: 1 }) {
  return {
    style: {
      setProperty: () => undefined,
      transform: ''
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, ...rect })
  };
}
