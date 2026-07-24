import { app, BrowserWindow, ipcMain, protocol, shell } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RevisionedReactBuilder, validateReactSourceWorkspace } from '@selene/core';
import {
  createElectronOpenIdClientRuntime,
  type HostedOidcProviderConfig
} from '@selene/identity-runtime';

import { ConfiguredProcessDesignerAdapter, loadTrustedAgentConfiguration } from './agent-config';
import { createEmbeddedBuildMetadataPort } from './build-metadata';
import {
  DesktopDesignerApplicationService,
  DeterministicDesignerFixtureAdapter
} from './designer-service';
import { createPreviewSecurityPolicy, PreviewArtifactRegistry } from './preview-adapter';
import { ViteReactCompilerPort } from './react-compiler';
import { createElectronOidcLogin, type ElectronOidcLogin } from './oidc';
import { createDesktopDesignInputLoader, desktopDesignInputRuntime } from './design-input-runtime';

protocol.registerSchemesAsPrivileged([
  { scheme: 'selene-preview', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);
app.enableSandbox();
// This must precede all local-project lifecycle composition. The filesystem adapter intentionally
// serializes only within one process; Electron's OS-backed singleton owns the user-data directory.
const ownsDesktopInstance = app.requestSingleInstanceLock();
if (!ownsDesktopInstance) app.quit();

const previews = new PreviewArtifactRegistry();
/** Trusted main-process capability composition; renderer code never receives these ports. */
export const desktopHostRuntime = Object.freeze({
  designInputs: Object.freeze({
    runtime: desktopDesignInputRuntime,
    createLoader: createDesktopDesignInputLoader
  })
});
const compiler = new ViteReactCompilerPort();
const builder = new RevisionedReactBuilder();
const activePreviewBuilds = new Map<number, AbortController>();
const designer = new DesktopDesignerApplicationService(createEmbeddedBuildMetadataPort());
const currentDirectory = dirname(fileURLToPath(import.meta.url));
designer.registerAgent(new DeterministicDesignerFixtureAdapter());

function configuredDesktopOidcLogin(): ElectronOidcLogin | undefined {
  const issuer = process.env.SELENE_OIDC_ISSUER;
  const clientId = process.env.SELENE_OIDC_CLIENT_ID;
  const redirectUri = process.env.SELENE_OIDC_REDIRECT_URI;
  if (!issuer && !clientId && !redirectUri) return undefined;
  if (!issuer || !clientId || !redirectUri) {
    throw new Error('Desktop OIDC requires SELENE_OIDC_ISSUER, _CLIENT_ID, and _REDIRECT_URI');
  }
  if (process.env.SELENE_OIDC_CLIENT_SECRET) {
    throw new Error(
      'Desktop OIDC is a public client and must never accept SELENE_OIDC_CLIENT_SECRET'
    );
  }
  const provider: HostedOidcProviderConfig = {
    issuer,
    allowedIssuerHosts: (process.env.SELENE_OIDC_ALLOWED_ISSUER_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
    clientId,
    redirectUri,
    scopes: (process.env.SELENE_OIDC_SCOPES ?? 'openid,profile,email')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean)
  };
  return createElectronOidcLogin(
    provider,
    createElectronOpenIdClientRuntime(provider),
    shell.openExternal
  );
}

const desktopOidcLogin = configuredDesktopOidcLogin();

async function registerTrustedUserAgents(): Promise<void> {
  const path = join(app.getPath('userData'), 'designer-agents.json');
  try {
    const configuration = await loadTrustedAgentConfiguration(path);
    for (const agent of configuration.agents)
      designer.registerAgent(new ConfiguredProcessDesignerAdapter(agent));
  } catch (error) {
    // This optional, user-owned main-process config is never renderer input.
    // Invalid values must not expose a renderer-controlled executable path.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn(
        `Configured desktop agents were not loaded: ${error instanceof Error ? error.message : 'unknown error'}`
      );
  }
}

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
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1100,
    height: 700,
    show: false,
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    }
  });

  window.once('ready-to-show', () => window.show());

  // Data crosses this small, versioned preload API only; the Electron-free
  // application service validates every renderer-controlled value.
  const designerHandler = <T>(channel: string, action: (value: unknown) => T | Promise<T>) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, value: unknown) => {
      if (!isMainRendererFrame(window, event))
        throw new Error('Designer actions require the main renderer frame');
      return action(value);
    });
  };
  designerHandler('selene:designer:snapshot', () => designer.snapshot());
  designerHandler('selene:designer:select-agent', (value) => designer.selectAgent(value));
  designerHandler('selene:designer:select-scenario', (value) => designer.selectScenario(value));
  designerHandler('selene:designer:select-node', (value) => designer.selectNode(value));
  designerHandler('selene:designer:add-review-thread', (value) => designer.addReviewThread(value));
  designerHandler('selene:designer:add-developer-annotation', (value) =>
    designer.addDeveloperAnnotation(value)
  );
  designerHandler('selene:designer:request-ai-change', (value) => designer.requestAIChange(value));
  designerHandler('selene:designer:cancel', (value) => designer.cancel(value));
  designerHandler('selene:designer:mark-ready-for-review', () => designer.markReadyForReview());
  designerHandler('selene:designer:mark-ready-for-handoff', () => designer.markReadyForHandoff());
  designerHandler('selene:designer:export-handoff', () => designer.exportHandoff());
  ipcMain.removeHandler('selene:identity:sign-in');
  ipcMain.handle('selene:identity:sign-in', async (event) => {
    if (!isMainRendererFrame(window, event))
      throw new Error('Desktop sign-in requires the main renderer frame');
    if (!desktopOidcLogin) return { mode: 'local' as const };
    const tokens = await desktopOidcLogin.signInWithLoopback();
    return {
      mode: 'oidc' as const,
      subject: tokens.claims.sub,
      ...(tokens.claims.email ? { email: tokens.claims.email } : {}),
      ...(tokens.claims.name ? { name: tokens.claims.name } : {})
    };
  });
  const unsubscribeProgress = designer.subscribe((event) => {
    if (!window.isDestroyed()) window.webContents.send('selene:designer:progress', event);
  });
  window.once('closed', unsubscribeProgress);

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
    void window.loadFile(join(currentDirectory, '../renderer/index.html'));
  }
}

if (ownsDesktopInstance) {
  app.whenReady().then(async () => {
    denyUnsafeRendererCapabilities();
    await registerTrustedUserAgents();
    protocol.handle('selene-preview', (request) => previews.handle(request.url));
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}
