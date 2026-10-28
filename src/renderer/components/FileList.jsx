import React, { useState, useCallback, useRef } from 'react';
import { Icons } from './Icons';

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function getIconClass(ext) {
  switch (ext) {
    case '.pdf': return 'pdf';
    case '.docx': return 'docx';
    case '.doc': return 'doc';
    default: return 'docx';
  }
}

function getIconLabel(ext) {
  switch (ext) {
    case '.pdf': return 'PDF';
    case '.docx': return 'DOCX';
    case '.doc': return 'DOC';
    default: return 'FILE';
  }
}

export default function FileList({
  files,
  activePreviewIndex = 0,
  onSelectPreview,
  onOpenPreview,
  onRemove,
  onClear,
  onReorder,
}) {
  const [dragIndex, setDragIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  const dragItem = useRef(null);

  const handleDragStart = useCallback((e, index) => {
    dragItem.current = index;
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    // Required for Firefox
    e.dataTransfer.setData('text/plain', String(index));
  }, []);

  const handleDragOver = useCallback((e, index) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
    dragItem.current = null;
  }, []);

  const handleDrop = useCallback((e, dropIndex) => {
    e.preventDefault();
    const fromIndex = dragItem.current;
    if (fromIndex !== null && fromIndex !== dropIndex) {
      onReorder(fromIndex, dropIndex);
      if (activePreviewIndex === fromIndex) {
        onSelectPreview?.(dropIndex);
      }
    }
    setDragIndex(null);
    setDragOverIndex(null);
    dragItem.current = null;
  }, [onReorder, activePreviewIndex, onSelectPreview]);

  const handleFileClick = useCallback((index) => {
    if (onOpenPreview) {
      onOpenPreview(index);
    } else {
      onSelectPreview?.(index);
    }
  }, [onOpenPreview, onSelectPreview]);

  if (files.length === 0) return null;

  return (
    <div className="file-list-section">
      <div className="file-list-header">
        <h2>
          Selected Files
          <span className="file-count">{files.length}</span>
        </h2>
        <button className="btn-clear-all" onClick={onClear} id="btn-clear-all">
          <Icons.Trash />
          Clear All
        </button>
      </div>

      <div className="file-list" role="list" aria-label="Selected files">
        {files.map((file, index) => {
          const isActivelyPreviewed = activePreviewIndex === index;

          return (
            <div
              key={`${file.path}-${index}`}
              className={`file-item ${dragIndex === index ? 'dragging-item' : ''} ${dragOverIndex === index ? 'drag-over' : ''} ${isActivelyPreviewed ? 'active-preview' : ''}`}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragEnd={handleDragEnd}
              onDrop={(e) => handleDrop(e, index)}
              onClick={() => handleFileClick(index)}
              role="listitem"
              aria-label={`File ${index + 1}: ${file.name}`}
            >
              {/* Drag handle */}
              <div className="file-item-drag-handle" aria-label="Drag to reorder" onClick={(e) => e.stopPropagation()}>
                <div className="drag-dot-row">
                  <span className="drag-dot" /><span className="drag-dot" />
                </div>
                <div className="drag-dot-row">
                  <span className="drag-dot" /><span className="drag-dot" />
                </div>
                <div className="drag-dot-row">
                  <span className="drag-dot" /><span className="drag-dot" />
                </div>
              </div>

              {/* Order number */}
              <div className="file-item-order">{index + 1}</div>

              {/* File type icon */}
              <div className={`file-item-icon ${getIconClass(file.extension)}`}>
                {getIconLabel(file.extension)}
              </div>

              {/* File info */}
              <div className="file-item-info">
                <div className="file-item-name" title={file.name}>{file.name}</div>
                <div className="file-item-meta">
                  <span>{file.type}</span>
                  <span className="dot" />
                  <span>{formatFileSize(file.size)}</span>
                  {file.excludedPages && file.excludedPages.length > 0 && (
                    <>
                      <span className="dot" />
                      <span className="file-excluded-pages-badge">
                        {file.excludedPages.length} page{file.excludedPages.length > 1 ? 's' : ''} removed
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Preview Quick Button */}
              <button
                type="button"
                className={`btn-file-preview ${isActivelyPreviewed ? 'active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleFileClick(index);
                }}
                title={`Preview ${file.name}`}
                aria-label={`Preview ${file.name}`}
              >
                <Icons.Eye />
                <span>Preview</span>
              </button>

              {/* Status */}
              <span className={`file-item-status ${file.error ? 'error' : 'ready'}`}>
                {file.error ? 'Error' : 'Ready'}
              </span>

              {/* Remove button */}
              <button
                className="btn-remove"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(index);
                }}
                aria-label={`Remove ${file.name}`}
                id={`btn-remove-${index}`}
              >
                <Icons.X />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
