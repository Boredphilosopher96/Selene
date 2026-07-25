import {
  type PreviewFrameMessage,
  validatePreviewFrameMessage
} from '../shared/preview-channel';

/** Typed, bounded transport for an untrusted renderer-hosted preview frame. */
export type PreviewMessage = PreviewFrameMessage;

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
  const message = validatePreviewFrameMessage(value, policy);
  if (!message) throw new PreviewMessageError('Preview channel message is invalid');
  return message;
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
  return `<!doctype html>
<html data-preview-origin="${origin}" data-preview-nonce="${nonce}" data-preview-revision-id="${revision}">
<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${canonical.csp}"><link rel="stylesheet" href="preview.css"></head>
<body><div id="root"></div><script nonce="${canonical.nonce}">
const root=document.documentElement;const decode=value=>decodeURIComponent(value||'');
const policy={origin:decode(root.dataset.previewOrigin),nonce:decode(root.dataset.previewNonce),revisionId:decode(root.dataset.previewRevisionId)};
const identifier=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;let port;let closed=false;
const fields=(value,allowed)=>{try{if(!value||typeof value!=='object'||Array.isArray(value))return null;const descriptors=Object.getOwnPropertyDescriptors(value);const keys=Reflect.ownKeys(descriptors);if(keys.some(key=>typeof key!=='string'||!allowed.includes(key)))return null;const output=Object.create(null);for(const key of keys){const descriptor=descriptors[key];if(!descriptor||!descriptor.enumerable||!Object.prototype.hasOwnProperty.call(descriptor,'value'))return null;output[key]=descriptor.value}return Object.freeze(output)}catch{return null}};
const identifiers=(value,limit)=>{try{if(!Array.isArray(value))return null;const descriptors=Object.getOwnPropertyDescriptors(value);const length=descriptors.length;if(!length||!Object.prototype.hasOwnProperty.call(length,'value')||length.enumerable||!Number.isSafeInteger(length.value)||length.value<0||length.value>limit||Reflect.ownKeys(descriptors).length!==length.value+1)return null;const output=[];for(let index=0;index<length.value;index+=1){const descriptor=descriptors[String(index)];if(!descriptor||!descriptor.enumerable||!Object.prototype.hasOwnProperty.call(descriptor,'value')||typeof descriptor.value!=='string'||!identifier.test(descriptor.value))return null;output.push(descriptor.value)}return Object.freeze(output)}catch{return null}};
const channel=value=>{const next=fields(value,['type','nonce','origin','revisionId','state']);if(!next||next.type!=='runtime-state'||next.nonce!==policy.nonce||next.origin!==policy.origin||next.revisionId!==policy.revisionId)return null;const state=fields(next.state,['activeNodeId','activeStateId','activeOverlayId','activePathTransitionIds']);if(!state||typeof state.activeNodeId!=='string'||!identifier.test(state.activeNodeId)||(state.activeStateId!==undefined&&(typeof state.activeStateId!=='string'||!identifier.test(state.activeStateId)))||(state.activeOverlayId!==undefined&&(typeof state.activeOverlayId!=='string'||!identifier.test(state.activeOverlayId))))return null;const activePathTransitionIds=identifiers(state.activePathTransitionIds,256);if(!activePathTransitionIds)return null;return Object.freeze({activeNodeId:state.activeNodeId,...(state.activeStateId?{activeStateId:state.activeStateId}:{}),...(state.activeOverlayId?{activeOverlayId:state.activeOverlayId}:{}),activePathTransitionIds})};
const report=(type,extra={})=>{if(!port||closed)return;port.postMessage({type,origin:policy.origin,nonce:policy.nonce,revisionId:policy.revisionId,...extra})};
const initialize=event=>{const value=fields(event.data,['type','nonce','revisionId']);if(event.source!==window.parent||port||!value||value.type!=='selene-preview-init'||value.nonce!==policy.nonce||value.revisionId!==policy.revisionId||event.ports.length!==1)return;window.removeEventListener('message',initialize);port=event.ports[0];port.onmessage=message=>{if(closed)return;const state=channel(message.data);if(state)window.dispatchEvent(new CustomEvent('selene-runtime-state',{detail:state}))};port.start?.();report('ready')};
window.addEventListener('message',initialize);window.addEventListener('pagehide',()=>{closed=true;port?.close();port=undefined},{once:true});window.addEventListener('error',event=>report('runtime-error',{message:String(event.message).slice(0,4000)}));
document.addEventListener('click',event=>{const action=event.target instanceof Element?event.target.closest('[data-selene-flow-node][data-selene-action-port]'):null;if(action){const nodeId=action.getAttribute('data-selene-flow-node')||'';const portId=action.getAttribute('data-selene-action-port')||'';if(identifier.test(nodeId)&&identifier.test(portId))report('trigger-action',{nodeId,portId});return}const node=event.target instanceof Element?event.target.closest('[data-selene-node-id]'):null;if(node){const nodeId=node.getAttribute('data-selene-node-id')||'';if(identifier.test(nodeId))report('select-node',{nodeId)}});
</script><script type="module" nonce="${canonical.nonce}" src="preview.js"></script></body></html>`;
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
