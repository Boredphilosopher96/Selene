import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, shell } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RevisionedReactBuilder, validateReactSourceWorkspace } from '@selene/core';
import {
  createElectronOpenIdClientRuntime,
  type HostedOidcProviderConfig
} from '@selene/identity-runtime';
import { createAddressPinnedOidcTransport } from '@selene/identity-runtime/node';

import { ConfiguredProcessDesignerAdapter, loadTrustedAgentConfiguration } from './agent-config';
import { createEmbeddedBuildMetadataPort } from './build-metadata';
import { MktempGeneratedProjectMaterializer } from './generated-project-materializer';
import { BunLockOnlyGeneratedProjectLockPort, HostAttestedBunCommandPort, LocalGeneratedProjectValidationAdapter } from './generated-project-lock';
import { PackagedMacBunRuntimeProvider } from './verified-bun-runtime';
import { GitHubGeneratedProjectPublishAdapter, HomebrewGitHubCliTransport } from './github-publish';
import { BunViteReactGeneratedProjectTemplate } from './generated-project-template';
import { createEmbeddedGeneratedProjectToolchainPort } from './generated-project-toolchain';
import {
  DesktopDesignerApplicationService,
  DeterministicDesignerFixtureAdapter,
  createInitialWorkspace
} from './designer-service';
import { JsonPrototypeGraphPersistencePort, UnconfiguredHostedStakeholderReviewPort, type TrustedPublishConsentPort } from './designer-host-ports';
import { DesktopDesignSystemIntake, DesktopProjectSetup, createLocalCatalogFixturePort } from './designer-setup-host';
import { FileProjectLifecycleStoragePort, LocalProjectLifecycleService } from './project-lifecycle';
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
import { defaultWorkspaceCockpitPreferences, validateWorkspaceCockpitPreferences, type WorkspaceCockpitPreferences } from '../shared/designer-api';
import { canonicalGitHubPullRequestUrl } from '../shared/github-repository';

protocol.registerSchemesAsPrivileged([
  { scheme: 'selene-preview', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);
app.enableSandbox();
// This must precede all local-project lifecycle composition. The filesystem adapter intentionally
// serializes only within one process; Electron's OS-backed singleton owns the user-data directory.
const ownsDesktopInstance = app.requestSingleInstanceLock();
if (!ownsDesktopInstance) app.quit();

const previews = new PreviewArtifactRegistry();
const generatedProjectTemplate = new BunViteReactGeneratedProjectTemplate(createEmbeddedGeneratedProjectToolchainPort());
const generatedProjectMaterializer = new MktempGeneratedProjectMaterializer(join(app.getPath('userData'), 'generated-projects-v1'));
const packagedBunRuntime = new PackagedMacBunRuntimeProvider(process.resourcesPath, app.getPath('userData'));
// Observation starts at host initialization. The inventory contains only
// bounded opaque stage IDs and never deletes or signals a prior process group.
const packagedBunRuntimeRecovery = packagedBunRuntime.recoveryInventory()
  .then((inventory) => Object.freeze({
    status: 'available' as const,
    recoveryRequired: inventory.items.length > 0 || inventory.truncated,
    ...inventory
  }))
  .catch(() => Object.freeze({
    status: 'unavailable' as const,
    recoveryRequired: true,
    items: Object.freeze([]),
    examined: 0,
    truncated: true
  }));
const generatedProjectLock = new BunLockOnlyGeneratedProjectLockPort(
  generatedProjectMaterializer,
  new HostAttestedBunCommandPort(
    packagedBunRuntime,
    app.getPath('userData')
  )
);
const localGeneratedProjectValidationAdapter = new LocalGeneratedProjectValidationAdapter(generatedProjectMaterializer, generatedProjectLock);
const githubPublishTransport = new HomebrewGitHubCliTransport(app.getPath('userData'), app.getPath('home'));
const githubGeneratedProjectPublishAdapter = new GitHubGeneratedProjectPublishAdapter(generatedProjectMaterializer, generatedProjectLock, githubPublishTransport);
/** Trusted main-process capability composition; renderer code never receives these ports. */
export const desktopHostRuntime = Object.freeze({
  designInputs: Object.freeze({
    runtime: desktopDesignInputRuntime,
    createLoader: createDesktopDesignInputLoader
  }),
  enterprise: desktopEnterpriseSecurityAdapter,
  generatedProjects: Object.freeze({
    template: generatedProjectTemplate,
    materializer: generatedProjectMaterializer,
    lock: generatedProjectLock,
    githubPublish: Object.freeze({ setup: (signal?: AbortSignal) => githubPublishTransport.setup(signal) }),
    recoveryInventory: () => generatedProjectMaterializer.recoveryInventory(),
    runtimeStageRecoveryInventory: () => packagedBunRuntimeRecovery
  })
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
let projectSetup: DesktopProjectSetup | undefined;
let safeMode = false;
let fatalExitScheduled = false;
let cleanShutdown: Promise<void> | undefined;
let workspaceCockpitPreferences: WorkspaceCockpitPreferences = defaultWorkspaceCockpitPreferences;
let workspaceCockpitPreferencesLoaded = false;
let workspaceCockpitPreferencesTail: Promise<void> = Promise.resolve();
function workspaceCockpitPreferencePath(): string { return join(app.getPath('userData'), 'workspace-cockpit-preferences-v1.json'); }
async function loadWorkspaceCockpitPreferences(): Promise<WorkspaceCockpitPreferences> {
  if (workspaceCockpitPreferencesLoaded) return workspaceCockpitPreferences;
  workspaceCockpitPreferencesLoaded = true;
  try { workspaceCockpitPreferences = validateWorkspaceCockpitPreferences(JSON.parse(await readFile(workspaceCockpitPreferencePath(), 'utf8'))); }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) workspaceCockpitPreferences = defaultWorkspaceCockpitPreferences; }
  return workspaceCockpitPreferences;
}
async function saveWorkspaceCockpitPreferences(value: unknown): Promise<WorkspaceCockpitPreferences> {
  const preferences = validateWorkspaceCockpitPreferences(value);
  await loadWorkspaceCockpitPreferences();
  const path = workspaceCockpitPreferencePath();
  const write = async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(preferences), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
      workspaceCockpitPreferences = preferences;
    } catch (error) {
      await import('node:fs/promises').then(({ rm }) => rm(temporary, { force: true })).catch(() => undefined);
      throw error;
    }
  };
  workspaceCockpitPreferencesTail = workspaceCockpitPreferencesTail.then(write, write);
  await workspaceCockpitPreferencesTail;
  return workspaceCockpitPreferences;
}
class ElectronPublishConsentPort implements TrustedPublishConsentPort {
  private readonly grants = new Map<string, { readonly digest: string; readonly expiresAt: number }>();
  public async request(binding: import('./designer-host-ports').PublishConsentBinding): Promise<{ readonly consentId: string; readonly expiresAt: number }> {
    const now = Date.now(); for (const [id, grant] of this.grants) if (grant.expiresAt < now) this.grants.delete(id);
    if (this.grants.size >= 64) throw new Error('Too many pending publish consents.');
    const remote = binding.mode === 'github-remote';
    const destination = remote ? binding.provisioning === undefined ? `Use existing repository ${binding.repository}` : `Create ${binding.provisioning.visibility} repository ${binding.repository} for ${binding.provisioning.owner.kind === 'organization' ? 'organization' : 'current user'} ${binding.provisioning.owner.login}` : 'Validate an immutable local generated-code bundle';
    const decision = await dialog.showMessageBox({ type: 'warning', buttons: ['Cancel', remote ? 'Allow remote publish' : 'Validate local publish bundle'], defaultId: 0, cancelId: 0, message: destination, detail: `${binding.title}\nProject: ${binding.projectId}\nSource: ${binding.sourceRevisionId}\nFlow revision: ${binding.graphRevision}\nBundle: ${binding.bundleDigest}\nPlan: ${binding.filePlanDigest}\n${remote ? 'This consent expires in ten minutes and is bound to the exact repository choice.' : 'Temporary project files are removed after validation; the isolated app cache is retained.'}` });
    if (decision.response !== 1) throw new Error('Publish consent was not granted.');
    const acceptedAt = Date.now(); if (!Number.isFinite(acceptedAt) || acceptedAt < now) throw new Error('Publish consent clock is invalid.');
    const consentId = `electron-consent-${randomUUID()}`; const expiresAt = acceptedAt + 10 * 60_000; this.grants.set(consentId, { digest: (await import('./designer-host-ports')).publishConsentDigest(binding), expiresAt }); return { consentId, expiresAt };
  }
  public async consume(consentId: string, binding: import('./designer-host-ports').PublishConsentBinding): Promise<void> { const digest = (await import('./designer-host-ports')).publishConsentDigest(binding); const grant = this.grants.get(consentId); this.grants.delete(consentId); if (grant === undefined || grant.expiresAt < Date.now() || grant.digest !== digest) throw new Error('Publish consent is missing, expired, or does not match this target.'); }
}

/** safeStorage is only trustworthy after Electron has initialized its native services. */
async function initializeDesktopDiagnostics(): Promise<void> {
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
  const localLifecycle = new LocalProjectLifecycleService(new FileProjectLifecycleStoragePort(join(app.getPath('userData'), 'local-projects-v2')));
  designer = new DesktopDesignerApplicationService(
    createEmbeddedBuildMetadataPort(),
    diagnostics,
    new JsonPrototypeGraphPersistencePort(join(app.getPath('userData'), 'designer-flow-v1')),
    new DesktopDesignSystemIntake(createLocalCatalogFixturePort(), desktopDesignInputRuntime, {
      requiredPeerDependencies: { react: '^19.0.0' },
      provider: {
        label: 'demo-only local catalog fixture',
        fixture: 'demo-only-local-catalog',
        supports: (input) => input.name === '@selene/design-tokens' && input.version === '1.0.0'
      }
    }),
    [localGeneratedProjectValidationAdapter, githubGeneratedProjectPublishAdapter],
    new ElectronPublishConsentPort(),
    localLifecycle,
    generatedProjectTemplate,
    new UnconfiguredHostedStakeholderReviewPort()
  );
  projectSetup = new DesktopProjectSetup(
    localLifecycle,
    (projectId, template) => {
      const workspace = createInitialWorkspace(projectId);
      const heading = template === 'review' ? 'Review workspace' : template === 'dashboard' ? 'Dashboard workspace' : 'Blank workspace';
      return {
        ...workspace,
        files: workspace.files.map((file) =>
          file.path === 'src/preview-data.json'
            ? { ...file, content: JSON.stringify({ format: 'selene-desktop-preview-data/v1', initialScreenId: 'dashboard', screens: [{ id: 'dashboard', route: '/', title: heading, summary: `${template} template`, action: 'Open orders', actionPort: 'open-orders', nextScreenId: 'orders' }, { id: 'orders', route: '/orders', title: 'Orders', summary: 'Template orders view', action: 'Back', actionPort: 'back', nextScreenId: 'dashboard' }] }, null, 2) }
            : file
        ),
        revision: { ...workspace.revision, id: `${projectId}-${template}-r1`, summary: `${heading} template` }
      };
    }
  );
  await diagnostics.initialize();
  const hydration = await designer.hydratePrototypeGraph();
  if (hydration.state === 'recovery-required')
    void diagnostics.capture('designer', 'prototype-graph-hydration', hydration).catch(() => undefined);
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
function activeProjectSetup(): DesktopProjectSetup {
  if (projectSetup === undefined) throw new Error('Project setup is not initialized');
  return projectSetup;
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
    createElectronOpenIdClientRuntime(provider, {
      transport: createAddressPinnedOidcTransport()
    }),
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
  designerHandler('selene:designer:inspect-design-system', (value) => desktopDesigner.inspectDesignSystem(value));
  designerHandler('selene:designer:ingest-design-language', (value) => desktopDesigner.ingestDesignLanguage(value));
  designerHandler('selene:designer:create-project', async (value) => {
    const receipt = await activeProjectSetup().create(value);
    return { receipt, snapshot: await desktopDesigner.openProjectWorkspace((await activeProjectSetup().open(receipt.projectId)).current) };
  });
  designerHandler('selene:designer:import-project', async (value) => {
    const receipt = await activeProjectSetup().importText(value);
    return { receipt, snapshot: await desktopDesigner.openProjectWorkspace((await activeProjectSetup().open(receipt.projectId)).current) };
  });
  designerHandler('selene:designer:configure-trusted-agent', async () => {
    const choice = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Trusted agent configuration', extensions: ['json'] }] });
    if (choice.canceled || choice.filePaths.length !== 1) return [];
    const configuration = await loadTrustedAgentConfiguration(choice.filePaths[0]!);
    for (const agent of configuration.agents)
      desktopDesigner.registerAgent(new ConfiguredProcessDesignerAdapter(agent, desktopDiagnostics));
    return desktopDesigner.snapshot().agents;
  });
  designerHandler('selene:designer:save-prototype-graph', (value) =>
    desktopDesigner.savePrototypeGraph(value)
  );
  designerHandler('selene:designer:retry-prototype-graph-hydration', () =>
    desktopDesigner.retryPrototypeGraphHydration()
  );
  designerHandler('selene:designer:recover-prototype-graph-from-fixture', () =>
    desktopDesigner.recoverPrototypeGraphFromFixture()
  );
  designerHandler('selene:designer:set-prototype-mode', (value) =>
    desktopDesigner.setPrototypeMode(value)
  );
  designerHandler('selene:designer:run-prototype-action', (value) => desktopDesigner.runPrototypeAction(value));
  designerHandler('selene:designer:reset-prototype-run', () => desktopDesigner.resetPrototypeRun());
  designerHandler('selene:designer:publish-generated-code', (value) =>
    desktopDesigner.publishGeneratedCode(value)
  );
  designerHandler('selene:designer:request-publish-consent', (value) =>
    desktopDesigner.requestGeneratedCodePublishConsent(value)
  );
  designerHandler('selene:designer:cancel-generated-code-publish', (value) =>
    desktopDesigner.cancelGeneratedCodePublish(value)
  );
  designerHandler('selene:designer:publish-operation', (value) =>
    desktopDesigner.publishOperation(value)
  );
  designerHandler('selene:designer:open-publish-receipt', async (value) => {
    if (typeof value !== 'string' || value.length > 128) throw new Error('Publish receipt ID is invalid');
    const operation = desktopDesigner.publishOperation(value);
    const receipt = operation.receipt;
    if (receipt?.mode !== 'github-remote') throw new Error('Completed remote receipt is unavailable');
    let receiptUrl: string;
    try { receiptUrl = canonicalGitHubPullRequestUrl(receipt.pullRequestUrl, receipt.repository); }
    catch { throw new Error('Completed remote receipt is unavailable'); }
    await shell.openExternal(receiptUrl, { activate: true });
  });
  designerHandler('selene:designer:github-publish-setup', () => githubPublishTransport.setup());
  designerHandler('selene:designer:add-review-thread', (value) =>
    desktopDesigner.addReviewThread(value)
  );
  designerHandler('selene:designer:resolve-review-thread', (value) =>
    desktopDesigner.resolveReviewThread(value)
  );
  designerHandler('selene:designer:reply-review-thread', (value) =>
    desktopDesigner.replyToReviewThread(value)
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
  designerHandler('selene:designer:workspace-cockpit-preferences', () => loadWorkspaceCockpitPreferences());
  designerHandler('selene:designer:save-workspace-cockpit-preferences', (value) => saveWorkspaceCockpitPreferences(value));
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
      await initializeDesktopDiagnostics();
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
