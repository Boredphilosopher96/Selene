import { contextBridge, ipcRenderer } from 'electron';

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
  platform: process.platform,
  preview: {
    build: (workspace: unknown) =>
      ipcRenderer.invoke('selene:preview-build', workspace) as Promise<PreviewBuildResult>,
    postMessage: (policy: PreviewPolicy, message: PreviewBridgeMessage) =>
      ipcRenderer.send('selene:preview-message', { policy, message })
  }
});
