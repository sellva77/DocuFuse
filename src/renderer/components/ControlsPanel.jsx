import React from 'react';
import { Icons } from './Icons';

export default function ControlsPanel({ outputFormat, onFormatChange, onMerge, onPreview, canMerge, isMerging }) {
  return (
    <div className="controls-panel">
      <div className="format-selector">
        <span className="format-selector-label">Output Format</span>
        <div className="format-options">
          <button
            className={`format-option ${outputFormat === 'pdf' ? 'active' : ''}`}
            onClick={() => onFormatChange('pdf')}
            aria-pressed={outputFormat === 'pdf'}
            id="format-pdf"
          >
            <Icons.PDF />
            PDF
          </button>
          <button
            className={`format-option ${outputFormat === 'docx' ? 'active' : ''}`}
            onClick={() => onFormatChange('docx')}
            aria-pressed={outputFormat === 'docx'}
            id="format-docx"
          >
            <Icons.Word />
            Word DOCX
          </button>
        </div>
      </div>

      <div className="controls-actions">
        {onPreview && (
          <button
            type="button"
            className="btn-preview-merged"
            onClick={onPreview}
            disabled={!canMerge}
            title="Preview documents before merging"
            id="btn-preview-merged"
          >
            <Icons.Eye />
            Preview
          </button>
        )}

        <button
          className="btn-merge"
          onClick={onMerge}
          disabled={!canMerge || isMerging}
          aria-label="Merge and export documents"
          id="btn-merge"
        >
          <Icons.Merge />
          {isMerging ? 'Merging...' : 'Merge & Export'}
        </button>
      </div>
    </div>
  );
}
