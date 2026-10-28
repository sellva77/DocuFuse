import React, { useState, useCallback, useEffect } from 'react';
import TitleBar from './components/TitleBar';
import DropZone from './components/DropZone';
import FileList from './components/FileList';
import ControlsPanel from './components/ControlsPanel';
import ProgressOverlay from './components/ProgressOverlay';
import Notification from './components/Notification';
import ExcelConverter from './components/ExcelConverter';
import DigitalSignature from './components/DigitalSignature';
import MergePdfPreview from './components/MergePdfPreview';
import { Icons } from './components/Icons';

export default function App() {
  const [activeTab, setActiveTab] = useState('merge'); // 'merge' | 'excel'
  const [files, setFiles] = useState([]);
  const [activePreviewIndex, setActivePreviewIndex] = useState(0);
  const [previewModal, setPreviewModal] = useState({
    isOpen: false,
    fileIndex: 0,
    mode: 'document',
  });
  const [outputFormat, setOutputFormat] = useState('pdf');
  const [isMerging, setIsMerging] = useState(false);
  const [progress, setProgress] = useState(null);
  const [notification, setNotification] = useState(null);

  const handleOpenPreview = useCallback((index = 0, mode = 'document') => {
    setActivePreviewIndex(index);
    setPreviewModal({
      isOpen: true,
      fileIndex: index,
      mode,
    });
  }, []);

  const handleClosePreview = useCallback(() => {
    setPreviewModal(prev => ({ ...prev, isOpen: false }));
  }, []);

  // Listen for merge progress from main process
  useEffect(() => {
    if (!window.electronAPI) return;

    const unsubscribe = window.electronAPI.onMergeProgress((progressData) => {
      setProgress(progressData);
    });

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  // Add files handler (from drop zone or file dialog)
  const handleFilesAdded = useCallback((newFiles, errors = []) => {
    if (newFiles && newFiles.length > 0) {
      setFiles(prev => {
        // Deduplicate by path
        const existingPaths = new Set(prev.map(f => f.path));
        const unique = newFiles
          .filter(f => !existingPaths.has(f.path) && !f.error)
          .map(f => ({ ...f, excludedPages: f.excludedPages || [] }));
        return [...prev, ...unique];
      });
    }

    // Show errors
    if (errors && errors.length > 0) {
      const errorMessages = errors.map(e => `${e.path}: ${e.error}`).join('\n');
      setNotification({
        type: 'warning',
        title: 'Some files could not be added',
        message: errorMessages,
        duration: 6000,
      });
    }
  }, []);

  // Remove a single file
  const handleRemoveFile = useCallback((index) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  // Clear all files
  const handleClearAll = useCallback(() => {
    setFiles([]);
  }, []);

  // Reorder files via drag
  const handleReorder = useCallback((fromIndex, toIndex) => {
    setFiles(prev => {
      const updated = [...prev];
      const [moved] = updated.splice(fromIndex, 1);
      updated.splice(toIndex, 0, moved);
      return updated;
    });
  }, []);

  // Change output format
  const handleFormatChange = useCallback((format) => {
    setOutputFormat(format);
  }, []);

  // Toggle page exclusion for a file (1-based page number)
  const handleToggleExcludePage = useCallback((fileIndex, pageNum) => {
    setFiles(prev => {
      if (fileIndex < 0 || fileIndex >= prev.length) return prev;
      return prev.map((f, i) => {
        if (i !== fileIndex) return f;
        const currentExcluded = f.excludedPages || [];
        const isExcluded = currentExcluded.includes(pageNum);
        const updated = isExcluded
          ? currentExcluded.filter(p => p !== pageNum)
          : [...currentExcluded, pageNum].sort((a, b) => a - b);
        return { ...f, excludedPages: updated };
      });
    });
  }, []);

  // Bulk update excluded pages for a file
  const handleUpdateExcludedPages = useCallback((fileIndex, excludedPages) => {
    setFiles(prev => {
      if (fileIndex < 0 || fileIndex >= prev.length) return prev;
      return prev.map((f, i) => {
        if (i !== fileIndex) return f;
        return { ...f, excludedPages: Array.isArray(excludedPages) ? excludedPages : [] };
      });
    });
  }, []);

  // Merge & Export
  const handleMerge = useCallback(async () => {
    if (!window.electronAPI || files.length === 0) return;

    // Get save path
    const saveResult = await window.electronAPI.saveFileDialog(outputFormat);
    if (saveResult.canceled || !saveResult.filePath) return;

    setIsMerging(true);
    setProgress({ step: 'Starting', detail: 'Preparing merge...', percent: 0 });

    try {
      const result = await window.electronAPI.mergeDocuments({
        filePaths: files.map(f => f.path),
        files: files.map(f => ({
          path: f.path,
          filePath: f.path,
          name: f.name,
          excludedPages: f.excludedPages || [],
        })),
        outputFormat,
        outputPath: saveResult.filePath,
      });

      setIsMerging(false);
      setProgress(null);

      if (result.success) {
        setNotification({
          type: 'success',
          title: 'Merge Complete!',
          message: `Saved to: ${result.outputPath}`,
          outputPath: result.outputPath,
          duration: 12000,
        });
      } else {
        setNotification({
          type: 'error',
          title: 'Merge Failed',
          message: result.error || 'An unknown error occurred',
          duration: 10000,
        });
      }
    } catch (err) {
      setIsMerging(false);
      setProgress(null);
      setNotification({
        type: 'error',
        title: 'Merge Failed',
        message: err.message || 'An unexpected error occurred',
        duration: 10000,
      });
    }
  }, [files, outputFormat]);

  // Dismiss notification
  const handleDismissNotification = useCallback(() => {
    setNotification(null);
  }, []);

  // Notification handler for ExcelConverter
  const handleExcelNotification = useCallback((n) => {
    setNotification(n);
  }, []);

  const validFiles = files.filter(f => !f.error);
  const canMerge = validFiles.length >= 1;

  return (
    <>
      <TitleBar />

      <div className="app-container">
        <div className="app-content">
          {/* Header with Tab Navigation */}
          <header className="app-header">
            <h1>DocuFuse</h1>
            <div className="app-tab-bar" id="app-tab-bar">
              <button
                className={`app-tab ${activeTab === 'merge' ? 'active' : ''}`}
                onClick={() => setActiveTab('merge')}
                id="tab-merge"
              >
                <Icons.Merge />
                Merge Documents
              </button>
              <button
                className={`app-tab ${activeTab === 'excel' ? 'active' : ''}`}
                onClick={() => setActiveTab('excel')}
                id="tab-excel"
              >
                <Icons.Excel />
                Excel to PDF
              </button>
              <button
                className={`app-tab ${activeTab === 'signature' ? 'active' : ''}`}
                onClick={() => setActiveTab('signature')}
                id="tab-signature"
              >
                <Icons.Signature />
                Digital Signature
              </button>
            </div>
          </header>

          {/* Tab Content */}
          {activeTab === 'merge' && (
            <>
              {/* Drop Zone */}
              <DropZone onFilesAdded={handleFilesAdded} />

              {/* File List */}
              <FileList
                files={files}
                activePreviewIndex={activePreviewIndex}
                onSelectPreview={setActivePreviewIndex}
                onOpenPreview={handleOpenPreview}
                onRemove={handleRemoveFile}
                onClear={handleClearAll}
                onReorder={handleReorder}
              />

              {/* Controls */}
              {files.length > 0 && (
                <ControlsPanel
                  outputFormat={outputFormat}
                  onFormatChange={handleFormatChange}
                  onMerge={handleMerge}
                  onPreview={() => handleOpenPreview(activePreviewIndex, 'sequence')}
                  canMerge={canMerge}
                  isMerging={isMerging}
                />
              )}
            </>
          )}

          {activeTab === 'excel' && (
            <ExcelConverter onNotification={handleExcelNotification} />
          )}

          {activeTab === 'signature' && (
            <DigitalSignature onNotification={handleExcelNotification} />
          )}
        </div>
      </div>

      {/* PDF Preview Modal */}
      {previewModal.isOpen && files.length > 0 && (
        <MergePdfPreview
          isModal={true}
          isOpen={previewModal.isOpen}
          onClose={handleClosePreview}
          files={files}
          activeFileIndex={previewModal.fileIndex}
          initialMode={previewModal.mode}
          onSelectFile={(idx) => {
            setActivePreviewIndex(idx);
            setPreviewModal(prev => ({ ...prev, fileIndex: idx }));
          }}
          onToggleExcludePage={handleToggleExcludePage}
          onUpdateExcludedPages={handleUpdateExcludedPages}
        />
      )}

      {/* Progress Overlay */}
      {isMerging && <ProgressOverlay progress={progress} />}

      {/* Notification */}
      <Notification notification={notification} onDismiss={handleDismissNotification} />
    </>
  );
}
