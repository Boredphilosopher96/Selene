import { contextBridge, ipcRenderer } from 'electron';

import type {
  AIChangeRequestInput,
  DeveloperAnnotationInput,
  DesignerProgress,
  DesignerSnapshot,
  ReviewThreadInput
} from '../shared/designer-api';

interface PreviewBridgeMessage {
  readonly type: 'ready' | 'select-node' | 'rendered' | 'runtime-error';
  readonly nonce: string;
  readonly origin: string;
  readonly revisionId: string;
  readonly nodeId?: string;
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
  designer: {
    apiVersion: 'selene-desktop-designer/v1',
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
    addReviewThread: (thread: ReviewThreadInput) =>
      ipcRenderer.invoke('selene:designer:add-review-thread', thread) as Promise<DesignerSnapshot>,
    addDeveloperAnnotation: (annotation: DeveloperAnnotationInput) =>
      ipcRenderer.invoke(
        'selene:designer:add-developer-annotation',
        annotation
      ) as Promise<DesignerSnapshot>,
    requestAIChange: (input: AIChangeRequestInput) =>
      ipcRenderer.invoke('selene:designer:request-ai-change', input) as Promise<DesignerSnapshot>,
    cancel: (requestId: string) => ipcRenderer.invoke('selene:designer:cancel', requestId),
    markReady: () => ipcRenderer.invoke('selene:designer:mark-ready') as Promise<DesignerSnapshot>,
    exportHandoff: () => ipcRenderer.invoke('selene:designer:export-handoff') as Promise<string>,
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
