import { contextBridge, ipcRenderer } from 'electron';

import type {
  AIChangeRequestInput,
  DesignerPublishConsentInput,
  DesignerPublishInput,
  GeneratedCodePublishOperation,
  GeneratedCodePublishStart,
  DeveloperAnnotationInput,
  DesignerProgress,
  DesignerSnapshot,
  DesignerAgentSummary,
  DesignSystemIntakeReceipt,
  MarkdownIntakeReceipt,
  ProjectOpenResult,
  ReviewThreadInput,
  ReviewThreadResolutionInput,
  ReviewThreadReplyInput,
  WorkspaceCockpitPreferences,
  GitHubPublishSetup
} from '../shared/designer-api';
import { DESIGNER_API_VERSION } from '../shared/designer-api';
import type {
  CrashDiagnosticsExport,
  CrashRecoveryStatus,
  DiagnosticsConsent
} from '../main/crash-diagnostics';

interface PreviewBridgeMessage {
  readonly type: 'ready' | 'select-node' | 'trigger-action' | 'rendered' | 'runtime-error';
  readonly nonce: string;
  readonly origin: string;
  readonly revisionId: string;
  readonly nodeId?: string;
  readonly portId?: string;
  readonly message?: string;
}

interface PreviewPolicy {
  readonly origin: string;
  readonly nonce: string;
  readonly maxMessageBytes: number;
  readonly csp: string;
}

interface PreviewBuildResult {
  readonly url: string;
  readonly policy: PreviewPolicy;
  readonly revisionId: string;
}

contextBridge.exposeInMainWorld('selene', {
  apiVersion: 'selene-desktop-preload/v1',
  platform: process.platform,
  identity: {
    signIn: () =>
      ipcRenderer.invoke('selene:identity:sign-in') as Promise<
        | { readonly mode: 'local' }
        | {
            readonly mode: 'oidc';
            readonly subject: string;
            readonly email?: string;
            readonly name?: string;
          }
      >
  },
  diagnostics: {
    export: () =>
      ipcRenderer.invoke('selene:diagnostics:export') as Promise<CrashDiagnosticsExport>,
    delete: () => ipcRenderer.invoke('selene:diagnostics:delete') as Promise<void>,
    consent: () => ipcRenderer.invoke('selene:diagnostics:consent') as Promise<DiagnosticsConsent>,
    recovery: () =>
      ipcRenderer.invoke('selene:diagnostics:recovery') as Promise<CrashRecoveryStatus>,
    resetRecovery: () =>
      ipcRenderer.invoke('selene:diagnostics:reset-recovery') as Promise<CrashRecoveryStatus>,
    setConsent: (choice: 'granted' | 'denied') =>
      ipcRenderer.invoke('selene:diagnostics:set-consent', choice) as Promise<DiagnosticsConsent>
  },
  designer: {
    apiVersion: DESIGNER_API_VERSION,
    snapshot: () => ipcRenderer.invoke('selene:designer:snapshot') as Promise<DesignerSnapshot>,
    selectAgent: (agentId: string) =>
      ipcRenderer.invoke('selene:designer:select-agent', agentId) as Promise<DesignerSnapshot>,
    selectScenario: (scenarioId: string) =>
      ipcRenderer.invoke(
        'selene:designer:select-scenario',
        scenarioId
      ) as Promise<DesignerSnapshot>,
    selectNode: (nodeId: string) =>
      ipcRenderer.invoke('selene:designer:select-node', nodeId) as Promise<DesignerSnapshot>,
    inspectDesignSystem: (request: { readonly name: string; readonly version: string }) =>
      ipcRenderer.invoke('selene:designer:inspect-design-system', request) as Promise<DesignSystemIntakeReceipt>,
    ingestDesignLanguage: (request: { readonly markdown: string }) =>
      ipcRenderer.invoke('selene:designer:ingest-design-language', request) as Promise<MarkdownIntakeReceipt>,
    createProject: (request: { readonly id: string; readonly name: string; readonly template: 'blank' | 'dashboard' | 'review' }) =>
      ipcRenderer.invoke('selene:designer:create-project', request) as Promise<ProjectOpenResult>,
    importProject: (request: { readonly contents: string }) =>
      ipcRenderer.invoke('selene:designer:import-project', request) as Promise<ProjectOpenResult>,
    configureTrustedAgent: () =>
      ipcRenderer.invoke('selene:designer:configure-trusted-agent') as Promise<readonly DesignerAgentSummary[]>,
    savePrototypeGraph: (graph: unknown) =>
      ipcRenderer.invoke('selene:designer:save-prototype-graph', graph) as Promise<DesignerSnapshot>,
    retryPrototypeGraphHydration: () =>
      ipcRenderer.invoke('selene:designer:retry-prototype-graph-hydration') as Promise<DesignerSnapshot>,
    recoverPrototypeGraphFromFixture: () =>
      ipcRenderer.invoke('selene:designer:recover-prototype-graph-from-fixture') as Promise<DesignerSnapshot>,
    setPrototypeMode: (mode: 'edit' | 'run') =>
      ipcRenderer.invoke('selene:designer:set-prototype-mode', mode) as Promise<DesignerSnapshot>,
    runPrototypeAction: (action: { nodeId: string; portId: string }) =>
      ipcRenderer.invoke('selene:designer:run-prototype-action', action) as Promise<DesignerSnapshot>,
    resetPrototypeRun: () => ipcRenderer.invoke('selene:designer:reset-prototype-run') as Promise<DesignerSnapshot>,
    publishGeneratedCode: (request: DesignerPublishInput) =>
      ipcRenderer.invoke('selene:designer:publish-generated-code', request) as Promise<GeneratedCodePublishStart>,
    requestGeneratedCodePublishConsent: (request: DesignerPublishConsentInput) =>
      ipcRenderer.invoke('selene:designer:request-publish-consent', request) as Promise<{ readonly consentId: string }>,
    cancelGeneratedCodePublish: (publishId: string) =>
      ipcRenderer.invoke('selene:designer:cancel-generated-code-publish', publishId) as Promise<void>,
    generatedCodePublishOperation: (publishId: string) =>
      ipcRenderer.invoke('selene:designer:publish-operation', publishId) as Promise<GeneratedCodePublishOperation>,
    openGeneratedCodePublishReceipt: (publishId: string) =>
      ipcRenderer.invoke('selene:designer:open-publish-receipt', publishId) as Promise<void>,
    githubPublishSetup: () =>
      ipcRenderer.invoke('selene:designer:github-publish-setup') as Promise<GitHubPublishSetup>,
    addReviewThread: (thread: ReviewThreadInput) =>
      ipcRenderer.invoke('selene:designer:add-review-thread', thread) as Promise<DesignerSnapshot>,
    resolveReviewThread: (thread: ReviewThreadResolutionInput) =>
      ipcRenderer.invoke('selene:designer:resolve-review-thread', thread) as Promise<DesignerSnapshot>,
    replyToReviewThread: (thread: ReviewThreadReplyInput) =>
      ipcRenderer.invoke('selene:designer:reply-review-thread', thread) as Promise<DesignerSnapshot>,
    addDeveloperAnnotation: (annotation: DeveloperAnnotationInput) =>
      ipcRenderer.invoke(
        'selene:designer:add-developer-annotation',
        annotation
      ) as Promise<DesignerSnapshot>,
    requestAIChange: (input: AIChangeRequestInput) =>
      ipcRenderer.invoke('selene:designer:request-ai-change', input) as Promise<DesignerSnapshot>,
    cancel: (requestId: string) => ipcRenderer.invoke('selene:designer:cancel', requestId),
    markReadyForReview: () =>
      ipcRenderer.invoke('selene:designer:mark-ready-for-review') as Promise<DesignerSnapshot>,
    markReadyForHandoff: () =>
      ipcRenderer.invoke('selene:designer:mark-ready-for-handoff') as Promise<DesignerSnapshot>,
    exportHandoff: () => ipcRenderer.invoke('selene:designer:export-handoff') as Promise<string>,
    workspaceCockpitPreferences: () => ipcRenderer.invoke('selene:designer:workspace-cockpit-preferences') as Promise<WorkspaceCockpitPreferences>,
    saveWorkspaceCockpitPreferences: (preferences: WorkspaceCockpitPreferences) => ipcRenderer.invoke('selene:designer:save-workspace-cockpit-preferences', preferences) as Promise<WorkspaceCockpitPreferences>,
    onProgress: (listener: (progress: DesignerProgress) => void) => {
      const callback = (_event: Electron.IpcRendererEvent, progress: DesignerProgress) =>
        listener(progress);
      ipcRenderer.on('selene:designer:progress', callback);
      return () => ipcRenderer.removeListener('selene:designer:progress', callback);
    }
  },
  preview: {
    build: (workspace: unknown) =>
      ipcRenderer.invoke('selene:preview-build', workspace) as Promise<PreviewBuildResult>,
    postMessage: (policy: PreviewPolicy, message: PreviewBridgeMessage) =>
      ipcRenderer.send('selene:preview-message', { policy, message })
  }
});
