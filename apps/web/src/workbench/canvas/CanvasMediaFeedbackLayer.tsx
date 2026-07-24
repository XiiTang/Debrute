import React, { useRef, useState } from 'react';
import type { CanvasFeedbackGeometry, CanvasFeedbackSpatialItem } from '@debrute/canvas-core';

export type CanvasMediaFeedbackMode = 'pin' | 'rect' | undefined;

export interface CanvasMediaFeedbackDraftRegion {
  itemId?: string | undefined;
  label?: number | undefined;
  geometry: CanvasFeedbackGeometry;
  momentTimeSeconds?: number | undefined;
}

export function CanvasMediaFeedbackLayer({
  items,
  mode,
  draftRegions = [],
  activeItemId,
  onItemActivate,
  onRegionDraft
}: {
  items: readonly CanvasFeedbackSpatialItem[];
  mode: CanvasMediaFeedbackMode;
  draftRegions?: readonly CanvasMediaFeedbackDraftRegion[] | undefined;
  activeItemId?: string | undefined;
  onItemActivate?: ((itemId: string) => void) | undefined;
  onRegionDraft: (geometry: CanvasFeedbackGeometry) => void;
}): React.ReactElement | null {
  const gestureRef = useRef<{
    type: 'pin' | 'rect';
    start: { x: number; y: number };
    pointerId: number;
  } | undefined>(undefined);
  const [dragDraftRegion, setDragDraftRegion] = useState<Extract<CanvasFeedbackGeometry, { type: 'rect' }>>();
  const visibleDraftRegions: readonly CanvasMediaFeedbackDraftRegion[] = dragDraftRegion
    ? [...draftRegions, { geometry: dragDraftRegion }]
    : draftRegions;
  if (items.length === 0 && !mode && visibleDraftRegions.length === 0) {
    return null;
  }
  const beginDraft = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!mode) {
      return;
    }
    stopCanvasFeedbackPointerEvent(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = normalizedPointFromPointer(event);
    gestureRef.current = { type: mode, start: { x: point.x, y: point.y }, pointerId: event.pointerId };
    if (mode === 'pin') {
      return;
    }
    setDragDraftRegion({ type: mode, x: point.x, y: point.y, width: 0, height: 0 });
  };
  const updateDraft = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.type !== 'rect' || gesture.pointerId !== event.pointerId) {
      return;
    }
    stopCanvasFeedbackPointerEvent(event);
    setDragDraftRegion(regionFromPoints(gesture.type, gesture.start, normalizedPointFromPointer(event)));
  };
  const finishDraft = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    stopCanvasFeedbackPointerEvent(event);
    gestureRef.current = undefined;
    if (gesture.type === 'pin') {
      onRegionDraft({ type: 'point', x: gesture.start.x, y: gesture.start.y });
      return;
    }
    const geometry = regionFromPoints(gesture.type, gesture.start, normalizedPointFromPointer(event));
    setDragDraftRegion(undefined);
    if (geometry.width >= 0.01 && geometry.height >= 0.01) {
      onRegionDraft(geometry);
    }
  };
  const cancelDraft = (event: React.PointerEvent<HTMLDivElement>) => {
    if (gestureRef.current?.pointerId !== event.pointerId) {
      return;
    }
    stopCanvasFeedbackPointerEvent(event);
    gestureRef.current = undefined;
    setDragDraftRegion(undefined);
  };
  return (
    <div
      className={mode ? 'canvas-media-feedback-layer editing' : 'canvas-media-feedback-layer'}
      data-canvas-media-feedback-layer="true"
      onPointerDown={mode ? beginDraft : stopCanvasFeedbackPointerEvent}
      onPointerMove={mode ? updateDraft : stopCanvasFeedbackPointerEvent}
      onPointerUp={mode ? finishDraft : stopCanvasFeedbackPointerEvent}
      onPointerCancel={mode ? cancelDraft : undefined}
      onClick={mode ? stopCanvasFeedbackPointerEvent : undefined}
    >
      {items.map((item) => {
        const label = (
          <span className="canvas-media-feedback-label">
            <span className="canvas-feedback-label-number">{item.label}</span>
          </span>
        );
        if (item.geometry.type === 'point') {
          return (
            <span
              key={item.id}
              className={`canvas-media-feedback-pin${activeItemId === item.id ? ' active' : ''}`}
              data-canvas-feedback-item-id={item.id}
              data-canvas-feedback-label={item.label}
              data-active={activeItemId === item.id ? 'true' : undefined}
              style={{
                left: `${item.geometry.x * 100}%`,
                top: `${item.geometry.y * 100}%`
              }}
              onClick={mode ? undefined : (event) => {
                stopCanvasFeedbackPointerEvent(event);
                onItemActivate?.(item.id);
              }}
            >
              {label}
            </span>
          );
        }
        return (
          <span
            key={item.id}
            className={`canvas-media-feedback-region canvas-media-feedback-region--${item.geometry.type}${activeItemId === item.id ? ' active' : ''}`}
            data-canvas-feedback-item-id={item.id}
            data-canvas-feedback-label={item.label}
            data-active={activeItemId === item.id ? 'true' : undefined}
            style={{
              left: `${item.geometry.x * 100}%`,
              top: `${item.geometry.y * 100}%`,
              width: `${item.geometry.width * 100}%`,
              height: `${item.geometry.height * 100}%`
            }}
            onClick={mode ? undefined : (event) => {
              stopCanvasFeedbackPointerEvent(event);
              onItemActivate?.(item.id);
            }}
          >
            {label}
          </span>
        );
      })}
      {visibleDraftRegions.map((region, index) => renderDraftRegion({
        region,
        key: region.itemId ?? `drag-${index}`,
        active: region.itemId !== undefined && activeItemId === region.itemId,
        onActivate: mode || !region.itemId ? undefined : () => onItemActivate?.(region.itemId!)
      }))}
    </div>
  );
}

function renderDraftRegion(input: {
  region: CanvasMediaFeedbackDraftRegion;
  key: string;
  active: boolean;
  onActivate?: (() => void) | undefined;
}): React.ReactElement {
  const { region } = input;
  const label = region.label === undefined
    ? <span className="canvas-media-feedback-label canvas-media-feedback-label--draft" aria-hidden="true" />
    : (
        <span className="canvas-media-feedback-label">
          <span className="canvas-feedback-label-number">{region.label}</span>
        </span>
      );
  const dataAttributes = region.label === undefined
    ? {}
    : { 'data-canvas-feedback-label': region.label };
  const geometry = region.geometry;
  if (geometry.type === 'point') {
    return (
      <span
        key={input.key}
        {...dataAttributes}
        className={`canvas-media-feedback-pin draft${input.active ? ' active' : ''}`}
        data-canvas-feedback-item-id={region.itemId}
        style={{
          left: `${geometry.x * 100}%`,
          top: `${geometry.y * 100}%`
        }}
        onClick={input.onActivate ? (event) => {
          stopCanvasFeedbackPointerEvent(event);
          input.onActivate?.();
        } : undefined}
      >
        {label}
      </span>
    );
  }
  return (
    <span
      key={input.key}
      {...dataAttributes}
      className={`canvas-media-feedback-region canvas-media-feedback-region--${geometry.type} draft${input.active ? ' active' : ''}`}
      data-canvas-feedback-item-id={region.itemId}
      style={{
        left: `${geometry.x * 100}%`,
        top: `${geometry.y * 100}%`,
        width: `${geometry.width * 100}%`,
        height: `${geometry.height * 100}%`
      }}
      onClick={input.onActivate ? (event) => {
        stopCanvasFeedbackPointerEvent(event);
        input.onActivate?.();
      } : undefined}
    >
      {label}
    </span>
  );
}

function normalizedPointFromPointer(event: React.PointerEvent<HTMLElement>): Extract<CanvasFeedbackGeometry, { type: 'point' }> {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    type: 'point',
    x: roundUnit((event.clientX - rect.left) / rect.width),
    y: roundUnit((event.clientY - rect.top) / rect.height)
  };
}

function regionFromPoints(
  type: 'rect',
  start: { x: number; y: number },
  end: { x: number; y: number }
): Extract<CanvasFeedbackGeometry, { type: 'rect' }> {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    type,
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  };
}

function roundUnit(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;
}

function stopCanvasFeedbackPointerEvent(event: React.SyntheticEvent): void {
  event.stopPropagation();
}
