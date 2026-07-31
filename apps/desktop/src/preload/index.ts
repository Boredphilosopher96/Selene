import { contextBridge, ipcRenderer } from 'electron';

import type {
  AIChangeRequestInput,
  AIChangeUndoInput,
  AIProposalDecisionInput,
  ManualDesignUndoInput,
  DesignerPublishConsentInput,
  DesignerPublishInput,
  GeneratedCodePublishOperation,
  GeneratedCodePublishStart,
  DeveloperAnnotationInput,
  DesignerProgress,
  DesignerSnapshot,
  DesignerAgentSummary,
  DesignSystemInputSelection,
  DesignSystemComponentInsertApplyRequest,
  DesignSystemComponentInsertCapabilityRequest,
  DesignLanguageInputSelection,
  DesignSystemIntakeReceipt,
  MarkdownIntakeReceipt,
  MarkdownSourceRefreshResult,
  ManualAppearanceEditApplyRequest,
  ManualAppearanceEditCapabilityRequest,
  ManualPositionEditApplyRequest,
  ManualPositionEditCapabilityRequest,
  ManualStructureEditApplyRequest,
  ManualStructureEditCapabilityRequest,
  ManualLayoutEditApplyRequest,
  ManualLayoutEditCapabilityRequest,
  ManualTextEditApplyRequest,
  ManualTextEditCapabilityRequest,
  RecentProject,
  ProjectOpenResult,
  ProductShellConfigurationInput,
  ReviewThreadInput,
  ReviewThreadResolutionInput,
  ReviewThreadReplyInput,
  WorkspaceCockpitPreferences,
  GitHubPublishSetup
} from '../shared/designer-api';
import { DESIGNER_API_VERSION } from '../shared/designer-api';
import type { PreviewFrameMessage } from '../shared/preview-channel';
import type {
  CrashDiagnosticsExport,
  CrashRecoveryStatus,
  DiagnosticsConsent
} from '../main/crash-diagnostics';
import { DESKTOP_PRELOAD_API_VERSION } from '../shared/desktop-api';

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

interface PreviewFrameDescriptor extends PreviewBuildResult {
  readonly screenId: string;
  readonly projectId: string;
}

contextBridge.exposeInMainWorld('selene', {
  apiVersion: DESKTOP_PRELOAD_API_VERSION,
  platform: process.platform,
  workspace: {
    resumeActiveProject: () =>
      ipcRenderer.invoke('selene:workspace:resume-active-project') as Promise<
        ProjectOpenResult | undefined
      >,
    reload: () => ipcRenderer.send('selene:workspace:reload')
  },
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
      ipcRenderer.invoke(
        'selene:designer:inspect-design-system',
        request
      ) as Promise<DesignSystemIntakeReceipt>,
    setDesignSystemInputs: (inputs: readonly DesignSystemInputSelection[]) =>
      ipcRenderer.invoke('selene:designer:set-design-system-inputs', {
        inputs
      }) as Promise<DesignerSnapshot>,
    setDesignLanguageInputs: (inputs: readonly DesignLanguageInputSelection[]) =>
      ipcRenderer.invoke('selene:designer:set-design-language-inputs', {
        inputs
      }) as Promise<DesignerSnapshot>,
    ingestDesignLanguage: (request: { readonly markdown: string }) =>
      ipcRenderer.invoke(
        'selene:designer:ingest-design-language',
        request
      ) as Promise<MarkdownIntakeReceipt>,
    chooseDesignLanguageToImport: (request: { readonly projectId: string }) =>
      ipcRenderer.invoke('selene:designer:choose-design-language-to-import', request) as Promise<
        readonly MarkdownIntakeReceipt[] | undefined
      >,
    refreshDesignLanguageSource: (request: {
      readonly artifactDigest: string;
      readonly projectId: string;
    }) =>
      ipcRenderer.invoke(
        'selene:designer:refresh-design-language-source',
        request
      ) as Promise<MarkdownSourceRefreshResult>,
    chooseDesignLanguageSourceToRelink: (request: {
      readonly artifactDigest: string;
      readonly projectId: string;
    }) =>
      ipcRenderer.invoke(
        'selene:designer:choose-design-language-source-to-relink',
        request
      ) as Promise<MarkdownSourceRefreshResult>,
    createProject: (request: {
      readonly id: string;
      readonly name: string;
      readonly template: 'blank' | 'dashboard' | 'review';
    }) =>
      ipcRenderer.invoke('selene:designer:create-project', request) as Promise<ProjectOpenResult>,
    chooseProjectToImport: () =>
      ipcRenderer.invoke('selene:designer:choose-project-to-import') as Promise<
        ProjectOpenResult | undefined
      >,
    listRecentProjects: () =>
      ipcRenderer.invoke('selene:designer:list-recent-projects') as Promise<
        readonly RecentProject[]
      >,
    openProject: (request: { readonly projectId: string }) =>
      ipcRenderer.invoke('selene:designer:open-project', request) as Promise<ProjectOpenResult>,
    configureTrustedAgent: () =>
      ipcRenderer.invoke('selene:designer:configure-trusted-agent') as Promise<
        readonly DesignerAgentSummary[]
      >,
    savePrototypeGraph: (graph: unknown) =>
      ipcRenderer.invoke(
        'selene:designer:save-prototype-graph',
        graph
      ) as Promise<DesignerSnapshot>,
    retryPrototypeGraphHydration: () =>
      ipcRenderer.invoke(
        'selene:designer:retry-prototype-graph-hydration'
      ) as Promise<DesignerSnapshot>,
    recoverPrototypeGraphFromFixture: () =>
      ipcRenderer.invoke(
        'selene:designer:recover-prototype-graph-from-fixture'
      ) as Promise<DesignerSnapshot>,
    setPrototypeMode: (mode: 'edit' | 'run') =>
      ipcRenderer.invoke('selene:designer:set-prototype-mode', mode) as Promise<DesignerSnapshot>,
    startPrototypeScenario: (
      request: import('../shared/designer-api').PrototypeScenarioStartInput
    ) =>
      ipcRenderer.invoke(
        'selene:designer:start-prototype-scenario',
        request
      ) as Promise<DesignerSnapshot>,
    runPrototypeAction: (action: { nodeId: string; portId: string }) =>
      ipcRenderer.invoke(
        'selene:designer:run-prototype-action',
        action
      ) as Promise<DesignerSnapshot>,
    resetPrototypeRun: () =>
      ipcRenderer.invoke('selene:designer:reset-prototype-run') as Promise<DesignerSnapshot>,
    publishGeneratedCode: (request: DesignerPublishInput) =>
      ipcRenderer.invoke(
        'selene:designer:publish-generated-code',
        request
      ) as Promise<GeneratedCodePublishStart>,
    requestGeneratedCodePublishConsent: (request: DesignerPublishConsentInput) =>
      ipcRenderer.invoke('selene:designer:request-publish-consent', request) as Promise<{
        readonly consentId: string;
      }>,
    cancelGeneratedCodePublish: (publishId: string) =>
      ipcRenderer.invoke(
        'selene:designer:cancel-generated-code-publish',
        publishId
      ) as Promise<void>,
    generatedCodePublishOperation: (publishId: string) =>
      ipcRenderer.invoke(
        'selene:designer:publish-operation',
        publishId
      ) as Promise<GeneratedCodePublishOperation>,
    openGeneratedCodePublishReceipt: (publishId: string) =>
      ipcRenderer.invoke('selene:designer:open-publish-receipt', publishId) as Promise<void>,
    githubPublishSetup: () =>
      ipcRenderer.invoke('selene:designer:github-publish-setup') as Promise<GitHubPublishSetup>,
    addReviewThread: (thread: ReviewThreadInput) =>
      ipcRenderer.invoke('selene:designer:add-review-thread', thread) as Promise<DesignerSnapshot>,
    resolveReviewThread: (thread: ReviewThreadResolutionInput) =>
      ipcRenderer.invoke(
        'selene:designer:resolve-review-thread',
        thread
      ) as Promise<DesignerSnapshot>,
    replyToReviewThread: (thread: ReviewThreadReplyInput) =>
      ipcRenderer.invoke(
        'selene:designer:reply-review-thread',
        thread
      ) as Promise<DesignerSnapshot>,
    addDeveloperAnnotation: (annotation: DeveloperAnnotationInput) =>
      ipcRenderer.invoke(
        'selene:designer:add-developer-annotation',
        annotation
      ) as Promise<DesignerSnapshot>,
    requestAIChange: (input: AIChangeRequestInput) =>
      ipcRenderer.invoke('selene:designer:request-ai-change', input) as Promise<DesignerSnapshot>,
    acceptAIProposal: (input: AIProposalDecisionInput) =>
      ipcRenderer.invoke('selene:designer:accept-ai-proposal', input) as Promise<DesignerSnapshot>,
    rejectAIProposal: (input: AIProposalDecisionInput) =>
      ipcRenderer.invoke('selene:designer:reject-ai-proposal', input) as Promise<DesignerSnapshot>,
    requestManualTextEditCapability: (input: ManualTextEditCapabilityRequest) =>
      ipcRenderer.invoke('selene:designer:request-manual-text-edit-capability', input) as Promise<
        | import('../shared/designer-api').ManualTextEditCapability
        | import('../shared/designer-api').ManualTextEditUnavailable
      >,
    applyManualTextEdit: (input: ManualTextEditApplyRequest) =>
      ipcRenderer.invoke('selene:designer:apply-manual-text-edit', input) as Promise<
        import('@selene/core').DesignEditResult
      >,
    requestManualLayoutEditCapability: (input: ManualLayoutEditCapabilityRequest) =>
      ipcRenderer.invoke('selene:designer:request-manual-layout-edit-capability', input) as Promise<
        | import('../shared/designer-api').ManualLayoutEditCapability
        | import('../shared/designer-api').ManualLayoutEditUnavailable
      >,
    applyManualLayoutEdit: (input: ManualLayoutEditApplyRequest) =>
      ipcRenderer.invoke('selene:designer:apply-manual-layout-edit', input) as Promise<
        import('@selene/core').DesignEditResult
      >,
    requestManualAppearanceEditCapability: (input: ManualAppearanceEditCapabilityRequest) =>
      ipcRenderer.invoke(
        'selene:designer:request-manual-appearance-edit-capability',
        input
      ) as Promise<
        | import('../shared/designer-api').ManualAppearanceEditCapability
        | import('../shared/designer-api').ManualAppearanceEditUnavailable
      >,
    applyManualAppearanceEdit: (input: ManualAppearanceEditApplyRequest) =>
      ipcRenderer.invoke('selene:designer:apply-manual-appearance-edit', input) as Promise<
        import('@selene/core').DesignEditResult
      >,
    requestManualPositionEditCapability: (input: ManualPositionEditCapabilityRequest) =>
      ipcRenderer.invoke(
        'selene:designer:request-manual-position-edit-capability',
        input
      ) as Promise<
        | import('../shared/designer-api').ManualPositionEditCapability
        | import('../shared/designer-api').ManualPositionEditUnavailable
      >,
    applyManualPositionEdit: (input: ManualPositionEditApplyRequest) =>
      ipcRenderer.invoke('selene:designer:apply-manual-position-edit', input) as Promise<
        import('@selene/core').DesignEditResult
      >,
    requestManualStructureEditCapability: (input: ManualStructureEditCapabilityRequest) =>
      ipcRenderer.invoke(
        'selene:designer:request-manual-structure-edit-capability',
        input
      ) as Promise<
        | import('../shared/designer-api').ManualStructureEditCapability
        | import('../shared/designer-api').ManualStructureEditUnavailable
      >,
    applyManualStructureEdit: (input: ManualStructureEditApplyRequest) =>
      ipcRenderer.invoke('selene:designer:apply-manual-structure-edit', input) as Promise<
        import('@selene/core').DesignEditResult
      >,
    requestDesignSystemComponentInsertCapability: (
      input: DesignSystemComponentInsertCapabilityRequest
    ) =>
      ipcRenderer.invoke(
        'selene:designer:request-design-system-component-insert-capability',
        input
      ) as Promise<
        | import('../shared/designer-api').DesignSystemComponentInsertCapability
        | import('../shared/designer-api').DesignSystemComponentInsertUnavailable
      >,
    applyDesignSystemComponentInsert: (input: DesignSystemComponentInsertApplyRequest) =>
      ipcRenderer.invoke('selene:designer:apply-design-system-component-insert', input) as Promise<
        import('@selene/core').DesignEditResult
      >,
    undoLastAIChange: (input: AIChangeUndoInput) =>
      ipcRenderer.invoke('selene:designer:undo-last-ai-change', input) as Promise<DesignerSnapshot>,
    undoLatestManualDesignEdit: (input: ManualDesignUndoInput) =>
      ipcRenderer.invoke(
        'selene:designer:undo-latest-manual-design-edit',
        input
      ) as Promise<DesignerSnapshot>,
    cancel: (requestId: string) => ipcRenderer.invoke('selene:designer:cancel', requestId),
    configureProductShell: (input: ProductShellConfigurationInput) =>
      ipcRenderer.invoke(
        'selene:designer:configure-product-shell',
        input
      ) as Promise<DesignerSnapshot>,
    markReadyForReview: () =>
      ipcRenderer.invoke('selene:designer:mark-ready-for-review') as Promise<DesignerSnapshot>,
    markReadyForHandoff: () =>
      ipcRenderer.invoke('selene:designer:mark-ready-for-handoff') as Promise<DesignerSnapshot>,
    exportHandoff: () => ipcRenderer.invoke('selene:designer:export-handoff') as Promise<string>,
    exportProductHandoff: () =>
      ipcRenderer.invoke('selene:designer:export-product-handoff') as Promise<string>,
    workspaceCockpitPreferences: () =>
      ipcRenderer.invoke(
        'selene:designer:workspace-cockpit-preferences'
      ) as Promise<WorkspaceCockpitPreferences>,
    saveWorkspaceCockpitPreferences: (preferences: WorkspaceCockpitPreferences) =>
      ipcRenderer.invoke(
        'selene:designer:save-workspace-cockpit-preferences',
        preferences
      ) as Promise<WorkspaceCockpitPreferences>,
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
    buildAIProposal: (input: AIProposalDecisionInput) =>
      ipcRenderer.invoke('selene:preview-build-ai-proposal', input) as Promise<PreviewBuildResult>,
    describe: (policy: PreviewPolicy, screenId: string, projectId: string) =>
      ipcRenderer.invoke(
        'selene:preview-descriptor',
        policy,
        screenId,
        projectId
      ) as Promise<PreviewFrameDescriptor>,
    postMessage: (policy: PreviewPolicy, message: PreviewFrameMessage) =>
      ipcRenderer.send('selene:preview-message', { policy, message })
  }
});
