/// <reference types="vite/client" />

import type {
  AIChangeRequestInput,
  ArtifactPinInput,
  DesignerPublishInput,
  GeneratedCodePublishOperation,
  GeneratedCodePublishStart,
  DeveloperAnnotationInput,
  DesignerProgress,
  DesignerSnapshot,
  ReviewThreadInput
} from '../../shared/designer-api';
import type {
  CrashDiagnosticsExport,
  CrashRecoveryStatus,
  DiagnosticsConsent
} from '../../main/crash-diagnostics';

declare global {
  interface Window {
    selene: {
      readonly apiVersion: 'selene-desktop-preload/v1';
      readonly platform: string;
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
        savePrototypeGraph(graph: unknown): Promise<DesignerSnapshot>;
        setPrototypeMode(mode: 'edit' | 'run'): Promise<DesignerSnapshot>;
        runPrototypeAction(action: { nodeId: string; portId: string }): Promise<DesignerSnapshot>;
        resetPrototypeRun(): Promise<DesignerSnapshot>;
        publishGeneratedCode(request: DesignerPublishInput): Promise<GeneratedCodePublishStart>;
        requestGeneratedCodePublishConsent(request: Omit<DesignerPublishInput, 'consentId'>): Promise<{ readonly consentId: string }>;
        cancelGeneratedCodePublish(publishId: string): Promise<void>;
        generatedCodePublishOperation(publishId: string): Promise<GeneratedCodePublishOperation>;
        addReviewThread(thread: ReviewThreadInput): Promise<DesignerSnapshot>;
        addArtifactPin(pin: ArtifactPinInput): Promise<DesignerSnapshot>;
        addDeveloperAnnotation(annotation: DeveloperAnnotationInput): Promise<DesignerSnapshot>;
        requestAIChange(input: AIChangeRequestInput): Promise<DesignerSnapshot>;
        cancel(requestId: string): Promise<void>;
        markReadyForReview(): Promise<DesignerSnapshot>;
        markReadyForHandoff(): Promise<DesignerSnapshot>;
        exportHandoff(): Promise<string>;
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
          message: {
            type: 'ready' | 'select-node' | 'rendered' | 'runtime-error';
            nonce: string;
            origin: string;
            revisionId: string;
            nodeId?: string;
            portId?: string;
            message?: string;
          }
        ): void;
      };
    };
  }
}
