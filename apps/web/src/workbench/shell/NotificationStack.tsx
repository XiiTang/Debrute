import React from 'react';

export function NotificationStack({ notifications }: { notifications: string[] }): React.ReactElement | null {
  if (notifications.length === 0) {
    return null;
  }
  return (
    <div className="notifications">
      {notifications.map((notification) => (
        <div className="notification" key={notification}>{notification}</div>
      ))}
    </div>
  );
}
