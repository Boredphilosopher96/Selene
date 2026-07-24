/** Typed, bounded transport for an untrusted renderer-hosted preview frame. */
export const PREVIEW_MESSAGE_TYPES = ['ready', 'select-node', 'rendered', 'runtime-error'] as const;
export type PreviewMessageType = (typeof PREVIEW_MESSAGE_TYPES)[number];

export interface PreviewMessage {
  readonly type: PreviewMessageType;
  readonly nonce: string;
  readonly origin: string;
  readonly revisionId: string;
  readonly nodeId?: string;
  readonly message?: string;
}

export interface PreviewSecurityPolicy {
  readonly origin: string;
  readonly nonce: string;
  readonly maxMessageBytes: number;
  readonly csp: string;
}

export class PreviewMessageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PreviewMessageError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodedMessageBytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') throw new Error('Message cannot be serialized');
    return new TextEncoder().encode(encoded).byteLength;
  } catch {
    throw new PreviewMessageError('Preview message must be JSON-serializable');
  }
}

/** The frame permits only its nonce-bound bootstrap script; no network or Node capability is granted. */
export function createPreviewSecurityPolicy(
  origin: string,
  nonce: string,
  maxMessageBytes = 16 * 1024
): PreviewSecurityPolicy {
  if (!/^selene-preview:\/\/[a-z0-9-]+$/i.test(origin))
    throw new PreviewMessageError('Preview origin must use the selene-preview scheme');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce))
    throw new PreviewMessageError('Preview nonce is invalid');
  if (
    !Number.isSafeInteger(maxMessageBytes) ||
    maxMessageBytes < 256 ||
    maxMessageBytes > 64 * 1024
  )
    throw new PreviewMessageError('Preview message limit is invalid');
  return {
    origin,
    nonce,
    maxMessageBytes,
    csp: `default-src 'none'; base-uri 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; form-action 'none'`
  };
}

/** Rejects spoofed origins/nonces, oversized payloads, and non-string user-controlled fields. */
export function validatePreviewMessage(
  value: unknown,
  policy: PreviewSecurityPolicy
): PreviewMessage {
  const bytes = encodedMessageBytes(value);
  if (bytes > policy.maxMessageBytes)
    throw new PreviewMessageError('Preview message exceeds size limit');
  if (!isRecord(value) || !PREVIEW_MESSAGE_TYPES.includes(value.type as PreviewMessageType))
    throw new PreviewMessageError('Unknown preview message');
  if (value.nonce !== policy.nonce || value.origin !== policy.origin)
    throw new PreviewMessageError('Preview message origin or nonce mismatch');
  if (
    typeof value.revisionId !== 'string' ||
    value.revisionId.length === 0 ||
    value.revisionId.length > 128
  )
    throw new PreviewMessageError('Preview revision is invalid');
  if (value.nodeId !== undefined && (typeof value.nodeId !== 'string' || value.nodeId.length > 128))
    throw new PreviewMessageError('Preview node ID is invalid');
  if (
    value.message !== undefined &&
    (typeof value.message !== 'string' || value.message.length > 4_000)
  )
    throw new PreviewMessageError('Preview message text is invalid');
  if (value.type === 'select-node' && value.nodeId === undefined)
    throw new PreviewMessageError('Node selection must include a node ID');
  if (value.type === 'runtime-error' && value.message === undefined)
    throw new PreviewMessageError('Runtime errors must include a message');
  return {
    type: value.type as PreviewMessageType,
    nonce: value.nonce as string,
    origin: value.origin as string,
    revisionId: value.revisionId as string,
    ...(value.nodeId === undefined ? {} : { nodeId: value.nodeId as string }),
    ...(value.message === undefined ? {} : { message: value.message as string })
  };
}

interface PreviewArtifact {
  readonly revisionId: string;
  readonly code: string;
  readonly css?: string;
}

function escapeInline(value: string, closingTag: string): string {
  return value.replace(new RegExp(`</${closingTag}`, 'gi'), `<\\/${closingTag}`);
}

/**
 * The compiled bundle executes only in this sandboxed frame. The bootstrap
 * turns DOM clicks into opaque node IDs; parent code verifies source + nonce
 * before forwarding the typed message across Electron IPC.
 */
export function createPreviewDocument(
  policy: PreviewSecurityPolicy,
  artifact: PreviewArtifact
): string {
  const escapedCsp = policy.csp.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const report = `(type,extra={})=>window.parent.postMessage({type,nonce:${JSON.stringify(policy.nonce)},origin:${JSON.stringify(policy.origin)},revisionId:${JSON.stringify(artifact.revisionId)},...extra},'*');`;
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapedCsp}"><style>${escapeInline(artifact.css ?? '', 'style')}</style><div id="root"></div><script nonce="${policy.nonce}">${report}window.addEventListener('error',e=>report('runtime-error',{message:String(e.message).slice(0,4000)}));document.addEventListener('click',e=>{const node=e.target instanceof Element?e.target.closest('[data-selene-node-id]'):null;if(node)report('select-node',{nodeId:node.getAttribute('data-selene-node-id')||undefined})});report('ready');</script><script type="module" nonce="${policy.nonce}">${escapeInline(artifact.code, 'script')}</script>`;
}

export interface PublishedPreview {
  readonly url: string;
  readonly policy: PreviewSecurityPolicy;
  readonly revisionId: string;
}

/** Bounded protocol-backed artifact store. It serves generated code only to a sandboxed custom origin. */
export class PreviewArtifactRegistry {
  private readonly previews = new Map<
    string,
    { readonly policy: PreviewSecurityPolicy; readonly artifact: PreviewArtifact }
  >();

  public publish(
    id: string,
    policy: PreviewSecurityPolicy,
    artifact: PreviewArtifact
  ): PublishedPreview {
    this.previews.set(id, { policy, artifact });
    while (this.previews.size > 8)
      this.previews.delete(this.previews.keys().next().value as string);
    return {
      url: `selene-preview://local/${encodeURIComponent(id)}`,
      policy,
      revisionId: artifact.revisionId
    };
  }

  /**
   * A policy may only be used for an artifact this registry published. This
   * prevents a renderer from fabricating an unrelated policy/revision pair
   * before its message reaches Electron's privileged process.
   */
  public validatePublishedMessage(policy: PreviewSecurityPolicy, value: unknown): PreviewMessage {
    const message = validatePreviewMessage(value, policy);
    const published = [...this.previews.values()].some(
      (entry) =>
        entry.artifact.revisionId === message.revisionId &&
        entry.policy.origin === policy.origin &&
        entry.policy.nonce === policy.nonce &&
        entry.policy.maxMessageBytes === policy.maxMessageBytes &&
        entry.policy.csp === policy.csp
    );
    if (!published) throw new PreviewMessageError('Preview policy is not published');
    return message;
  }

  public async handle(url: string): Promise<Response> {
    const parsed = new URL(url);
    const entry =
      parsed.protocol === 'selene-preview:' && parsed.hostname === 'local'
        ? this.previews.get(decodeURIComponent(parsed.pathname.slice(1)))
        : undefined;
    if (entry === undefined) return new Response('Preview not found', { status: 404 });
    return new Response(createPreviewDocument(entry.policy, entry.artifact), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
}
