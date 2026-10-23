import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Icons } from './Icons';
import * as pdfjsLib from 'pdfjs-dist';
import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.js?worker';

// Normalize pdfjs module for both namespace and default exports
const pdfjs = pdfjsLib.getDocument ? pdfjsLib : (pdfjsLib.default || pdfjsLib);

// Configure worker using Vite-supported ?worker module
if (typeof window !== 'undefined' && pdfjs.GlobalWorkerOptions) {
  try {
    if (!pdfjs.GlobalWorkerOptions.workerPort) {
      pdfjs.GlobalWorkerOptions.workerPort = new PdfjsWorker();
    }
  } catch (e) {
    try {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.js',
        import.meta.url
      ).toString();
    } catch (_) {}
  }
}

/**
 * Robust conversion of IPC data to Uint8Array across all Node/Electron Buffer formats
 */
function toUint8Array(data) {
  if (!data) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data?.buffer instanceof ArrayBuffer) {
    return new Uint8Array(
      data.buffer,
      data.byteOffset || 0,
      data.byteLength || data.length
    );
  }
  if (Array.isArray(data)) return new Uint8Array(data);
  if (data?.data && Array.isArray(data.data)) return new Uint8Array(data.data);
  return new Uint8Array(data);
}

/**
 * MergePdfPreview
 * 
 * Supports both embedded panel and popup modal views:
 * - isModal: boolean (renders centered modal with backdrop blur when true)
 * - isOpen: boolean
 * - onClose: () => void
 * - initialMode: 'document' | 'sequence'
 * - files: Array of file objects
 * - activeFileIndex: number
 * - onSelectFile: (index) => void
 */
export default function MergePdfPreview({
  files = [],
  activeFileIndex = 0,
  onSelectFile,
  isMerging = false,
  isModal = false,
  isOpen = true,
  onClose,
  initialMode = 'document',
}) {
  const containerRef = useRef(null);
  const viewportRef = useRef(null);
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const loadedDocsCache = useRef(new Map());

  // View settings
  const [viewMode, setViewMode] = useState(initialMode || 'document');
  const [selectedDocIndex, setSelectedDocIndex] = useState(activeFileIndex || 0);
  const [docPageNum, setDocPageNum] = useState(1);
  const [sequencePageNum, setSequencePageNum] = useState(1);
  const [docPageCounts, setDocPageCounts] = useState({});

  // Canvas & zoom state
  const [zoomLevel, setZoomLevel] = useState(1.0);
  const [rotation, setRotation] = useState(0);
  const [pageInputVal, setPageInputVal] = useState('');
  const [showThumbnails, setShowThumbnails] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Loading & error state
  const [isLoading, setIsLoading] = useState(false);
  const [loadingError, setLoadingError] = useState(null);
  const [currentPdfDoc, setCurrentPdfDoc] = useState(null);
  const [retryTrigger, setRetryTrigger] = useState(0);

  // Sync mode and file index when opened or changed
  useEffect(() => {
    if (initialMode) setViewMode(initialMode);
  }, [initialMode, isOpen]);

  useEffect(() => {
    if (typeof activeFileIndex === 'number' && activeFileIndex >= 0 && activeFileIndex < files.length) {
      setSelectedDocIndex(activeFileIndex);
      setDocPageNum(1);
    }
  }, [activeFileIndex, files.length, isOpen]);

  // Handle escape key to close modal
  useEffect(() => {
    if (!isModal || !isOpen) return;

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isModal, isOpen, onClose]);

  // Active document
  const currentFile = files[selectedDocIndex] || files[0] || null;
  const currentFilePath = currentFile?.path || currentFile?.filePath || '';
  const isPdfFile = currentFile?.extension?.toLowerCase() === '.pdf';

  // Build merged sequence mapping (all pages of all PDFs in merge order)
  const sequenceMap = useMemo(() => {
    const list = [];
    files.forEach((file, fIdx) => {
      const ext = file.extension?.toLowerCase();
      const p = file.path || file.filePath || '';
      if (ext === '.pdf') {
        const pages = docPageCounts[p] || 1;
        for (let pg = 1; pg <= pages; pg++) {
          list.push({
            fileIndex: fIdx,
            file,
            filePath: p,
            docPage: pg,
            docTotalPages: pages,
            isPdf: true,
          });
        }
      } else {
        list.push({
          fileIndex: fIdx,
          file,
          filePath: p,
          docPage: 1,
          docTotalPages: 1,
          isPdf: false,
        });
      }
    });
    return list;
  }, [files, docPageCounts]);

  const totalSequencePages = sequenceMap.length;

  const activeSequenceItem = viewMode === 'sequence'
    ? sequenceMap[sequencePageNum - 1] || sequenceMap[0] || null
    : null;

  const targetFile = viewMode === 'sequence'
    ? activeSequenceItem?.file || currentFile
    : currentFile;

  const targetFilePath = targetFile?.path || targetFile?.filePath || '';
  const targetPageNum = viewMode === 'sequence'
    ? activeSequenceItem?.docPage || 1
    : docPageNum;

  // Pre-load page counts for all PDF files
  useEffect(() => {
    let cancelled = false;

    async function loadAllPageCounts() {
      for (const file of files) {
        if (cancelled) break;
        const ext = file.extension?.toLowerCase();
        if (ext !== '.pdf') continue;
        const p = file.path || file.filePath;
        if (!p || docPageCounts[p]) continue;

        try {
          if (loadedDocsCache.current.has(p)) {
            const cached = loadedDocsCache.current.get(p);
            setDocPageCounts(prev => ({ ...prev, [p]: cached.numPages }));
            continue;
          }

          const res = await window.electronAPI.readPdfBytes(p);
          if (cancelled) break;
          if (res?.success && res.data) {
            const uint8 = toUint8Array(res.data);
            const task = pdfjs.getDocument({ data: uint8, cMapPacked: true });
            const doc = await task.promise;
            if (cancelled) break;
            loadedDocsCache.current.set(p, doc);
            setDocPageCounts(prev => ({ ...prev, [p]: doc.numPages }));
          }
        } catch (err) {
          console.warn(`Could not load page count for ${file.name}:`, err);
        }
      }
    }

    if (files.length > 0) {
      loadAllPageCounts();
    }

    return () => {
      cancelled = true;
    };
  }, [files, retryTrigger]);

  // Load the target PDF document for rendering
  useEffect(() => {
    if (!targetFile || targetFile.extension?.toLowerCase() !== '.pdf' || !targetFilePath) {
      setCurrentPdfDoc(null);
      setIsLoading(false);
      setLoadingError(null);
      return;
    }

    let cancelled = false;
    let localLoadingTask = null;

    async function loadTargetPdf() {
      setIsLoading(true);
      setLoadingError(null);

      if (loadedDocsCache.current.has(targetFilePath)) {
        const cached = loadedDocsCache.current.get(targetFilePath);
        setCurrentPdfDoc(cached);
        setIsLoading(false);
        return;
      }

      try {
        const res = await window.electronAPI.readPdfBytes(targetFilePath);
        if (cancelled) return;
        if (!res?.success) throw new Error(res?.error || 'Failed to read PDF file from disk');

        const uint8 = toUint8Array(res.data);
        localLoadingTask = pdfjs.getDocument({ data: uint8, cMapPacked: true });
        const doc = await localLoadingTask.promise;
        if (cancelled) return;

        loadedDocsCache.current.set(targetFilePath, doc);
        setCurrentPdfDoc(doc);
        setDocPageCounts(prev => ({ ...prev, [targetFilePath]: doc.numPages }));
      } catch (err) {
        if (!cancelled) {
          console.error('Merge preview PDF load error:', err);
          setLoadingError(err.message || 'Could not load PDF document for preview');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    loadTargetPdf();

    return () => {
      cancelled = true;
      if (localLoadingTask) {
        try { localLoadingTask.destroy(); } catch (_) {}
      }
    };
  }, [targetFilePath, retryTrigger]);

  // Render the target page onto the canvas
  useEffect(() => {
    if (!currentPdfDoc || !canvasRef.current || !targetFile || targetFile.extension?.toLowerCase() !== '.pdf') {
      return;
    }

    let cancelled = false;

    async function renderPage() {
      try {
        if (renderTaskRef.current) {
          try { renderTaskRef.current.cancel(); } catch (_) {}
          renderTaskRef.current = null;
        }

        const validPage = Math.max(1, Math.min(targetPageNum, currentPdfDoc.numPages));
        const page = await currentPdfDoc.getPage(validPage);
        if (cancelled) return;

        const viewportContainer = viewportRef.current;
        const containerWidth = viewportContainer?.clientWidth || 720;
        const containerHeight = (viewportContainer?.clientHeight || 500) - 40;

        const unscaledViewport = page.getViewport({ scale: 1.0, rotation });
        const widthScale = Math.max(0.2, (containerWidth - 50) / unscaledViewport.width);
        const heightScale = Math.max(0.15, containerHeight / unscaledViewport.height);
        const pageScale = Math.min(widthScale, heightScale);

        let effectiveScale = zoomLevel;
        if (zoomLevel === -1) effectiveScale = widthScale;
        else if (zoomLevel === -2) effectiveScale = pageScale;

        const viewport = page.getViewport({ scale: effectiveScale, rotation });
        const dpr = window.devicePixelRatio || 1;
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const renderTask = page.render({
          canvasContext: ctx,
          viewport,
        });
        renderTaskRef.current = renderTask;

        await renderTask.promise;
      } catch (err) {
        if (!cancelled && err?.name !== 'RenderingCancelledException') {
          console.error('Merge preview canvas render error:', err);
        }
      }
    }

    renderPage();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel(); } catch (_) {}
      }
    };
  }, [currentPdfDoc, targetPageNum, zoomLevel, rotation, targetFilePath]);

  const maxDocPages = currentPdfDoc?.numPages || docPageCounts[currentFilePath] || 1;

  const handlePrevPage = useCallback(() => {
    if (viewMode === 'sequence') setSequencePageNum(p => Math.max(1, p - 1));
    else setDocPageNum(p => Math.max(1, p - 1));
  }, [viewMode]);

  const handleNextPage = useCallback(() => {
    if (viewMode === 'sequence') setSequencePageNum(p => Math.min(totalSequencePages, p + 1));
    else setDocPageNum(p => Math.min(maxDocPages, p + 1));
  }, [viewMode, totalSequencePages, maxDocPages]);

  const handleFirstPage = useCallback(() => {
    if (viewMode === 'sequence') setSequencePageNum(1);
    else setDocPageNum(1);
  }, [viewMode]);

  const handleLastPage = useCallback(() => {
    if (viewMode === 'sequence') setSequencePageNum(totalSequencePages);
    else setDocPageNum(maxDocPages);
  }, [viewMode, totalSequencePages, maxDocPages]);

  const handlePageInputSubmit = useCallback((e) => {
    e.preventDefault();
    const val = parseInt(pageInputVal, 10);
    if (!isNaN(val)) {
      if (viewMode === 'sequence') {
        setSequencePageNum(Math.max(1, Math.min(totalSequencePages, val)));
      } else {
        setDocPageNum(Math.max(1, Math.min(maxDocPages, val)));
      }
    }
    setPageInputVal('');
  }, [pageInputVal, viewMode, totalSequencePages, maxDocPages]);

  const handleSelectDoc = useCallback((index) => {
    setSelectedDocIndex(index);
    setDocPageNum(1);
    onSelectFile?.(index);
  }, [onSelectFile]);

  const handleZoomIn = useCallback(() => {
    setZoomLevel(z => Math.min(3.0, +((z <= 0 ? 1.0 : z) * 1.2).toFixed(2)));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoomLevel(z => Math.max(0.3, +((z <= 0 ? 1.0 : z) / 1.2).toFixed(2)));
  }, []);

  const handleRotate = useCallback(() => {
    setRotation(r => (r + 90) % 360);
  }, []);

  const zoomDisplay = zoomLevel === -1
    ? 'Fit Width'
    : zoomLevel === -2
      ? 'Fit Page'
      : `${Math.round(zoomLevel * 100)}%`;

  const totalMergedPages = Object.values(docPageCounts).reduce((acc, c) => acc + (c || 1), 0);

  if (isModal && !isOpen) return null;
  if (!isModal && files.length === 0) return null;

  // The inner preview content
  const previewContent = (
    <div className={`merge-preview-container ${isModal ? 'modal-view' : 'embedded-view'}`}>
      {/* 1. Header with Mode Toggle & Stats */}
      <div className="merge-preview-header">
        <div className="merge-preview-title-group">
          <div className="merge-preview-icon-wrapper">
            <Icons.Eye />
          </div>
          <div>
            <h3 className="merge-preview-title">
              {isModal ? 'Document Preview' : 'Merge Preview'}
              <span className="merge-preview-badge">
                {files.length} document{files.length !== 1 ? 's' : ''}
              </span>
              {totalMergedPages > 0 && (
                <span className="merge-preview-badge pages">
                  {totalMergedPages} page{totalMergedPages !== 1 ? 's' : ''} total
                </span>
              )}
            </h3>
            <p className="merge-preview-subtitle">
              {isModal
                ? 'High-resolution document viewer with page navigation and zoom controls.'
                : 'Interactive page preview before merging. Inspect document flow, order, and appearance.'}
            </p>
          </div>
        </div>

        <div className="merge-preview-header-actions">
          {/* Mode Switcher: By Document vs Merged Sequence */}
          <div className="merge-preview-mode-toggle" title="Switch view perspective">
            <button
              type="button"
              className={`mode-btn ${viewMode === 'document' ? 'active' : ''}`}
              onClick={() => setViewMode('document')}
              id="btn-mode-document"
            >
              <Icons.File />
              <span>By Document</span>
            </button>
            <button
              type="button"
              className={`mode-btn ${viewMode === 'sequence' ? 'active' : ''}`}
              onClick={() => setViewMode('sequence')}
              id="btn-mode-sequence"
              title="Continuous page sequence in exact merge order"
            >
              <Icons.Layers />
              <span>Merged Sequence</span>
            </button>
          </div>

          {/* Close or Collapse button */}
          {isModal ? (
            <button
              type="button"
              className="merge-preview-close-modal-btn"
              onClick={onClose}
              title="Close preview (Esc)"
              aria-label="Close preview modal"
            >
              <Icons.X />
            </button>
          ) : (
            <button
              type="button"
              className="merge-preview-collapse-btn"
              onClick={() => setIsCollapsed(c => !c)}
              title={isCollapsed ? 'Expand preview viewer' : 'Collapse preview viewer'}
              aria-label="Toggle preview size"
            >
              {isCollapsed ? <Icons.Maximize2 /> : <Icons.Minimize2 />}
            </button>
          )}
        </div>
      </div>

      {!isCollapsed && (
        <>
          {/* 2. Document Switcher Pills */}
          <div className="merge-preview-switcher-bar">
            {viewMode === 'document' ? (
              <div className="merge-doc-pills" role="tablist">
                {files.map((file, idx) => {
                  const isSelected = idx === selectedDocIndex;
                  const ext = file.extension?.toLowerCase();
                  const p = file.path || file.filePath || '';
                  const pageCount = docPageCounts[p];

                  return (
                    <button
                      key={`${p}-${idx}`}
                      type="button"
                      className={`merge-doc-pill ${isSelected ? 'active' : ''}`}
                      onClick={() => handleSelectDoc(idx)}
                      role="tab"
                      aria-selected={isSelected}
                      title={file.name}
                    >
                      <span className="pill-order">{idx + 1}</span>
                      <span className="pill-name">{file.name}</span>
                      <span className={`pill-ext ${ext === '.pdf' ? 'pdf' : 'docx'}`}>
                        {ext?.replace('.', '').toUpperCase()}
                      </span>
                      {ext === '.pdf' && pageCount && (
                        <span className="pill-pages">{pageCount}p</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="merge-sequence-banner">
                <span className="seq-step-badge">
                  Merged Page {sequencePageNum} of {totalSequencePages}
                </span>
                <span className="seq-source-label">From Source File:</span>
                <span className="seq-file-name" title={activeSequenceItem?.file?.name}>
                  [{activeSequenceItem ? activeSequenceItem.fileIndex + 1 : 1}] {activeSequenceItem?.file?.name}
                </span>
                <span className="seq-file-page-tag">
                  (Page {activeSequenceItem?.docPage} of {activeSequenceItem?.docTotalPages})
                </span>
              </div>
            )}
          </div>

          {/* 3. Toolbar */}
          <div className="merge-preview-toolbar">
            <div className="pdf-toolbar-group">
              <button
                type="button"
                className="pdf-tb-btn"
                onClick={handleFirstPage}
                disabled={viewMode === 'sequence' ? sequencePageNum <= 1 : docPageNum <= 1}
                title="First page"
              >
                &laquo;
              </button>
              <button
                type="button"
                className="pdf-tb-btn"
                onClick={handlePrevPage}
                disabled={viewMode === 'sequence' ? sequencePageNum <= 1 : docPageNum <= 1}
                title="Previous page (Left arrow)"
              >
                <Icons.ChevronLeft />
              </button>

              <form onSubmit={handlePageInputSubmit} className="pdf-page-form">
                <span className="pdf-page-label">Page</span>
                <input
                  type="text"
                  className="pdf-page-input"
                  value={pageInputVal || (viewMode === 'sequence' ? sequencePageNum : docPageNum)}
                  onChange={(e) => setPageInputVal(e.target.value)}
                  onBlur={() => setPageInputVal('')}
                  aria-label="Current page"
                />
                <span className="pdf-page-total">
                  of {viewMode === 'sequence' ? totalSequencePages : maxDocPages}
                </span>
              </form>

              <button
                type="button"
                className="pdf-tb-btn"
                onClick={handleNextPage}
                disabled={viewMode === 'sequence' ? sequencePageNum >= totalSequencePages : docPageNum >= maxDocPages}
                title="Next page (Right arrow)"
              >
                <Icons.ChevronRight />
              </button>
              <button
                type="button"
                className="pdf-tb-btn"
                onClick={handleLastPage}
                disabled={viewMode === 'sequence' ? sequencePageNum >= totalSequencePages : docPageNum >= maxDocPages}
                title="Last page"
              >
                &raquo;
              </button>
            </div>

            <div className="pdf-toolbar-divider" />

            <div className="pdf-toolbar-group">
              <button
                type="button"
                className="pdf-tb-btn"
                onClick={handleZoomOut}
                title="Zoom Out (-)"
              >
                <Icons.ZoomOut />
              </button>
              <span className="pdf-zoom-label" title="Current zoom">{zoomDisplay}</span>
              <button
                type="button"
                className="pdf-tb-btn"
                onClick={handleZoomIn}
                title="Zoom In (+)"
              >
                <Icons.ZoomIn />
              </button>

              <button
                type="button"
                className={`pdf-tb-btn ${zoomLevel === -1 ? 'active' : ''}`}
                onClick={() => setZoomLevel(-1)}
                title="Fit to width"
              >
                Fit Width
              </button>
              <button
                type="button"
                className={`pdf-tb-btn ${zoomLevel === -2 ? 'active' : ''}`}
                onClick={() => setZoomLevel(-2)}
                title="Fit to page"
              >
                Fit Page
              </button>
              <button
                type="button"
                className={`pdf-tb-btn ${zoomLevel === 1.0 ? 'active' : ''}`}
                onClick={() => setZoomLevel(1.0)}
                title="Reset zoom to 100%"
              >
                100%
              </button>
            </div>

            <div className="pdf-toolbar-divider" />

            <div className="pdf-toolbar-group">
              <button
                type="button"
                className="pdf-tb-btn"
                onClick={handleRotate}
                title="Rotate 90° Clockwise"
              >
                <Icons.RotateCw />
                <span>{rotation !== 0 ? `${rotation}°` : 'Rotate'}</span>
              </button>
              <button
                type="button"
                className={`pdf-tb-btn ${showThumbnails ? 'active' : ''}`}
                onClick={() => setShowThumbnails(s => !s)}
                title="Toggle page thumbnails"
              >
                <Icons.Grid />
                <span>Thumbnails</span>
              </button>
            </div>

            {isModal && (
              <div className="pdf-toolbar-group-right">
                <button
                  type="button"
                  className="pdf-tb-btn btn-close-preview-modal"
                  onClick={onClose}
                >
                  Close Preview
                </button>
              </div>
            )}
          </div>

          {/* 4. Canvas Viewport Area */}
          <div className="merge-preview-viewport" ref={viewportRef}>
            {isLoading && (
              <div className="pdf-canvas-loading">
                <div className="pdf-spinner" />
                <span>Rendering high-resolution document preview...</span>
              </div>
            )}

            {loadingError && !isLoading && (
              <div className="pdf-canvas-error">
                <Icons.AlertTriangle />
                <div className="pdf-canvas-error-text">
                  <p className="pdf-error-title">Document Preview Error</p>
                  <p className="pdf-error-detail">{loadingError}</p>
                  <button
                    type="button"
                    className="pdf-retry-btn"
                    onClick={() => setRetryTrigger(r => r + 1)}
                  >
                    <Icons.Refresh />
                    Retry Preview
                  </button>
                </div>
              </div>
            )}

            {/* Non-PDF File Card */}
            {!isLoading && !loadingError && targetFile && targetFile.extension?.toLowerCase() !== '.pdf' && (
              <div className="merge-non-pdf-placeholder">
                <div className="non-pdf-icon-card">
                  {targetFile.extension?.toLowerCase().includes('doc') ? <Icons.Word /> : <Icons.Excel />}
                </div>
                <h4>{targetFile.name}</h4>
                <div className="non-pdf-pill-row">
                  <span className="non-pdf-tag">{targetFile.type}</span>
                  <span className="non-pdf-tag">Dynamic Conversion</span>
                </div>
                <p>
                  This document will be automatically converted to high-fidelity PDF during the merge process and positioned at slot <strong>#{selectedDocIndex + 1}</strong> in your final merged document.
                </p>
              </div>
            )}

            {/* Canvas Viewport */}
            {!loadingError && targetFile && targetFile.extension?.toLowerCase() === '.pdf' && (
              <div className="merge-canvas-wrapper" ref={containerRef}>
                <canvas ref={canvasRef} className="merge-pdf-canvas" />
              </div>
            )}
          </div>

          {/* 5. Page Thumbnail Strip */}
          {showThumbnails && (
            <div className="merge-thumbnails-strip">
              <div className="thumbnails-scroll-container">
                {viewMode === 'sequence' ? (
                  sequenceMap.map((item, idx) => {
                    const isCurrent = idx === sequencePageNum - 1;
                    return (
                      <button
                        key={`thumb-seq-${idx}`}
                        type="button"
                        className={`thumb-card ${isCurrent ? 'active' : ''}`}
                        onClick={() => setSequencePageNum(idx + 1)}
                        title={`Page ${idx + 1} (${item.file.name})`}
                      >
                        <div className="thumb-preview-box">
                          <Icons.PDF />
                          <span className="thumb-doc-idx">Doc {item.fileIndex + 1}</span>
                        </div>
                        <div className="thumb-caption">
                          <span>p.{idx + 1}</span>
                          <span className="thumb-sub">({item.docPage}/{item.docTotalPages})</span>
                        </div>
                      </button>
                    );
                  })
                ) : (
                  Array.from({ length: maxDocPages }, (_, i) => i + 1).map((pg) => {
                    const isCurrent = pg === docPageNum;
                    return (
                      <button
                        key={`thumb-doc-${pg}`}
                        type="button"
                        className={`thumb-card ${isCurrent ? 'active' : ''}`}
                        onClick={() => setDocPageNum(pg)}
                        title={`Page ${pg}`}
                      >
                        <div className="thumb-preview-box">
                          <Icons.PDF />
                          <span className="thumb-doc-idx">Page {pg}</span>
                        </div>
                        <div className="thumb-caption">
                          <span>Page {pg}</span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );

  // If modal, wrap in overlay
  if (isModal) {
    return (
      <div className="merge-preview-modal-overlay" onClick={onClose} id="merge-preview-modal">
        <div className="merge-preview-modal-dialog" onClick={(e) => e.stopPropagation()}>
          {previewContent}
        </div>
      </div>
    );
  }

  // Embedded view on page
  return (
    <div className={`merge-preview-section ${isCollapsed ? 'collapsed' : ''}`} id="merge-preview-section">
      {previewContent}
    </div>
  );
}
