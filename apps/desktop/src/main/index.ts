import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { createPreviewSecurityPolicy, PreviewArtifactRegistry } from './preview-adapter';
import { ViteReactCompilerPort } from './react-compiler';
import { RevisionedReactBuilder, validateReactSourceWorkspace } from '@selene/core';

protocol.registerSchemesAsPrivileged([
  { scheme: 'selene-preview', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

const previews = new PreviewArtifactRegistry();
const compiler = new ViteReactCompilerPort();
const builder = new RevisionedReactBuilder();
const activePreviewBuilds = new Map<number, AbortController>();

function isMainRendererFrame(
  window: BrowserWindow,
  sender: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent
): boolean {
  const frame = sender.senderFrame;
  return (
    sender.sender === window.webContents &&
    frame !== null &&
    frame.routingId === window.webContents.mainFrame.routingId
  );
}

function denyUnsafeRendererCapabilities(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false)
    );
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1100,
    height: 700,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.once('ready-to-show', () => window.show());

  // The only preview inputs accepted from the UI are a bounded, schema-checked
  // source workspace and typed frame messages. The preview frame itself is not
  // allowed to invoke the preload bridge because it is not the main renderer.
  ipcMain.removeHandler('selene:preview-build');
  ipcMain.handle('selene:preview-build', async (event, value: unknown) => {
    if (!isMainRendererFrame(window, event))
      throw new Error('Preview builds require the main renderer frame');
    validateReactSourceWorkspace(value as never);
    const previous = activePreviewBuilds.get(event.sender.id);
    previous?.abort();
    const controller = new AbortController();
    activePreviewBuilds.set(event.sender.id, controller);
    try {
      const artifact = await builder.build(
        compiler,
        value as Parameters<typeof compiler.compile>[0],
        controller.signal
      );
      if (artifact.diagnostics.length > 0)
        throw new Error(artifact.diagnostics.map((issue) => issue.message).join('\n'));
      const policy = createPreviewSecurityPolicy(
        'selene-preview://local',
        randomBytes(24).toString('base64url')
      );
      return previews.publish(randomUUID(), policy, artifact);
    } finally {
      if (activePreviewBuilds.get(event.sender.id) === controller)
        activePreviewBuilds.delete(event.sender.id);
    }
  });
  ipcMain.on('selene:preview-message', (event, payload: unknown) => {
    if (!isMainRendererFrame(window, event)) return;
    try {
      // The renderer validates iframe source first; this second validation
      // makes forged renderer payloads inert as well.
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('policy' in payload) ||
        !('message' in payload)
      )
        return;
      const { policy, message } = payload as {
        policy: ReturnType<typeof createPreviewSecurityPolicy>;
        message: unknown;
      };
      previews.validatePublishedMessage(policy, message);
    } catch {
      // Untrusted preview messages are intentionally ignored.
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  denyUnsafeRendererCapabilities();
  protocol.handle('selene-preview', (request) => previews.handle(request.url));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
