import React, { useLayoutEffect, useRef } from 'react';
import type { CanvasTextPreviewSource } from './CanvasTextPreviewRuntime';

export interface CanvasTextPreviewPresentation {
  visible?: CanvasTextPreviewSource | undefined;
  pending?: CanvasTextPreviewSource | undefined;
  visibleCommittedSourceKey?: string | undefined;
}

export function CanvasTextPreviewImageHandoff({
  presentation,
  hidden = false,
  onPendingReady,
  onPendingFailure,
  onVisibleFailure,
  onVisibleCommitted
}: {
  presentation: CanvasTextPreviewPresentation;
  hidden?: boolean | undefined;
  onPendingReady(source: CanvasTextPreviewSource): void;
  onPendingFailure(source: CanvasTextPreviewSource, error: unknown): void;
  onVisibleFailure(source: CanvasTextPreviewSource, error: unknown): void;
  onVisibleCommitted(source: CanvasTextPreviewSource): void;
}): React.ReactElement {
  if (!presentation.visible && !presentation.pending) {
    return <div className="canvas-text-preview-empty" aria-hidden="true" />;
  }

  return (
    <div
      className="canvas-text-preview-layers"
      data-canvas-text-preview-hidden={hidden ? 'true' : 'false'}
      aria-hidden={hidden}
    >
      {presentation.visible ? (
        <CanvasTextPreviewImageLayer
          key={presentation.visible.sourceKey}
          layer="visible"
          source={presentation.visible}
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
        />
      ) : null}
    </div>
  );
}

type CanvasTextPreviewImageLayerProps = {
  source: CanvasTextPreviewSource;
  onFailure(source: CanvasTextPreviewSource, error: unknown): void;
} & ({
  layer: 'pending';
  onReady(source: CanvasTextPreviewSource): void;
} | {
  layer: 'visible';
  onVisibleCommitted(source: CanvasTextPreviewSource): void;
});

function CanvasTextPreviewImageLayer(props: CanvasTextPreviewImageLayerProps): React.ReactElement {
  const { layer, source } = props;
  const pendingSettledSourceKeyRef = useRef<string | undefined>(undefined);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const onVisibleCommittedRef = useRef<((source: CanvasTextPreviewSource) => void) | undefined>(undefined);
  onVisibleCommittedRef.current = props.layer === 'visible' ? props.onVisibleCommitted : undefined;

  const finishPendingLoad = (image: HTMLImageElement) => {
    if (props.layer !== 'pending'
      || pendingSettledSourceKeyRef.current === source.sourceKey
      || !image.isConnected
      || image.dataset.canvasTextPreviewSourceKey !== source.sourceKey) {
      return;
    }
    pendingSettledSourceKeyRef.current = source.sourceKey;
    props.onReady(source);
  };

  useLayoutEffect(() => {
    if (layer !== 'pending') {
      return undefined;
    }
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) {
      finishPendingLoad(image);
    }
    return undefined;
  }, [layer, source.sourceKey]);

  useLayoutEffect(() => {
    if (layer !== 'visible') {
      return undefined;
    }
    let secondFrame: number | undefined;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        secondFrame = undefined;
        onVisibleCommittedRef.current?.(source);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) {
        window.cancelAnimationFrame(secondFrame);
      }
    };
  }, [layer, source.sourceKey]);

  return (
    <img
      ref={imageRef}
      className={`canvas-text-preview-image canvas-text-preview-image--${layer}`}
      src={source.src}
      alt=""
      draggable={false}
      decoding="async"
      data-canvas-text-preview-layer={layer}
      data-canvas-text-preview-source-key={source.sourceKey}
      data-preview-width={source.previewWidth}
      onLoad={layer === 'pending'
        ? (event) => finishPendingLoad(event.currentTarget)
        : undefined}
      onError={(event) => {
        if (layer === 'visible') {
          props.onFailure(source, event.nativeEvent);
          return;
        }
        const image = event.currentTarget;
        if (pendingSettledSourceKeyRef.current === source.sourceKey
          || !image.isConnected
          || image.dataset.canvasTextPreviewSourceKey !== source.sourceKey) {
          return;
        }
        pendingSettledSourceKeyRef.current = source.sourceKey;
        props.onFailure(source, event.nativeEvent);
      }}
    />
  );
}
