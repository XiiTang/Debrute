import React from 'react';

export interface CanvasNodeTitleBarProps {
  icon: React.ReactNode;
  title: string;
  status?: React.ReactNode | undefined;
  actions?: React.ReactNode | undefined;
}

export function CanvasNodeTitleBar({
  icon,
  title,
  status,
  actions
}: CanvasNodeTitleBarProps): React.ReactElement {
  return (
    <div
      className="db-canvas-node-titlebar"
      data-canvas-node-zone="manipulation"
    >
      {icon}
      <strong>{title}</strong>
      {status}
      {actions}
    </div>
  );
}
