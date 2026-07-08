import React from 'react';

export interface CanvasNodeTitleBarProps {
  icon: React.ReactNode;
  title: string;
  status?: React.ReactNode | undefined;
  actions?: React.ReactNode | undefined;
  onPointerDown?: ((event: React.PointerEvent<HTMLDivElement>) => void) | undefined;
  onPointerMove?: ((event: React.PointerEvent<HTMLDivElement>) => void) | undefined;
  onPointerUp?: ((event: React.PointerEvent<HTMLDivElement>) => void) | undefined;
}

export function CanvasNodeTitleBar({
  icon,
  title,
  status,
  actions,
  onPointerDown,
  onPointerMove,
  onPointerUp
}: CanvasNodeTitleBarProps): React.ReactElement {
  return (
    <div
      className="db-canvas-node-titlebar"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {icon}
      <strong>{title}</strong>
      {status}
      {actions}
    </div>
  );
}
