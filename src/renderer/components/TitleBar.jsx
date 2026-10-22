import React, { useState, useEffect } from 'react';
import { Icons } from './Icons';

export default function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const checkMaximized = async () => {
      if (window.electronAPI) {
        const max = await window.electronAPI.isMaximized();
        setIsMaximized(max);
      }
    };
    checkMaximized();

    // Listen for window state changes
    const interval = setInterval(checkMaximized, 500);
    return () => clearInterval(interval);
  }, []);

  const handleMinimize = () => window.electronAPI?.minimizeWindow();
  const handleMaximize = async () => {
    await window.electronAPI?.maximizeWindow();
    const max = await window.electronAPI?.isMaximized();
    setIsMaximized(max);
  };
  const handleClose = () => window.electronAPI?.closeWindow();

  return (
    <div className="titlebar">
      <div className="titlebar-title">
        <div className="titlebar-icon">
          <Icons.DocMergerLogo />
        </div>
        <span>Document Merger</span>
      </div>
      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={handleMinimize} aria-label="Minimize" id="btn-minimize">
          <Icons.Minimize />
        </button>
        <button className="titlebar-btn" onClick={handleMaximize} aria-label={isMaximized ? 'Restore' : 'Maximize'} id="btn-maximize">
          {isMaximized ? <Icons.Restore /> : <Icons.Maximize />}
        </button>
        <button className="titlebar-btn close" onClick={handleClose} aria-label="Close" id="btn-close">
          <Icons.Close />
        </button>
      </div>
    </div>
  );
}
