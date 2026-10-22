const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// We need main process handlers from dist-electron or register them
const distMain = path.resolve('dist-electron/main.js');
console.log('Testing production Electron app with built dist/index.html...');

// Let's launch electron with main.js directly
