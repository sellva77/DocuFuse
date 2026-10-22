import React, { useState, useCallback, useEffect } from 'react';
import TitleBar from './components/TitleBar';
import DropZone from './components/DropZone';
import FileList from './components/FileList';
import ControlsPanel from './components/ControlsPanel';
import ProgressOverlay from './components/ProgressOverlay';
import Notification from './components/Notification';
import ExcelConverter from './components/ExcelConverter';
import DigitalSignature from './components/DigitalSignature';
import { Icons } from './components/Icons';

export default function App() {
  const [activeTab, setActiveTab] = useState('merge'); // 'merge' | 'excel'
  const [files, setFiles] = useState([]);
  const [outputFormat, setOutputFormat] = useState('pdf');
  const [isMerging, setIsMerging] = useState(false);
  const [progress, setProgress] = useState(null);
  const [notification, setNotification] = useState(null);

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
        const unique = newFiles.filter(f => !existingPaths.has(f.path) && !f.error);
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
            <h1>Document Merger</h1>
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

      {/* Progress Overlay */}
      {isMerging && <ProgressOverlay progress={progress} />}

      {/* Notification */}
      <Notification notification={notification} onDismiss={handleDismissNotification} />
    </>
  );
}
