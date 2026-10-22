const { contextBridge, ipcRenderer } = require('electron');

// Whitelist of valid channels
const validInvokeChannels = [
  'window:minimize',
  'window:maximize',
  'window:close',
  'window:isMaximized',
  'dialog:openFiles',
  'dialog:saveFile',
  'files:validate',
  'documents:merge',
  'shell:showItemInFolder',
  'shell:openPath',
  'excel:openDialog',
  'excel:inspect',
  'excel:preview',
  'excel:saveDialog',
  'excel:export',
  'dialog:openPdfForSigning',
  'dialog:saveSignedPdf',
  'signing:getProviders',
  'signing:discoverCertificates',
  'signing:signDocument',
  'signing:verifyDocument',
  'signing:readPdfBytes',
  'dialog:openPdfsForSigning',
  'dialog:selectSigningOutputFolder',
  'signing:signDocumentBatch',
];

const validReceiveChannels = [
  'merge:progress',
  'excel:progress',
  'signing:progress',
  'signing:batchProgress',
];

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),

  // Document Merge file operations
  openFileDialog: () => ipcRenderer.invoke('dialog:openFiles'),
  validateFiles: (filePaths) => ipcRenderer.invoke('files:validate', filePaths),
  saveFileDialog: (format) => ipcRenderer.invoke('dialog:saveFile', format),
  mergeDocuments: (options) => ipcRenderer.invoke('documents:merge', options),

  // Excel to PDF operations
  openExcelFileDialog: () => ipcRenderer.invoke('excel:openDialog'),
  inspectExcelWorkbook: (filePath) => ipcRenderer.invoke('excel:inspect', filePath),
  getWorksheetPreview: (options) => ipcRenderer.invoke('excel:preview', options),
  saveExcelPdfDialog: (defaultName) => ipcRenderer.invoke('excel:saveDialog', defaultName),
  exportExcelToPdf: (options) => ipcRenderer.invoke('excel:export', options),

  // Digital Signature operations
  openPdfForSigningDialog: () => ipcRenderer.invoke('dialog:openPdfForSigning'),
  saveSignedPdfDialog: (defaultName) => ipcRenderer.invoke('dialog:saveSignedPdf', defaultName),
  getSigningProviders: () => ipcRenderer.invoke('signing:getProviders'),
  discoverCertificates: (providerId) => ipcRenderer.invoke('signing:discoverCertificates', providerId),
  signPdfDocument: (options) => ipcRenderer.invoke('signing:signDocument', options),
  verifyPdfDocument: (filePath) => ipcRenderer.invoke('signing:verifyDocument', filePath),
  readPdfBytes: (filePath) => ipcRenderer.invoke('signing:readPdfBytes', filePath),
  openPdfsForSigningDialog: () => ipcRenderer.invoke('dialog:openPdfsForSigning'),
  selectSigningOutputFolderDialog: () => ipcRenderer.invoke('dialog:selectSigningOutputFolder'),
  signPdfDocumentBatch: (options) => ipcRenderer.invoke('signing:signDocumentBatch', options),

  // Shell operations
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
  openPath: (targetPath) => ipcRenderer.invoke('shell:openPath', targetPath),

  // Progress listeners
  onMergeProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('merge:progress', handler);
    return () => ipcRenderer.removeListener('merge:progress', handler);
  },
  onExcelProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('excel:progress', handler);
    return () => ipcRenderer.removeListener('excel:progress', handler);
  },
  onSigningProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('signing:progress', handler);
    return () => ipcRenderer.removeListener('signing:progress', handler);
  },
  onSigningBatchProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('signing:batchProgress', handler);
    return () => ipcRenderer.removeListener('signing:batchProgress', handler);
  },
});
