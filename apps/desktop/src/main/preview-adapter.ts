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
  readonly screenIds?: readonly string[];
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
  return `<!doctype html>
<html data-preview-origin="${origin}" data-preview-nonce="${nonce}" data-preview-revision-id="${revision}"${screenId === undefined ? '' : ` data-preview-screen-id="${screen}"`}${projectId === undefined ? '' : ` data-preview-project-id="${project}"`}>
<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${canonical.csp}"><link rel="stylesheet" href="preview.css"></head>
<body><div id="root"></div><script type="module" nonce="${canonical.nonce}">
const root=document.documentElement;const decode=value=>decodeURIComponent(value||'');
const policy=Object.freeze({origin:decode(root.dataset.previewOrigin),nonce:decode(root.dataset.previewNonce),revisionId:decode(root.dataset.previewRevisionId)});let previewCommitted=false;let pendingRuntimeState;let pendingInspectNodeId;const dispatchRuntimeState=state=>dispatchWindow(new TrustedCustomEvent('selene-runtime-state',{detail:state}));
const identifier=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;let port;let closed=false;let canvasNavigationEnabled=false;let canvasPointerSelection=false;let suppressUnsupportedClick=false;let targetCancelEnabled=false;let selectionInteractionSequence=0;
const previewRoot=document.getElementById('root');if(previewRoot)previewRoot.hidden=true;const apply=Reflect.apply;const TrustedPromise=Promise;const TrustedError=Error;const TrustedSet=Set;const TrustedCustomEvent=CustomEvent;const dispatchWindow=window.dispatchEvent.bind(window);const postMessage=MessagePort.prototype.postMessage;const postParentMessage=window.parent.postMessage.bind(window.parent);const addPortListener=MessagePort.prototype.addEventListener;const startPort=MessagePort.prototype.start;const closePort=MessagePort.prototype.close;const stopImmediate=Event.prototype.stopImmediatePropagation;const preventDefault=Event.prototype.preventDefault;const requestFrame=window.requestAnimationFrame.bind(window);const addWindowListener=window.addEventListener.bind(window);const removeWindowListener=window.removeEventListener.bind(window);const queryMarkedNodes=document.querySelectorAll.bind(document);const hasChildNodes=Node.prototype.hasChildNodes;const containsNode=Node.prototype.contains;const getParentElement=Object.getOwnPropertyDescriptor(Node.prototype,'parentElement').get;const getTagName=Object.getOwnPropertyDescriptor(Element.prototype,'tagName').get;const getBounds=Element.prototype.getBoundingClientRect;const getAttribute=Element.prototype.getAttribute;const computedStyle=window.getComputedStyle.bind(window);const finite=Number.isFinite;const TrustedMutationObserver=MutationObserver;const observeMutation=MutationObserver.prototype.observe;const disconnectMutation=MutationObserver.prototype.disconnect;const readonlyPreview=Boolean(root.dataset.previewScreenId&&root.dataset.previewProjectId);let commitObserver;let acceptInitialRuntime;const initialRuntime=new TrustedPromise(resolve=>{acceptInitialRuntime=resolve});if(readonlyPreview)acceptInitialRuntime();
const fields=(value,allowed)=>{try{if(!value||typeof value!=='object'||Array.isArray(value))return null;const descriptors=Object.getOwnPropertyDescriptors(value);const keys=Reflect.ownKeys(descriptors);if(keys.some(key=>typeof key!=='string'||!allowed.includes(key)))return null;const output=Object.create(null);for(const key of keys){const descriptor=descriptors[key];if(!descriptor||!descriptor.enumerable||!Object.prototype.hasOwnProperty.call(descriptor,'value'))return null;output[key]=descriptor.value}return Object.freeze(output)}catch{return null}};
const identifiers=(value,limit)=>{try{if(!Array.isArray(value))return null;const descriptors=Object.getOwnPropertyDescriptors(value);const length=descriptors.length;if(!length||!Object.prototype.hasOwnProperty.call(length,'value')||length.enumerable||!Number.isSafeInteger(length.value)||length.value<0||length.value>limit||Reflect.ownKeys(descriptors).length!==length.value+1)return null;const output=[];for(let index=0;index<length.value;index+=1){const descriptor=descriptors[String(index)];if(!descriptor||!descriptor.enumerable||!Object.prototype.hasOwnProperty.call(descriptor,'value')||typeof descriptor.value!=='string'||!identifier.test(descriptor.value))return null;output.push(descriptor.value)}return Object.freeze(output)}catch{return null}};
const channel=value=>{const next=fields(value,['type','nonce','origin','revisionId','state','enabled','nodeId']);if(!next||next.nonce!==policy.nonce||next.origin!==policy.origin||next.revisionId!==policy.revisionId)return null;if(next.type==='canvas-navigation'||next.type==='target-cancel')return typeof next.enabled==='boolean'&&next.state===undefined&&next.nodeId===undefined?Object.freeze({type:next.type,enabled:next.enabled}):null;if(next.type==='inspect-node')return next.enabled===undefined&&next.state===undefined&&typeof next.nodeId==='string'&&identifier.test(next.nodeId)?Object.freeze({type:next.type,nodeId:next.nodeId}):null;if(next.type!=='runtime-state'||next.enabled!==undefined||next.nodeId!==undefined)return null;const state=fields(next.state,['activeNodeId','activeStateId','activeOverlayId','activePathTransitionIds']);if(!state||typeof state.activeNodeId!=='string'||!identifier.test(state.activeNodeId)||(state.activeStateId!==undefined&&(typeof state.activeStateId!=='string'||!identifier.test(state.activeStateId)))||(state.activeOverlayId!==undefined&&(typeof state.activeOverlayId!=='string'||!identifier.test(state.activeOverlayId))))return null;const activePathTransitionIds=identifiers(state.activePathTransitionIds,256);if(!activePathTransitionIds)return null;return Object.freeze({type:'runtime-state',state:Object.freeze({activeNodeId:state.activeNodeId,...(state.activeStateId?{activeStateId:state.activeStateId}:{}),...(state.activeOverlayId?{activeOverlayId:state.activeOverlayId}:{}),activePathTransitionIds})})};
const report=(type,extra={})=>{if(closed)return;const interactionSequence=type==='clear-selection'||type==='select-node'?++selectionInteractionSequence:undefined;const message={type,origin:policy.origin,nonce:policy.nonce,revisionId:policy.revisionId,...(interactionSequence===undefined?{}:{interactionSequence}),...extra};if(port)apply(postMessage,port,[message]);if(interactionSequence!==undefined)postParentMessage(message,'*')};
let painted=false;let renderFailure;let inspectElementSequence=0;let windowUnsupportedPointerHit=false;let windowUnsupportedPointerNavigation=false;const reportPaint=()=>{if(painted)report('rendered')};const reportFailure=()=>{if(renderFailure)report('runtime-error',{message:renderFailure})};const fail=message=>{renderFailure=(String(message).trim()||'Preview module could not render').slice(0,4000);reportFailure()};
const initialize=event=>{if(!event.isTrusted||event.source!==window.parent||port)return;apply(stopImmediate,event,[]);const value=fields(event.data,['type','nonce','revisionId','enabled','state']);const initial=value?channel({type:'runtime-state',nonce:value.nonce,origin:policy.origin,revisionId:value.revisionId,state:value.state}):null;if(!value||value.type!=='selene-preview-init'||value.nonce!==policy.nonce||value.revisionId!==policy.revisionId||typeof value.enabled!=='boolean'||!initial||event.ports.length!==1)return;removeWindowListener('message',initialize,true);canvasNavigationEnabled=value.enabled;pendingRuntimeState=initial.state;port=event.ports[0];apply(addPortListener,port,['message',event=>{if(closed)return;const message=channel(event.data);if(!message)return;if(message.type==='canvas-navigation'){canvasNavigationEnabled=message.enabled;if(!message.enabled)canvasPointerSelection=false;return}if(message.type==='target-cancel'){targetCancelEnabled=message.enabled;return}if(message.type==='inspect-node'){if(!previewCommitted)pendingInspectNodeId=message.nodeId;else inspectNode(message.nodeId);return}if(!previewCommitted){pendingRuntimeState=message.state;return}dispatchRuntimeState(message.state)}]);apply(startPort,port,[]);acceptInitialRuntime();report('ready');reportFailure();reportPaint()};
addWindowListener('message',initialize,true);addWindowListener('pagehide',()=>{closed=true;canvasPointerSelection=false;removeWindowListener('message',initialize,true);if(commitObserver)apply(disconnectMutation,commitObserver,[]);if(port)apply(closePort,port,[]);port=undefined},{once:true});addWindowListener('error',event=>fail(event.message),true);
const markedHierarchy=node=>{const hierarchy=[];let current=node;let depth=0;while(current&&hierarchy.length<16&&depth<256){depth+=1;const nodeId=apply(getAttribute,current,['data-selene-node-id'])||'';if(identifier.test(nodeId)&&hierarchy[0]?.nodeId!==nodeId){const semanticTag=String(apply(getTagName,current,[])).toLowerCase().slice(0,128);if(/^[a-z][a-z0-9-]{0,127}$/.test(semanticTag))hierarchy.unshift(Object.freeze({nodeId,semanticTag}))}current=apply(getParentElement,current,[])}return Object.freeze(hierarchy)};
const alignmentTargets=node=>{const targets=[];const nodeIds=new TrustedSet();const selectedNodeId=apply(getAttribute,node,['data-selene-node-id'])||'';if(identifier.test(selectedNodeId))nodeIds.add(selectedNodeId);const nodes=queryMarkedNodes('[data-selene-node-id]');const limit=Math.min(nodes.length,10000);for(let index=0;index<limit&&targets.length<64;index+=1){const candidate=nodes[index];if(!candidate||candidate===node||apply(containsNode,node,[candidate])||apply(containsNode,candidate,[node]))continue;const nodeId=apply(getAttribute,candidate,['data-selene-node-id'])||'';if(!identifier.test(nodeId)||nodeIds.has(nodeId))continue;const rect=apply(getBounds,candidate,[]);if(!finite(rect.left)||!finite(rect.top)||!finite(rect.width)||!finite(rect.height)||rect.width<=0||rect.height<=0)continue;nodeIds.add(nodeId);targets.push(Object.freeze({nodeId,left:rect.left,top:rect.top,width:rect.width,height:rect.height}))}return Object.freeze(targets)};
const measuredConstraint=value=>{const numeric=Number.parseFloat(value);return finite(numeric)&&numeric>=0?Math.min(100000,numeric):undefined};const elementTelemetry=node=>{const style=computedStyle(node);const rect=apply(getBounds,node,[]);const parent=apply(getParentElement,node,[]);const parentRect=parent?apply(getBounds,parent,[]):undefined;const attribute=name=>(apply(getAttribute,node,[name])||'').slice(0,256);const minWidth=measuredConstraint(style.minWidth);const minHeight=measuredConstraint(style.minHeight);const maxWidth=measuredConstraint(style.maxWidth);const maxHeight=measuredConstraint(style.maxHeight);const parentWidth=parentRect&&finite(parentRect.width)&&parentRect.width>=0?Math.min(100000,parentRect.width):undefined;const parentHeight=parentRect&&finite(parentRect.height)&&parentRect.height>=0?Math.min(100000,parentRect.height):undefined;return {hierarchy:markedHierarchy(node),alignmentTargets:alignmentTargets(node),left:rect.left,top:rect.top,width:Math.max(0,rect.width),height:Math.max(0,rect.height),...(minWidth===undefined?{}:{minWidth}),...(minHeight===undefined?{}:{minHeight}),...(maxWidth===undefined?{}:{maxWidth}),...(maxHeight===undefined?{}:{maxHeight}),...(parentWidth===undefined?{}:{parentWidth}),...(parentHeight===undefined?{}:{parentHeight}),display:style.display.slice(0,256),position:style.position.slice(0,256),boxSizing:style.boxSizing.slice(0,256),margin:style.margin.slice(0,256),padding:style.padding.slice(0,256),gap:style.gap.slice(0,256),flexDirection:style.flexDirection.slice(0,256),alignItems:style.alignItems.slice(0,256),justifyContent:style.justifyContent.slice(0,256),gridTemplateColumns:style.gridTemplateColumns.slice(0,256),gridTemplateRows:style.gridTemplateRows.slice(0,256),overflow:style.overflow.slice(0,256),fontFamily:style.fontFamily.slice(0,256),fontSize:style.fontSize.slice(0,256),fontWeight:style.fontWeight.slice(0,256),lineHeight:style.lineHeight.slice(0,256),letterSpacing:style.letterSpacing.slice(0,256),textAlign:style.textAlign.slice(0,256),textDecoration:style.textDecoration.slice(0,256),color:style.color.slice(0,256),backgroundColor:style.backgroundColor.slice(0,256),border:style.border.slice(0,256),borderRadius:style.borderRadius.slice(0,256),boxShadow:style.boxShadow.slice(0,512),opacity:style.opacity.slice(0,256),semanticTag:String(apply(getTagName,node,[])).toLowerCase().slice(0,256),explicitAriaRole:attribute('role'),ariaLabel:attribute('aria-label'),accessibleDescription:(attribute('aria-description')||attribute('title')).slice(0,256),ariaDisabled:attribute('aria-disabled'),ariaExpanded:attribute('aria-expanded'),ariaPressed:attribute('aria-pressed'),ariaChecked:attribute('aria-checked'),ariaSelected:attribute('aria-selected'),ariaHidden:attribute('aria-hidden'),tabIndex:node instanceof HTMLElement?Math.max(-1,Math.min(32767,node.tabIndex)):-1}};
const inspectNode=nodeId=>{const nodes=queryMarkedNodes('[data-selene-node-id]');const limit=Math.min(nodes.length,10000);let match;for(let index=0;index<limit;index+=1){const node=nodes[index];if(node&&apply(getAttribute,node,['data-selene-node-id'])===nodeId){if(match)return;match=node}}if(match)report('inspect-node-result',{nodeId,telemetry:elementTelemetry(match)})};
const unmappedElementTelemetry=node=>{const {hierarchy,alignmentTargets,minWidth,minHeight,maxWidth,maxHeight,parentWidth,parentHeight,explicitAriaRole,ariaLabel,accessibleDescription,ariaDisabled,ariaExpanded,ariaPressed,ariaChecked,ariaSelected,ariaHidden,tabIndex,...telemetry}=elementTelemetry(node);return telemetry};
// This boundary is earlier than any generated-document listener. Do not let a
// stopped or navigated unsupported event preserve the previous host selection.
addWindowListener('pointerdown',event=>{windowUnsupportedPointerHit=false;if(!event.isTrusted||!event.isPrimary||event.button!==0)return;const target=event.target instanceof Element?event.target:null;if(!target)return;const markedNode=target.closest('[data-selene-node-id]');if(markedNode||target.closest('[data-selene-flow-node][data-selene-action-port]'))return;windowUnsupportedPointerHit=true;windowUnsupportedPointerNavigation=canvasNavigationEnabled;suppressUnsupportedClick=!canvasNavigationEnabled;report('clear-selection');inspectElementSequence+=1;report('inspect-element',{elementId:'unmapped-'+inspectElementSequence,telemetry:unmappedElementTelemetry(markedNode||target)});if(canvasNavigationEnabled){canvasPointerSelection=false;apply(preventDefault,event,[])}apply(stopImmediate,event,[])},{capture:true});
addWindowListener('click',event=>{if(!windowUnsupportedPointerHit)return;windowUnsupportedPointerHit=false;if(!windowUnsupportedPointerNavigation)return;apply(preventDefault,event,[]);apply(stopImmediate,event,[])},{capture:true});addWindowListener('pointercancel',()=>{windowUnsupportedPointerHit=false},{capture:true});
document.addEventListener('click',event=>{const target=event.target instanceof Element?event.target:null;if(!target)return;const action=target.closest('[data-selene-flow-node][data-selene-action-port]');const markedNode=target.closest('[data-selene-node-id]');if(!canvasNavigationEnabled&&action){const nodeId=action.getAttribute('data-selene-flow-node')||'';const portId=action.getAttribute('data-selene-action-port')||'';if(identifier.test(nodeId)&&identifier.test(portId)){report('trigger-action',{nodeId,portId});return}}if(canvasNavigationEnabled){if(canvasPointerSelection){canvasPointerSelection=false;apply(preventDefault,event,[]);apply(stopImmediate,event,[]);return}const inspected=markedNode||target;const nodeId=apply(getAttribute,inspected,['data-selene-node-id'])||'';apply(preventDefault,event,[]);apply(stopImmediate,event,[]);if(identifier.test(nodeId)){report('select-node',{nodeId,telemetry:elementTelemetry(inspected)});return}report('clear-selection');inspectElementSequence+=1;report('inspect-element',{elementId:'unmapped-'+inspectElementSequence,telemetry:unmappedElementTelemetry(inspected)});return}if(markedNode){const nodeId=markedNode.getAttribute('data-selene-node-id')||'';if(identifier.test(nodeId))report('select-node',{nodeId,telemetry:elementTelemetry(markedNode)});return}if(suppressUnsupportedClick){suppressUnsupportedClick=false;return}report('clear-selection');inspectElementSequence+=1;report('inspect-element',{elementId:'unmapped-'+inspectElementSequence,telemetry:unmappedElementTelemetry(target)})},{capture:true});
addWindowListener('click',event=>{if(!canvasPointerSelection||!canvasNavigationEnabled||!event.isTrusted){if(!canvasNavigationEnabled)canvasPointerSelection=false;return}canvasPointerSelection=false;apply(preventDefault,event,[]);apply(stopImmediate,event,[])},{capture:true});addWindowListener('pointercancel',event=>{if(event.isTrusted&&event.isPrimary){canvasPointerSelection=false;suppressUnsupportedClick=false}},{capture:true});document.addEventListener('pointerdown',event=>{canvasPointerSelection=false;suppressUnsupportedClick=false;if(!event.isTrusted||!event.isPrimary||event.button!==0)return;const target=event.target instanceof Element?event.target:null;if(!target)return;const markedNode=target.closest('[data-selene-node-id]');if(!canvasNavigationEnabled){if(markedNode||target.closest('[data-selene-flow-node][data-selene-action-port]'))return;suppressUnsupportedClick=true;report('clear-selection');inspectElementSequence+=1;report('inspect-element',{elementId:'unmapped-'+inspectElementSequence,telemetry:unmappedElementTelemetry(target)});return}const inspected=markedNode||target;canvasPointerSelection=true;apply(preventDefault,event,[]);apply(stopImmediate,event,[]);const nodeId=apply(getAttribute,inspected,['data-selene-node-id'])||'';if(identifier.test(nodeId)){report('select-node',{nodeId,telemetry:elementTelemetry(inspected)});return}report('clear-selection');inspectElementSequence+=1;report('inspect-element',{elementId:'unmapped-'+inspectElementSequence,telemetry:unmappedElementTelemetry(inspected)})},{capture:true});
document.addEventListener('keydown',event=>{if(!targetCancelEnabled||!event.isTrusted||event.defaultPrevented||event.isComposing||event.key!=='Escape')return;apply(preventDefault,event,[]);apply(stopImmediate,event,[]);report('target-cancel')},{capture:true});
const boundedDelta=value=>{if(!finite(value))return 0;const normalized=value>512?512:value< -512?-512:value;return normalized===0?0:normalized};const normalizedPoint=(value,size)=>{if(!finite(value)||!finite(size)||size<=0)return 0.5;const point=value/size;return point<0?0:point>1?1:point};
addWindowListener('wheel',event=>{if(!canvasNavigationEnabled||!event.isTrusted)return;const width=root.clientWidth;const height=root.clientHeight;const unit=event.deltaMode===1?16:event.deltaMode===2?(height>width?height:width):1;const deltaX=boundedDelta(event.deltaX*unit);const deltaY=boundedDelta(event.deltaY*unit);if(deltaX===0&&deltaY===0)return;apply(preventDefault,event,[]);report('canvas-gesture',{gesture:event.ctrlKey?'zoom':'pan',deltaX,deltaY,x:normalizedPoint(event.clientX,width),y:normalizedPoint(event.clientY,height)})},{capture:true,passive:false});
const waitForCommit=()=>new TrustedPromise(resolve=>{if(previewRoot&&apply(hasChildNodes,previewRoot,[])){resolve();return}commitObserver=new TrustedMutationObserver(()=>{if(previewRoot&&apply(hasChildNodes,previewRoot,[])){apply(disconnectMutation,commitObserver,[]);commitObserver=undefined;resolve()}});if(previewRoot)apply(observeMutation,commitObserver,[previewRoot,{childList:true,subtree:true}])});
// The Electron shell document may be file-backed, so it has no stable serializable
// target origin. The parent validates the trusted source window plus every fenced
// identifier below before accepting this best-effort readiness signal.
const readonlyStatus=(status,message='')=>{if(!root.dataset.previewScreenId||!root.dataset.previewProjectId)return;window.parent.postMessage({type:'selene-readonly-preview-status',nonce:policy.nonce,origin:policy.origin,revisionId:policy.revisionId,projectId:root.dataset.previewProjectId,screenId:root.dataset.previewScreenId,status,message:message.slice(0,256)},'*')};
const mountPreview=async()=>{try{await initialRuntime;await import('./preview.js');await waitForCommit();await new TrustedPromise(resolve=>requestFrame(()=>requestFrame(resolve)));previewCommitted=true;if(pendingRuntimeState){dispatchRuntimeState(pendingRuntimeState);pendingRuntimeState=undefined}await new TrustedPromise(resolve=>requestFrame(()=>requestFrame(resolve)));if(previewRoot)previewRoot.hidden=false;await new TrustedPromise(resolve=>requestFrame(()=>requestFrame(resolve)));const bounds=previewRoot?apply(getBounds,previewRoot,[]):undefined;if(!bounds||!finite(bounds.width)||!finite(bounds.height)||bounds.width<=0||bounds.height<=0)throw new TrustedError('Preview committed no visible content');painted=true;if(pendingInspectNodeId){inspectNode(pendingInspectNodeId);pendingInspectNodeId=undefined}readonlyStatus('ready');reportPaint()}catch(error){const message=error instanceof TrustedError?error.message:'Preview module could not render';readonlyStatus('error',message);fail(message)}};void mountPreview()
</script></body></html>`;
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

  public async handle(url: string): Promise<Response> {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/');
    const direct =
      segments.length === 3 && segments[0] === ''
        ? { id: segments[1], resource: segments[2] }
        : undefined;
    const screen =
      segments.length === 5 && segments[0] === '' && segments[2] === 'screens'
        ? { id: segments[1], screenId: segments[3], resource: segments[4] }
        : undefined;
    const id = direct?.id ?? screen?.id;
    const resource = direct?.resource ?? screen?.resource;
    const entry =
      parsed.protocol === 'selene-preview:' &&
      parsed.hostname === 'local' &&
      id !== undefined &&
      PREVIEW_ID_PATTERN.test(id)
        ? this.previews.get(id)
        : undefined;
    if (entry === undefined) return new Response('Preview not found', { status: 404 });
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (resource === 'index.html') {
      if (
        screen &&
        (screen.screenId === undefined ||
          !PREVIEW_SCREEN_ID_PATTERN.test(screen.screenId) ||
          !entry.artifact.screenIds?.includes(screen.screenId) ||
          entry.artifact.projectId === undefined)
      )
        return new Response('Preview screen not found', { status: 404 });
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
