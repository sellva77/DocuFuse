import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Icons } from './Icons';
import {
  screenToNormalized,
  normalizedToScreen,
  normalizeRect,
  clampRectToBounds,
} from '../../utils/pdfCoordinateUtils.js';

import * as pdfjsLib from 'pdfjs-dist';
import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.js?worker';

// Normalize pdfjs module for both namespace and default exports
const pdfjs = pdfjsLib.getDocument ? pdfjsLib : (pdfjsLib.default || pdfjsLib);

// Configure worker using Vite-supported ?worker module.
// GlobalWorkerOptions.workerPort overrides workerSrc and completely avoids HTTP fetch/CORS/fake worker issues.
if (typeof window !== 'undefined' && pdfjs.GlobalWorkerOptions) {
  try {
    if (!pdfjs.GlobalWorkerOptions.workerPort) {
      pdfjs.GlobalWorkerOptions.workerPort = new PdfjsWorker();
    }
  } catch (e) {
    console.warn('Could not instantiate workerPort, falling back to workerSrc', e);
    try {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.js',
        import.meta.url
      ).toString();
    } catch (_) {}
  }
}

/**
 * PdfSignatureCanvas
 * 
 * Interactive PDF viewer with drag-to-draw signature rectangle placement.
 * Uses PDF.js to render pages onto a <canvas>, with an overlay for the
 * interactive signature box (move, resize with 8 handles, delete).
 *
 * Props:
 * - filePath: string - Path to the PDF file to render
 * - onPlacementChange: ({ page, normX, normY, normWidth, normHeight }) => void
 * - placement: { page, normX, normY, normWidth, normHeight } | null - existing placement
 * - disabled: boolean
 * - signerName: string
 * - reason: string
 */
export default function PdfSignatureCanvas({
  filePath,
  onPlacementChange,
  placement,
  disabled = false,
  signerName = '',
  reason = '',
  location = '',
  onApplyToAll,
  hasMultipleDocs = false,
  customAppearance = null,
  onOpenCustomizeAppearance,
}) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const renderTaskRef = useRef(null);

  // Context menu state for right-click
  const [contextMenu, setContextMenu] = useState(null); // { x, y } in viewport px

  // PDF state
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pageNum, setPageNum] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [retryCount, setRetryCount] = useState(0);

  // Zoom state
  const [zoomLevel, setZoomLevel] = useState(1.0);
  const [fitWidthScale, setFitWidthScale] = useState(1.0);
  const [fitPageScale, setFitPageScale] = useState(1.0);

  // Rendering dimensions (CSS pixels the canvas occupies)
  const [viewportDims, setViewportDims] = useState({ width: 0, height: 0 });

  // Placement mode and rect state
  const [placingMode, setPlacingMode] = useState(false);
  const [sigRect, setSigRect] = useState(null); // { x, y, width, height } in CSS px relative to canvas
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef(null);

  // Move/resize state
  const [interactionMode, setInteractionMode] = useState(null); // 'move' | 'resize-nw' | ... | null
  const interactionStartRef = useRef(null);

  // Page jump input
  const [pageInputVal, setPageInputVal] = useState('');

  // Load PDF document from file
  useEffect(() => {
    if (!filePath) {
      setPdfDoc(null);
      setTotalPages(0);
      setPageNum(1);
      setLoadError(null);
      return;
    }

    let cancelled = false;
    let loadingTask = null;

    async function loadPdf() {
      setIsLoading(true);
      setLoadError(null);
      setSigRect(null);

      try {
        // Read bytes via Electron IPC
        const result = await window.electronAPI.readPdfBytes(filePath);
        if (!result.success) throw new Error(result.error || 'Failed to read PDF file from disk');
        if (cancelled) return;

        // Ensure data is Uint8Array
        let data;
        if (result.data instanceof Uint8Array) {
          data = result.data;
        } else if (result.data instanceof ArrayBuffer) {
          data = new Uint8Array(result.data);
        } else if (result.data?.buffer instanceof ArrayBuffer) {
          data = new Uint8Array(
            result.data.buffer,
            result.data.byteOffset || 0,
            result.data.byteLength || result.data.length
          );
        } else {
          data = new Uint8Array(result.data);
        }

        // Ensure workerPort or workerSrc is initialized before creating document task
        if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerPort && !pdfjs.GlobalWorkerOptions.workerSrc) {
          try {
            pdfjs.GlobalWorkerOptions.workerPort = new PdfjsWorker();
          } catch (_) {
            try {
              pdfjs.GlobalWorkerOptions.workerSrc = new URL(
                'pdfjs-dist/build/pdf.worker.min.js',
                import.meta.url
              ).toString();
            } catch (__) {}
          }
        }

        loadingTask = pdfjs.getDocument({
          data,
          cMapPacked: true,
        });

        const doc = await loadingTask.promise;
        if (cancelled) return;

        setPdfDoc(doc);
        setTotalPages(doc.numPages);
        const targetPage = (placement && typeof placement.page === 'number' && placement.page >= 1 && placement.page <= doc.numPages) ? placement.page : 1;
        setPageNum(targetPage);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err.message || 'An error occurred while loading the PDF document');
          console.error('PDF load error:', err);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    loadPdf();
    return () => {
      cancelled = true;
      if (loadingTask) {
        try { loadingTask.destroy(); } catch (_) {}
      }
    };
  }, [filePath, retryCount]);

  // Restore placement rect when page changes or placement prop changes
  useEffect(() => {
    if (placement && placement.page === pageNum && viewportDims.width > 0) {
      const screen = normalizedToScreen(
        { normX: placement.normX, normY: placement.normY, normWidth: placement.normWidth, normHeight: placement.normHeight },
        viewportDims.width,
        viewportDims.height
      );
      setSigRect(screen);
    } else if (!placement || placement.page !== pageNum) {
      setSigRect(null);
    }
  }, [pageNum, placement, viewportDims]);

  // Render PDF page onto canvas
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;

    let cancelled = false;

    async function renderPage() {
      try {
        // Cancel in-flight page rendering if page or zoom changed
        if (renderTaskRef.current) {
          try {
            renderTaskRef.current.cancel();
          } catch (_) {}
          renderTaskRef.current = null;
        }

        const page = await pdfDoc.getPage(pageNum);
        if (cancelled) return;

        const containerWidth = containerRef.current?.clientWidth || 700;
        const unscaledViewport = page.getViewport({ scale: 1.0 });

        // Compute fit-to-width scale (with 40px margin)
        const fitScale = Math.max(0.2, (containerWidth - 40) / unscaledViewport.width);
        setFitWidthScale(fitScale);

        // Compute fit-to-page scale (with 40px margin, assuming ~480px viewport height)
        const viewportContainer = containerRef.current?.querySelector('.pdf-canvas-viewport');
        const availHeight = (viewportContainer?.clientHeight || 480) - 40;
        const pageFit = Math.max(0.15, Math.min(fitScale, availHeight / unscaledViewport.height));
        setFitPageScale(pageFit);

        let effectiveScale = zoomLevel;
        if (zoomLevel === -1) effectiveScale = fitScale;
        else if (zoomLevel === -2) effectiveScale = pageFit;

        const viewport = page.getViewport({ scale: effectiveScale });

        const dpr = window.devicePixelRatio || 1;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        setViewportDims({ width: viewport.width, height: viewport.height });

        const renderTask = page.render({
          canvasContext: ctx,
          viewport,
        });
        renderTaskRef.current = renderTask;

        await renderTask.promise;
      } catch (err) {
        if (!cancelled && err?.name !== 'RenderingCancelledException') {
          console.error('Render error:', err);
        }
      }
    }

    renderPage();
    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch (_) {}
      }
    };
  }, [pdfDoc, pageNum, zoomLevel]);

  // Navigation
  const goToPage = useCallback((num) => {
    const p = Math.max(1, Math.min(totalPages, num));
    setPageNum(p);
    setPageInputVal('');
  }, [totalPages]);

  const handlePageInputKeyDown = (e) => {
    if (e.key === 'Enter') {
      const val = parseInt(pageInputVal, 10);
      if (!isNaN(val)) goToPage(val);
    }
  };

  // Zoom controls
  const zoomIn = () => {
    const current = zoomLevel === -1 ? fitWidthScale : (zoomLevel === -2 ? fitPageScale : zoomLevel);
    setZoomLevel(Math.min(3.0, Math.round((current + 0.25) * 100) / 100));
  };
  const zoomOut = () => {
    const current = zoomLevel === -1 ? fitWidthScale : (zoomLevel === -2 ? fitPageScale : zoomLevel);
    setZoomLevel(Math.max(0.2, Math.round((current - 0.25) * 100) / 100));
  };
  const zoomFitWidth = () => setZoomLevel(-1);
  const zoomFitPage = () => setZoomLevel(-2);
  const zoomReset = () => setZoomLevel(1.0);

  const displayZoom = zoomLevel === -1
    ? Math.round(fitWidthScale * 100)
    : zoomLevel === -2
      ? Math.round(fitPageScale * 100)
      : Math.round(zoomLevel * 100);

  // ── Signature Size Adjustment Controls (Increase / Decrease / Presets) ──
  const updateRectSize = useCallback((newWidth, newHeight) => {
    setSigRect(prev => {
      if (!prev || viewportDims.width === 0) return prev;
      const centerX = prev.x + prev.width / 2;
      const centerY = prev.y + prev.height / 2;

      // Min 40x20 px, Max page width/height - 10px
      const clampedW = Math.max(40, Math.min(viewportDims.width - 10, Math.round(newWidth)));
      const clampedH = Math.max(20, Math.min(viewportDims.height - 10, Math.round(newHeight)));

      const newX = Math.round(centerX - clampedW / 2);
      const newY = Math.round(centerY - clampedH / 2);

      const clamped = clampRectToBounds({ x: newX, y: newY, width: clampedW, height: clampedH }, viewportDims, 5);

      const norm = screenToNormalized(clamped, viewportDims.width, viewportDims.height);
      onPlacementChange?.({
        page: pageNum,
        normX: norm.normX,
        normY: norm.normY,
        normWidth: norm.normWidth,
        normHeight: norm.normHeight,
      });

      return clamped;
    });
  }, [viewportDims, pageNum, onPlacementChange]);

  const increaseSize = useCallback(() => {
    setSigRect(prev => {
      if (!prev) return prev;
      updateRectSize(prev.width * 1.2, prev.height * 1.2);
      return prev;
    });
  }, [updateRectSize]);

  const decreaseSize = useCallback(() => {
    setSigRect(prev => {
      if (!prev) return prev;
      updateRectSize(prev.width * 0.83, prev.height * 0.83);
      return prev;
    });
  }, [updateRectSize]);

  const setPresetSize = useCallback((preset) => {
    if (viewportDims.width === 0) return;
    switch (preset) {
      case 'small':
        updateRectSize(Math.min(140, viewportDims.width * 0.25), Math.min(50, viewportDims.height * 0.08));
        break;
      case 'medium':
        updateRectSize(Math.min(200, viewportDims.width * 0.35), Math.min(70, viewportDims.height * 0.12));
        break;
      case 'large':
        updateRectSize(Math.min(280, viewportDims.width * 0.48), Math.min(95, viewportDims.height * 0.16));
        break;
      default:
        break;
    }
  }, [viewportDims, updateRectSize]);

  // ── Placing mode: draw rectangle with window listeners & 1-click standard size ──
  const handleCanvasMouseDown = (e) => {
    if (disabled) return;
    if (e.button !== 0) return; // Only left click draws/places
    if (!placingMode) return;

    const rect = overlayRef.current.getBoundingClientRect();
    const startX = e.clientX - rect.left;
    const startY = e.clientY - rect.top;

    dragStartRef.current = { x: startX, y: startY };
    setIsDragging(true);
    setSigRect({ x: startX, y: startY, width: 0, height: 0 });

    const handleWindowMove = (ev) => {
      if (!dragStartRef.current || !overlayRef.current) return;
      const oRect = overlayRef.current.getBoundingClientRect();
      const curX = ev.clientX - oRect.left;
      const curY = ev.clientY - oRect.top;
      const start = dragStartRef.current;

      setSigRect({
        x: Math.min(start.x, curX),
        y: Math.min(start.y, curY),
        width: Math.abs(curX - start.x),
        height: Math.abs(curY - start.y),
      });
    };

    const handleWindowUp = () => {
      window.removeEventListener('mousemove', handleWindowMove);
      window.removeEventListener('mouseup', handleWindowUp);
      setIsDragging(false);

      const start = dragStartRef.current;
      dragStartRef.current = null;

      setSigRect(curr => {
        let finalRect = curr;
        // If single click without drag (almost zero size), drop a standard Medium rectangle centered at click point
        if (!finalRect || (finalRect.width <= 5 && finalRect.height <= 5)) {
          if (start && viewportDims.width > 0) {
            const stdW = Math.min(200, Math.floor(viewportDims.width * 0.35));
            const stdH = Math.min(70, Math.floor(viewportDims.height * 0.12));
            finalRect = {
              x: Math.max(0, start.x - stdW / 2),
              y: Math.max(0, start.y - stdH / 2),
              width: stdW,
              height: stdH,
            };
          }
        }

        if (finalRect && finalRect.width >= 5 && finalRect.height >= 5) {
          const clamped = clampRectToBounds(finalRect, viewportDims, 5);
          setPlacingMode(false);

          const norm = screenToNormalized(clamped, viewportDims.width, viewportDims.height);
          onPlacementChange?.({
            page: pageNum,
            normX: norm.normX,
            normY: norm.normY,
            normWidth: norm.normWidth,
            normHeight: norm.normHeight,
          });
          return clamped;
        } else {
          return null;
        }
      });
    };

    window.addEventListener('mousemove', handleWindowMove);
    window.addEventListener('mouseup', handleWindowUp);
  };

  // ── Move/Resize interactions ──
  const handleRectMouseDown = (e, mode) => {
    if (disabled) return;
    // Only handle left mouse button (0) for move/resize; stop propagation on right-click to avoid canvas interference
    if (e.button !== 0) {
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    e.preventDefault();

    setInteractionMode(mode);
    interactionStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      rect: { ...sigRect },
    };

    const handleMove = (ev) => {
      if (!interactionStartRef.current) return;
      const dx = ev.clientX - interactionStartRef.current.mouseX;
      const dy = ev.clientY - interactionStartRef.current.mouseY;
      const origRect = interactionStartRef.current.rect;

      let newRect;
      if (mode === 'move') {
        newRect = {
          x: origRect.x + dx,
          y: origRect.y + dy,
          width: origRect.width,
          height: origRect.height,
        };
      } else {
        newRect = computeResizedRect(origRect, mode, dx, dy);
      }

      const clamped = clampRectToBounds(newRect, viewportDims, 5);
      setSigRect(clamped);
    };

    const handleUp = () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      setInteractionMode(null);
      interactionStartRef.current = null;

      // Emit updated placement
      setSigRect(prev => {
        if (prev) {
          const norm = screenToNormalized(prev, viewportDims.width, viewportDims.height);
          onPlacementChange?.({
            page: pageNum,
            normX: norm.normX,
            normY: norm.normY,
            normWidth: norm.normWidth,
            normHeight: norm.normHeight,
          });
        }
        return prev;
      });
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  };

  const handleDeleteRect = (e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    setSigRect(null);
    onPlacementChange?.(null);
  };

  // Center signature horizontally on page
  const centerHorizontally = () => {
    if (!sigRect || viewportDims.width === 0) return;
    const newX = Math.max(0, Math.round((viewportDims.width - sigRect.width) / 2));
    const updated = { ...sigRect, x: newX };
    setSigRect(updated);
    const norm = screenToNormalized(updated, viewportDims.width, viewportDims.height);
    onPlacementChange?.({
      page: pageNum,
      normX: norm.normX,
      normY: norm.normY,
      normWidth: norm.normWidth,
      normHeight: norm.normHeight,
    });
  };

  // Close context menu on outside click or Escape key
  useEffect(() => {
    if (!contextMenu) return;

    const handleOutsideClick = (e) => {
      // Don't close if clicked inside the context menu itself
      if (e.target && e.target.closest && e.target.closest('.pdf-sig-context-menu')) {
        return;
      }
      setContextMenu(null);
    };

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setContextMenu(null);
    };

    // Delay attaching so the triggering right-click event doesn't immediately close it
    const timer = setTimeout(() => {
      window.addEventListener('mousedown', handleOutsideClick);
      window.addEventListener('click', handleOutsideClick);
      window.addEventListener('contextmenu', handleOutsideClick);
    }, 50);

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousedown', handleOutsideClick);
      window.removeEventListener('click', handleOutsideClick);
      window.removeEventListener('contextmenu', handleOutsideClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu]);

  // Right-click context menu handler on signature rectangle or page
  const handleRectContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled || !sigRect) return;

    // Viewport-based coordinates (works with position: fixed)
    const menuWidth = 230;
    const menuHeight = 175;
    const x = Math.min(Math.max(10, e.clientX), window.innerWidth - menuWidth - 10);
    const y = Math.min(Math.max(10, e.clientY), window.innerHeight - menuHeight - 10);

    setContextMenu({ x, y });
  };

  // Resize compute
  function computeResizedRect(orig, handle, dx, dy) {
    let { x, y, width, height } = orig;

    switch (handle) {
      case 'resize-nw': x += dx; y += dy; width -= dx; height -= dy; break;
      case 'resize-n': y += dy; height -= dy; break;
      case 'resize-ne': y += dy; width += dx; height -= dy; break;
      case 'resize-e': width += dx; break;
      case 'resize-se': width += dx; height += dy; break;
      case 'resize-s': height += dy; break;
      case 'resize-sw': x += dx; width -= dx; height += dy; break;
      case 'resize-w': x += dx; width -= dx; break;
    }

    return normalizeRect({ x, y, width, height });
  }

  // Handle cursor for resize handles
  const handleCursors = {
    'resize-nw': 'nwse-resize',
    'resize-n': 'ns-resize',
    'resize-ne': 'nesw-resize',
    'resize-e': 'ew-resize',
    'resize-se': 'nwse-resize',
    'resize-s': 'ns-resize',
    'resize-sw': 'nesw-resize',
    'resize-w': 'ew-resize',
  };

  const handlePositions = useMemo(() => {
    if (!sigRect) return [];
    const { x, y, width, height } = sigRect;
    const hs = 8; // handle size
    const ho = hs / 2;
    return [
      { id: 'resize-nw', left: x - ho, top: y - ho },
      { id: 'resize-n', left: x + width / 2 - ho, top: y - ho },
      { id: 'resize-ne', left: x + width - ho, top: y - ho },
      { id: 'resize-e', left: x + width - ho, top: y + height / 2 - ho },
      { id: 'resize-se', left: x + width - ho, top: y + height - ho },
      { id: 'resize-s', left: x + width / 2 - ho, top: y + height - ho },
      { id: 'resize-sw', left: x - ho, top: y + height - ho },
      { id: 'resize-w', left: x - ho, top: y + height / 2 - ho },
    ];
  }, [sigRect]);

  // Rect dimensions in points (approx, for display tooltip)
  const rectInfoText = useMemo(() => {
    if (!sigRect || viewportDims.width === 0) return '';
    const norm = screenToNormalized(sigRect, viewportDims.width, viewportDims.height);
    const wPt = Math.round(norm.normWidth * 612); // approx letter width
    const hPt = Math.round(norm.normHeight * 792);
    return `${Math.round(sigRect.width)}×${Math.round(sigRect.height)} px`;
  }, [sigRect, viewportDims]);

  if (!filePath) {
    return (
      <div className="pdf-canvas-empty" id="pdf-canvas-empty">
        <Icons.PDF />
        <p>Select a PDF document above to place your signature</p>
      </div>
    );
  }

  return (
    <div className="pdf-canvas-container" id="pdf-canvas-container" ref={containerRef}>
      {/* Toolbar */}
      <div className="pdf-canvas-toolbar" id="pdf-canvas-toolbar">
        {/* Page navigation */}
        <div className="pdf-toolbar-group">
          <button
            className="pdf-tb-btn"
            onClick={() => goToPage(pageNum - 1)}
            disabled={pageNum <= 1 || isLoading}
            title="Previous Page"
            id="btn-pdf-prev"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>

          <div className="pdf-page-indicator">
            <input
              type="text"
              className="pdf-page-input"
              value={pageInputVal || pageNum}
              onChange={(e) => setPageInputVal(e.target.value)}
              onKeyDown={handlePageInputKeyDown}
              onBlur={() => { setPageInputVal(''); }}
              title="Type page number and press Enter"
              id="pdf-page-input"
            />
            <span className="pdf-page-total">/ {totalPages}</span>
          </div>

          <button
            className="pdf-tb-btn"
            onClick={() => goToPage(pageNum + 1)}
            disabled={pageNum >= totalPages || isLoading}
            title="Next Page"
            id="btn-pdf-next"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>

        <div className="pdf-toolbar-divider" />

        {/* Zoom controls */}
        <div className="pdf-toolbar-group">
          <button className="pdf-tb-btn" onClick={zoomOut} disabled={isLoading} title="Zoom Out" id="btn-zoom-out">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <span className="pdf-zoom-label">{displayZoom}%</span>
          <button className="pdf-tb-btn" onClick={zoomIn} disabled={isLoading} title="Zoom In" id="btn-zoom-in">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <button className="pdf-tb-btn" onClick={zoomFitWidth} disabled={isLoading} title="Fit to Width" id="btn-zoom-fit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
            Width
          </button>
          <button className="pdf-tb-btn" onClick={zoomFitPage} disabled={isLoading} title="Fit Entire Page" id="btn-zoom-page">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg>
            Page
          </button>
          <button className="pdf-tb-btn" onClick={zoomReset} disabled={isLoading} title="100%" id="btn-zoom-100">
            1:1
          </button>
        </div>

        <div className="pdf-toolbar-divider" />

        {/* Place Signature button */}
        <div className="pdf-toolbar-group">
          <button
            className={`pdf-tb-btn pdf-tb-place ${placingMode ? 'active' : ''} ${sigRect ? 'has-placement' : ''}`}
            onClick={() => {
              if (sigRect) {
                // Clear existing and enter placing mode
                setSigRect(null);
                onPlacementChange?.(null);
              }
              setPlacingMode(!placingMode);
            }}
            disabled={isLoading || disabled}
            title={placingMode ? 'Cancel placing' : (sigRect ? 'Replace signature placement' : 'Click anywhere on page or drag to place signature')}
            id="btn-place-signature"
          >
            <Icons.Signature />
            {placingMode ? 'Drawing...' : (sigRect ? 'Replace Position' : 'Place Signature')}
          </button>
        </div>

        {/* Customize Signature Appearance button */}
        {onOpenCustomizeAppearance && (
          <>
            <div className="pdf-toolbar-divider" />
            <div className="pdf-toolbar-group">
              <button
                type="button"
                className="pdf-tb-btn btn-customize-sig-appearance"
                onClick={onOpenCustomizeAppearance}
                title="Customize Signature Appearance (Adobe Acrobat Style)"
                id="btn-tb-customize-appearance"
              >
                <Icons.Palette />
                <span>Appearance</span>
              </button>
            </div>
          </>
        )}

        {/* Signature Size adjustment controls (when placed) */}
        {sigRect && (
          <>
            <div className="pdf-toolbar-divider" />
            <div className="pdf-toolbar-group pdf-size-controls" id="pdf-size-controls">
              <span className="pdf-size-label">Size:</span>
              <button
                type="button"
                className="pdf-tb-btn pdf-size-btn"
                onClick={decreaseSize}
                title="Decrease size (-17%)"
                id="btn-sig-size-dec"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Smaller
              </button>
              <button
                type="button"
                className="pdf-tb-btn pdf-size-btn"
                onClick={increaseSize}
                title="Increase size (+20%)"
                id="btn-sig-size-inc"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Larger
              </button>

              <div className="pdf-size-presets">
                <button
                  type="button"
                  className="pdf-tb-btn pdf-preset-btn"
                  onClick={() => setPresetSize('small')}
                  title="Preset Small (140×50)"
                  id="btn-preset-s"
                >
                  S
                </button>
                <button
                  type="button"
                  className="pdf-tb-btn pdf-preset-btn"
                  onClick={() => setPresetSize('medium')}
                  title="Preset Medium (200×70)"
                  id="btn-preset-m"
                >
                  M
                </button>
                <button
                  type="button"
                  className="pdf-tb-btn pdf-preset-btn"
                  onClick={() => setPresetSize('large')}
                  title="Preset Large (280×95)"
                  id="btn-preset-l"
                >
                  L
                </button>
              </div>

              <span className="pdf-dim-tag" title="Current dimensions in screen pixels">
                {Math.round(sigRect.width)}×{Math.round(sigRect.height)}px
              </span>
            </div>
          </>
        )}
      </div>

      {/* Canvas viewport */}
      <div className="pdf-canvas-viewport" id="pdf-canvas-viewport">
        {isLoading && (
          <div className="pdf-canvas-loading">
            <div className="sig-spinner" />
            <p>Loading PDF page...</p>
          </div>
        )}

        {loadError && (
          <div className="pdf-canvas-error">
            <Icons.AlertCircle />
            <div className="pdf-canvas-error-text">
              <p className="pdf-error-title">PDF Preview Unavailable</p>
              <p className="pdf-error-detail">{loadError}</p>
            </div>
            <button
              className="pdf-retry-btn"
              onClick={() => {
                setLoadError(null);
                setRetryCount(c => c + 1);
              }}
              title="Retry loading this PDF"
              id="btn-pdf-retry"
            >
              <Icons.Refresh /> Retry
            </button>
          </div>
        )}

        <div
          className="pdf-canvas-wrapper"
          style={{ position: 'relative', display: 'inline-block' }}
        >
          <canvas ref={canvasRef} className="pdf-render-canvas" id="pdf-render-canvas" />

          {/* Interactive overlay for drawing and manipulating signature rect */}
          <div
            ref={overlayRef}
            className={`pdf-sig-overlay ${placingMode ? 'placing' : ''}`}
            style={{
              width: viewportDims.width || '100%',
              height: viewportDims.height || '100%',
            }}
            onMouseDown={handleCanvasMouseDown}
            onContextMenu={(e) => {
              if (sigRect) {
                handleRectContextMenu(e);
              }
            }}
            id="pdf-sig-overlay"
          >
            {/* Signature rectangle */}
            {sigRect && (
              <>
                <div
                  className="pdf-sig-rect"
                  style={{
                    left: sigRect.x,
                    top: sigRect.y,
                    width: sigRect.width,
                    height: sigRect.height,
                  }}
                  onMouseDown={(e) => handleRectMouseDown(e, 'move')}
                  onContextMenu={handleRectContextMenu}
                  title="Right-click for options (Apply to All Documents, Center, Delete)"
                  id="pdf-sig-rect"
                >
                  {/* Main rectangle content with full appearance customizability */}
                  {(() => {
                    const fields = customAppearance?.customFields || {};
                    const styling = customAppearance?.styling || {};
                    const inkColor = styling.inkColor || '#000000';

                    const signerSource = fields.signerNameSource || 'certificate';
                    let activeSigner = '';
                    if (signerSource === 'none') {
                      activeSigner = '';
                    } else if (signerSource === 'custom') {
                      activeSigner = fields.signerName || signerName || '';
                    } else {
                      activeSigner = signerName || fields.signerName || '';
                    }

                    let activePrefix = fields.signPrefix;
                    if (activePrefix === '__custom__') {
                      activePrefix = fields.signPrefixCustom || '';
                    } else if (activePrefix === undefined) {
                      activePrefix = 'Digitally signed by';
                    }

                    const showSignerName = (customAppearance?.includeText ? customAppearance.includeText.name !== false : true) &&
                      signerSource !== 'none' &&
                      Boolean(activeSigner);

                    const activeDn = fields.distinguishedName || (activeSigner ? `cn=${activeSigner}` : '');
                    const activeReason = fields.reason !== undefined ? fields.reason : (reason || 'Document signature and certification');
                    const activeLocation = fields.location !== undefined ? fields.location : (location || 'Office');
                    const activeVersion = fields.versionText || 'DocuFuse 1.0.0';
                    const showLabels = customAppearance?.includeText?.labels !== false;

                    const padTwo = (n) => String(n).padStart(2, '0');
                    const d = new Date();
                    const tzOffsetMin = -d.getTimezoneOffset();
                    const sign = tzOffsetMin >= 0 ? '+' : '-';
                    const tzHours = padTwo(Math.floor(Math.abs(tzOffsetMin) / 60));
                    const tzMins = padTwo(Math.abs(tzOffsetMin) % 60);
                    const tzStr = `${sign}${tzHours}'${tzMins}'`;
                    let dateDisplay = `${d.getFullYear()}.${padTwo(d.getMonth() + 1)}.${padTwo(d.getDate())} ${padTwo(d.getHours())}:${padTwo(d.getMinutes())}:${padTwo(d.getSeconds())} ${tzStr}`;
                    if (fields.dateFormat === 'date_only') {
                      dateDisplay = `${d.getFullYear()}.${padTwo(d.getMonth() + 1)}.${padTwo(d.getDate())}`;
                    } else if (fields.dateFormat === 'iso') {
                      dateDisplay = d.toISOString();
                    }

                    return (
                      <div
                        className={`pdf-sig-rect-content ${customAppearance?.textDirection && customAppearance.textDirection !== 'auto' ? `align-${customAppearance.textDirection}` : ''} border-${styling.borderStyle || 'solid'}`}
                        style={{
                          color: inkColor,
                          backgroundColor: styling.backgroundColor || '#ffffff',
                          position: 'relative',
                        }}
                      >
                        {/* Optional subtle watermark logo */}
                        {customAppearance?.includeText?.logo && fields.logoPosition === 'watermark' && (
                          <div className="adobe-preview-watermark-overlay" style={{ opacity: 0.1 }}>
                            {fields.customLogoDataUrl ? (
                              <img src={fields.customLogoDataUrl} alt="Watermark" className="watermark-img" />
                            ) : (
                              <Icons.ShieldCheck />
                            )}
                          </div>
                        )}

                        {/* Graphic Side */}
                        {customAppearance?.graphicType && customAppearance.graphicType !== 'none' && (
                          <div className="pdf-sig-rect-graphic">
                            {customAppearance.graphicType === 'draw' && customAppearance.drawnDataUrl && (
                              <img src={customAppearance.drawnDataUrl} alt="Signature" className="rect-graphic-img" />
                            )}
                            {customAppearance.graphicType === 'image' && customAppearance.imageDataUrl && (
                              <img src={customAppearance.imageDataUrl} alt="Seal" className="rect-graphic-img" />
                            )}
                            {customAppearance.graphicType === 'text' && (
                              <div
                                className={`rect-graphic-text style-${customAppearance.textStyle || 'script'}`}
                                style={{ color: inkColor }}
                              >
                                {(customAppearance.textSignature && customAppearance.textSignature !== 'Authorized Signer')
                                  ? customAppearance.textSignature
                                  : (activeSigner || signerName || '')}
                              </div>
                            )}
                          </div>
                        )}

                        <div className="pdf-sig-rect-text-col">
                          {showSignerName && (
                            <div className="pdf-sig-rect-header" style={{ color: inkColor }}>
                              {activePrefix ? `${activePrefix} ` : ''}{activeSigner}
                            </div>
                          )}
                          {customAppearance?.includeText?.distinguishedName && activeDn && (
                            <div className="pdf-sig-rect-detail">
                              {showLabels ? 'DN: ' : ''}{activeDn}
                            </div>
                          )}
                          {(customAppearance?.includeText ? customAppearance.includeText.date : true) && (
                            <div className="pdf-sig-rect-date">
                              {showLabels ? 'Date: ' : ''}{dateDisplay}
                            </div>
                          )}
                          {customAppearance?.includeText?.reason && (
                            <div className="pdf-sig-rect-detail">
                              {showLabels ? 'Reason: ' : ''}{activeReason}
                            </div>
                          )}
                          {customAppearance?.includeText?.location && (
                            <div className="pdf-sig-rect-detail">
                              {showLabels ? 'Location: ' : ''}{activeLocation}
                            </div>
                          )}
                          {customAppearance?.includeText?.adobeVersion && (
                            <div className="pdf-sig-rect-detail">
                              {showLabels ? 'Version: ' : ''}{activeVersion}
                            </div>
                          )}
                          {customAppearance?.includeText?.logo && fields.logoPosition === 'badge' && (
                            <div className="pdf-sig-rect-badge" style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '9px', fontWeight: 600, opacity: 0.85, marginTop: '2px' }}>
                              {fields.customLogoDataUrl ? (
                                <img src={fields.customLogoDataUrl} alt="Logo" style={{ width: '12px', height: '12px', objectFit: 'contain' }} />
                              ) : (
                                <Icons.ShieldCheck />
                              )}
                              <span>Certified Digital Signature</span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                  <div className="pdf-sig-rect-dims">{rectInfoText}</div>

                  {/* Top-right action controls: apply all, decrease size, increase size, delete */}
                  <div className="pdf-sig-rect-controls" onMouseDown={(e) => e.stopPropagation()}>
                    {hasMultipleDocs && onApplyToAll && (
                      <button
                        type="button"
                        className="pdf-sig-ctrl-btn apply-all"
                        onClick={(e) => { e.stopPropagation(); onApplyToAll(); }}
                        title="Apply this signature position to all documents (or right-click)"
                        id="btn-rect-apply-all"
                      >
                        <Icons.Layers />
                      </button>
                    )}
                    <button
                      type="button"
                      className="pdf-sig-ctrl-btn"
                      onClick={(e) => { e.stopPropagation(); decreaseSize(); }}
                      title="Decrease signature size"
                      id="btn-rect-size-dec"
                    >
                      −
                    </button>
                    <button
                      type="button"
                      className="pdf-sig-ctrl-btn"
                      onClick={(e) => { e.stopPropagation(); increaseSize(); }}
                      title="Increase signature size"
                      id="btn-rect-size-inc"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="pdf-sig-ctrl-btn delete"
                      onClick={handleDeleteRect}
                      title="Remove signature placement"
                      id="btn-sig-rect-delete"
                    >
                      <Icons.X />
                    </button>
                  </div>
                </div>

                {/* 8 Resize handles */}
                {handlePositions.map(h => (
                  <div
                    key={h.id}
                    className="pdf-sig-handle"
                    style={{
                      left: h.left,
                      top: h.top,
                      cursor: handleCursors[h.id],
                    }}
                    onMouseDown={(e) => handleRectMouseDown(e, h.id)}
                    onContextMenu={handleRectContextMenu}
                  />
                ))}
              </>
            )}

            {/* Placing mode tooltip */}
            {placingMode && !isDragging && !sigRect && (
              <div className="pdf-place-tooltip">
                <Icons.Signature />
                <span>Click anywhere on document to place standard signature, or drag to draw custom area</span>
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Context Menu on Right-Click */}
      {contextMenu && (
        <div
          className="pdf-sig-context-menu"
          style={{
            position: 'fixed',
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
            zIndex: 99999,
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div className="pdf-ctx-header">Signature Options</div>
          {hasMultipleDocs && onApplyToAll && (
            <button
              type="button"
              className="pdf-ctx-item primary"
              onClick={() => {
                setContextMenu(null);
                onApplyToAll();
              }}
              id="ctx-apply-all-docs"
            >
              <Icons.Layers />
              <div className="pdf-ctx-text">
                <strong>Apply to All Documents</strong>
                <span>Sync this position across all files</span>
              </div>
            </button>
          )}
          <button
            type="button"
            className="pdf-ctx-item"
            onClick={() => {
              setContextMenu(null);
              centerHorizontally();
            }}
            id="ctx-center-horiz"
          >
            <Icons.Grid />
            <div className="pdf-ctx-text">
              <strong>Center on Page</strong>
              <span>Align horizontally in middle</span>
            </div>
          </button>
          {onOpenCustomizeAppearance && (
            <button
              type="button"
              className="pdf-ctx-item"
              onClick={() => {
                setContextMenu(null);
                onOpenCustomizeAppearance();
              }}
              id="ctx-customize-appearance"
            >
              <Icons.Palette />
              <div className="pdf-ctx-text">
                <strong>Customize Appearance...</strong>
                <span>Graphic, text fields & layout</span>
              </div>
            </button>
          )}
          <div className="pdf-ctx-divider" />
          <button
            type="button"
            className="pdf-ctx-item delete"
            onClick={(e) => {
              setContextMenu(null);
              handleDeleteRect(e);
            }}
            id="ctx-delete-sig"
          >
            <Icons.Trash />
            <div className="pdf-ctx-text">
              <strong>Remove Signature</strong>
              <span>Clear placement on this page</span>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}
