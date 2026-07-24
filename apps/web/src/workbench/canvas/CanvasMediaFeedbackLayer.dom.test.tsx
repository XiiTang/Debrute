import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { CanvasFeedbackSpatialItem } from '@debrute/canvas-core';
import { CanvasMediaFeedbackLayer } from './CanvasMediaFeedbackLayer';

it('activates an immutable geometry by stable Feedback Item identity', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onItemActivate = vi.fn();
  await act(async () => {
    root.render(
      <CanvasMediaFeedbackLayer
        items={spatialItemsFixture()}
        mode={undefined}
        activeItemId="region-2"
        onItemActivate={onItemActivate}
        onRegionDraft={() => undefined}
      />
    );
  });

  const active = container.querySelector('[data-canvas-feedback-item-id="region-2"]') as HTMLElement;
  expect(active.dataset.active).toBe('true');
  await act(async () => active.click());
  expect(onItemActivate).toHaveBeenCalledWith('region-2');

  await act(async () => root.unmount());
  container.remove();
});

it('renders and activates multiple unsynchronized geometries by their stable identities', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onItemActivate = vi.fn();
  await act(async () => {
    root.render(
      <CanvasMediaFeedbackLayer
        items={[]}
        mode={undefined}
        draftRegions={[
          { itemId: 'local-pin', geometry: { type: 'point', x: 0.2, y: 0.3 } },
          { itemId: 'local-region', geometry: { type: 'rect', x: 0.4, y: 0.5, width: 0.2, height: 0.1 } }
        ]}
        activeItemId="local-pin"
        onItemActivate={onItemActivate}
        onRegionDraft={() => undefined}
      />
    );
  });

  const pin = container.querySelector('[data-canvas-feedback-item-id="local-pin"]') as HTMLElement;
  const region = container.querySelector('[data-canvas-feedback-item-id="local-region"]') as HTMLElement;
  expect(pin.classList.contains('active')).toBe(true);
  expect(region).not.toBeNull();
  await act(async () => region.click());
  expect(onItemActivate).toHaveBeenCalledWith('local-region');

  await act(async () => root.unmount());
  container.remove();
});

it('keeps existing unsynchronized geometries visible while a new rectangle is being drawn', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <CanvasMediaFeedbackLayer
        items={[]}
        mode="rect"
        draftRegions={[
          { itemId: 'local-pin', geometry: { type: 'point', x: 0.2, y: 0.3 } },
          { itemId: 'local-region', geometry: { type: 'rect', x: 0.4, y: 0.5, width: 0.2, height: 0.1 } }
        ]}
        onRegionDraft={() => undefined}
      />
    );
  });

  const layer = container.querySelector('[data-canvas-media-feedback-layer="true"]') as HTMLDivElement;
  layer.setPointerCapture = vi.fn();
  layer.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON: () => ({})
  });
  await act(async () => {
    layer.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      clientX: 10,
      clientY: 20,
      pointerId: 1
    }));
    layer.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      clientX: 30,
      clientY: 40,
      pointerId: 1
    }));
  });

  expect(container.querySelector('[data-canvas-feedback-item-id="local-pin"]')).not.toBeNull();
  expect(container.querySelector('[data-canvas-feedback-item-id="local-region"]')).not.toBeNull();
  expect(container.querySelectorAll('.draft')).toHaveLength(3);

  await act(async () => root.unmount());
  container.remove();
});

it('commits a pin after pointer release so the resulting Capsule can retain input focus', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onRegionDraft = vi.fn();
  await act(async () => {
    root.render(
      <CanvasMediaFeedbackLayer
        items={[]}
        mode="pin"
        onRegionDraft={onRegionDraft}
      />
    );
  });

  const layer = container.querySelector('[data-canvas-media-feedback-layer="true"]') as HTMLDivElement;
  layer.setPointerCapture = vi.fn();
  layer.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON: () => ({})
  });

  await act(async () => {
    layer.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      clientX: 25,
      clientY: 40,
      pointerId: 1
    }));
  });
  expect(onRegionDraft).not.toHaveBeenCalled();

  await act(async () => {
    layer.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      clientX: 25,
      clientY: 40,
      pointerId: 1
    }));
  });
  expect(onRegionDraft).toHaveBeenCalledWith({ type: 'point', x: 0.25, y: 0.4 });

  await act(async () => root.unmount());
  container.remove();
});

it('keeps pin and rectangle pointer-down events out of Canvas node movement before activation', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onCanvasPointerDown = vi.fn();
  const onItemActivate = vi.fn();
  await act(async () => {
    root.render(
      <div onPointerDown={onCanvasPointerDown}>
        <CanvasMediaFeedbackLayer
          items={[
            {
              id: 'pin-1',
              label: 1,
              kind: 'pin',
              scope: 'file',
              geometry: { type: 'point', x: 0.2, y: 0.3 },
              comment: 'Pin',
              createdAt: '2026-07-23T00:00:00.000Z',
              updatedAt: '2026-07-23T00:00:00.000Z'
            },
            ...spatialItemsFixture()
          ]}
          mode={undefined}
          onItemActivate={onItemActivate}
          onRegionDraft={() => undefined}
        />
      </div>
    );
  });

  for (const itemId of ['pin-1', 'region-2']) {
    const geometry = container.querySelector(`[data-canvas-feedback-item-id="${itemId}"]`) as HTMLElement;
    await act(async () => {
      geometry.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      geometry.click();
    });
  }

  expect(onCanvasPointerDown).not.toHaveBeenCalled();
  expect(onItemActivate.mock.calls).toEqual([['pin-1'], ['region-2']]);
  await act(async () => root.unmount());
  container.remove();
});

function spatialItemsFixture(): CanvasFeedbackSpatialItem[] {
  return [{
    id: 'region-2',
    label: 2,
    kind: 'region',
    scope: 'file',
    geometry: { type: 'rect', x: 0.4, y: 0.2, width: 0.25, height: 0.2 },
    comment: 'rect comment',
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z'
  }];
}
