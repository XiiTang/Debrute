import React from 'react';
import { Card } from '../ui/index.js';

export function NotificationStack({ notifications }: { notifications: string[] }): React.ReactElement | null {
  if (notifications.length === 0) {
    return null;
  }
  return (
    <div className="db-notification-stack">
      {notifications.map((notification, index) => (
        <Card className="db-notification-row" key={`${index}:${notification}`}>{notification}</Card>
      ))}
    </div>
  );
}
