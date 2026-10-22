import React, { useState, useCallback } from 'react';
import { Icons } from './Icons';

export default function DropZone({ onFilesAdded }) {
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = React.useRef(0);

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const filePaths = Array.from(files).map(f => f.path).filter(Boolean);
    if (filePaths.length === 0) return;

    if (window.electronAPI) {
      const result = await window.electronAPI.validateFiles(filePaths);
      if (result.files && result.files.length > 0) {
        onFilesAdded(result.files);
      }
      if (result.errors && result.errors.length > 0) {
        // Return errors for the parent to handle
        onFilesAdded([], result.errors);
      }
    }
  }, [onFilesAdded]);

  const handleBrowse = useCallback(async () => {
    if (window.electronAPI) {
      const result = await window.electronAPI.openFileDialog();
      if (!result.canceled && result.files && result.files.length > 0) {
        onFilesAdded(result.files);
      }
    }
  }, [onFilesAdded]);

  return (
    <div className="dropzone-container">
      <div
        className={`dropzone ${isDragging ? 'dragging' : ''}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onClick={handleBrowse}
        role="button"
        tabIndex={0}
        aria-label="Drop zone for documents"
        id="dropzone"
      >
        <div className="dropzone-icon">
          <Icons.Upload />
        </div>
        <p className="dropzone-text">
          <strong>Drag & drop</strong> your documents here
        </p>
        <p className="dropzone-hint">
          Supports PDF, Word (DOCX, DOC), and Excel (XLSX, XLS) files
        </p>
        <button
          className="btn-browse"
          onClick={(e) => {
            e.stopPropagation();
            handleBrowse();
          }}
          id="btn-browse-files"
        >
          <Icons.FolderOpen />
          Browse Files
        </button>
      </div>
    </div>
  );
}
