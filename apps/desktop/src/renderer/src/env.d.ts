/// <reference types="vite/client" />

import type {
  AIChangeRequestInput,
  AIChangeUndoInput,
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
  RecentProject,
  ProjectOpenResult,
  ReviewThreadInput,
  ReviewThreadResolutionInput,
  ReviewThreadReplyInput,
  WorkspaceCockpitPreferences,
  GitHubPublishSetup
} from '../../shared/designer-api';
import type {
  CrashDiagnosticsExport,
  CrashRecoveryStatus,
  DiagnosticsConsent
} from '../../main/crash-diagnostics';
import { DESKTOP_PRELOAD_API_VERSION } from '../../shared/desktop-api';
import type { PreviewFrameMessage } from '../../shared/preview-channel';

declare global {
  interface Window {
    selene: {
      readonly apiVersion: typeof DESKTOP_PRELOAD_API_VERSION;
      readonly platform: string;
      readonly workspace: {
        resumeActiveProject(): Promise<ProjectOpenResult | undefined>;
        reload(): void;
      };
      readonly identity: {
        signIn(): Promise<
          | { readonly mode: 'local' }
          | {
              readonly mode: 'oidc';
              readonly subject: string;
              readonly email?: string;
              readonly name?: string;
            }
        >;
      };
      readonly diagnostics: {
        export(): Promise<CrashDiagnosticsExport>;
        delete(): Promise<void>;
        consent(): Promise<DiagnosticsConsent>;
        recovery(): Promise<CrashRecoveryStatus>;
        resetRecovery(): Promise<CrashRecoveryStatus>;
        setConsent(choice: 'granted' | 'denied'): Promise<DiagnosticsConsent>;
      };
      readonly designer: {
        readonly apiVersion: string;
        snapshot(): Promise<DesignerSnapshot>;
        selectAgent(agentId: string): Promise<DesignerSnapshot>;
        selectScenario(scenarioId: string): Promise<DesignerSnapshot>;
        selectNode(nodeId: string): Promise<DesignerSnapshot>;
        inspectDesignSystem(request: {
          readonly name: string;
          readonly version: string;
        }): Promise<DesignSystemIntakeReceipt>;
        setDesignSystemInputs(
          inputs: readonly import('../../shared/designer-api').DesignSystemInputSelection[]
        ): Promise<DesignerSnapshot>;
        setDesignLanguageInputs(
          inputs: readonly import('../../shared/designer-api').DesignLanguageInputSelection[]
        ): Promise<DesignerSnapshot>;
        ingestDesignLanguage(request: {
          readonly markdown: string;
        }): Promise<MarkdownIntakeReceipt>;
        chooseDesignLanguageToImport(request: {
          readonly projectId: string;
        }): Promise<readonly MarkdownIntakeReceipt[] | undefined>;
        refreshDesignLanguageSource(request: {
          readonly artifactDigest: string;
          readonly projectId: string;
        }): Promise<import('../../shared/designer-api').MarkdownSourceRefreshResult>;
        chooseDesignLanguageSourceToRelink(request: {
          readonly artifactDigest: string;
          readonly projectId: string;
        }): Promise<import('../../shared/designer-api').MarkdownSourceRefreshResult>;
        createProject(request: {
          readonly id: string;
          readonly name: string;
          readonly template: 'blank' | 'dashboard' | 'review';
        }): Promise<ProjectOpenResult>;
        chooseProjectToImport(): Promise<ProjectOpenResult | undefined>;
        listRecentProjects(): Promise<readonly RecentProject[]>;
        openProject(request: { readonly projectId: string }): Promise<ProjectOpenResult>;
        configureTrustedAgent(): Promise<readonly DesignerAgentSummary[]>;
        savePrototypeGraph(graph: unknown): Promise<DesignerSnapshot>;
        retryPrototypeGraphHydration(): Promise<DesignerSnapshot>;
        recoverPrototypeGraphFromFixture(): Promise<DesignerSnapshot>;
        setPrototypeMode(mode: 'edit' | 'run'): Promise<DesignerSnapshot>;
        startPrototypeScenario(
          request: import('../../shared/designer-api').PrototypeScenarioStartInput
        ): Promise<DesignerSnapshot>;
        runPrototypeAction(action: { nodeId: string; portId: string }): Promise<DesignerSnapshot>;
        resetPrototypeRun(): Promise<DesignerSnapshot>;
        publishGeneratedCode(request: DesignerPublishInput): Promise<GeneratedCodePublishStart>;
        requestGeneratedCodePublishConsent(
          request: DesignerPublishConsentInput
        ): Promise<{ readonly consentId: string }>;
        cancelGeneratedCodePublish(publishId: string): Promise<void>;
        generatedCodePublishOperation(publishId: string): Promise<GeneratedCodePublishOperation>;
        openGeneratedCodePublishReceipt(publishId: string): Promise<void>;
        githubPublishSetup(): Promise<GitHubPublishSetup>;
        addReviewThread(thread: ReviewThreadInput): Promise<DesignerSnapshot>;
        resolveReviewThread(thread: ReviewThreadResolutionInput): Promise<DesignerSnapshot>;
        replyToReviewThread(thread: ReviewThreadReplyInput): Promise<DesignerSnapshot>;
        addDeveloperAnnotation(annotation: DeveloperAnnotationInput): Promise<DesignerSnapshot>;
        requestAIChange(input: AIChangeRequestInput): Promise<DesignerSnapshot>;
        undoLastAIChange(input: AIChangeUndoInput): Promise<DesignerSnapshot>;
        cancel(requestId: string): Promise<void>;
        markReadyForReview(): Promise<DesignerSnapshot>;
        markReadyForHandoff(): Promise<DesignerSnapshot>;
        exportHandoff(): Promise<string>;
        workspaceCockpitPreferences(): Promise<WorkspaceCockpitPreferences>;
        saveWorkspaceCockpitPreferences(
          preferences: WorkspaceCockpitPreferences
        ): Promise<WorkspaceCockpitPreferences>;
        onProgress(listener: (progress: DesignerProgress) => void): () => void;
      };
      readonly preview: {
        build(workspace: unknown): Promise<{
          url: string;
          revisionId: string;
          policy: { origin: string; nonce: string; maxMessageBytes: number; csp: string };
        }>;
        postMessage(
          policy: { origin: string; nonce: string; maxMessageBytes: number; csp: string },
          message: PreviewFrameMessage
        ): void;
      };
    };
  }
}
