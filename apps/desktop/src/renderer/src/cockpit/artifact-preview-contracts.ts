import type { RefObject } from 'react';

import type { ReviewThread, SpatialTargetInput } from '../../../shared/designer-api';

/** Host-issued build identity consumed by the unified canvas artifact only. */
export interface PreviewBuild {
  readonly url: string;
  readonly revisionId: string;
  readonly policy?: {
    readonly origin: string;
    readonly nonce: string;
    readonly maxMessageBytes: number;
    readonly csp: string;
  };
}

/** A durable discussion pin; its geometry never grants Inspect or AI authority. */
export interface ArtifactPin {
  readonly id: string;
  readonly label: string;
  readonly anchor: SpatialTargetInput;
}

/** Shared contract for the single unified canvas artifact surface. */
export interface ArtifactPreviewContract {
  readonly build?: PreviewBuild;
  readonly frame: RefObject<HTMLIFrameElement | null>;
  readonly onFrameLoad: (frame: HTMLIFrameElement) => void;
  readonly onFrameError: (frame: HTMLIFrameElement) => void;
  /** Parent-side fail-closed revocation before a preview gesture resolves. */
  readonly onFramePointerDown: () => void;
  readonly pins: readonly ArtifactPin[];
  readonly selectedPinId?: string;
  readonly onSelectPin: (id: string, invoking: HTMLButtonElement) => void;
  readonly selectedThread?: ReviewThread;
  readonly replyBody: string;
  readonly threadAction: 'idle' | 'replying' | 'resolving';
  readonly threadStatus: string;
  readonly onReplyBodyChange: (body: string) => void;
  readonly onReplyThread: (id: string, body: string) => Promise<void>;
  readonly onResolveThread: (id: string, resolved: boolean) => Promise<void>;
  readonly onCloseThread: () => void;
}
