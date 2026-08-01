import { randomUUID, webcrypto } from 'node:crypto';

import type { PreviewSelectionProof, SpatialTargetInput } from '../shared/designer-api';
import { type PreviewFrameMessage, validatePreviewFrameMessage } from '../shared/preview-channel';

/** Typed, bounded transport for an untrusted renderer-hosted preview frame. */
export type PreviewMessage = PreviewFrameMessage;

export interface PreviewSecurityPolicy {
  readonly origin: string;
  readonly nonce: string;
  readonly maxMessageBytes: number;
  readonly csp: string;
}

export interface PreviewFrameDescriptor {
  readonly url: string;
  readonly policy: PreviewSecurityPolicy;
  readonly revisionId: string;
  readonly screenId: string;
  readonly projectId: string;
}

export class PreviewMessageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PreviewMessageError';
  }
}

const PREVIEW_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PREVIEW_SCREEN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
    csp: `default-src 'none'; base-uri 'none'; connect-src 'self'; img-src data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'; frame-ancestors 'none'; form-action 'none'`
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
  policy: PreviewSecurityPolicy,
  revisionId: string
): PreviewMessage {
  const bytes = encodedMessageBytes(value);
  if (bytes > policy.maxMessageBytes)
    throw new PreviewMessageError('Preview message exceeds size limit');
  const message = validatePreviewFrameMessage(value, { ...policy, revisionId });
  if (!message) throw new PreviewMessageError('Preview channel message is invalid');
  return message;
}

interface PreviewArtifact {
  readonly revisionId: string;
  readonly projectId?: string;
  /** Host build identity; never returned as selection authority to the renderer. */
  readonly bindingId?: string;
  /** Compiler-authenticated node IDs for this exact artifact and binding. */
  readonly compilerNodeIds?: readonly string[];
  readonly screenIds?: readonly string[];
  readonly code: string;
  readonly css?: string;
}

interface PreviewFrameAuthority {
  publicKey?: JsonWebKey;
  nextCounter: number;
}

interface PublishedPreviewArtifact {
  readonly policy: PreviewSecurityPolicy;
  readonly artifact: PreviewArtifact;
  readonly frameAuthorities: Map<string, PreviewFrameAuthority>;
}

interface NativePreviewSelectionReceipt {
  readonly bindingId: string;
  readonly frameScope: string;
  readonly issuedAt: number;
  readonly point: Readonly<{ readonly x: number; readonly y: number }>;
  readonly previewId: string;
  readonly revisionId: string;
}

/** Private preload-to-frame bridge data; never part of the renderer API. */
export interface NativePreviewSelectionBridge {
  readonly nonce: string;
  readonly origin: string;
  readonly receiptId: string;
  readonly revisionId: string;
  readonly x: number;
  readonly y: number;
}

const directPreviewFrameScope = 'direct';

function screenPreviewFrameScope(screenId: string): string {
  return `screen:${screenId}`;
}

function selectionProofRejection(
  headers: Readonly<Record<string, string>>,
  reason: string
): Response {
  console.error(`[selene-selection-proof-rejection] ${reason}`);
  return new Response('Preview selection proof is unavailable', { status: 403, headers });
}

/** Registry-owned target reconstructed only when an opaque preview proof is consumed. */
export interface PreviewSelectionProofTarget {
  readonly format: 'selene-authenticated-artifact-element-target/v1';
  readonly projectId: string;
  readonly nodeRef: string;
  readonly revisionId: string;
  readonly bindingId: string;
  readonly anchor: SpatialTargetInput;
}

function encodedAttribute(value: string): string {
  return encodeURIComponent(value);
}

/** Accept the JSON media type Chromium emits, with its optional UTF-8 parameter only. */
function isJsonUtf8ContentType(value: string | null): boolean {
  return /^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/iu.test(value ?? '');
}

/** Trusted pre-import proof authority. Generated preview code cannot reach its private key. */
function createSelectionProofBootstrap(policy: PreviewSecurityPolicy): string {
  return `<script nonce="${policy.nonce}">
const proofRoot=document.documentElement;
const proofIdentifier=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const apply=Reflect.apply;
const nativeElement=Element;
const closest=Element.prototype.closest;
const getAttribute=Element.prototype.getAttribute;
const setAttribute=Element.prototype.setAttribute;
const getBounds=Element.prototype.getBoundingClientRect;
const clientWidthDescriptor=Object.getOwnPropertyDescriptor(Element.prototype,'clientWidth');
const clientHeightDescriptor=Object.getOwnPropertyDescriptor(Element.prototype,'clientHeight');
if(!clientWidthDescriptor||typeof clientWidthDescriptor.get!=='function'||!clientHeightDescriptor||typeof clientHeightDescriptor.get!=='function')throw new Error('Preview viewport measurement is unavailable');
const clientWidthGetter=clientWidthDescriptor.get;
const clientHeightGetter=clientHeightDescriptor.get;
const nativeFetch=window.fetch.bind(window);
const stringify=JSON.stringify;
const parse=JSON.parse;
const round=Math.round;
const finite=Number.isFinite;
const safeInteger=Number.isSafeInteger;
const decode=decodeURIComponent;
const postParent=window.parent.postMessage.bind(window.parent);
const addWindowListener=window.addEventListener.bind(window);
const targetGetter=Object.getOwnPropertyDescriptor(Event.prototype,'target').get;
const sourceGetter=Object.getOwnPropertyDescriptor(MessageEvent.prototype,'source').get;
const dataGetter=Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data').get;
const nativeSubtle=crypto.subtle;
const generateKey=nativeSubtle.generateKey.bind(nativeSubtle);
const exportKey=nativeSubtle.exportKey.bind(nativeSubtle);
const sign=nativeSubtle.sign.bind(nativeSubtle);
const encoder=new TextEncoder;
const toBase64=btoa.bind(window);
const elementFromPoint=document.elementFromPoint.bind(document);
const proofNow=performance.now.bind(performance);
const nativeStage=value=>{const current=apply(getAttribute,proofRoot,['data-selene-native-selection-stage']);if(value==='relayed'&&typeof current==='string'&&current.slice(0,9)==='rejected-')return;apply(setAttribute,proofRoot,['data-selene-native-selection-stage',value])};
const envelope=Object.freeze({origin:decode(proofRoot.dataset.previewOrigin||''),nonce:decode(proofRoot.dataset.previewNonce||''),revisionId:decode(proofRoot.dataset.previewRevisionId||'')});
let designEnabled=false;
let signer;
let counter=0;
const proofReady=generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']).then(pair=>{signer=pair.privateKey;return exportKey('jwk',pair.publicKey)}).then(publicKey=>nativeFetch('./selection-key',{method:'POST',headers:{'content-type':'application/json'},body:apply(stringify,JSON,[publicKey])})).then(response=>response.ok).catch(()=>false);
Object.defineProperty(window,'__selenePreviewProofReady',{value:proofReady,writable:false,configurable:false});
const updateMode=event=>{if(!event.isTrusted||apply(sourceGetter,event,[])!==window.parent)return;const value=apply(dataGetter,event,[]);if(!value||typeof value!=='object'||Array.isArray(value))return;const next=value;if(next.type==='selene-preview-init'&&next.nonce===envelope.nonce&&next.revisionId===envelope.revisionId&&typeof next.enabled==='boolean')designEnabled=next.enabled};
const relayProofResponse=(text,nodeId,requiresSelection)=>{if(typeof text!=='string')return;let reply;try{reply=apply(parse,JSON,[text])}catch{return}if(reply&&reply.format==='selene-preview-selection-diagnostic/v1'&&typeof reply.reason==='string'&&/^[a-z-]+$/.test(reply.reason)){nativeStage('rejected-'+reply.reason);return}const proof=reply&&reply.proof?reply.proof:reply;const selection=reply&&reply.selection;if(requiresSelection&&(!selection||selection.type!=='select-node'||selection.nodeId!==nodeId))return;if(selection)apply(postParent,window.parent,[{type:'authenticated-select-node',origin:envelope.origin,nonce:envelope.nonce,revisionId:envelope.revisionId,nodeId:selection.nodeId,telemetry:selection.telemetry},'*']);if(!proof||proof.format!=='selene-preview-selection-proof/v1'||typeof proof.proofId!=='string')return;apply(postParent,window.parent,[{type:'selection-proof',origin:envelope.origin,nonce:envelope.nonce,revisionId:envelope.revisionId,nodeId,selectionProof:proof},'*'])};
const issueProof=event=>{if(!event.isTrusted||!event.isPrimary||event.button!==0||!designEnabled)return;const target=apply(targetGetter,event,[]);const node=target instanceof nativeElement?apply(closest,target,['[data-selene-node-id]']):null;const nodeId=node?apply(getAttribute,node,['data-selene-node-id'])||'':'';if(!node||!proofIdentifier.test(nodeId))return;const bounds=apply(getBounds,node,[]);const viewportWidth=apply(round,Math,[apply(clientWidthGetter,proofRoot,[])]);const viewportHeight=apply(round,Math,[apply(clientHeightGetter,proofRoot,[])]);if(!apply(finite,Number,[bounds.left])||!apply(finite,Number,[bounds.top])||!apply(finite,Number,[bounds.width])||!apply(finite,Number,[bounds.height])||!apply(safeInteger,Number,[viewportWidth])||!apply(safeInteger,Number,[viewportHeight])||viewportWidth<1||viewportHeight<1||bounds.left<0||bounds.top<0||bounds.width<=0||bounds.height<=0||bounds.left+bounds.width>viewportWidth||bounds.top+bounds.height>viewportHeight)return;directPointerAt=proofNow();void proofReady.then(ready=>{if(!ready||!signer)return;const payload={counter:++counter,nodeId,left:bounds.left,top:bounds.top,width:bounds.width,height:bounds.height,viewportWidth,viewportHeight};const canonical=apply(stringify,JSON,[payload]);return sign({name:'ECDSA',hash:'SHA-256'},signer,encoder.encode(canonical)).then(bytes=>{let binary='';for(const byte of new Uint8Array(bytes))binary+=String.fromCharCode(byte);return nativeFetch('./selection-proof',{method:'POST',headers:{'content-type':'application/json'},body:apply(stringify,JSON,[{...payload,signature:toBase64(binary)}])})}).then(response=>response?.ok?response.text():undefined).then(text=>relayProofResponse(text,nodeId,false))}).catch(()=>undefined)};
let directPointerAt=-Infinity;
const issueNativeBridge=event=>{if(!event.isTrusted||apply(sourceGetter,event,[])!==window.parent||!designEnabled||proofNow()-directPointerAt<500)return;const value=apply(dataGetter,event,[]);if(!value||typeof value!=='object'||Array.isArray(value))return;const next=value;if(next.type!=='selene-preview-native-selection'||next.nonce!==envelope.nonce||next.revisionId!==envelope.revisionId||typeof next.receiptId!=='string'||!/^[a-f0-9]{32}$/.test(next.receiptId)||typeof next.x!=='number'||typeof next.y!=='number'||!apply(finite,Number,[next.x])||!apply(finite,Number,[next.y])||next.x<0||next.x>1||next.y<0||next.y>1)return;nativeStage('received');const viewportWidth=apply(round,Math,[apply(clientWidthGetter,proofRoot,[])]);const viewportHeight=apply(round,Math,[apply(clientHeightGetter,proofRoot,[])]);if(!apply(safeInteger,Number,[viewportWidth])||!apply(safeInteger,Number,[viewportHeight])||viewportWidth<1||viewportHeight<1){nativeStage('invalid-viewport');return}const target=elementFromPoint(next.x*viewportWidth,next.y*viewportHeight);const node=target instanceof nativeElement?apply(closest,target,['[data-selene-node-id]']):null;const nodeId=node?apply(getAttribute,node,['data-selene-node-id'])||'':'';if(!node||!proofIdentifier.test(nodeId)){nativeStage('unmapped');return}const bounds=apply(getBounds,node,[]);if(!apply(finite,Number,[bounds.left])||!apply(finite,Number,[bounds.top])||!apply(finite,Number,[bounds.width])||!apply(finite,Number,[bounds.height])||bounds.left<0||bounds.top<0||bounds.width<=0||bounds.height<=0||bounds.left+bounds.width>viewportWidth||bounds.top+bounds.height>viewportHeight){nativeStage('invalid-bounds');return}nativeStage('mapped');void proofReady.then(ready=>{if(!ready||!signer){nativeStage('authority-unavailable');return}nativeStage('signing');const payload={counter:++counter,nodeId,left:bounds.left,top:bounds.top,width:bounds.width,height:bounds.height,viewportWidth,viewportHeight,receiptId:next.receiptId};const canonical=apply(stringify,JSON,[payload]);return sign({name:'ECDSA',hash:'SHA-256'},signer,encoder.encode(canonical)).then(bytes=>{let binary='';for(const byte of new Uint8Array(bytes))binary+=String.fromCharCode(byte);return nativeFetch('./selection-proof',{method:'POST',headers:{'content-type':'application/json'},body:apply(stringify,JSON,[{...payload,signature:toBase64(binary)}])})}).then(response=>{if(!response?.ok){nativeStage('rejected-status-'+String(response?.status??0));return response?.text().then(text=>{const prefix='Preview selection proof is unavailable:';const bodyDiagnostic=text.startsWith(prefix)?text.slice(prefix.length):'';const headerDiagnostic=response.headers.get('X-Selene-Selection-Diagnostic')||'';const diagnostic=bodyDiagnostic||headerDiagnostic;nativeStage(/^[a-z-]+$/.test(diagnostic)?'rejected-'+diagnostic:'rejected')});nativeStage('accepted');return response.text()}).then(text=>{if(typeof text!=='string')return;relayProofResponse(text,nodeId,true);nativeStage('relayed')})}).catch(()=>nativeStage('failed'))};
addWindowListener('message',updateMode,true);
addWindowListener('message',issueNativeBridge,true);
addWindowListener('pointerdown',issueProof,true);
</script>`;
}

/**
 * The document contains only trusted bootstrap markup. Generated CSS and
 * JavaScript are served as distinct resources, so untrusted artifact text is
 * never interpolated into HTML.
 */
export function createPreviewDocument(
  policy: PreviewSecurityPolicy,
  revisionId: string,
  screenId?: string,
  projectId?: string
): string {
  const canonical = canonicalPreviewPolicy(policy);
  const nonce = encodedAttribute(canonical.nonce);
  const origin = encodedAttribute(canonical.origin);
  const revision = encodedAttribute(revisionId);
  const screen = screenId === undefined ? '' : encodedAttribute(screenId);
  const project = projectId === undefined ? '' : encodedAttribute(projectId);
  const proofBootstrap = createSelectionProofBootstrap(canonical);
  return `<!doctype html>
<html data-preview-origin="${origin}" data-preview-nonce="${nonce}" data-preview-revision-id="${revision}"${screenId === undefined ? '' : ` data-preview-screen-id="${screen}"`}${projectId === undefined ? '' : ` data-preview-project-id="${project}"`}>
<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${canonical.csp}"><link rel="stylesheet" href="preview.css"></head>
<body>${proofBootstrap}<div id="root"></div><script type="module" nonce="${canonical.nonce}">
const root=document.documentElement;const decode=value=>decodeURIComponent(value||'');
const policy=Object.freeze({origin:decode(root.dataset.previewOrigin),nonce:decode(root.dataset.previewNonce),revisionId:decode(root.dataset.previewRevisionId)});let previewCommitted=false;let pendingRuntimeState;let pendingInspectNodeId;const dispatchRuntimeState=state=>dispatchWindow(new TrustedCustomEvent('selene-runtime-state',{detail:state}));
const identifier=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;let port;let closed=false;let canvasNavigationEnabled=false;let canvasPointerSelection;let suppressUnsupportedClick=false;let targetCancelEnabled=false;let selectionInteractionSequence=0;
const previewRoot=document.getElementById('root');if(previewRoot)previewRoot.hidden=true;const apply=Reflect.apply;const TrustedPromise=Promise;const TrustedError=Error;const TrustedSet=Set;const TrustedCustomEvent=CustomEvent;const dispatchWindow=window.dispatchEvent.bind(window);const postMessage=MessagePort.prototype.postMessage;const postParentMessage=window.parent.postMessage.bind(window.parent);const addPortListener=MessagePort.prototype.addEventListener;const startPort=MessagePort.prototype.start;const closePort=MessagePort.prototype.close;const stopImmediate=Event.prototype.stopImmediatePropagation;const preventDefault=Event.prototype.preventDefault;const requestFrame=window.requestAnimationFrame.bind(window);const addWindowListener=window.addEventListener.bind(window);const removeWindowListener=window.removeEventListener.bind(window);const queryMarkedNodes=document.querySelectorAll.bind(document);const hasChildNodes=Node.prototype.hasChildNodes;const containsNode=Node.prototype.contains;const getParentElement=Object.getOwnPropertyDescriptor(Node.prototype,'parentElement').get;const getTagName=Object.getOwnPropertyDescriptor(Element.prototype,'tagName').get;const getBounds=Element.prototype.getBoundingClientRect;const getAttribute=Element.prototype.getAttribute;const computedStyle=window.getComputedStyle.bind(window);const finite=Number.isFinite;const TrustedMutationObserver=MutationObserver;const observeMutation=MutationObserver.prototype.observe;const disconnectMutation=MutationObserver.prototype.disconnect;const readonlyPreview=Boolean(root.dataset.previewScreenId&&root.dataset.previewProjectId);let commitObserver;let acceptInitialRuntime;const initialRuntime=new TrustedPromise(resolve=>{acceptInitialRuntime=resolve});if(readonlyPreview)acceptInitialRuntime();
const fields=(value,allowed)=>{try{if(!value||typeof value!=='object'||Array.isArray(value))return null;const descriptors=Object.getOwnPropertyDescriptors(value);const keys=Reflect.ownKeys(descriptors);if(keys.some(key=>typeof key!=='string'||!allowed.includes(key)))return null;const output=Object.create(null);for(const key of keys){const descriptor=descriptors[key];if(!descriptor||!descriptor.enumerable||!Object.prototype.hasOwnProperty.call(descriptor,'value'))return null;output[key]=descriptor.value}return Object.freeze(output)}catch{return null}};
const identifiers=(value,limit)=>{try{if(!Array.isArray(value))return null;const descriptors=Object.getOwnPropertyDescriptors(value);const length=descriptors.length;if(!length||!Object.prototype.hasOwnProperty.call(length,'value')||length.enumerable||!Number.isSafeInteger(length.value)||length.value<0||length.value>limit||Reflect.ownKeys(descriptors).length!==length.value+1)return null;const output=[];for(let index=0;index<length.value;index+=1){const descriptor=descriptors[String(index)];if(!descriptor||!descriptor.enumerable||!Object.prototype.hasOwnProperty.call(descriptor,'value')||typeof descriptor.value!=='string'||!identifier.test(descriptor.value))return null;output.push(descriptor.value)}return Object.freeze(output)}catch{return null}};
const channel=value=>{const next=fields(value,['type','nonce','origin','revisionId','state','enabled','nodeId']);if(!next||next.nonce!==policy.nonce||next.origin!==policy.origin||next.revisionId!==policy.revisionId)return null;if(next.type==='canvas-navigation'||next.type==='target-cancel')return typeof next.enabled==='boolean'&&next.state===undefined&&next.nodeId===undefined?Object.freeze({type:next.type,enabled:next.enabled}):null;if(next.type==='inspect-node')return next.enabled===undefined&&next.state===undefined&&typeof next.nodeId==='string'&&identifier.test(next.nodeId)?Object.freeze({type:next.type,nodeId:next.nodeId}):null;if(next.type!=='runtime-state'||next.enabled!==undefined||next.nodeId!==undefined)return null;const state=fields(next.state,['activeNodeId','activeStateId','activeOverlayId','activePathTransitionIds']);if(!state||typeof state.activeNodeId!=='string'||!identifier.test(state.activeNodeId)||(state.activeStateId!==undefined&&(typeof state.activeStateId!=='string'||!identifier.test(state.activeStateId)))||(state.activeOverlayId!==undefined&&(typeof state.activeOverlayId!=='string'||!identifier.test(state.activeOverlayId))))return null;const activePathTransitionIds=identifiers(state.activePathTransitionIds,256);if(!activePathTransitionIds)return null;return Object.freeze({type:'runtime-state',state:Object.freeze({activeNodeId:state.activeNodeId,...(state.activeStateId?{activeStateId:state.activeStateId}:{}),...(state.activeOverlayId?{activeOverlayId:state.activeOverlayId}:{}),activePathTransitionIds})})};
const report=(type,extra={})=>{if(closed)return;const interactionSequence=type==='clear-selection'||type==='select-node'?++selectionInteractionSequence:undefined;if(interactionSequence!==undefined)root.dataset.seleneSelectionInteraction=type+':'+interactionSequence;const message={type,origin:policy.origin,nonce:policy.nonce,revisionId:policy.revisionId,...(interactionSequence===undefined?{}:{interactionSequence}),...extra};if(interactionSequence!==undefined)try{postParentMessage(message,'*')}catch{}if(port)try{apply(postMessage,port,[message])}catch{}};
let painted=false;let renderFailure;let inspectElementSequence=0;let windowUnsupportedPointerHit=false;let windowUnsupportedPointerNavigation=false;const reportPaint=()=>{if(painted)report('rendered')};const reportFailure=()=>{if(renderFailure)report('runtime-error',{message:renderFailure})};const fail=message=>{renderFailure=(String(message).trim()||'Preview module could not render').slice(0,4000);reportFailure()};
const initialize=event=>{if(!event.isTrusted||event.source!==window.parent||port)return;apply(stopImmediate,event,[]);const value=fields(event.data,['type','nonce','revisionId','enabled','state']);const initial=value?channel({type:'runtime-state',nonce:value.nonce,origin:policy.origin,revisionId:value.revisionId,state:value.state}):null;if(!value||value.type!=='selene-preview-init'||value.nonce!==policy.nonce||value.revisionId!==policy.revisionId||typeof value.enabled!=='boolean'||!initial||event.ports.length!==1)return;removeWindowListener('message',initialize,true);canvasNavigationEnabled=value.enabled;root.dataset.seleneCanvasNavigation=value.enabled?'design':'prototype';pendingRuntimeState=initial.state;port=event.ports[0];apply(addPortListener,port,['message',event=>{if(closed)return;const message=channel(event.data);if(!message)return;if(message.type==='canvas-navigation'){canvasNavigationEnabled=message.enabled;root.dataset.seleneCanvasNavigation=message.enabled?'design':'prototype';if(!message.enabled)canvasPointerSelection=undefined;return}if(message.type==='target-cancel'){targetCancelEnabled=message.enabled;return}if(message.type==='inspect-node'){if(!previewCommitted)pendingInspectNodeId=message.nodeId;else inspectNode(message.nodeId);return}if(!previewCommitted){pendingRuntimeState=message.state;return}dispatchRuntimeState(message.state)}]);apply(startPort,port,[]);acceptInitialRuntime();report('ready');reportFailure();reportPaint()};
addWindowListener('message',initialize,true);addWindowListener('pagehide',()=>{closed=true;canvasPointerSelection=undefined;removeWindowListener('message',initialize,true);if(commitObserver)apply(disconnectMutation,commitObserver,[]);if(port)apply(closePort,port,[]);port=undefined},{once:true});addWindowListener('error',event=>fail(event.message),true);
const markedHierarchy=node=>{const hierarchy=[];let current=node;let depth=0;while(current&&hierarchy.length<16&&depth<256){depth+=1;const nodeId=apply(getAttribute,current,['data-selene-node-id'])||'';if(identifier.test(nodeId)&&hierarchy[0]?.nodeId!==nodeId){const semanticTag=String(apply(getTagName,current,[])).toLowerCase().slice(0,128);if(/^[a-z][a-z0-9-]{0,127}$/.test(semanticTag))hierarchy.unshift(Object.freeze({nodeId,semanticTag}))}current=apply(getParentElement,current,[])}return Object.freeze(hierarchy)};
const alignmentTargets=node=>{const targets=[];const nodeIds=new TrustedSet();const selectedNodeId=apply(getAttribute,node,['data-selene-node-id'])||'';if(identifier.test(selectedNodeId))nodeIds.add(selectedNodeId);const nodes=queryMarkedNodes('[data-selene-node-id]');const limit=Math.min(nodes.length,10000);for(let index=0;index<limit&&targets.length<64;index+=1){const candidate=nodes[index];if(!candidate||candidate===node||apply(containsNode,node,[candidate])||apply(containsNode,candidate,[node]))continue;const nodeId=apply(getAttribute,candidate,['data-selene-node-id'])||'';if(!identifier.test(nodeId)||nodeIds.has(nodeId))continue;const rect=apply(getBounds,candidate,[]);if(!finite(rect.left)||!finite(rect.top)||!finite(rect.width)||!finite(rect.height)||rect.width<=0||rect.height<=0)continue;nodeIds.add(nodeId);targets.push(Object.freeze({nodeId,left:rect.left,top:rect.top,width:rect.width,height:rect.height}))}return Object.freeze(targets)};
const measuredConstraint=value=>{const numeric=Number.parseFloat(value);return finite(numeric)&&numeric>=0?Math.min(100000,numeric):undefined};const elementTelemetry=node=>{const style=computedStyle(node);const rect=apply(getBounds,node,[]);const parent=apply(getParentElement,node,[]);const parentRect=parent?apply(getBounds,parent,[]):undefined;const attribute=name=>(apply(getAttribute,node,[name])||'').slice(0,256);const minWidth=measuredConstraint(style.minWidth);const minHeight=measuredConstraint(style.minHeight);const maxWidth=measuredConstraint(style.maxWidth);const maxHeight=measuredConstraint(style.maxHeight);const parentWidth=parentRect&&finite(parentRect.width)&&parentRect.width>=0?Math.min(100000,parentRect.width):undefined;const parentHeight=parentRect&&finite(parentRect.height)&&parentRect.height>=0?Math.min(100000,parentRect.height):undefined;return {hierarchy:markedHierarchy(node),alignmentTargets:alignmentTargets(node),left:rect.left,top:rect.top,width:Math.max(0,rect.width),height:Math.max(0,rect.height),...(minWidth===undefined?{}:{minWidth}),...(minHeight===undefined?{}:{minHeight}),...(maxWidth===undefined?{}:{maxWidth}),...(maxHeight===undefined?{}:{maxHeight}),...(parentWidth===undefined?{}:{parentWidth}),...(parentHeight===undefined?{}:{parentHeight}),display:style.display.slice(0,256),position:style.position.slice(0,256),boxSizing:style.boxSizing.slice(0,256),margin:style.margin.slice(0,256),padding:style.padding.slice(0,256),gap:style.gap.slice(0,256),flexDirection:style.flexDirection.slice(0,256),alignItems:style.alignItems.slice(0,256),justifyContent:style.justifyContent.slice(0,256),gridTemplateColumns:style.gridTemplateColumns.slice(0,256),gridTemplateRows:style.gridTemplateRows.slice(0,256),overflow:style.overflow.slice(0,256),fontFamily:style.fontFamily.slice(0,256),fontSize:style.fontSize.slice(0,256),fontWeight:style.fontWeight.slice(0,256),lineHeight:style.lineHeight.slice(0,256),letterSpacing:style.letterSpacing.slice(0,256),textAlign:style.textAlign.slice(0,256),textDecoration:style.textDecoration.slice(0,256),color:style.color.slice(0,256),backgroundColor:style.backgroundColor.slice(0,256),border:style.border.slice(0,256),borderRadius:style.borderRadius.slice(0,256),boxShadow:style.boxShadow.slice(0,512),opacity:style.opacity.slice(0,256),semanticTag:String(apply(getTagName,node,[])).toLowerCase().slice(0,256),explicitAriaRole:attribute('role'),ariaLabel:attribute('aria-label'),accessibleDescription:(attribute('aria-description')||attribute('title')).slice(0,256),ariaDisabled:attribute('aria-disabled'),ariaExpanded:attribute('aria-expanded'),ariaPressed:attribute('aria-pressed'),ariaChecked:attribute('aria-checked'),ariaSelected:attribute('aria-selected'),ariaHidden:attribute('aria-hidden'),tabIndex:node instanceof HTMLElement?Math.max(-1,Math.min(32767,node.tabIndex)):-1}};
const inspectNode=nodeId=>{const nodes=queryMarkedNodes('[data-selene-node-id]');const limit=Math.min(nodes.length,10000);let match;for(let index=0;index<limit;index+=1){const node=nodes[index];if(node&&apply(getAttribute,node,['data-selene-node-id'])===nodeId){if(match)return;match=node}}if(match)report('inspect-node-result',{nodeId,telemetry:elementTelemetry(match)})};
const unmappedElementTelemetry=node=>{const {hierarchy,alignmentTargets,minWidth,minHeight,maxWidth,maxHeight,parentWidth,parentHeight,explicitAriaRole,ariaLabel,accessibleDescription,ariaDisabled,ariaExpanded,ariaPressed,ariaChecked,ariaSelected,ariaHidden,tabIndex,...telemetry}=elementTelemetry(node);return telemetry};
// This boundary is earlier than any generated-document listener. Do not let a
// stopped or navigated unsupported event preserve the previous host selection.
addWindowListener('pointerdown',event=>{windowUnsupportedPointerHit=false;if(!event.isTrusted||!event.isPrimary||event.button!==0)return;canvasPointerSelection=undefined;const target=event.target instanceof Element?event.target:null;if(!target){if(canvasNavigationEnabled)report('clear-selection');return}const markedNode=target.closest('[data-selene-node-id]');if(canvasNavigationEnabled&&markedNode){const nodeId=apply(getAttribute,markedNode,['data-selene-node-id'])||'';canvasPointerSelection={target:markedNode,timeStamp:event.timeStamp};apply(preventDefault,event,[]);if(identifier.test(nodeId)){report('select-node',{nodeId,telemetry:elementTelemetry(markedNode)});return}report('clear-selection');inspectElementSequence+=1;report('inspect-element',{elementId:'unmapped-'+inspectElementSequence,telemetry:unmappedElementTelemetry(markedNode)});return}if(target.closest('[data-selene-flow-node][data-selene-action-port]'))return;windowUnsupportedPointerHit=true;windowUnsupportedPointerNavigation=canvasNavigationEnabled;suppressUnsupportedClick=!canvasNavigationEnabled;report('clear-selection');inspectElementSequence+=1;report('inspect-element',{elementId:'unmapped-'+inspectElementSequence,telemetry:unmappedElementTelemetry(markedNode||target)});if(canvasNavigationEnabled){canvasPointerSelection=undefined;apply(preventDefault,event,[])}apply(stopImmediate,event,[])},{capture:true});
addWindowListener('click',event=>{if(!windowUnsupportedPointerHit)return;windowUnsupportedPointerHit=false;if(!windowUnsupportedPointerNavigation)return;apply(preventDefault,event,[]);apply(stopImmediate,event,[])},{capture:true});addWindowListener('pointercancel',()=>{windowUnsupportedPointerHit=false},{capture:true});
document.addEventListener('click',event=>{const target=event.target instanceof Element?event.target:null;if(!target)return;const action=target.closest('[data-selene-flow-node][data-selene-action-port]');const markedNode=target.closest('[data-selene-node-id]');if(!canvasNavigationEnabled&&action){const nodeId=action.getAttribute('data-selene-flow-node')||'';const portId=action.getAttribute('data-selene-action-port')||'';if(identifier.test(nodeId)&&identifier.test(portId)){report('trigger-action',{nodeId,portId});return}}if(canvasNavigationEnabled)return;if(markedNode){const nodeId=markedNode.getAttribute('data-selene-node-id')||'';if(identifier.test(nodeId))report('select-node',{nodeId,telemetry:elementTelemetry(markedNode)});return}if(suppressUnsupportedClick){suppressUnsupportedClick=false;return}report('clear-selection');inspectElementSequence+=1;report('inspect-element',{elementId:'unmapped-'+inspectElementSequence,telemetry:unmappedElementTelemetry(target)})},{capture:true});
addWindowListener('click',event=>{if(!canvasNavigationEnabled||!event.isTrusted){if(!canvasNavigationEnabled)canvasPointerSelection=undefined;return}const target=event.target instanceof Element?event.target:null;const markedNode=target?target.closest('[data-selene-node-id]'):undefined;const priorPointerSelection=canvasPointerSelection;canvasPointerSelection=undefined;if(priorPointerSelection&&markedNode===priorPointerSelection.target&&event.timeStamp>=priorPointerSelection.timeStamp&&event.timeStamp-priorPointerSelection.timeStamp<1000){apply(preventDefault,event,[]);apply(stopImmediate,event,[]);return}if(!target){report('clear-selection');return}const inspected=markedNode||target;const nodeId=apply(getAttribute,inspected,['data-selene-node-id'])||'';apply(preventDefault,event,[]);apply(stopImmediate,event,[]);if(identifier.test(nodeId)){report('select-node',{nodeId,telemetry:elementTelemetry(inspected)});return}report('clear-selection');inspectElementSequence+=1;report('inspect-element',{elementId:'unmapped-'+inspectElementSequence,telemetry:unmappedElementTelemetry(inspected)})},{capture:true});addWindowListener('pointercancel',event=>{if(event.isTrusted&&event.isPrimary){canvasPointerSelection=undefined;suppressUnsupportedClick=false}},{capture:true});document.addEventListener('pointerdown',event=>{suppressUnsupportedClick=false;if(!event.isTrusted||!event.isPrimary||event.button!==0||canvasNavigationEnabled)return;const target=event.target instanceof Element?event.target:null;if(!target)return;const markedNode=target.closest('[data-selene-node-id]');if(markedNode||target.closest('[data-selene-flow-node][data-selene-action-port]'))return;suppressUnsupportedClick=true;report('clear-selection');inspectElementSequence+=1;report('inspect-element',{elementId:'unmapped-'+inspectElementSequence,telemetry:unmappedElementTelemetry(target)})},{capture:true});
document.addEventListener('keydown',event=>{if(!targetCancelEnabled||!event.isTrusted||event.defaultPrevented||event.isComposing||event.key!=='Escape')return;apply(preventDefault,event,[]);apply(stopImmediate,event,[]);report('target-cancel')},{capture:true});
const boundedDelta=value=>{if(!finite(value))return 0;const normalized=value>512?512:value< -512?-512:value;return normalized===0?0:normalized};const normalizedPoint=(value,size)=>{if(!finite(value)||!finite(size)||size<=0)return 0.5;const point=value/size;return point<0?0:point>1?1:point};
addWindowListener('wheel',event=>{if(!canvasNavigationEnabled||!event.isTrusted)return;const width=root.clientWidth;const height=root.clientHeight;const unit=event.deltaMode===1?16:event.deltaMode===2?(height>width?height:width):1;const deltaX=boundedDelta(event.deltaX*unit);const deltaY=boundedDelta(event.deltaY*unit);if(deltaX===0&&deltaY===0)return;apply(preventDefault,event,[]);report('canvas-gesture',{gesture:event.ctrlKey?'zoom':'pan',deltaX,deltaY,x:normalizedPoint(event.clientX,width),y:normalizedPoint(event.clientY,height)})},{capture:true,passive:false});
const waitForCommit=()=>new TrustedPromise(resolve=>{if(previewRoot&&apply(hasChildNodes,previewRoot,[])){resolve();return}commitObserver=new TrustedMutationObserver(()=>{if(previewRoot&&apply(hasChildNodes,previewRoot,[])){apply(disconnectMutation,commitObserver,[]);commitObserver=undefined;resolve()}});if(previewRoot)apply(observeMutation,commitObserver,[previewRoot,{childList:true,subtree:true}])});
// The Electron shell document may be file-backed, so it has no stable serializable
// target origin. The parent validates the trusted source window plus every fenced
// identifier below before accepting this best-effort readiness signal.
const readonlyStatus=(status,message='')=>{if(!root.dataset.previewScreenId||!root.dataset.previewProjectId)return;window.parent.postMessage({type:'selene-readonly-preview-status',nonce:policy.nonce,origin:policy.origin,revisionId:policy.revisionId,projectId:root.dataset.previewProjectId,screenId:root.dataset.previewScreenId,status,message:message.slice(0,256)},'*')};
const mountPreview=async()=>{try{await initialRuntime;const proofReady=window.__selenePreviewProofReady;if(typeof proofReady!=='object'||proofReady===null||typeof proofReady.then!=='function'||!(await proofReady))throw new TrustedError('Preview selection authority could not initialize');await import('./preview.js');await waitForCommit();await new TrustedPromise(resolve=>requestFrame(()=>requestFrame(resolve)));previewCommitted=true;if(pendingRuntimeState){dispatchRuntimeState(pendingRuntimeState);pendingRuntimeState=undefined}await new TrustedPromise(resolve=>requestFrame(()=>requestFrame(resolve)));if(previewRoot)previewRoot.hidden=false;await new TrustedPromise(resolve=>requestFrame(()=>requestFrame(resolve)));const bounds=previewRoot?apply(getBounds,previewRoot,[]):undefined;if(!bounds||!finite(bounds.width)||!finite(bounds.height)||bounds.width<=0||bounds.height<=0)throw new TrustedError('Preview committed no visible content');painted=true;if(pendingInspectNodeId){inspectNode(pendingInspectNodeId);pendingInspectNodeId=undefined}readonlyStatus('ready');reportPaint()}catch(error){const message=error instanceof TrustedError?error.message:'Preview module could not render';readonlyStatus('error',message);fail(message)}};void mountPreview()
</script></body></html>`;
}

export interface PublishedPreview {
  readonly url: string;
  readonly policy: PreviewSecurityPolicy;
  readonly revisionId: string;
}

/** Bounded protocol-backed artifact store. It serves generated code only to a sandboxed custom origin. */
export class PreviewArtifactRegistry {
  private readonly previews = new Map<string, PublishedPreviewArtifact>();
  private readonly selectionProofs = new Map<
    string,
    { readonly frameScope: string; readonly target: PreviewSelectionProofTarget }
  >();
  private readonly nativeSelectionReceipts = new Map<string, NativePreviewSelectionReceipt>();

  public publish(
    id: string,
    policy: PreviewSecurityPolicy,
    artifact: PreviewArtifact
  ): PublishedPreview {
    if (!PREVIEW_ID_PATTERN.test(id)) throw new PreviewMessageError('Preview ID is invalid');
    const canonical = canonicalPreviewPolicy(policy);
    this.previews.set(id, {
      policy: canonical,
      artifact,
      frameAuthorities: new Map()
    });
    this.selectionProofs.clear();
    this.nativeSelectionReceipts.clear();
    while (this.previews.size > 8)
      this.previews.delete(this.previews.keys().next().value as string);
    return {
      url: `selene-preview://local/${id}/index.html`,
      policy: canonical,
      revisionId: artifact.revisionId
    };
  }

  /**
   * Produces a read-only screen descriptor for a published artifact. The
   * descriptor is fenced to the exact nonce/revision policy already issued by
   * the host; it never grants a MessageChannel or renderer authority.
   */
  public describe(
    policy: PreviewSecurityPolicy,
    screenId: string,
    projectId?: string
  ): PreviewFrameDescriptor {
    if (!PREVIEW_SCREEN_ID_PATTERN.test(screenId))
      throw new PreviewMessageError('Preview screen ID is invalid');
    const canonical = canonicalPreviewPolicy(policy);
    for (const [id, entry] of this.previews) {
      if (
        entry.policy.origin !== canonical.origin ||
        entry.policy.nonce !== canonical.nonce ||
        entry.policy.maxMessageBytes !== canonical.maxMessageBytes ||
        entry.policy.csp !== canonical.csp
      )
        continue;
      if (
        entry.artifact.projectId === undefined ||
        entry.artifact.projectId !== projectId ||
        !entry.artifact.screenIds?.includes(screenId)
      )
        throw new PreviewMessageError('Preview screen is not published for this project');
      return {
        url: `selene-preview://local/${id}/screens/${screenId}/index.html`,
        policy: entry.policy,
        revisionId: entry.artifact.revisionId,
        screenId,
        projectId: entry.artifact.projectId
      };
    }
    throw new PreviewMessageError('Preview policy is not published');
  }

  /**
   * A policy may only be used for an artifact this registry published. This
   * prevents a renderer from fabricating an unrelated policy/revision pair
   * before its message reaches Electron's privileged process.
   */
  public validatePublishedMessage(policy: PreviewSecurityPolicy, value: unknown): PreviewMessage {
    const canonical = canonicalPreviewPolicy(policy);
    for (const entry of this.previews.values()) {
      if (
        entry.policy.origin !== canonical.origin ||
        entry.policy.nonce !== canonical.nonce ||
        entry.policy.maxMessageBytes !== canonical.maxMessageBytes ||
        entry.policy.csp !== canonical.csp
      )
        continue;
      try {
        return validatePreviewMessage(value, canonical, entry.artifact.revisionId);
      } catch {
        // A matching policy with a different revision remains untrusted.
      }
    }
    throw new PreviewMessageError('Preview policy or revision is not published');
  }

  /**
   * Converts one authenticated frame selection into a short-lived opaque proof.
   * The renderer receives only the random proof ID: node, source revision,
   * preview binding, and measured geometry remain in this main-process map.
   */
  private recordSelectionProof(
    entry: PublishedPreviewArtifact,
    frameScope: string,
    value: unknown
  ): PreviewSelectionProof {
    // A new physical trusted hit replaces every prior current-selection capability.
    this.selectionProofs.clear();
    const message = validatePreviewMessage(value, entry.policy, entry.artifact.revisionId);
    if (message.type !== 'select-node')
      throw new PreviewMessageError('Selection proof requires a trusted preview pointer hit');
    const { projectId, bindingId, compilerNodeIds } = entry.artifact;
    const { left, top, width, height, viewportWidth, viewportHeight } = message.telemetry;
    if (
      projectId === undefined ||
      bindingId === undefined ||
      compilerNodeIds === undefined ||
      !compilerNodeIds.includes(message.nodeId) ||
      left === undefined ||
      top === undefined ||
      viewportWidth === undefined ||
      viewportHeight === undefined ||
      width <= 0 ||
      height <= 0 ||
      left < 0 ||
      top < 0 ||
      left + width > viewportWidth ||
      top + height > viewportHeight
    )
      throw new PreviewMessageError('Preview selection has no bounded measured anchor');
    const proofId = randomUUID().replaceAll('-', '').slice(0, 32);
    this.selectionProofs.set(proofId, {
      frameScope,
      target: Object.freeze({
        format: 'selene-authenticated-artifact-element-target/v1',
        projectId,
        nodeRef: message.nodeId,
        revisionId: entry.artifact.revisionId,
        bindingId,
        anchor: Object.freeze({
          x: left / viewportWidth,
          y: top / viewportHeight,
          width: width / viewportWidth,
          height: height / viewportHeight,
          viewport: Object.freeze({ width: viewportWidth, height: viewportHeight }),
          nodeRef: message.nodeId
        })
      })
    });
    return Object.freeze({ format: 'selene-preview-selection-proof/v1', proofId });
  }

  private frameAuthority(
    entry: PublishedPreviewArtifact,
    frameScope: string
  ): PreviewFrameAuthority {
    let authority = entry.frameAuthorities.get(frameScope);
    if (authority === undefined) {
      authority = { nextCounter: 1 };
      entry.frameAuthorities.set(frameScope, authority);
    }
    return authority;
  }

  /**
   * Mints a brief, single-use bridge receipt from isolated-preload physical input.
   * The caller supplies only the observed frame URL and normalized point; this
   * registry resolves the published policy, binding, and frame scope itself.
   */
  public issueNativeSelectionBridge(
    previewUrl: string,
    x: unknown,
    y: unknown
  ): NativePreviewSelectionBridge {
    if (
      typeof x !== 'number' ||
      !Number.isFinite(x) ||
      x < 0 ||
      x > 1 ||
      typeof y !== 'number' ||
      !Number.isFinite(y) ||
      y < 0 ||
      y > 1
    )
      throw new PreviewMessageError('Native preview point is invalid');
    const parsed = new URL(previewUrl);
    if (
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.port !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    )
      throw new PreviewMessageError('Native preview frame is invalid');
    const segments = parsed.pathname.split('/');
    const direct =
      parsed.protocol === 'selene-preview:' &&
      parsed.hostname === 'local' &&
      segments.length === 3 &&
      segments[0] === '' &&
      PREVIEW_ID_PATTERN.test(segments[1] ?? '') &&
      segments[2] === 'index.html'
        ? { frameScope: directPreviewFrameScope, id: segments[1]! }
        : undefined;
    const screen =
      parsed.protocol === 'selene-preview:' &&
      parsed.hostname === 'local' &&
      segments.length === 5 &&
      segments[0] === '' &&
      PREVIEW_ID_PATTERN.test(segments[1] ?? '') &&
      segments[2] === 'screens' &&
      PREVIEW_SCREEN_ID_PATTERN.test(segments[3] ?? '') &&
      segments[4] === 'index.html'
        ? {
            frameScope: screenPreviewFrameScope(segments[3]!),
            id: segments[1]!,
            screenId: segments[3]!
          }
        : undefined;
    const frame = direct ?? screen;
    if (frame === undefined) throw new PreviewMessageError('Native preview frame is not active');
    const entry = this.previews.get(frame.id);
    if (
      entry === undefined ||
      entry.artifact.bindingId === undefined ||
      entry.artifact.projectId === undefined ||
      (screen !== undefined && !entry.artifact.screenIds?.includes(screen.screenId))
    )
      throw new PreviewMessageError('Native preview frame is not active');
    const now = Date.now();
    for (const [candidateId, receipt] of this.nativeSelectionReceipts) {
      if (now - receipt.issuedAt > 5_000) this.nativeSelectionReceipts.delete(candidateId);
    }
    while (this.nativeSelectionReceipts.size >= 32)
      this.nativeSelectionReceipts.delete(this.nativeSelectionReceipts.keys().next().value!);
    const receiptId = randomUUID().replaceAll('-', '').slice(0, 32);
    this.nativeSelectionReceipts.set(receiptId, {
      bindingId: entry.artifact.bindingId,
      frameScope: frame.frameScope,
      issuedAt: now,
      point: Object.freeze({ x, y }),
      previewId: frame.id,
      revisionId: entry.artifact.revisionId
    });
    return Object.freeze({
      nonce: entry.policy.nonce,
      origin: entry.policy.origin,
      receiptId,
      revisionId: entry.artifact.revisionId,
      x,
      y
    });
  }

  private consumeNativeSelectionReceipt(
    entry: PublishedPreviewArtifact,
    previewId: string,
    frameScope: string,
    receiptId: string,
    left: number,
    top: number,
    width: number,
    height: number,
    viewportWidth: number,
    viewportHeight: number
  ): void {
    const receipt = this.nativeSelectionReceipts.get(receiptId);
    this.nativeSelectionReceipts.delete(receiptId);
    if (
      receipt === undefined ||
      Date.now() - receipt.issuedAt > 5_000 ||
      receipt.previewId !== previewId ||
      receipt.frameScope !== frameScope ||
      receipt.revisionId !== entry.artifact.revisionId ||
      receipt.bindingId !== entry.artifact.bindingId
    )
      throw new PreviewMessageError('Native preview selection receipt is unavailable');
    const x = receipt.point.x * viewportWidth;
    const y = receipt.point.y * viewportHeight;
    if (x < left || x > left + width || y < top || y > top + height)
      throw new PreviewMessageError('Native preview receipt does not match the selected element');
  }

  /** Resolves the current frame-issued proof; action receipts, not proofs, are single-use. */
  public consumeSelectionProof(proofId: string): PreviewSelectionProofTarget {
    const proof = this.selectionProofs.get(proofId);
    if (proof === undefined)
      throw new PreviewMessageError('Preview selection proof is unavailable');
    return proof.target;
  }

  /** Safe revocation path used for clear, mode, and frame-lifecycle transitions. */
  public clearSelectionProofs(): void {
    this.selectionProofs.clear();
    this.nativeSelectionReceipts.clear();
  }

  public async handle(request: Request | string): Promise<Response> {
    const url = typeof request === 'string' ? request : request.url;
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/');
    const direct =
      segments.length === 3 &&
      segments[0] === '' &&
      typeof segments[1] === 'string' &&
      typeof segments[2] === 'string'
        ? { id: segments[1], resource: segments[2] }
        : undefined;
    const screen =
      segments.length === 5 &&
      segments[0] === '' &&
      segments[2] === 'screens' &&
      typeof segments[1] === 'string' &&
      typeof segments[3] === 'string' &&
      typeof segments[4] === 'string'
        ? { id: segments[1], screenId: segments[3], resource: segments[4] }
        : undefined;
    const id = direct?.id ?? screen?.id;
    const resource = direct?.resource ?? screen?.resource;
    if (
      parsed.protocol !== 'selene-preview:' ||
      parsed.hostname !== 'local' ||
      id === undefined ||
      !PREVIEW_ID_PATTERN.test(id)
    )
      return new Response('Preview not found', { status: 404 });
    const entry = this.previews.get(id);
    if (entry === undefined) return new Response('Preview not found', { status: 404 });
    if (
      screen !== undefined &&
      (!PREVIEW_SCREEN_ID_PATTERN.test(screen.screenId) ||
        !entry.artifact.screenIds?.includes(screen.screenId) ||
        entry.artifact.projectId === undefined)
    )
      return new Response('Preview screen not found', { status: 404 });
    const frameScope =
      screen === undefined ? directPreviewFrameScope : screenPreviewFrameScope(screen.screenId);
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (resource === 'selection-key') {
      const authority = this.frameAuthority(entry, frameScope);
      if (
        typeof request === 'string' ||
        request.method !== 'POST' ||
        !isJsonUtf8ContentType(request.headers.get('content-type')) ||
        authority.publicKey !== undefined
      )
        return new Response('Preview selection key is unavailable', { status: 403, headers });
      try {
        const body = await request.text();
        if (body.length === 0 || body.length > 1_024)
          throw new PreviewMessageError('Preview selection key body is invalid');
        const publicKey: unknown = JSON.parse(body);
        await webcrypto.subtle.importKey(
          'jwk',
          publicKey as JsonWebKey,
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['verify']
        );
        authority.publicKey = publicKey as JsonWebKey;
        return new Response('registered', { status: 200, headers });
      } catch {
        return new Response('Preview selection key is unavailable', { status: 403, headers });
      }
    }
    if (resource === 'selection-proof') {
      const authority = entry.frameAuthorities.get(frameScope);
      if (
        typeof request === 'string' ||
        request.method !== 'POST' ||
        !isJsonUtf8ContentType(request.headers.get('content-type')) ||
        authority === undefined ||
        authority.publicKey === undefined
      )
        return selectionProofRejection(headers, 'authority');
      try {
        const body = await request.text();
        if (body.length === 0 || body.length > 2_048)
          throw new PreviewMessageError('Preview selection proof body is invalid');
        const input: unknown = JSON.parse(body);
        if (
          typeof input !== 'object' ||
          input === null ||
          Array.isArray(input) ||
          ![
            [
              'counter',
              'height',
              'left',
              'nodeId',
              'signature',
              'top',
              'viewportHeight',
              'viewportWidth',
              'width'
            ],
            [
              'counter',
              'height',
              'left',
              'nodeId',
              'receiptId',
              'signature',
              'top',
              'viewportHeight',
              'viewportWidth',
              'width'
            ]
          ].some(
            (fields) => Object.keys(input).sort().join('\u0000') === fields.sort().join('\u0000')
          )
        )
          throw new PreviewMessageError('Preview selection proof input is invalid');
        const value = input as Record<string, unknown>;
        if (
          typeof value.counter !== 'number' ||
          !Number.isSafeInteger(value.counter) ||
          value.counter !== authority.nextCounter ||
          typeof value.signature !== 'string' ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(value.signature)
        )
          throw new PreviewMessageError('Preview selection proof counter is invalid');
        if (
          value.receiptId !== undefined &&
          (typeof value.receiptId !== 'string' || !/^[a-f0-9]{32}$/.test(value.receiptId))
        )
          throw new PreviewMessageError('Preview selection receipt is invalid');
        const canonical = JSON.stringify({
          counter: value.counter,
          nodeId: value.nodeId,
          left: value.left,
          top: value.top,
          width: value.width,
          height: value.height,
          viewportWidth: value.viewportWidth,
          viewportHeight: value.viewportHeight,
          ...(value.receiptId === undefined ? {} : { receiptId: value.receiptId })
        });
        const publicKey = await webcrypto.subtle.importKey(
          'jwk',
          authority.publicKey,
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['verify']
        );
        const verified = await webcrypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          publicKey,
          Buffer.from(value.signature, 'base64'),
          new TextEncoder().encode(canonical)
        );
        if (!verified) throw new PreviewMessageError('Preview selection signature is invalid');
        // A valid signed physical hit advances the frame counter even if its
        // node or measured bounds are later rejected by semantic validation.
        authority.nextCounter += 1;
        const receiptId = value.receiptId;
        if (typeof receiptId === 'string')
          this.consumeNativeSelectionReceipt(
            entry,
            id,
            frameScope,
            receiptId,
            value.left as number,
            value.top as number,
            value.width as number,
            value.height as number,
            value.viewportWidth as number,
            value.viewportHeight as number
          );
        const message = {
          type: 'select-node' as const,
          nonce: entry.policy.nonce,
          origin: entry.policy.origin,
          revisionId: entry.artifact.revisionId,
          interactionSequence: 1,
          nodeId: value.nodeId,
          telemetry: {
            hierarchy: [{ nodeId: value.nodeId, semanticTag: 'div' }],
            left: value.left,
            top: value.top,
            width: value.width,
            height: value.height,
            viewportWidth: value.viewportWidth,
            viewportHeight: value.viewportHeight,
            display: 'block',
            position: 'static',
            boxSizing: 'border-box',
            margin: '',
            padding: '',
            gap: '',
            flexDirection: 'row',
            alignItems: 'normal',
            justifyContent: 'normal',
            gridTemplateColumns: 'none',
            gridTemplateRows: 'none',
            overflow: 'visible',
            fontFamily: '',
            fontSize: '',
            fontWeight: '',
            lineHeight: '',
            letterSpacing: '',
            textAlign: 'start',
            textDecoration: 'none',
            color: '',
            backgroundColor: '',
            border: '',
            borderRadius: '',
            boxShadow: '',
            opacity: '1',
            semanticTag: 'div',
            explicitAriaRole: '',
            ariaLabel: '',
            accessibleDescription: '',
            ariaDisabled: '',
            ariaExpanded: '',
            ariaPressed: '',
            ariaChecked: '',
            ariaSelected: '',
            ariaHidden: '',
            tabIndex: -1
          }
        };
        const proof = this.recordSelectionProof(entry, frameScope, message);
        return Response.json(
          value.receiptId === undefined ? proof : { proof, selection: message },
          { headers }
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const reason = message.includes('body is invalid')
          ? 'body'
          : message.includes('input is invalid')
            ? 'input'
            : message.includes('counter is invalid')
              ? 'counter'
              : message.includes('receipt is invalid')
                ? 'receipt-input'
                : message.includes('signature is invalid')
                  ? 'signature'
                  : message.includes('receipt is unavailable')
                    ? 'receipt-unavailable'
                    : message.includes('receipt does not match')
                      ? 'receipt-mismatch'
                      : 'target';
        // TEMPORARY CI forensics. This is deliberately only a bounded
        // classifier: no payload, identities, geometry, or key material.
        console.error(`[selene-selection-proof-rejection] ${reason}`);
        return selectionProofRejection(headers, reason);
      }
    }
    if (resource === 'index.html') {
      return new Response(
        createPreviewDocument(
          entry.policy,
          entry.artifact.revisionId,
          screen?.screenId,
          screen === undefined ? undefined : entry.artifact.projectId
        ),
        {
          headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' }
        }
      );
    }
    if (
      resource === 'preview.js' &&
      entry.artifact.bindingId !== undefined &&
      entry.frameAuthorities.get(frameScope)?.publicKey === undefined
    )
      return new Response('Preview selection authority is not ready', { status: 425, headers });
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
