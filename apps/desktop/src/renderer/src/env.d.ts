/// <reference types="vite/client" />

interface Window {
  selene: {
    readonly platform: string;
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
          message?: string;
        }
      ): void;
    };
  };
}
