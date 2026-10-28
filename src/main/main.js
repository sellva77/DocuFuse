import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { processFiles } from '../services/documentProcessor.js';
import { validateFile } from '../utils/fileValidator.js';
import { cleanupTempDir, createTempDir } from '../utils/tempManager.js';
import { inspectWorkbook, getWorksheetPreview, exportExcelToPdf } from '../services/excel/excelService.js';
import { registerSigningHandlers } from './signingHandlers.js';

// Security: Disable remote module
// Updated digital signing engine: no-borderline monochrome layout v3
app.disableHardwareAcceleration && (() => {})();

let mainWindow = null;

const SUPPORTED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xlsx', '.xls'];
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

function getAppIcon() {
  const possiblePaths = [
    path.join(process.resourcesPath, 'resources', 'icon.ico'),
    path.join(__dirname, '..', 'resources', 'icon.ico'),
    path.join(__dirname, '..', '..', 'resources', 'icon.ico'),
    path.join(__dirname, 'resources', 'icon.ico'),
  ];
  for (const p of possiblePaths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: 'DocuFuse',
    icon: getAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0f0f14',
    show: false,
  });

  // Graceful show
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Security: prevent new windows
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  // Load the app
  if (process.env.NODE_ENV === 'development' || process.env.VITE_DEV_SERVER_URL) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // Cleanup temp files
  cleanupTempDir();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// ─── IPC Handlers ────────────────────────────────────────
registerSigningHandlers(() => mainWindow);

// Window controls
ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize();
});

ipcMain.handle('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});

ipcMain.handle('window:close', () => {
  mainWindow?.close();
});

ipcMain.handle('window:isMaximized', () => {
  return mainWindow?.isMaximized() || false;
});

// File picker
ipcMain.handle('dialog:openFiles', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Documents to Merge',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'xlsx', 'xls'] },
      { name: 'PDF Files', extensions: ['pdf'] },
      { name: 'Word Documents', extensions: ['doc', 'docx'] },
      { name: 'Excel Workbooks', extensions: ['xlsx', 'xls'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, files: [] };
  }

  const files = [];
  for (const filePath of result.filePaths) {
    const fileInfo = await validateAndGetFileInfo(filePath);
    if (fileInfo) {
      files.push(fileInfo);
    }
  }

  return { canceled: false, files };
});

// Validate dropped files
ipcMain.handle('files:validate', async (_event, filePaths) => {
  if (!Array.isArray(filePaths)) {
    return { error: 'Invalid input' };
  }

  const files = [];
  const errors = [];

  for (const filePath of filePaths) {
    // Security: validate path is a string
    if (typeof filePath !== 'string') {
      errors.push({ path: String(filePath), error: 'Invalid file path' });
      continue;
    }

    // Security: prevent path traversal
    const normalizedPath = path.normalize(filePath);
    if (normalizedPath.includes('..')) {
      errors.push({ path: filePath, error: 'Invalid file path' });
      continue;
    }

    const fileInfo = await validateAndGetFileInfo(normalizedPath);
    if (fileInfo) {
      if (fileInfo.error) {
        errors.push({ path: filePath, error: fileInfo.error });
      } else {
        files.push(fileInfo);
      }
    }
  }

  return { files, errors };
});

// Save dialog
ipcMain.handle('dialog:saveFile', async (_event, format) => {
  if (format !== 'pdf' && format !== 'docx') {
    return { canceled: true, error: 'Invalid format' };
  }

  const ext = format === 'pdf' ? 'pdf' : 'docx';
  const filterName = format === 'pdf' ? 'PDF Document' : 'Word Document';

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Merged Document',
    defaultPath: path.join(
      app.getPath('documents'),
      `Merged_Document_${new Date().toISOString().slice(0, 10)}.${ext}`
    ),
    filters: [{ name: filterName, extensions: [ext] }],
  });

  return {
    canceled: result.canceled,
    filePath: result.filePath || null,
  };
});

// Merge documents
ipcMain.handle('documents:merge', async (_event, { filePaths, files: filesConfigs, outputFormat, outputPath }) => {
  // Validate inputs
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return { success: false, error: 'No files provided' };
  }

  if (outputFormat !== 'pdf' && outputFormat !== 'docx') {
    return { success: false, error: 'Invalid output format' };
  }

  if (typeof outputPath !== 'string' || outputPath.trim() === '') {
    return { success: false, error: 'Invalid output path' };
  }

  // Validate all file paths
  for (const fp of filePaths) {
    if (typeof fp !== 'string') {
      return { success: false, error: 'Invalid file path in list' };
    }
    const normalized = path.normalize(fp);
    if (normalized.includes('..')) {
      return { success: false, error: `Invalid file path: ${fp}` };
    }
    const ext = path.extname(fp).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      return { success: false, error: `Unsupported file type: ${ext}` };
    }
  }

  // Validate output path
  const outputNormalized = path.normalize(outputPath);
  const outputDir = path.dirname(outputNormalized);

  try {
    await fs.promises.access(outputDir, fs.constants.W_OK);
  } catch {
    return { success: false, error: 'Cannot write to the selected output directory' };
  }

  let tempDir = null;

  try {
    tempDir = createTempDir();

    // Send progress updates
    const sendProgress = (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('merge:progress', progress);
      }
    };

    await processFiles({
      filePaths,
      files: filesConfigs,
      outputFormat,
      outputPath: outputNormalized,
      tempDir,
      onProgress: sendProgress,
    });

    // Verify output exists
    const stats = await fs.promises.stat(outputNormalized);
    if (stats.size === 0) {
      return { success: false, error: 'Merge produced an empty file' };
    }

    return {
      success: true,
      outputPath: outputNormalized,
      outputSize: stats.size,
    };
  } catch (err) {
    console.error('Merge error:', err);
    return {
      success: false,
      error: err.message || 'An unknown error occurred during merging',
    };
  } finally {
    if (tempDir) {
      cleanupTempDir(tempDir);
    }
  }
});

// ─── Excel to PDF IPC Handlers ───────────────────────────

// Open Excel file picker
ipcMain.handle('excel:openDialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Excel Workbook',
    properties: ['openFile'],
    filters: [
      { name: 'Excel Workbooks', extensions: ['xlsx', 'xls'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const filePath = result.filePaths[0];
  const normalized = path.normalize(filePath);
  if (normalized.includes('..')) {
    return { canceled: false, error: 'Invalid file path' };
  }

  return { canceled: false, filePath: normalized };
});

// Inspect workbook: list sheets, visibility, pagination
ipcMain.handle('excel:inspect', async (_event, filePath) => {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return { success: false, error: 'Invalid file path' };
  }
  const normalized = path.normalize(filePath);
  if (normalized.includes('..')) {
    return { success: false, error: 'Invalid file path' };
  }

  try {
    const inspection = await inspectWorkbook(normalized);
    return { success: true, ...inspection };
  } catch (err) {
    console.error('Excel inspect error:', err);
    return { success: false, error: err.message || 'Failed to inspect workbook' };
  }
});

// Get preview for a worksheet page
ipcMain.handle('excel:preview', async (_event, { filePath, sheetIndex, pageNumber }) => {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return { success: false, error: 'Invalid file path' };
  }
  if (typeof sheetIndex !== 'number' || sheetIndex < 0) {
    return { success: false, error: 'Invalid sheet index' };
  }
  const normalized = path.normalize(filePath);
  if (normalized.includes('..')) {
    return { success: false, error: 'Invalid file path' };
  }

  try {
    const preview = await getWorksheetPreview(normalized, sheetIndex, pageNumber || 1);
    return { success: true, preview };
  } catch (err) {
    console.error('Excel preview error:', err);
    return { success: false, error: err.message || 'Failed to generate preview' };
  }
});

// Save dialog for Excel-to-PDF export
ipcMain.handle('excel:saveDialog', async (_event, defaultName) => {
  const fileName = typeof defaultName === 'string' && defaultName.trim()
    ? defaultName
    : `Excel_to_PDF_${new Date().toISOString().slice(0, 10)}.pdf`;

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Converted PDF',
    defaultPath: path.join(app.getPath('documents'), fileName),
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
  });

  return {
    canceled: result.canceled,
    filePath: result.filePath || null,
  };
});

// Export Excel to PDF
ipcMain.handle('excel:export', async (_event, { filePath, sheetConfigs, outputPath }) => {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return { success: false, error: 'No Excel file specified' };
  }
  if (!Array.isArray(sheetConfigs) || sheetConfigs.length === 0) {
    return { success: false, error: 'No worksheet configuration provided' };
  }
  if (typeof outputPath !== 'string' || outputPath.trim() === '') {
    return { success: false, error: 'No output path specified' };
  }

  const normalizedInput = path.normalize(filePath);
  const normalizedOutput = path.normalize(outputPath);

  if (normalizedInput.includes('..') || normalizedOutput.includes('..')) {
    return { success: false, error: 'Invalid file path' };
  }

  // Validate sheet configs
  for (const sc of sheetConfigs) {
    if (typeof sc.sheetIndex !== 'number' && typeof sc.sheetName !== 'string') {
      return { success: false, error: 'Each sheet config must have a sheetIndex or sheetName' };
    }
    if (sc.pageRange && typeof sc.pageRange !== 'string') {
      return { success: false, error: 'Page range must be a string' };
    }
  }

  // Validate output directory
  const outputDir = path.dirname(normalizedOutput);
  try {
    await fs.promises.access(outputDir, fs.constants.W_OK);
  } catch {
    return { success: false, error: 'Cannot write to the selected output directory' };
  }

  try {
    const sendProgress = (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('excel:progress', progress);
      }
    };

    const result = await exportExcelToPdf({
      filePath: normalizedInput,
      sheetConfigs,
      outputPath: normalizedOutput,
      onProgress: sendProgress,
    });

    return result;
  } catch (err) {
    console.error('Excel export error:', err);
    return {
      success: false,
      error: err.message || 'An unknown error occurred during Excel to PDF conversion',
    };
  }
});

// Reveal file in explorer
ipcMain.handle('shell:showItemInFolder', (_event, filePath) => {
  if (typeof filePath === 'string' && filePath.trim()) {
    shell.showItemInFolder(path.normalize(filePath));
  }
});

// Open folder or executable
ipcMain.handle('shell:openPath', async (_event, targetPath) => {
  if (typeof targetPath === 'string' && targetPath.trim()) {
    try {
      const err = await shell.openPath(path.normalize(targetPath));
      return { success: !err, error: err || null };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  return { success: false, error: 'Target path is required' };
});

// ─── Helpers ─────────────────────────────────────────────

async function validateAndGetFileInfo(filePath) {
  try {
    const validation = validateFile(filePath, SUPPORTED_EXTENSIONS, MAX_FILE_SIZE);
    if (!validation.valid) {
      return { path: filePath, error: validation.error };
    }

    const stats = await fs.promises.stat(filePath);
    const ext = path.extname(filePath).toLowerCase();

    return {
      path: filePath,
      name: path.basename(filePath),
      extension: ext,
      size: stats.size,
      type: getFileType(ext),
      error: null,
    };
  } catch (err) {
    return {
      path: filePath,
      error: err.code === 'ENOENT' ? 'File not found' : `Cannot read file: ${err.message}`,
    };
  }
}

function getFileType(ext) {
  switch (ext) {
    case '.pdf':
      return 'PDF';
    case '.docx':
      return 'Word (DOCX)';
    case '.doc':
      return 'Word (DOC)';
    case '.xlsx':
      return 'Excel (XLSX)';
    case '.xls':
      return 'Excel (XLS)';
    default:
      return 'Unknown';
  }
}
