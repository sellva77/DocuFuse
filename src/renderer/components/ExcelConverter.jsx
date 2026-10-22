import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Icons } from './Icons';

/**
 * ExcelConverter — Full Excel-to-PDF conversion panel
 * Handles file selection, workbook inspection, worksheet ordering,
 * page-range selection, preview, and PDF export.
 */
export default function ExcelConverter({ onNotification }) {
  const [filePath, setFilePath] = useState(null);
  const [fileName, setFileName] = useState('');
  const [sheets, setSheets] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewSheet, setPreviewSheet] = useState(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [dragIndex, setDragIndex] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  // Listen for export progress
  useEffect(() => {
    if (!window.electronAPI) return;
    const unsub = window.electronAPI.onExcelProgress((p) => setProgress(p));
    return () => { if (unsub) unsub(); };
  }, []);

  // ── Open File ──
  const handleOpenFile = useCallback(async () => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.openExcelFileDialog();
    if (result.canceled) return;
    if (result.error) {
      onNotification?.({ type: 'error', title: 'File Error', message: result.error, duration: 6000 });
      return;
    }
    await loadWorkbook(result.filePath);
  }, [onNotification]);

  const loadWorkbook = useCallback(async (fPath) => {
    if (!window.electronAPI) return;
    setIsLoading(true);
    setPreview(null);
    setPreviewSheet(null);

    try {
      const result = await window.electronAPI.inspectExcelWorkbook(fPath);
      if (!result.success) {
        onNotification?.({ type: 'error', title: 'Workbook Error', message: result.error, duration: 6000 });
        setIsLoading(false);
        return;
      }

      setFilePath(result.filePath);
      setFileName(result.fileName);

      // Sheets with extra UI state: selected, pageRange
      const mappedSheets = result.sheets.map(s => ({
        ...s,
        selected: s.isVisible,
        pageRange: 'all',
      }));
      setSheets(mappedSheets);

      // Auto-preview first visible sheet
      const firstVisible = mappedSheets.find(s => s.isVisible);
      if (firstVisible) {
        loadPreview(fPath, firstVisible.index, 1);
        setPreviewSheet(firstVisible.index);
        setPreviewPage(1);
      }
    } catch (err) {
      onNotification?.({ type: 'error', title: 'Unexpected Error', message: err.message, duration: 6000 });
    }

    setIsLoading(false);
  }, [onNotification]);

  // ── Preview ──
  const loadPreview = useCallback(async (fPath, sheetIdx, pageNum) => {
    if (!window.electronAPI) return;
    try {
      const res = await window.electronAPI.getWorksheetPreview({
        filePath: fPath,
        sheetIndex: sheetIdx,
        pageNumber: pageNum,
      });
      if (res.success) {
        setPreview(res.preview);
      }
    } catch (_) {}
  }, []);

  const handlePreviewSheet = useCallback((sheetIdx) => {
    setPreviewSheet(sheetIdx);
    setPreviewPage(1);
    if (filePath) loadPreview(filePath, sheetIdx, 1);
  }, [filePath, loadPreview]);

  const handlePreviewPageChange = useCallback((delta) => {
    const sheet = sheets.find(s => s.index === previewSheet);
    if (!sheet) return;
    const newPage = Math.max(1, Math.min(sheet.pageCount, previewPage + delta));
    setPreviewPage(newPage);
    if (filePath) loadPreview(filePath, previewSheet, newPage);
  }, [filePath, previewSheet, previewPage, sheets, loadPreview]);

  // ── Sheet Selection ──
  const toggleSheetSelected = useCallback((sheetIdx) => {
    setSheets(prev => prev.map(s =>
      s.index === sheetIdx ? { ...s, selected: !s.selected } : s
    ));
  }, []);

  const updatePageRange = useCallback((sheetIdx, value) => {
    setSheets(prev => prev.map(s =>
      s.index === sheetIdx ? { ...s, pageRange: value } : s
    ));
  }, []);

  // ── Drag & Drop Reordering ──
  const handleDragStart = useCallback((idx) => {
    setDragIndex(idx);
  }, []);

  const handleDragOver = useCallback((e, idx) => {
    e.preventDefault();
    setDropTarget(idx);
  }, []);

  const handleDrop = useCallback((targetIdx) => {
    if (dragIndex === null || dragIndex === targetIdx) {
      setDragIndex(null);
      setDropTarget(null);
      return;
    }
    setSheets(prev => {
      const updated = [...prev];
      const [moved] = updated.splice(dragIndex, 1);
      updated.splice(targetIdx, 0, moved);
      return updated;
    });
    setDragIndex(null);
    setDropTarget(null);
  }, [dragIndex]);

  // ── Move Up / Down ──
  const moveSheet = useCallback((idx, direction) => {
    const target = idx + direction;
    if (target < 0 || target >= sheets.length) return;
    setSheets(prev => {
      const updated = [...prev];
      [updated[idx], updated[target]] = [updated[target], updated[idx]];
      return updated;
    });
  }, [sheets.length]);

  // ── Export ──
  const handleExport = useCallback(async () => {
    if (!window.electronAPI || !filePath) return;

    const selectedSheets = sheets.filter(s => s.selected);
    if (selectedSheets.length === 0) {
      onNotification?.({ type: 'warning', title: 'No Sheets Selected', message: 'Please select at least one worksheet to export.', duration: 5000 });
      return;
    }

    const baseName = fileName.replace(/\.(xlsx|xls)$/i, '');
    const saveResult = await window.electronAPI.saveExcelPdfDialog(`${baseName}.pdf`);
    if (saveResult.canceled || !saveResult.filePath) return;

    setIsExporting(true);
    setProgress({ step: 'Starting', detail: 'Preparing export...', percent: 0 });

    try {
      const result = await window.electronAPI.exportExcelToPdf({
        filePath,
        sheetConfigs: selectedSheets.map(s => ({
          sheetIndex: s.index,
          sheetName: s.name,
          selected: true,
          pageRange: s.pageRange || 'all',
        })),
        outputPath: saveResult.filePath,
      });

      setIsExporting(false);
      setProgress(null);

      if (result.success) {
        onNotification?.({
          type: 'success',
          title: 'Export Complete!',
          message: `PDF saved to: ${result.outputPath} (${result.pageCount} pages, ${Math.round(result.outputSize / 1024)}KB)`,
          outputPath: result.outputPath,
          duration: 12000,
        });
      } else {
        onNotification?.({
          type: 'error',
          title: 'Export Failed',
          message: result.error || 'Unknown error during export',
          duration: 10000,
        });
      }
    } catch (err) {
      setIsExporting(false);
      setProgress(null);
      onNotification?.({
        type: 'error',
        title: 'Export Error',
        message: err.message || 'Unexpected error during PDF export',
        duration: 10000,
      });
    }
  }, [filePath, fileName, sheets, onNotification]);

  // ── Clear ──
  const handleClear = useCallback(() => {
    setFilePath(null);
    setFileName('');
    setSheets([]);
    setPreview(null);
    setPreviewSheet(null);
    setPreviewPage(1);
  }, []);

  const selectedCount = sheets.filter(s => s.selected).length;
  const totalPagesSelected = sheets
    .filter(s => s.selected)
    .reduce((sum, s) => sum + s.pageCount, 0);

  // ── Render ──
  return (
    <div className="excel-converter" id="excel-converter">
      {/* File Selection */}
      {!filePath ? (
        <div className="excel-dropzone" onClick={handleOpenFile} id="excel-open-file">
          <div className="excel-dropzone-icon">
            <Icons.Excel />
          </div>
          <h3>Open Excel Workbook</h3>
          <p>Select an <strong>.xlsx</strong> or <strong>.xls</strong> file to convert to PDF</p>
          <button className="btn-open-excel" id="btn-open-excel">
            <Icons.FolderOpen />
            Browse Files
          </button>
        </div>
      ) : (
        <div className="excel-workspace">
          {/* File Header */}
          <div className="excel-file-header">
            <div className="excel-file-info">
              <Icons.Excel />
              <div>
                <span className="excel-file-name">{fileName}</span>
                <span className="excel-file-meta">
                  {sheets.length} worksheets · {selectedCount} selected · ~{totalPagesSelected} pages
                </span>
              </div>
            </div>
            <div className="excel-file-actions">
              <button className="btn-icon-sm" onClick={handleOpenFile} title="Open different file" id="btn-excel-change">
                <Icons.Refresh />
              </button>
              <button className="btn-icon-sm btn-danger-sm" onClick={handleClear} title="Close workbook" id="btn-excel-close">
                <Icons.X />
              </button>
            </div>
          </div>

          <div className="excel-split-view">
            {/* Left Panel: Sheet List */}
            <div className="excel-sheet-panel">
              <div className="excel-panel-header">
                <h3>Worksheets</h3>
                <span className="excel-badge">{selectedCount}/{sheets.length}</span>
              </div>

              <div className="excel-sheet-list" id="excel-sheet-list">
                {sheets.map((sheet, idx) => (
                  <div
                    key={sheet.index}
                    className={`excel-sheet-item ${sheet.selected ? 'selected' : ''} ${dragIndex === idx ? 'dragging' : ''} ${dropTarget === idx ? 'drop-target' : ''}`}
                    draggable
                    onDragStart={() => handleDragStart(idx)}
                    onDragOver={(e) => handleDragOver(e, idx)}
                    onDrop={() => handleDrop(idx)}
                    onDragEnd={() => { setDragIndex(null); setDropTarget(null); }}
                    id={`sheet-item-${sheet.index}`}
                  >
                    <div className="excel-sheet-drag-handle" title="Drag to reorder">⋮⋮</div>

                    <label className="excel-sheet-checkbox">
                      <input
                        type="checkbox"
                        checked={sheet.selected}
                        onChange={() => toggleSheetSelected(sheet.index)}
                        id={`sheet-checkbox-${sheet.index}`}
                      />
                      <span className="excel-checkmark" />
                    </label>

                    <div className="excel-sheet-info" onClick={() => handlePreviewSheet(sheet.index)}>
                      <div className="excel-sheet-name">
                        {sheet.name}
                        {sheet.isHidden && (
                          <span className="excel-sheet-badge hidden" title="Hidden worksheet">
                            <Icons.EyeOff /> Hidden
                          </span>
                        )}
                        {sheet.isVeryHidden && (
                          <span className="excel-sheet-badge very-hidden" title="Very hidden worksheet (macro-only)">
                            <Icons.EyeOff /> Very Hidden
                          </span>
                        )}
                      </div>
                      <div className="excel-sheet-meta-line">
                        {sheet.pageCount} {sheet.pageCount === 1 ? 'page' : 'pages'}
                        {' · '}
                        {sheet.orientation}
                        {sheet.hasPageBreaks && ' · page breaks'}
                      </div>
                    </div>

                    {/* Page range input */}
                    {sheet.selected && (
                      <div className="excel-page-range">
                        <input
                          type="text"
                          value={sheet.pageRange}
                          onChange={(e) => updatePageRange(sheet.index, e.target.value)}
                          placeholder="e.g. 1-3, 5"
                          title="Page range (e.g. all, 1-3, 5, 7-9)"
                          className="excel-page-range-input"
                          id={`page-range-${sheet.index}`}
                        />
                      </div>
                    )}

                    {/* Move buttons */}
                    <div className="excel-sheet-move-btns">
                      <button
                        className="btn-move"
                        disabled={idx === 0}
                        onClick={() => moveSheet(idx, -1)}
                        title="Move up"
                        id={`move-up-${sheet.index}`}
                      >
                        <Icons.ChevronUp />
                      </button>
                      <button
                        className="btn-move"
                        disabled={idx === sheets.length - 1}
                        onClick={() => moveSheet(idx, 1)}
                        title="Move down"
                        id={`move-down-${sheet.index}`}
                      >
                        <Icons.ChevronDown />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Right Panel: Preview */}
            <div className="excel-preview-panel">
              <div className="excel-panel-header">
                <h3>Page Preview</h3>
                {preview && (
                  <div className="excel-preview-nav">
                    <button
                      className="btn-move"
                      disabled={previewPage <= 1}
                      onClick={() => handlePreviewPageChange(-1)}
                      id="preview-prev-page"
                    >
                      <Icons.ChevronUp />
                    </button>
                    <span className="excel-preview-page-label">
                      {previewPage} / {preview.totalPages}
                    </span>
                    <button
                      className="btn-move"
                      disabled={previewPage >= preview.totalPages}
                      onClick={() => handlePreviewPageChange(1)}
                      id="preview-next-page"
                    >
                      <Icons.ChevronDown />
                    </button>
                  </div>
                )}
              </div>

              <div className="excel-preview-container" id="excel-preview-container">
                {isLoading ? (
                  <div className="excel-preview-empty">
                    <div className="excel-spinner" />
                    <p>Loading workbook...</p>
                  </div>
                ) : preview ? (
                  <PreviewCanvas preview={preview} />
                ) : (
                  <div className="excel-preview-empty">
                    <Icons.Grid />
                    <p>Select a worksheet to preview</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Export Bar */}
          <div className="excel-export-bar">
            <div className="excel-export-summary">
              <span>{selectedCount} worksheet{selectedCount !== 1 ? 's' : ''} selected</span>
              <span className="excel-export-sep">·</span>
              <span>~{totalPagesSelected} PDF page{totalPagesSelected !== 1 ? 's' : ''}</span>
            </div>
            <button
              className="btn-merge btn-excel-export"
              onClick={handleExport}
              disabled={selectedCount === 0 || isExporting}
              id="btn-excel-export"
            >
              <Icons.Download />
              {isExporting ? 'Exporting...' : 'Export to PDF'}
            </button>
          </div>
        </div>
      )}

      {/* Export progress overlay */}
      {isExporting && progress && (
        <div className="excel-progress-overlay">
          <div className="excel-progress-card">
            <div className="excel-spinner" />
            <h4>{progress.step || 'Processing'}</h4>
            <p>{progress.detail || ''}</p>
            <div className="excel-progress-bar-track">
              <div
                className="excel-progress-bar-fill"
                style={{ width: `${progress.percent || 0}%` }}
              />
            </div>
            <span className="excel-progress-pct">{progress.percent || 0}%</span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Renders preview data as an SVG on a canvas-like container
 */
function PreviewCanvas({ preview }) {
  if (!preview) return null;

  const { pageWidth, pageHeight, rects, lines, texts, orientation, sheetName, pageIndex } = preview;

  // Scale to fit container (max 560px wide)
  const maxW = 560;
  const maxH = 720;
  const scale = Math.min(maxW / pageWidth, maxH / pageHeight, 1);
  const svgW = pageWidth * scale;
  const svgH = pageHeight * scale;

  return (
    <div className="excel-preview-svg-wrapper">
      <svg
        width={svgW}
        height={svgH}
        viewBox={`0 0 ${pageWidth} ${pageHeight}`}
        className="excel-preview-svg"
      >
        {/* Page background */}
        <rect x="0" y="0" width={pageWidth} height={pageHeight} fill="#fff" />

        {/* Backgrounds */}
        {rects.map((r, i) => (
          <rect
            key={`r-${i}`}
            x={r.x}
            y={r.y}
            width={r.width}
            height={r.height}
            fill={r.fill || '#f9fafb'}
          />
        ))}

        {/* Borders / Lines */}
        {lines.map((l, i) => (
          <line
            key={`l-${i}`}
            x1={l.x1}
            y1={l.y1}
            x2={l.x2}
            y2={l.y2}
            stroke={l.stroke || '#d1d5db'}
            strokeWidth={l.strokeWidth || 0.75}
          />
        ))}

        {/* Text */}
        {texts.map((t, i) => {
          const fontSize = Math.min(t.fontSize || 10, 14);
          let anchor = 'start';
          let tx = t.x;
          if (t.align === 'center') {
            anchor = 'middle';
            tx = t.x + (t.cellWidth || 0) / 2;
          } else if (t.align === 'right') {
            anchor = 'end';
            tx = t.x + (t.cellWidth || 0);
          }
          // Truncate long text for preview
          let displayText = t.text || '';
          if (displayText.length > 30) displayText = displayText.slice(0, 28) + '…';
          return (
            <text
              key={`t-${i}`}
              x={tx}
              y={t.y}
              fontSize={fontSize}
              fontWeight={t.bold ? 'bold' : 'normal'}
              fill={t.color || '#000'}
              textAnchor={anchor}
              dominantBaseline="middle"
            >
              {displayText}
            </text>
          );
        })}
      </svg>
      <div className="excel-preview-label">
        {sheetName} — Page {pageIndex} ({orientation})
      </div>
    </div>
  );
}
