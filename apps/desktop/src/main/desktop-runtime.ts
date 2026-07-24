import { app, BrowserWindow, ipcMain, protocol, safeStorage, shell } from 'electron';
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
import { desktopEnterpriseSecurityAdapter } from './enterprise-security-runtime';
import {
  CrashDiagnostics,
  CrashLoopRecovery,
  type DiagnosticsStorageCodec,
  JsonFileDiagnosticsConsentStore,
  JsonFileDiagnosticsDeliveryStore,
  JsonFileDiagnosticsStore
} from './crash-diagnostics';

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
  }),
  enterprise: desktopEnterpriseSecurityAdapter
});
const compiler = new ViteReactCompilerPort();
const builder = new RevisionedReactBuilder();
const activePreviewBuilds = new Map<number, AbortController>();
const currentDirectory = dirname(fileURLToPath(import.meta.url));
// This app/profile-private subdirectory is never exposed through preload, exports, or sinks.
const diagnosticDirectory = join(app.getPath('userData'), 'private-diagnostics-v1');
function encryptedDiagnosticsStorage(): DiagnosticsStorageCodec {
  // This deny-only process setting lets deployment smoke tests exercise the same fail-closed path
  // as an unavailable OS keychain; it can never enable plaintext diagnostics.
  if (
    process.env.SELENE_DIAGNOSTICS_FORCE_SAFE_STORAGE_UNAVAILABLE === '1' ||
    !safeStorage.isEncryptionAvailable()
  )
    throw new Error('Encrypted diagnostics storage is unavailable for this desktop profile');
  return Object.freeze({
    seal: (plaintext: string) =>
      `selene-safe-storage/v1:${safeStorage.encryptString(plaintext).toString('base64')}`,
    open: (ciphertext: string) => {
      const prefix = 'selene-safe-storage/v1:';
      if (!ciphertext.startsWith(prefix))
        throw new Error('Diagnostics storage encryption envelope is invalid');
      return safeStorage.decryptString(Buffer.from(ciphertext.slice(prefix.length), 'base64'));
    }
  });
}
const diagnosticsPolicy = Object.freeze({
  collection: process.env.SELENE_DIAGNOSTICS_COLLECTION === 'deny' ? 'deny' : 'allow',
  reporting: process.env.SELENE_DIAGNOSTICS_REPORTING === 'deny' ? 'deny' : 'allow'
} as const);
let diagnostics: CrashDiagnostics | undefined;
let crashLoopRecovery: CrashLoopRecovery | undefined;
let designer: DesktopDesignerApplicationService | undefined;
let safeMode = false;
let fatalExitScheduled = false;
let cleanShutdown: Promise<void> | undefined;

/** safeStorage is only trustworthy after Electron has initialized its native services. */
function initializeDesktopDiagnostics(): void {
  const diagnosticsStorage = encryptedDiagnosticsStorage();
  diagnostics = new CrashDiagnostics(
    new JsonFileDiagnosticsStore(
      join(diagnosticDirectory, 'crash-diagnostics.json'),
      undefined,
      diagnosticsStorage
    ),
    new JsonFileDiagnosticsConsentStore(
      join(diagnosticDirectory, 'crash-diagnostics-consent.json'),
      undefined,
      diagnosticsStorage
    ),
    {
      policy: diagnosticsPolicy,
      deliveryStore: new JsonFileDiagnosticsDeliveryStore(
        join(diagnosticDirectory, 'crash-diagnostics-delivery.json'),
        undefined,
        diagnosticsStorage
      )
    }
  );
  crashLoopRecovery = new CrashLoopRecovery(
    new JsonFileDiagnosticsStore(
      join(diagnosticDirectory, 'crash-starts.json'),
      undefined,
      diagnosticsStorage
    )
  );
  designer = new DesktopDesignerApplicationService(createEmbeddedBuildMetadataPort(), diagnostics);
  designer.registerAgent(new DeterministicDesignerFixtureAdapter());
}

function activeDiagnostics(): CrashDiagnostics {
  if (diagnostics === undefined) throw new Error('Diagnostics runtime is not initialized');
  return diagnostics;
}

function activeCrashLoopRecovery(): CrashLoopRecovery {
  if (crashLoopRecovery === undefined) throw new Error('Crash recovery is not initialized');
  return crashLoopRecovery;
}

function activeDesigner(): DesktopDesignerApplicationService {
  if (designer === undefined) throw new Error('Desktop designer is not initialized');
  return designer;
}

function isUncleanProcessExit(details: unknown): boolean {
  return (
    typeof details !== 'object' ||
    details === null ||
    !('reason' in details) ||
    (details as { readonly reason?: unknown }).reason !== 'clean-exit'
  );
}

async function failFastAfterFatalDiagnostic(
  category: 'uncaught-exception' | 'unhandled-rejection',
  hostile: unknown
): Promise<void> {
  if (fatalExitScheduled) return;
  fatalExitScheduled = true;
  crashLoopRecovery?.markUncleanTermination();
  await Promise.race([
    diagnostics?.capture('electron', category, hostile).catch(() => undefined) ?? Promise.resolve(),
    new Promise<void>((resolve) => setTimeout(resolve, 250))
  ]);
  app.exit(1);
}

process.on('uncaughtException', (error) => {
  void failFastAfterFatalDiagnostic('uncaught-exception', error);
});
process.on('unhandledRejection', (reason) => {
  void failFastAfterFatalDiagnostic('unhandled-rejection', reason);
});

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
      activeDesigner().registerAgent(
        new ConfiguredProcessDesignerAdapter(agent, activeDiagnostics())
      );
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
    contents.on('render-process-gone', (_processEvent, details) => {
      if (isUncleanProcessExit(details)) crashLoopRecovery?.markUncleanTermination();
      void diagnostics?.capture('electron', 'renderer-gone', details).catch(() => undefined);
    });
  });
}

function createWindow(): void {
  const desktopDesigner = activeDesigner();
  const desktopDiagnostics = activeDiagnostics();
  const recovery = activeCrashLoopRecovery();
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
  designerHandler('selene:designer:snapshot', () => desktopDesigner.snapshot());
  designerHandler('selene:designer:select-agent', (value) => desktopDesigner.selectAgent(value));
  designerHandler('selene:designer:select-scenario', (value) =>
    desktopDesigner.selectScenario(value)
  );
  designerHandler('selene:designer:select-node', (value) => desktopDesigner.selectNode(value));
  designerHandler('selene:designer:add-review-thread', (value) =>
    desktopDesigner.addReviewThread(value)
  );
  designerHandler('selene:designer:add-developer-annotation', (value) =>
    desktopDesigner.addDeveloperAnnotation(value)
  );
  designerHandler('selene:designer:request-ai-change', (value) =>
    desktopDesigner.requestAIChange(value)
  );
  designerHandler('selene:designer:cancel', (value) => desktopDesigner.cancel(value));
  designerHandler('selene:designer:mark-ready-for-review', () =>
    desktopDesigner.markReadyForReview()
  );
  designerHandler('selene:designer:mark-ready-for-handoff', () =>
    desktopDesigner.markReadyForHandoff()
  );
  designerHandler('selene:designer:export-handoff', () => desktopDesigner.exportHandoff());
  designerHandler('selene:diagnostics:export', () => desktopDiagnostics.export());
  designerHandler('selene:diagnostics:delete', () => desktopDiagnostics.delete());
  designerHandler('selene:diagnostics:consent', () => desktopDiagnostics.getConsent());
  designerHandler('selene:diagnostics:recovery', () => ({
    ...recovery.status(),
    active: safeMode
  }));
  designerHandler('selene:diagnostics:reset-recovery', async () => {
    await recovery.reset();
    if (safeMode) await registerTrustedUserAgents();
    safeMode = false;
    return recovery.status();
  });
  designerHandler('selene:diagnostics:set-consent', (value) => {
    if (value !== 'granted' && value !== 'denied')
      throw new Error('Diagnostics consent must be granted or denied');
    return desktopDiagnostics.setUserConsent(value);
  });
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
  const unsubscribeProgress = desktopDesigner.subscribe((event) => {
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
    if (safeMode) throw new Error('Preview builds are disabled while crash recovery is active');
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
      const validated = previews.validatePublishedMessage(policy, message);
      if (validated.type === 'runtime-error')
        void desktopDiagnostics
          .capture('preview', 'runtime-error', validated)
          .catch(() => undefined);
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
  void app
    .whenReady()
    .then(async () => {
      initializeDesktopDiagnostics();
      await activeDiagnostics().initialize();
      safeMode = (await activeCrashLoopRecovery().beginStartup()).active;
      denyUnsafeRendererCapabilities();
      if (!safeMode) await registerTrustedUserAgents();
      protocol.handle('selene-preview', (request) => previews.handle(request.url));
      createWindow();

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch(() => app.exit(1));
  app.on('child-process-gone', (_event, details) => {
    if (isUncleanProcessExit(details)) crashLoopRecovery?.markUncleanTermination();
    void diagnostics?.capture('electron', 'child-process-gone', details).catch(() => undefined);
  });
  app.on('before-quit', (event) => {
    // A normal quit is the only place recovery evidence may be erased. Keep Electron alive until
    // the delete is durable; app.exit below bypasses before-quit and cannot recurse here.
    if (fatalExitScheduled || cleanShutdown !== undefined) return;
    event.preventDefault();
    cleanShutdown = activeCrashLoopRecovery()
      .cleanShutdown()
      .then((clean) => app.exit(clean ? 0 : 1))
      .catch(() => app.exit(1));
  });
}
