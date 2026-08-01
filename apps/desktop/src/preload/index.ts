import { contextBridge, ipcRenderer } from 'electron';

import type {
  AIChangeRequestInput,
  ArtifactSelectionReceipt,
  ArtifactSelectionReceiptRequest,
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
  DesignSystemComponentReplaceApplyRequest,
  DesignSystemComponentReplaceCapabilityRequest,
  DesignSystemComponentPropertyEditApplyRequest,
  DesignSystemComponentPropertyEditCapabilityRequest,
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
  PreviewBuildResult,
  PreviewBuildTicket,
  ProductShellConfigurationInput,
  ReviewThreadInput,
  ReviewThreadResolutionInput,
  ReviewThreadReplyInput,
  StoryPreviewBuildResult,
  StoryPreviewTicket,
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

interface PublishedPreviewResult {
  readonly url: string;
  readonly policy: PreviewPolicy;
  readonly revisionId: string;
}

interface PreviewFrameDescriptor extends PublishedPreviewResult {
  readonly screenId: string;
  readonly projectId: string;
}

interface NativePreviewSelectionBridge {
  readonly nonce: string;
  readonly origin: string;
  readonly receiptId: string;
  readonly revisionId: string;
  readonly x: number;
  readonly y: number;
}

type NativePreviewInputResponse =
  | { readonly ok: true; readonly bridge: NativePreviewSelectionBridge }
  | {
      readonly ok: false;
      readonly reason: 'frame' | 'input' | 'preview' | 'point' | 'internal';
    };

const nativeDocumentAddEventListener = document.addEventListener.bind(document);
const nativeDocumentCreateElement = document.createElement.bind(document);
const nativeDocumentElementFromPoint = document.elementFromPoint.bind(document);
const nativeDocumentQuerySelectorAll = document.querySelectorAll.bind(document);
const nativeFramePostMessage = Window.prototype.postMessage;
const nativeFrameBounds = Element.prototype.getBoundingClientRect;
const nativeFrameClosest = Element.prototype.closest;
const nativeElementAppendChild = Node.prototype.appendChild;
const nativeEventPreventDefault = Event.prototype.preventDefault;
const nativeEventStopImmediatePropagation = Event.prototype.stopImmediatePropagation;
const nativeReflectApply = Reflect.apply;
const nativeNow = performance.now.bind(performance);
const NativeMutationObserver = MutationObserver;

interface NativePointerSequence {
  readonly frame: HTMLIFrameElement;
  readonly pointerId: number;
  readonly until: number;
  readonly x: number;
  readonly y: number;
}

let activeNativePreviewFrame: HTMLIFrameElement | undefined;
let nativeInputBridge: HTMLDivElement | undefined;
let nativePointerSequence: NativePointerSequence | undefined;

function setNativeInputBridgeState(state: string): void {
  nativeInputBridge?.setAttribute('data-selene-native-input-state', state);
}

function activeDesignPreviewFrame(): HTMLIFrameElement | undefined {
  for (const candidate of nativeDocumentQuerySelectorAll(
    'iframe[title="Generated React preview frame"]'
  )) {
    if (!(candidate instanceof HTMLIFrameElement)) continue;
    if (nativeFrameClosest.call(candidate, '.canvas-artboard--active[data-mode="design"]') !== null)
      return candidate;
  }
  return undefined;
}

/**
 * An isolated-world-only capture surface addresses Electron's transformed-frame
 * compositor bug. It has no renderer API and covers precisely the active
 * Design-mode iframe; existing higher-z canvas controls remain interactive.
 */
function synchronizeNativeInputBridge(): void {
  const frame = activeDesignPreviewFrame();
  const container = frame?.parentElement;
  if (frame === undefined || container === null || container === undefined) {
    activeNativePreviewFrame = undefined;
    nativeInputBridge?.setAttribute('hidden', '');
    return;
  }
  if (nativeInputBridge === undefined) {
    nativeInputBridge = nativeDocumentCreateElement('div');
    nativeInputBridge.setAttribute('aria-hidden', 'true');
    nativeInputBridge.setAttribute('data-selene-native-input-bridge', '');
    nativeInputBridge.setAttribute('data-selene-native-input-state', 'ready');
    nativeInputBridge.style.cssText =
      'position:absolute;z-index:3;inset:0;pointer-events:auto;background:transparent;border:0;margin:0;padding:0;touch-action:auto;';
  }
  if (nativeInputBridge.parentElement !== container)
    nativeElementAppendChild.call(container, nativeInputBridge);
  nativeInputBridge.removeAttribute('hidden');
  activeNativePreviewFrame = frame;
}

function startNativeInputBridge(): void {
  synchronizeNativeInputBridge();
  new NativeMutationObserver(synchronizeNativeInputBridge).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-mode', 'src'],
    childList: true,
    subtree: true
  });
}

function matchedNativePreviewFrame(event: PointerEvent): HTMLIFrameElement | undefined {
  synchronizeNativeInputBridge();
  const frame = activeNativePreviewFrame;
  if (frame === undefined || nativeInputBridge === undefined) return undefined;
  const bounds = nativeFrameBounds.call(frame);
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.left + bounds.width ||
    event.clientY < bounds.top ||
    event.clientY > bounds.top + bounds.height
  )
    return undefined;
  const hit = nativeDocumentElementFromPoint(event.clientX, event.clientY);
  return hit === nativeInputBridge || hit === frame ? frame : undefined;
}

function suppressNativeSequence(event: Event): void {
  nativeEventPreventDefault.call(event);
  nativeEventStopImmediatePropagation.call(event);
}

/** This stays in Electron's isolated preload world, outside the renderer API. */
nativeDocumentAddEventListener(
  'pointerdown',
  (event: PointerEvent) => {
    if (!event.isTrusted || !event.isPrimary || event.button !== 0) return;
    const frame = matchedNativePreviewFrame(event);
    if (frame === undefined) return;
    suppressNativeSequence(event);
    setNativeInputBridgeState('requesting');
    const bounds = nativeFrameBounds.call(frame);
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return;
    nativePointerSequence = {
      frame,
      pointerId: event.pointerId,
      until: nativeNow() + 1_000,
      x: event.clientX,
      y: event.clientY
    };
    const previewUrl = frame.src;
    void ipcRenderer
      .invoke('selene:preview-native-input', previewUrl, x, y)
      .then((response: NativePreviewInputResponse) => {
        if (typeof response !== 'object' || response === null || response.ok !== true) {
          const reason =
            typeof response === 'object' &&
            response !== null &&
            response.ok === false &&
            typeof response.reason === 'string'
              ? response.reason
              : 'internal';
          setNativeInputBridgeState(`rejected-${reason}`);
          return;
        }
        const bridge = response.bridge;
        if (
          typeof bridge !== 'object' ||
          bridge === null ||
          bridge.origin !== 'selene-preview://local' ||
          typeof bridge.nonce !== 'string' ||
          typeof bridge.receiptId !== 'string' ||
          typeof bridge.revisionId !== 'string' ||
          bridge.x !== x ||
          bridge.y !== y ||
          frame !== activeNativePreviewFrame ||
          frame.contentWindow === null
        ) {
          setNativeInputBridgeState('invalid-response');
          return;
        }
        try {
          nativeReflectApply(nativeFramePostMessage, frame.contentWindow, [
            {
              type: 'selene-preview-native-selection',
              nonce: bridge.nonce,
              receiptId: bridge.receiptId,
              revisionId: bridge.revisionId,
              x: bridge.x,
              y: bridge.y
            },
            bridge.origin
          ]);
          setNativeInputBridgeState('posted');
        } catch {
          setNativeInputBridgeState('rejected-post');
        }
      })
      .catch(() => setNativeInputBridgeState('rejected-transport'));
  },
  true
);
nativeDocumentAddEventListener(
  'pointerup',
  (event: PointerEvent) => {
    const sequence = nativePointerSequence;
    if (
      sequence === undefined ||
      !event.isTrusted ||
      event.pointerId !== sequence.pointerId ||
      nativeNow() > sequence.until
    )
      return;
    suppressNativeSequence(event);
  },
  true
);
nativeDocumentAddEventListener(
  'pointercancel',
  (event: PointerEvent) => {
    if (nativePointerSequence?.pointerId === event.pointerId) nativePointerSequence = undefined;
  },
  true
);
nativeDocumentAddEventListener(
  'click',
  (event: MouseEvent) => {
    const sequence = nativePointerSequence;
    if (
      sequence === undefined ||
      !event.isTrusted ||
      nativeNow() > sequence.until ||
      Math.abs(event.clientX - sequence.x) > 2 ||
      Math.abs(event.clientY - sequence.y) > 2
    )
      return;
    nativePointerSequence = undefined;
    suppressNativeSequence(event);
  },
  true
);
nativeDocumentAddEventListener('DOMContentLoaded', startNativeInputBridge, { once: true });
if (document.readyState !== 'loading') startNativeInputBridge();

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
    clearSelectedNode: () =>
      ipcRenderer.invoke('selene:designer:clear-selected-node') as Promise<DesignerSnapshot>,
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
    mintArtifactSelectionReceipt: (request: ArtifactSelectionReceiptRequest) =>
      ipcRenderer.invoke(
        'selene:designer:mint-artifact-selection-receipt',
        request
      ) as Promise<ArtifactSelectionReceipt>,
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
    requestDesignSystemComponentReplaceCapability: (
      input: DesignSystemComponentReplaceCapabilityRequest
    ) =>
      ipcRenderer.invoke(
        'selene:designer:request-design-system-component-replace-capability',
        input
      ) as Promise<
        | import('../shared/designer-api').DesignSystemComponentReplaceCapability
        | import('../shared/designer-api').DesignSystemComponentReplaceUnavailable
      >,
    applyDesignSystemComponentReplace: (input: DesignSystemComponentReplaceApplyRequest) =>
      ipcRenderer.invoke('selene:designer:apply-design-system-component-replace', input) as Promise<
        import('@selene/core').DesignEditResult
      >,
    requestDesignSystemComponentPropertyEditCapability: (
      input: DesignSystemComponentPropertyEditCapabilityRequest
    ) =>
      ipcRenderer.invoke(
        'selene:designer:request-design-system-component-property-edit-capability',
        input
      ) as Promise<
        | import('../shared/designer-api').DesignSystemComponentPropertyEditCapability
        | import('../shared/designer-api').DesignSystemComponentPropertyEditUnavailable
      >,
    applyDesignSystemComponentPropertyEdit: (
      input: DesignSystemComponentPropertyEditApplyRequest
    ) =>
      ipcRenderer.invoke(
        'selene:designer:apply-design-system-component-property-edit',
        input
      ) as Promise<import('@selene/core').DesignEditResult>,
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
    build: (ticket: PreviewBuildTicket) =>
      ipcRenderer.invoke('selene:preview-build', ticket) as Promise<PreviewBuildResult>,
    buildAIProposal: (input: AIProposalDecisionInput) =>
      ipcRenderer.invoke(
        'selene:preview-build-ai-proposal',
        input
      ) as Promise<PublishedPreviewResult>,
    buildStory: (ticket: StoryPreviewTicket) =>
      ipcRenderer.invoke('selene:story-preview-build', ticket) as Promise<StoryPreviewBuildResult>,
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
