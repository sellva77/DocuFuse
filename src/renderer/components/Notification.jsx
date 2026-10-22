import React, { useState, useEffect, useCallback } from 'react';
import { Icons } from './Icons';

export default function Notification({ notification, onDismiss }) {
  const [isLeaving, setIsLeaving] = useState(false);

  useEffect(() => {
    if (!notification) return;

    const timer = setTimeout(() => {
      setIsLeaving(true);
      setTimeout(() => {
        onDismiss();
        setIsLeaving(false);
      }, 250);
    }, notification.duration || 8000);

    return () => clearTimeout(timer);
  }, [notification, onDismiss]);

  const handleDismiss = useCallback(() => {
    setIsLeaving(true);
    setTimeout(() => {
      onDismiss();
      setIsLeaving(false);
    }, 250);
  }, [onDismiss]);

  const handleShowInFolder = useCallback(() => {
    if (notification?.outputPath && window.electronAPI) {
      window.electronAPI.showItemInFolder(notification.outputPath);
    }
  }, [notification]);

  if (!notification) return null;

  const iconMap = {
    success: <Icons.CheckCircle />,
    error: <Icons.AlertCircle />,
    warning: <Icons.AlertTriangle />,
  };

  return (
    <div
      className={`notification ${notification.type} ${isLeaving ? 'leaving' : ''}`}
      role="alert"
      id="notification"
    >
      <div className="notification-icon">
        {iconMap[notification.type] || iconMap.success}
      </div>
      <div className="notification-content">
        <div className="notification-title">{notification.title}</div>
        <div className="notification-message">{notification.message}</div>
        {notification.outputPath && (
          <div className="notification-actions">
            <button
              className="btn-notification-action primary"
              onClick={handleShowInFolder}
              id="btn-show-in-folder"
            >
              <Icons.ExternalLink />
              Show in Folder
            </button>
          </div>
        )}
      </div>
      <button className="btn-notification-close" onClick={handleDismiss} aria-label="Dismiss">
        <Icons.X />
      </button>
    </div>
  );
}
