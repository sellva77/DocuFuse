# DocuFuse

A standalone Windows desktop application for merging multiple PDF, DOC, and DOCX files into a single output document.

## Features

- **Document Merger Mode**:
  - **Multi-format Input**: Supports PDF, DOCX, legacy DOC, and Excel (.xlsx, .xls) files
  - **Drag & Drop**: Drag files directly into the application or use the file browser
  - **Reorder**: Drag-and-drop reordering of documents before merging
  - **Dual Output Formats**:
    - **PDF Export**: Merges all documents into a single PDF file
    - **DOCX Export**: Combines content into an editable Word document with structured tables
- **Excel to PDF Conversion Module**:
  - **Supported Formats**: Modern `.xlsx` and legacy `.xls` workbooks
  - **Worksheet Inspector**: Lists all sheets with visibility badges (Visible, Hidden, Very Hidden)
  - **Worksheet Ordering**: Drag-and-drop reordering & up/down controls with order preservation
  - **Print Pagination Engine**: Calculates print-ready pages respecting orientation (Portrait/Landscape), paper size (A4, Letter, Legal, etc.), margins, print areas, repeating header rows/columns, and explicit row breaks
  - **Custom Page Ranges**: Filter printable pages per worksheet (e.g. `all`, `1-3, 5, 7-9`)
  - **Visual Page Preview**: High-fidelity SVG canvas preview with cell text, alignments, fills, and borders
  - **Standalone & Offline**: Zero dependencies on Microsoft Office, LibreOffice, or Python
  - **Progress Tracking & Feedback**: Real-time progress bar with step details and instant notifications
- **Secure**: No internet connection required, all processing is 100% local
- **Professional UI**: Modern dark theme with glassmorphism design and tab navigation

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Desktop Runtime | Electron.js |
| UI Framework | React 19 |
| Build Tool | Vite |
| PDF Processing | pdf-lib, pdf-parse |
| DOCX Processing | docx, mammoth |
| Excel Processing | exceljs, xlsx |
| Packaging | electron-builder |

## Development

### Prerequisites

- Node.js 18+ and npm

### Install Dependencies

```bash
npm install
```

### Run in Development Mode

```bash
npm run dev
```

This starts the Vite dev server and opens the Electron window with hot reload.

### Build for Production

**Windows Installer (NSIS):**
```bash
npm run electron:build
```

Output: `release/DocumentMergerSetup.exe`

**Portable Version:**
```bash
npm run electron:build:portable
```

Output: `release/DocumentMergerPortable.exe`

**Both:**
```bash
npm run electron:build:all
```

## Project Structure

```
document-merger/
├── src/
│   ├── main/              # Electron main process
│   │   └── main.js        # Application entry, IPC handlers (merge & excel)
│   ├── preload/           # Secure IPC bridge
│   │   └── preload.js     # Context-isolated API exposure
│   ├── renderer/          # React UI
│   │   ├── main.jsx       # React entry point
│   │   ├── App.jsx        # Main application component with tab navigation
│   │   ├── index.css      # Design system & styles
│   │   └── components/    # UI components
│   │       ├── TitleBar.jsx
│   │       ├── DropZone.jsx
│   │       ├── FileList.jsx
│   │       ├── ControlsPanel.jsx
│   │       ├── ProgressOverlay.jsx
│   │       ├── Notification.jsx
│   │       ├── ExcelConverter.jsx  # Excel-to-PDF conversion panel
│   │       └── Icons.jsx
│   ├── services/          # Document processing engines
│   │   ├── documentProcessor.js
│   │   └── excel/         # Excel conversion module
│   │       ├── excelValidator.js   # Magic bytes, corrupt & password checks
│   │       ├── excelPaginator.js   # Page break calculation, paper size & ranges
│   │       ├── excelParser.js      # Workbook, sheet, style & layout parsing
│   │       ├── excelRenderer.js    # PDF drawing & SVG preview generation
│   │       └── excelService.js     # High-level inspect, preview & export API
│   └── utils/             # Utilities
│       ├── fileValidator.js
│       └── tempManager.js
├── tests/                 # Automated test suite
│   ├── testMerge.mjs               # Document merger test suite
│   └── testExcelService.mjs        # Excel conversion test suite
├── resources/             # App icons and assets
├── package.json
├── vite.config.js
└── README.md
```

## Electron Security

This application implements secure Electron defaults:

- `contextIsolation: true` — Renderer and main process are isolated
- `nodeIntegration: false` — No direct Node.js access from UI
- **Preload script** exposes only whitelisted IPC channels
- **Input validation** on all IPC arguments (paths, extensions, formats, sheet configs)
- **Path traversal protection** — Normalized paths with `..` detection
- **No shell command execution** with user input
- **No external network calls** — All processing is 100% local
- **Temp file cleanup** on completion, failure, and app exit

## Export Capabilities & Limitations

### PDF Export ✅
- **Excel (.xlsx, .xls) → PDF**: Spreadsheet-compatible rendering
  - Supports custom worksheet selection and custom ordering
  - Honors page orientation (Portrait/Landscape), paper size (A4, Letter, Legal, etc.)
  - Honors print margins, print areas, explicit page breaks, and repeating header rows
  - Accurately renders cell background fills, fonts, alignments, and borders
  - Interactive SVG page preview before exporting
- **PDF → PDF**: Lossless page-by-page copy (full fidelity)
- **DOCX → PDF**: Text and images extracted, rendered as PDF pages
  - Headings are bold and larger
  - JPEG and PNG images are embedded
  - Complex Word formatting (columns, headers/footers, exact fonts) may not be perfectly preserved
- **DOC → PDF**: Basic text extraction from binary format
  - For best results, save DOC files as DOCX first

### DOCX Export ✅
- **Excel (.xlsx, .xls) → DOCX**: Worksheets extracted as structured Word tables
- **DOCX → DOCX**: Structured content extraction via mammoth
  - Headings, paragraphs, lists are preserved
  - Images are embedded
  - Complex formatting may be simplified
- **PDF → DOCX**: Text extraction using pdf-parse
  - Text content is preserved
  - Page layouts, columns, and exact formatting are not reproduced
  - Image-only or scanned PDFs will show minimal content
  - A notice is included in the output explaining the limitation
- **DOC → DOCX**: Basic text extraction
  - Limited by the binary format parser

### Known Limitations

1. **PDF to DOCX**: Inherently lossy. PDFs are a visual format; converting to editable DOCX cannot perfectly reproduce layouts, fonts, or images in all cases.
2. **Legacy DOC**: The .doc format is a proprietary binary format. Without Microsoft Word or LibreOffice, text extraction is best-effort.
3. **Password-protected files**: Detected and reported with a clear error message.
4. **Scanned/image PDFs**: Text extraction relies on embedded text; OCR is not included.

## Licence

MIT

### Third-Party Licences

| Library | Licence |
|---------|---------|
| Electron | MIT |
| React | MIT |
| Vite | MIT |
| pdf-lib | MIT |
| pdf-parse | MIT |
| mammoth | BSD-2-Clause |
| docx | MIT |
| exceljs | MIT |
| xlsx | Apache-2.0 |
| electron-builder | MIT |
