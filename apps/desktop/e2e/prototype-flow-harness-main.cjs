const { app, BrowserWindow } = require('electron');
const { join } = require('node:path');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1100, height: 700 });
  await window.loadFile(
    join(__dirname, '..', '..', '..', '.cache', 'prototype-flow-harness', 'index.html')
  );
});

app.on('window-all-closed', () => app.quit());
