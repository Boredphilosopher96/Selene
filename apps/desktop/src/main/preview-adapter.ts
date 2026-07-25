/** Typed, bounded transport for an untrusted renderer-hosted preview frame. */
export const PREVIEW_MESSAGE_TYPES = ['ready', 'select-node', 'trigger-action', 'rendered', 'runtime-error'] as const;
export type PreviewMessageType = (typeof PREVIEW_MESSAGE_TYPES)[number];

export interface PreviewMessage {
  readonly type: PreviewMessageType;
  readonly nonce: string;
  readonly origin: string;
  readonly revisionId: string;
  readonly nodeId?: string;
  readonly portId?: string;
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

const PREVIEW_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

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
    csp: `default-src 'none'; base-uri 'none'; connect-src 'none'; img-src data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'; frame-ancestors 'none'; form-action 'none'`
  };
}

function canonicalPreviewPolicy(policy: PreviewSecurityPolicy): PreviewSecurityPolicy {
  const canonical = createPreviewSecurityPolicy(
    policy.origin,
    policy.nonce,
    policy.maxMessageBytes
  );
  if (policy.csp !== canonical.csp)
    throw new PreviewMessageError('Preview policy CSP does not match its security parameters');
  return canonical;
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
  if ((value.type === 'select-node' || value.type === 'trigger-action') && value.nodeId === undefined)
    throw new PreviewMessageError('Node selection must include a node ID');
  if (value.type === 'runtime-error' && value.message === undefined)
    throw new PreviewMessageError('Runtime errors must include a message');
  return {
    type: value.type as PreviewMessageType,
    nonce: value.nonce as string,
    origin: value.origin as string,
    revisionId: value.revisionId as string,
    ...(value.nodeId === undefined ? {} : { nodeId: value.nodeId as string }),
    ...(value.portId === undefined ? {} : { portId: value.portId as string }),
    ...(value.message === undefined ? {} : { message: value.message as string })
  };
}

interface PreviewArtifact {
  readonly revisionId: string;
  readonly code: string;
  readonly css?: string;
}

function encodedAttribute(value: string): string {
  return encodeURIComponent(value);
}

/**
 * The document contains only trusted bootstrap markup. Generated CSS and
 * JavaScript are served as distinct resources, so untrusted artifact text is
 * never interpolated into HTML.
 */
export function createPreviewDocument(policy: PreviewSecurityPolicy, revisionId: string): string {
  const canonical = canonicalPreviewPolicy(policy);
  const nonce = encodedAttribute(canonical.nonce);
  const origin = encodedAttribute(canonical.origin);
  const revision = encodedAttribute(revisionId);
  return `<!doctype html><html data-preview-origin="${origin}" data-preview-nonce="${nonce}" data-preview-revision-id="${revision}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${canonical.csp}"><link rel="stylesheet" href="preview.css"></head><body><div id="root"></div><script nonce="${canonical.nonce}">const root=document.documentElement;const decode=value=>decodeURIComponent(value||'');const policy={nonce:decode(root.dataset.previewNonce),revisionId:decode(root.dataset.previewRevisionId)};let port;const valid=value=>value&&typeof value==='object'&&value.nonce===policy.nonce&&value.revisionId===policy.revisionId;const report=(type,extra={})=>port?.postMessage({type,nonce:policy.nonce,revisionId:policy.revisionId,...extra});window.addEventListener('message',event=>{const value=event.data;if(event.source!==window.parent||port||!valid(value)||value.type!=='selene-preview-init'||event.ports.length!==1)return;port=event.ports[0];port.onmessage=message=>{const next=message.data;if(valid(next)&&next.type==='runtime-state'&&next.state&&typeof next.state==='object')window.dispatchEvent(new CustomEvent('selene-runtime-state',{detail:next.state}))};report('ready')});window.addEventListener('error',event=>report('runtime-error',{message:String(event.message).slice(0,4000)}));document.addEventListener('click',event=>{const action=event.target instanceof Element?event.target.closest('[data-selene-flow-node][data-selene-action-port]'):null;if(action){report('trigger-action',{nodeId:action.getAttribute('data-selene-flow-node')||undefined,portId:action.getAttribute('data-selene-action-port')||undefined});return}const node=event.target instanceof Element?event.target.closest('[data-selene-node-id]'):null;if(node)report('select-node',{nodeId:node.getAttribute('data-selene-node-id')||undefined})});</script><script type="module" nonce="${canonical.nonce}" src="preview.js"></script></body></html>`;
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
    if (!PREVIEW_ID_PATTERN.test(id)) throw new PreviewMessageError('Preview ID is invalid');
    const canonical = canonicalPreviewPolicy(policy);
    this.previews.set(id, { policy: canonical, artifact });
    while (this.previews.size > 8)
      this.previews.delete(this.previews.keys().next().value as string);
    return {
      url: `selene-preview://local/${id}/index.html`,
      policy: canonical,
      revisionId: artifact.revisionId
    };
  }

  /**
   * A policy may only be used for an artifact this registry published. This
   * prevents a renderer from fabricating an unrelated policy/revision pair
   * before its message reaches Electron's privileged process.
   */
  public validatePublishedMessage(policy: PreviewSecurityPolicy, value: unknown): PreviewMessage {
    const canonical = canonicalPreviewPolicy(policy);
    const message = validatePreviewMessage(value, canonical);
    const published = [...this.previews.values()].some(
      (entry) =>
        entry.artifact.revisionId === message.revisionId &&
        entry.policy.origin === canonical.origin &&
        entry.policy.nonce === canonical.nonce &&
        entry.policy.maxMessageBytes === canonical.maxMessageBytes &&
        entry.policy.csp === canonical.csp
    );
    if (!published) throw new PreviewMessageError('Preview policy is not published');
    return message;
  }

  public async handle(url: string): Promise<Response> {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/');
    const id = segments.length === 3 && segments[0] === '' ? segments[1] : undefined;
    const resource = segments.length === 3 && segments[0] === '' ? segments[2] : undefined;
    const entry =
      parsed.protocol === 'selene-preview:' &&
      parsed.hostname === 'local' &&
      id !== undefined &&
      PREVIEW_ID_PATTERN.test(id)
        ? this.previews.get(id)
        : undefined;
    if (entry === undefined) return new Response('Preview not found', { status: 404 });
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (resource === 'index.html')
      return new Response(createPreviewDocument(entry.policy, entry.artifact.revisionId), {
        headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' }
      });
    if (resource === 'preview.js')
      return new Response(entry.artifact.code, {
        headers: { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' }
      });
    if (resource === 'preview.css')
      return new Response(entry.artifact.css ?? '', {
        headers: { ...headers, 'Content-Type': 'text/css; charset=utf-8' }
      });
    return new Response('Preview resource not found', { status: 404 });
  }
}
  if (value.type === 'trigger-action' && (typeof value.portId !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value.portId)))
    throw new PreviewMessageError('Preview action port ID is invalid');
