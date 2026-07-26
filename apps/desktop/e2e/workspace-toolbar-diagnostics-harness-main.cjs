const { app, BrowserWindow } = require('electron');
const { join } = require('node:path');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 900, height: 640 });
  await window.loadFile(
    join(
      __dirname,
      '..',
      '..',
      '..',
      '.cache',
      'workspace-toolbar-diagnostics-harness',
      'index.html'
    )
  );
});

app.on('window-all-closed', () => app.quit());
