import React from 'react';

export default function ProgressOverlay({ progress }) {
  if (!progress) return null;

  return (
    <div className="progress-overlay" role="dialog" aria-label="Processing progress" id="progress-overlay">
      <div className="progress-card">
        <div className="progress-spinner" />
        <h3 className="progress-title">{progress.step || 'Processing'}</h3>
        <p className="progress-detail">{progress.detail || 'Please wait...'}</p>
        <div className="progress-bar-container">
          <div
            className="progress-bar-fill"
            style={{ width: `${progress.percent || 0}%` }}
            role="progressbar"
            aria-valuenow={progress.percent || 0}
            aria-valuemin="0"
            aria-valuemax="100"
          />
        </div>
        <p className="progress-percent">{progress.percent || 0}%</p>
      </div>
    </div>
  );
}
