import React, { useRef, useState } from 'react';
import type { CanvasFeedbackGeometry, CanvasFeedbackSpatialItem } from '@debrute/canvas-core';

export type CanvasMediaFeedbackMode = 'pin' | 'rect' | undefined;

export interface CanvasMediaFeedbackDraftRegion {
  label: number;
  geometry: CanvasFeedbackGeometry;
}

export function CanvasMediaFeedbackLayer({
  items,
  mode,
  draftRegion,
  onRegionDraft
}: {
  items: readonly CanvasFeedbackSpatialItem[];
  mode: CanvasMediaFeedbackMode;
  draftRegion?: CanvasMediaFeedbackDraftRegion | undefined;
  onRegionDraft: (geometry: CanvasFeedbackGeometry) => void;
}): React.ReactElement | null {
  const dragRef = useRef<{ type: 'rect'; start: { x: number; y: number }; pointerId: number } | undefined>(undefined);
  const [dragDraftRegion, setDragDraftRegion] = useState<Extract<CanvasFeedbackGeometry, { type: 'rect' }>>();
  const visibleDraftRegion = dragDraftRegion
    ? { geometry: dragDraftRegion, label: undefined }
    : draftRegion;
  if (items.length === 0 && !mode && !visibleDraftRegion) {
    return null;
  }
  const beginDraft = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!mode) {
      return;
    }
    stopCanvasFeedbackPointerEvent(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = normalizedPointFromPointer(event);
    if (mode === 'pin') {
      onRegionDraft(point);
      return;
    }
    dragRef.current = { type: mode, start: { x: point.x, y: point.y }, pointerId: event.pointerId };
    setDragDraftRegion({ type: mode, x: point.x, y: point.y, width: 0, height: 0 });
  };
  const updateDraft = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) {
      return;
    }
    stopCanvasFeedbackPointerEvent(event);
    setDragDraftRegion(regionFromPoints(dragRef.current.type, dragRef.current.start, normalizedPointFromPointer(event)));
  };
  const finishDraft = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) {
      return;
    }
    stopCanvasFeedbackPointerEvent(event);
    const geometry = regionFromPoints(dragRef.current.type, dragRef.current.start, normalizedPointFromPointer(event));
    dragRef.current = undefined;
    setDragDraftRegion(undefined);
    if (geometry.width >= 0.01 && geometry.height >= 0.01) {
      onRegionDraft(geometry);
    }
  };
  return (
    <div
      className={mode ? 'canvas-media-feedback-layer editing' : 'canvas-media-feedback-layer'}
      data-canvas-media-feedback-layer="true"
      onPointerDown={mode ? beginDraft : undefined}
      onPointerMove={mode ? updateDraft : undefined}
      onPointerUp={mode ? finishDraft : undefined}
      onClick={mode ? stopCanvasFeedbackPointerEvent : undefined}
    >
      {items.map((item) => {
        const label = <span className="canvas-media-feedback-label">{item.label}</span>;
        if (item.geometry.type === 'point') {
          return (
            <span
              key={item.id}
              className="canvas-media-feedback-pin"
              data-canvas-feedback-label={item.label}
              style={{
                left: `${item.geometry.x * 100}%`,
                top: `${item.geometry.y * 100}%`
              }}
            >
              {label}
            </span>
          );
        }
        return (
          <span
            key={item.id}
            className={`canvas-media-feedback-region canvas-media-feedback-region--${item.geometry.type}`}
            data-canvas-feedback-label={item.label}
            style={{
              left: `${item.geometry.x * 100}%`,
              top: `${item.geometry.y * 100}%`,
              width: `${item.geometry.width * 100}%`,
              height: `${item.geometry.height * 100}%`
            }}
          >
            {label}
          </span>
        );
      })}
      {visibleDraftRegion ? renderDraftRegion(visibleDraftRegion) : null}
    </div>
  );
}

function renderDraftRegion(region: { geometry: CanvasFeedbackGeometry; label: number | undefined }): React.ReactElement {
  const label = region.label === undefined
    ? undefined
    : <span className="canvas-media-feedback-label">{region.label}</span>;
  const dataAttributes = region.label === undefined
    ? {}
    : { 'data-canvas-feedback-label': region.label };
  const geometry = region.geometry;
  if (geometry.type === 'point') {
    return (
      <span
        {...dataAttributes}
        className="canvas-media-feedback-pin draft"
        style={{
          left: `${geometry.x * 100}%`,
          top: `${geometry.y * 100}%`
        }}
      >
        {label}
      </span>
    );
  }
  return (
    <span
      {...dataAttributes}
      className={`canvas-media-feedback-region canvas-media-feedback-region--${geometry.type} draft`}
      style={{
        left: `${geometry.x * 100}%`,
        top: `${geometry.y * 100}%`,
        width: `${geometry.width * 100}%`,
        height: `${geometry.height * 100}%`
      }}
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
