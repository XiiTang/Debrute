import React, { useLayoutEffect, useRef } from 'react';
import type { CanvasTextPreviewSource } from './CanvasTextPreviewRuntime';

export interface CanvasTextPreviewPresentation {
  visible?: CanvasTextPreviewSource | undefined;
  pending?: CanvasTextPreviewSource | undefined;
  visibleCommittedSourceKey?: string | undefined;
}

export function CanvasTextPreviewImageHandoff({
  presentation,
  onPendingReady,
  onPendingFailure,
  onVisibleFailure,
  onVisibleCommitted
}: {
  presentation: CanvasTextPreviewPresentation;
  onPendingReady(source: CanvasTextPreviewSource): void;
  onPendingFailure(source: CanvasTextPreviewSource, error: unknown): void;
  onVisibleFailure(source: CanvasTextPreviewSource, error: unknown): void;
  onVisibleCommitted(source: CanvasTextPreviewSource): void;
}): React.ReactElement {
  if (!presentation.visible && !presentation.pending) {
    return <div className="canvas-text-preview-empty" aria-hidden="true" />;
  }

  return (
    <div className="canvas-text-preview-layers">
      {presentation.visible ? (
        <CanvasTextPreviewImageLayer
          key={presentation.visible.sourceKey}
          layer="visible"
          source={presentation.visible}
          onReady={onPendingReady}
          onFailure={onVisibleFailure}
          onVisibleCommitted={onVisibleCommitted}
        />
      ) : null}
      {presentation.pending && presentation.pending.sourceKey !== presentation.visible?.sourceKey ? (
        <CanvasTextPreviewImageLayer
          key={presentation.pending.sourceKey}
          layer="pending"
          source={presentation.pending}
          onReady={onPendingReady}
          onFailure={onPendingFailure}
          onVisibleCommitted={onVisibleCommitted}
        />
      ) : null}
    </div>
  );
}

function CanvasTextPreviewImageLayer({
  layer,
  source,
  onReady,
  onFailure,
  onVisibleCommitted
}: {
  layer: 'visible' | 'pending';
  source: CanvasTextPreviewSource;
  onReady(source: CanvasTextPreviewSource): void;
  onFailure(source: CanvasTextPreviewSource, error: unknown): void;
  onVisibleCommitted(source: CanvasTextPreviewSource): void;
}): React.ReactElement {
  const pendingLifecycleRef = useRef<{
    cancelled: boolean;
    settled: boolean;
  } | undefined>(undefined);
  const onVisibleCommittedRef = useRef(onVisibleCommitted);
  onVisibleCommittedRef.current = onVisibleCommitted;

  useLayoutEffect(() => {
    if (layer !== 'pending') {
      pendingLifecycleRef.current = undefined;
      return undefined;
    }
    const lifecycle = { cancelled: false, settled: false };
    pendingLifecycleRef.current = lifecycle;
    return () => {
      lifecycle.cancelled = true;
      if (pendingLifecycleRef.current === lifecycle) {
        pendingLifecycleRef.current = undefined;
      }
    };
  }, [layer, source.sourceKey]);

  useLayoutEffect(() => {
    if (layer !== 'visible') {
      return undefined;
    }
    let secondFrame: number | undefined;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        secondFrame = undefined;
        onVisibleCommittedRef.current(source);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) {
        window.cancelAnimationFrame(secondFrame);
      }
    };
  }, [layer, source.sourceKey]);

  const finishPendingLoad = (image: HTMLImageElement) => {
    const lifecycle = pendingLifecycleRef.current;
    if (layer !== 'pending' || !lifecycle || lifecycle.cancelled || lifecycle.settled) {
      return;
    }
    const decode = image.decode();
    void decode.then(() => {
      if (pendingLifecycleRef.current === lifecycle
        && !lifecycle.cancelled
        && !lifecycle.settled
        && image.isConnected
        && image.dataset.canvasTextPreviewSourceKey === source.sourceKey) {
        lifecycle.settled = true;
        onReady(source);
      }
    }, (error: unknown) => {
      if (pendingLifecycleRef.current === lifecycle
        && !lifecycle.cancelled
        && !lifecycle.settled
        && image.isConnected
        && image.dataset.canvasTextPreviewSourceKey === source.sourceKey) {
        lifecycle.settled = true;
        onFailure(source, error);
      }
    });
  };

  return (
    <img
      className={`canvas-text-preview-image canvas-text-preview-image--${layer}`}
      src={source.src}
      alt=""
      draggable={false}
      decoding="async"
      data-canvas-text-preview-layer={layer}
      data-canvas-text-preview-source-key={source.sourceKey}
      data-preview-width={source.previewWidth}
      onLoad={(event) => finishPendingLoad(event.currentTarget)}
      onError={(event) => {
        if (layer === 'visible') {
          onFailure(source, event.nativeEvent);
          return;
        }
        const lifecycle = pendingLifecycleRef.current;
        if (!lifecycle || lifecycle.cancelled || lifecycle.settled) {
          return;
        }
        lifecycle.settled = true;
        onFailure(source, event.nativeEvent);
      }}
    />
  );
}
