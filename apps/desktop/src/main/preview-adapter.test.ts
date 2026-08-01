import { webcrypto } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import {
  createSourceFile,
  forEachChild,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isStringLiteral,
  ModuleKind,
  ScriptKind,
  ScriptTarget,
  transpileModule,
  type ArrowFunction,
  type Node
} from '@selene/preview-adapter-typescript6-api';

import {
  createPreviewDocument,
  createPreviewSecurityPolicy,
  PreviewArtifactRegistry,
  validatePreviewMessage
} from './preview-adapter';

const validTelemetry = {
  hierarchy: [
    { nodeId: 'app.root', semanticTag: 'main' },
    { nodeId: 'orders.root', semanticTag: 'button' }
  ],
  alignmentTargets: [{ nodeId: 'orders.summary', left: 372, top: 32, width: 240, height: 48 }],
  left: 24,
  top: 32,
  width: 320,
  height: 48,
  minWidth: 160,
  minHeight: 32,
  maxWidth: 640,
  maxHeight: 96,
  parentWidth: 480,
  parentHeight: 320,
  display: 'flex',
  position: 'relative',
  boxSizing: 'border-box',
  margin: '0px',
  padding: '12px 16px',
  gap: '8px',
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
  gridTemplateColumns: 'none',
  gridTemplateRows: 'none',
  overflow: 'visible',
  fontFamily: 'Inter',
  fontSize: '14px',
  fontWeight: '500',
  lineHeight: '20px',
  letterSpacing: 'normal',
  textAlign: 'start',
  textDecoration: 'none',
  color: 'rgb(0, 0, 0)',
  backgroundColor: 'rgb(255, 255, 255)',
  border: '0px none rgb(0, 0, 0)',
  borderRadius: '8px',
  boxShadow: 'none',
  opacity: '1',
  semanticTag: 'button',
  explicitAriaRole: '',
  ariaLabel: 'Continue',
  accessibleDescription: '',
  ariaDisabled: '',
  ariaExpanded: '',
  ariaPressed: '',
  ariaChecked: '',
  ariaSelected: '',
  ariaHidden: '',
  tabIndex: 0
} as const;

function inlinePreviewModule(document: string): string {
  const opening = '<script type="module"';
  const openingIndex = document.indexOf(opening);
  if (openingIndex < 0) throw new Error('Preview document has no inline module.');
  const sourceStart = document.indexOf('>', openingIndex) + 1;
  const sourceEnd = document.indexOf('</script>', sourceStart);
  if (sourceStart <= openingIndex || sourceEnd < sourceStart)
    throw new Error('Preview inline module is malformed.');
  return document.slice(sourceStart, sourceEnd);
}

function documentEventListener(source: Node, eventType: string): ArrowFunction | undefined {
  let listener: ArrowFunction | undefined;
  const visit = (node: Node): void => {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'document' &&
      node.expression.name.text === 'addEventListener'
    ) {
      const [eventName, callback] = node.arguments;
      if (
        eventName !== undefined &&
        callback !== undefined &&
        isStringLiteral(eventName) &&
        eventName.text === eventType &&
        isArrowFunction(callback)
      )
        listener = callback;
    }
    forEachChild(node, visit);
  };
  visit(source);
  return listener;
}

function containsStringLiteral(source: Node, value: string): boolean {
  let found = false;
  const visit = (node: Node): void => {
    if (isStringLiteral(node) && node.text === value) found = true;
    forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('isolated preview transport', () => {
  const policy = createPreviewSecurityPolicy('selene-preview://local', '1234567890abcdef');

  it('uses a nonce CSP and accepts only typed same-origin messages', () => {
    const document = createPreviewDocument(policy, 'r2');
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("await import('./preview.js')");
    expect(document).toContain('href="preview.css"');
    expect(document).toContain("style-src 'self' 'unsafe-inline'");
    expect(document).toContain("script-src 'self' 'nonce-");
    expect(document).toContain("closest('[data-selene-node-id]')");
    expect(document).toContain('event.source!==window.parent');
    expect(document).toContain('!event.isTrusted');
    expect(document).toContain('apply(stopImmediate,event,[])');
    expect(document).toContain('event.ports.length!==1');
    expect(document).toContain(
      "fields(event.data,['type','nonce','revisionId','enabled','state'])"
    );
    expect(document).toContain("typeof value.enabled!=='boolean'");
    expect(document).toContain(
      "canvasNavigationEnabled=value.enabled;root.dataset.seleneCanvasNavigation=value.enabled?'design':'prototype';pendingRuntimeState=initial.state;port=event.ports[0]"
    );
    expect(document).toContain("apply(startPort,port,[]);acceptInitialRuntime();report('ready')");
    expect(document).toContain('value.nonce!==policy.nonce||value.revisionId!==policy.revisionId');
    expect(document).toContain("type==='inspect-node'");
    expect(document).toContain(
      "const dispatchRuntimeState=state=>dispatchWindow(new TrustedCustomEvent('selene-runtime-state',{detail:state}))"
    );
    expect(document).toContain('if(previewRoot)previewRoot.hidden=true');
    expect(document).toContain(
      'const readonlyPreview=Boolean(root.dataset.previewScreenId&&root.dataset.previewProjectId)'
    );
    expect(document).toContain('if(readonlyPreview)acceptInitialRuntime()');
    expect(document).toContain(
      'try{await initialRuntime;const proofReady=window.__selenePreviewProofReady;'
    );
    expect(document).toContain(
      "if(typeof proofReady!=='object'||proofReady===null||typeof proofReady.then!=='function'||!(await proofReady))throw new TrustedError('Preview selection authority could not initialize');await import('./preview.js')"
    );
    expect(document.indexOf('if(previewRoot)previewRoot.hidden=false')).toBeLessThan(
      document.indexOf('if(pendingInspectNodeId){inspectNode(pendingInspectNodeId)')
    );
    const inlineModule = inlinePreviewModule(document);
    expect(inlineModule).toContain(
      "if(identifier.test(nodeId)){report('select-node',{nodeId,telemetry:elementTelemetry(markedNode)});return}"
    );
    expect(inlineModule).toContain(
      "if(match)report('inspect-node-result',{nodeId,telemetry:elementTelemetry(match)})"
    );
    // Canvas-mode selection is published first from trusted pointerdown. Its
    // click is consumed only when it matches the same marked element within a
    // short event-time window; otherwise window capture fails closed.
    expect(inlineModule).toContain(
      "addWindowListener('click',event=>{if(!canvasNavigationEnabled||!event.isTrusted){if(!canvasNavigationEnabled)canvasPointerSelection=undefined;return}const target=event.target instanceof Element?event.target:null;const markedNode=target?target.closest('[data-selene-node-id]'):undefined;const priorPointerSelection=canvasPointerSelection;canvasPointerSelection=undefined;if(priorPointerSelection&&markedNode===priorPointerSelection.target&&event.timeStamp>=priorPointerSelection.timeStamp&&event.timeStamp-priorPointerSelection.timeStamp<1000){apply(preventDefault,event,[]);apply(stopImmediate,event,[]);return}if(!target){report('clear-selection');return}const inspected=markedNode||target;"
    );
    expect(inlineModule).not.toContain(
      "if(canvasNavigationEnabled){const inspected=markedNode||target;const nodeId=apply(getAttribute,inspected,['data-selene-node-id'])||'';"
    );
    expect(inlineModule).toContain(
      "document.addEventListener('pointerdown',event=>{suppressUnsupportedClick=false;if(!event.isTrusted||!event.isPrimary||event.button!==0||canvasNavigationEnabled)return;"
    );
    // Selection and unsupported revocation both happen at window capture,
    // before generated-document handlers can stop propagation or navigate.
    const authoritativeWindowPointer =
      "addWindowListener('pointerdown',event=>{windowUnsupportedPointerHit=false;if(!event.isTrusted||!event.isPrimary||event.button!==0)return;canvasPointerSelection=undefined;const target=event.target instanceof Element?event.target:null;if(!target){if(canvasNavigationEnabled)report('clear-selection');return}const markedNode=target.closest('[data-selene-node-id]');if(canvasNavigationEnabled&&markedNode){const nodeId=apply(getAttribute,markedNode,['data-selene-node-id'])||'';canvasPointerSelection={target:markedNode,timeStamp:event.timeStamp};apply(preventDefault,event,[]);if(identifier.test(nodeId)){report('select-node',{nodeId,telemetry:elementTelemetry(markedNode)});return}report('clear-selection');inspectElementSequence+=1;report('inspect-element'";
    expect(inlineModule).toContain(authoritativeWindowPointer);
    expect(inlineModule).toContain(
      "windowUnsupportedPointerNavigation=canvasNavigationEnabled;suppressUnsupportedClick=!canvasNavigationEnabled;report('clear-selection');inspectElementSequence+=1;report('inspect-element'"
    );
    expect(inlineModule).toContain(
      "addWindowListener('click',event=>{if(!windowUnsupportedPointerHit)return;windowUnsupportedPointerHit=false;if(!windowUnsupportedPointerNavigation)return;apply(preventDefault,event,[]);apply(stopImmediate,event,[])"
    );
    expect(inlineModule.indexOf("report('clear-selection')")).toBeLessThan(
      inlineModule.indexOf(
        "report('inspect-element'",
        inlineModule.indexOf(authoritativeWindowPointer)
      )
    );
    expect(inlineModule).toContain(
      "const report=(type,extra={})=>{if(closed)return;const interactionSequence=type==='clear-selection'||type==='select-node'?++selectionInteractionSequence:undefined;if(interactionSequence!==undefined)root.dataset.seleneSelectionInteraction=type+':'+interactionSequence;const message={type,origin:policy.origin,nonce:policy.nonce,revisionId:policy.revisionId,...(interactionSequence===undefined?{}:{interactionSequence}),...extra};if(interactionSequence!==undefined)try{postParentMessage(message,'*')}catch{}if(port)try{apply(postMessage,port,[message])}catch{}}"
    );
    expect(inlineModule).toContain(
      "if(target.closest('[data-selene-flow-node][data-selene-action-port]'))return;windowUnsupportedPointerHit=true;windowUnsupportedPointerNavigation=canvasNavigationEnabled;suppressUnsupportedClick=!canvasNavigationEnabled;report('clear-selection');inspectElementSequence+=1;report('inspect-element'"
    );
    expect(inlineModule).toContain(
      'canvasPointerSelection={target:markedNode,timeStamp:event.timeStamp};apply(preventDefault,event,[]);if(identifier.test(nodeId))'
    );
    expect(inlineModule).toContain(
      "const nodeId=apply(getAttribute,inspected,['data-selene-node-id'])||'';apply(preventDefault,event,[]);apply(stopImmediate,event,[]);if(identifier.test(nodeId)){report('select-node',{nodeId,telemetry:elementTelemetry(inspected)});return}report('clear-selection');inspectElementSequence+=1;report('inspect-element'"
    );
    expect(inlineModule).toContain(
      "addWindowListener('pointercancel',event=>{if(event.isTrusted&&event.isPrimary){canvasPointerSelection=undefined;suppressUnsupportedClick=false}}"
    );
    expect(inlineModule).toContain(
      "if(message.type==='canvas-navigation'){canvasNavigationEnabled=message.enabled;root.dataset.seleneCanvasNavigation=message.enabled?'design':'prototype';if(!message.enabled)canvasPointerSelection=undefined;return}"
    );
    // The trusted outer Design plane sends bounded coordinates only. The
    // iframe resolves them with its own document API, so no parent DOM target
    // can become source or selection authority.
    expect(inlineModule).toContain(
      'const elementFromPoint=document.elementFromPoint.bind(document)'
    );
    expect(inlineModule).toContain(
      "fields(value,['type','nonce','origin','revisionId','state','enabled','nodeId','x','y'])"
    );
    expect(inlineModule).toContain(
      "if(next.type==='selection-point')return next.enabled===undefined&&next.state===undefined&&next.nodeId===undefined&&typeof next.x==='number'&&finite(next.x)&&next.x>=0&&next.x<=1&&typeof next.y==='number'&&finite(next.y)&&next.y>=0&&next.y<=1"
    );
    expect(inlineModule).toContain(
      "if(message.type==='selection-point'){selectDesignPoint(message.x,message.y);return}"
    );
    const designPointSelection =
      "const selectDesignPoint=(x,y)=>{if(!canvasNavigationEnabled||!previewCommitted)return;const width=root.clientWidth;const height=root.clientHeight;if(!finite(x)||!finite(y)||x<0||x>1||y<0||y>1||!finite(width)||!finite(height)||width<=0||height<=0)return;const target=elementFromPoint(x*width,y*height);const markedNode=target?target.closest('[data-selene-node-id]'):undefined;if(markedNode){const nodeId=apply(getAttribute,markedNode,['data-selene-node-id'])||'';if(identifier.test(nodeId)){report('select-node',{nodeId,telemetry:elementTelemetry(markedNode)});return}}report('clear-selection');inspectElementSequence+=1;report('inspect-element',{elementId:'unmapped-'+inspectElementSequence,telemetry:unmappedElementTelemetry(target||previewRoot||root)});};";
    expect(inlineModule).toContain(designPointSelection);
    // Pointerdown is the primary publication owner. Its following click is
    // swallowed at window capture; otherwise that same boundary falls back.
    expect(inlineModule).toContain(
      "if(identifier.test(nodeId)){report('select-node',{nodeId,telemetry:elementTelemetry(inspected)});return}"
    );
    expect(inlineModule).not.toContain('pendingCanvasSelection');
    expect(inlineModule).not.toContain("addWindowListener('pointerup'");
    expect(inlineModule).toContain('telemetry:elementTelemetry(inspected)');
    expect(inlineModule).toContain('left:rect.left,top:rect.top,width:Math.max(0,rect.width)');
    expect(inlineModule).toContain(
      "const inspectNode=nodeId=>{const nodes=queryMarkedNodes('[data-selene-node-id]')"
    );
    expect(inlineModule).toContain(
      "if(message.type==='inspect-node'){if(!previewCommitted)pendingInspectNodeId=message.nodeId;else inspectNode(message.nodeId);return}"
    );
    expect(inlineModule).toContain(
      "report('inspect-element',{elementId:'unmapped-'+inspectElementSequence"
    );
    expect(inlineModule).toContain(
      "if(suppressUnsupportedClick){suppressUnsupportedClick=false;return}report('clear-selection');inspectElementSequence+=1;report('inspect-element'"
    );
    expect(inlineModule).toContain('const unmappedElementTelemetry=node=>');
    expect(inlineModule).toContain(
      "const getParentElement=Object.getOwnPropertyDescriptor(Node.prototype,'parentElement').get"
    );
    expect(inlineModule).toContain(
      "const getTagName=Object.getOwnPropertyDescriptor(Element.prototype,'tagName').get"
    );
    expect(inlineModule).toContain('while(current&&hierarchy.length<16&&depth<256)');
    expect(inlineModule).not.toContain('textContent');
    expect(inlineModule).not.toContain('outerHTML');
    expect(inlineModule).not.toContain('className');
    const parsed = createSourceFile(
      'selene-preview-bootstrap.mjs',
      inlineModule,
      ScriptTarget.ESNext,
      true,
      ScriptKind.JS
    );
    expect(
      transpileModule(inlineModule, {
        compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ESNext },
        reportDiagnostics: true
      }).diagnostics
    ).toEqual([]);
    const clickListener = documentEventListener(parsed, 'click');
    if (clickListener === undefined)
      throw new Error('Preview bootstrap has no document click listener.');
    expect(isBlock(clickListener.body)).toBe(true);
    expect(
      containsStringLiteral(clickListener.body, '[data-selene-flow-node][data-selene-action-port]')
    ).toBe(true);
    expect(containsStringLiteral(clickListener.body, '[data-selene-node-id]')).toBe(true);
    const actionCapture =
      "if(!canvasNavigationEnabled&&action){const nodeId=action.getAttribute('data-selene-flow-node')||'';const portId=action.getAttribute('data-selene-action-port')||'';if(identifier.test(nodeId)&&identifier.test(portId)){report('trigger-action',{nodeId,portId});return}}";
    const unsupportedClear =
      "report('clear-selection');inspectElementSequence+=1;report('inspect-element'";
    expect(inlineModule).toContain(actionCapture);
    expect(inlineModule).toContain(unsupportedClear);
    expect(inlineModule).toContain('if(canvasNavigationEnabled)return;if(markedNode){');
    const clickNavigation = inlineModule.indexOf(
      'if(canvasNavigationEnabled)',
      inlineModule.indexOf(actionCapture)
    );
    expect(inlineModule.indexOf(actionCapture)).toBeLessThan(clickNavigation);
    expect(clickNavigation).toBeLessThan(inlineModule.indexOf(unsupportedClear, clickNavigation));
    const keydownListener = documentEventListener(parsed, 'keydown');
    if (keydownListener === undefined)
      throw new Error('Preview bootstrap has no document keydown listener.');
    expect(isBlock(keydownListener.body)).toBe(true);
    expect(containsStringLiteral(keydownListener.body, 'Escape')).toBe(true);
    expect(containsStringLiteral(keydownListener.body, 'target-cancel')).toBe(true);
    expect(inlineModule).toContain(
      "if(!targetCancelEnabled||!event.isTrusted||event.defaultPrevented||event.isComposing||event.key!=='Escape')return"
    );
    expect(inlineModule).toContain(
      "apply(preventDefault,event,[]);apply(stopImmediate,event,[]);report('target-cancel')"
    );
    // The bootstrap binds this before importing generated React code. Window
    // capture ensures a preview cannot install an earlier component/window
    // handler that stops propagation before the trusted bridge sees a gesture.
    expect(document).toContain("addWindowListener('wheel',event=>{");
    expect(document).toContain("gesture:event.ctrlKey?'zoom':'pan'");
    expect(inlineModule.indexOf("addWindowListener('wheel',event=>{")).toBeLessThan(
      inlineModule.indexOf("await import('./preview.js')")
    );
    expect(document.indexOf('const proofReady=window.__selenePreviewProofReady')).toBeLessThan(
      document.indexOf("await import('./preview.js')")
    );
    expect(document).toContain('if(!canvasNavigationEnabled||!event.isTrusted)return');
    expect(document).toContain('apply(preventDefault,event,[])');
    expect(document).toContain('{capture:true,passive:false}');
    expect(document).toContain(
      "const report=(type,extra={})=>{if(closed)return;const interactionSequence=type==='clear-selection'||type==='select-node'?++selectionInteractionSequence:undefined;if(interactionSequence!==undefined)root.dataset.seleneSelectionInteraction=type+':'+interactionSequence;const message={type,origin:policy.origin,nonce:policy.nonce,revisionId:policy.revisionId,...(interactionSequence===undefined?{}:{interactionSequence}),...extra};if(interactionSequence!==undefined)try{postParentMessage(message,'*')}catch{}if(port)try{apply(postMessage,port,[message])}catch{}}"
    );
    expect(document).not.toContain('__selenePreviewRendered');
    expect(document).not.toContain('__selenePreviewFailed');
    expect(document).toContain("report('rendered')");
    expect(document).toContain('await waitForCommit()');
    expect(document).toContain('requestFrame(()=>requestFrame(resolve))');
    expect(document).toContain("throw new TrustedError('Preview committed no visible content')");
    expect(inlineModule).toContain(
      'if(!previewCommitted){pendingRuntimeState=message.state;return}dispatchRuntimeState(message.state)'
    );
    expect(inlineModule).toContain(
      'previewCommitted=true;if(pendingRuntimeState){dispatchRuntimeState(pendingRuntimeState);pendingRuntimeState=undefined}'
    );
    expect(
      inlineModule.indexOf(
        'previewCommitted=true;if(pendingRuntimeState){dispatchRuntimeState(pendingRuntimeState);pendingRuntimeState=undefined}'
      )
    ).toBeGreaterThan(inlineModule.indexOf('await waitForCommit()'));
    const selectedNode = validatePreviewMessage(
      {
        type: 'select-node',
        nonce: policy.nonce,
        origin: policy.origin,
        revisionId: 'r2',
        interactionSequence: 1,
        nodeId: 'orders.root',
        telemetry: validTelemetry
      },
      policy,
      'r2'
    );
    if (selectedNode.type !== 'select-node')
      throw new Error('Preview selection message lost its discriminant.');
    expect(selectedNode.nodeId).toBe('orders.root');
    expect(selectedNode.interactionSequence).toBe(1);
    const inspectedNode = validatePreviewMessage(
      {
        type: 'inspect-node-result',
        nonce: policy.nonce,
        origin: policy.origin,
        revisionId: 'r2',
        nodeId: 'orders.root',
        telemetry: validTelemetry
      },
      policy,
      'r2'
    );
    if (inspectedNode.type !== 'inspect-node-result')
      throw new Error('Preview inspect result lost its discriminant.');
    expect(inspectedNode.nodeId).toBe('orders.root');
    expect(() =>
      validatePreviewMessage(
        {
          type: 'inspect-node-result',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          nodeId: 'orders.root'
        },
        policy,
        'r2'
      )
    ).toThrow(/Preview channel message is invalid/);
    expect(() =>
      validatePreviewMessage(
        {
          type: 'inspect-node-result',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          nodeId: 'orders.root',
          telemetry: {
            ...validTelemetry,
            hierarchy: [{ nodeId: 'other.node', semanticTag: 'main' }]
          }
        },
        policy,
        'r2'
      )
    ).toThrow(/Preview channel message is invalid/);
    expect(() =>
      validatePreviewMessage(
        {
          type: 'inspect-node-result',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          nodeId: 'orders.root',
          telemetry: validTelemetry,
          elementId: 'extra'
        },
        policy,
        'r2'
      )
    ).toThrow(/Preview channel message is invalid/);
    expect(selectedNode.telemetry).toMatchObject({
      left: 24,
      top: 32,
      width: 320,
      height: 48,
      minWidth: 160,
      maxWidth: 640,
      parentWidth: 480
    });
    expect(selectedNode.telemetry.semanticTag).toBe('button');
    expect(selectedNode.telemetry.hierarchy).toEqual([
      { nodeId: 'app.root', semanticTag: 'main' },
      { nodeId: 'orders.root', semanticTag: 'button' }
    ]);
    expect(selectedNode.telemetry.alignmentTargets).toEqual([
      { nodeId: 'orders.summary', left: 372, top: 32, width: 240, height: 48 }
    ]);
    const unmappedTelemetry = Object.fromEntries(
      Object.entries(validTelemetry).filter(
        ([key]) =>
          ![
            'hierarchy',
            'alignmentTargets',
            'minWidth',
            'minHeight',
            'maxWidth',
            'maxHeight',
            'parentWidth',
            'parentHeight',
            'explicitAriaRole',
            'ariaLabel',
            'accessibleDescription',
            'ariaDisabled',
            'ariaExpanded',
            'ariaPressed',
            'ariaChecked',
            'ariaSelected',
            'ariaHidden',
            'tabIndex'
          ].includes(key)
      )
    );
    const unmapped = validatePreviewMessage(
      {
        type: 'inspect-element',
        nonce: policy.nonce,
        origin: policy.origin,
        revisionId: 'r2',
        elementId: 'unmapped-1',
        telemetry: unmappedTelemetry
      },
      policy,
      'r2'
    );
    if (unmapped.type !== 'inspect-element')
      throw new Error('Unmapped preview inspection lost its discriminant.');
    expect(unmapped.elementId).toBe('unmapped-1');
    expect(unmapped.telemetry).not.toHaveProperty('ariaLabel');
    expect(unmapped.telemetry).not.toHaveProperty('hierarchy');
    expect(
      validatePreviewMessage(
        {
          type: 'target-cancel',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2'
        },
        policy,
        'r2'
      )
    ).toEqual({
      type: 'target-cancel',
      nonce: policy.nonce,
      origin: policy.origin,
      revisionId: 'r2'
    });
    expect(() =>
      validatePreviewMessage(
        {
          type: 'clear-selection',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2'
        },
        policy,
        'r2'
      )
    ).toThrow(/Preview channel message is invalid/);
    expect(
      validatePreviewMessage(
        {
          type: 'clear-selection',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          interactionSequence: 2
        },
        policy,
        'r2'
      )
    ).toEqual({
      type: 'clear-selection',
      nonce: policy.nonce,
      origin: policy.origin,
      revisionId: 'r2',
      interactionSequence: 2
    });
    expect(() =>
      validatePreviewMessage(
        {
          type: 'target-cancel',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          message: 'not allowed'
        },
        policy,
        'r2'
      )
    ).toThrow(/Preview channel message is invalid/);
    expect(() =>
      validatePreviewMessage(
        {
          type: 'select-node',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          nodeId: 'orders.root',
          telemetry: { ...validTelemetry, left: Number.POSITIVE_INFINITY }
        },
        policy,
        'r2'
      )
    ).toThrow(/Preview channel message is invalid/);
    expect(() =>
      validatePreviewMessage(
        {
          type: 'select-node',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          nodeId: 'orders.root',
          telemetry: {
            ...validTelemetry,
            hierarchy: [{ nodeId: 'different.node', semanticTag: 'button' }]
          }
        },
        policy,
        'r2'
      )
    ).toThrow(/Preview channel message is invalid/);
    expect(() =>
      validatePreviewMessage(
        {
          type: 'select-node',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          nodeId: 'orders.root',
          telemetry: {
            ...validTelemetry,
            hierarchy: [{ nodeId: 'orders.root', semanticTag: 'main', className: 'private' }]
          }
        },
        policy,
        'r2'
      )
    ).toThrow(/Preview channel message is invalid/);
    expect(() =>
      validatePreviewMessage(
        {
          type: 'select-node',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          nodeId: 'orders.root',
          telemetry: {
            ...validTelemetry,
            alignmentTargets: [
              validTelemetry.alignmentTargets[0],
              validTelemetry.alignmentTargets[0]
            ]
          }
        },
        policy,
        'r2'
      )
    ).toThrow(/Preview channel message is invalid/);
    expect(
      validatePreviewMessage(
        {
          type: 'canvas-gesture',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          gesture: 'zoom',
          deltaX: 24,
          deltaY: -18,
          x: 0.5,
          y: 0.25
        },
        policy,
        'r2'
      )
    ).toMatchObject({
      type: 'canvas-gesture',
      gesture: 'zoom',
      deltaX: 24,
      deltaY: -18,
      x: 0.5,
      y: 0.25
    });
    expect(() =>
      validatePreviewMessage(
        { type: 'select-node', nonce: 'wrong', origin: policy.origin, revisionId: 'r2' },
        policy,
        'r2'
      )
    ).toThrow(/Preview channel message is invalid/);
    expect(
      validatePreviewMessage(
        {
          type: 'canvas-gesture',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          gesture: 'pan',
          deltaX: 0,
          deltaY: -120,
          x: 0.5,
          y: 0.5
        },
        policy,
        'r2'
      )
    ).toMatchObject({ type: 'canvas-gesture', gesture: 'pan', deltaX: 0, deltaY: -120 });
    expect(() =>
      validatePreviewMessage(
        {
          type: 'canvas-gesture',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          gesture: 'rotate',
          deltaX: 0,
          deltaY: -120,
          x: 0.5,
          y: 0.5
        },
        policy,
        'r2'
      )
    ).toThrow(/Preview channel message is invalid/);
    expect(() =>
      validatePreviewMessage(
        {
          type: 'canvas-gesture',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          gesture: 'zoom',
          deltaX: 0,
          deltaY: 513,
          x: 0.5,
          y: 0.5
        },
        policy,
        'r2'
      )
    ).toThrow(/Preview channel message is invalid/);
  });

  it('rejects oversized and unsupported frame messages', () => {
    expect(() =>
      validatePreviewMessage(
        { type: 'nope', nonce: policy.nonce, origin: policy.origin, revisionId: 'r2' },
        policy,
        'r2'
      )
    ).toThrow(/Preview channel message is invalid/);
    expect(() =>
      validatePreviewMessage(
        {
          type: 'ready',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          message: 'x'.repeat(20_000)
        },
        policy,
        'r2'
      )
    ).toThrow(/size/);
    expect(() => validatePreviewMessage(undefined, policy, 'r2')).toThrow(/serializable/);
    expect(() =>
      validatePreviewMessage(
        { type: 'select-node', nonce: policy.nonce, origin: policy.origin, revisionId: 'r2' },
        policy,
        'r2'
      )
    ).toThrow(/Preview channel message is invalid/);
    expect(() =>
      validatePreviewMessage(
        {
          type: 'select-node',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          nodeId: 'orders.root',
          telemetry: { ...validTelemetry, semanticTag: 42 }
        },
        policy,
        'r2'
      )
    ).toThrow(/Preview channel message is invalid/);
    expect(() =>
      validatePreviewMessage(
        {
          type: 'select-node',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          nodeId: 'orders.root',
          telemetry: { ...validTelemetry, boxShadow: 'x'.repeat(513) }
        },
        policy,
        'r2'
      )
    ).toThrow(/Preview channel message is invalid/);
  });

  it('serves adversarial generated source as separate assets and only accepts published pairs', async () => {
    const css = '</style><img src=x onerror=alert(1)>';
    const code = '</script><img src=x onerror=alert(1)>';
    const previews = new PreviewArtifactRegistry();
    const published = previews.publish('safe', policy, {
      revisionId: 'r2',
      projectId: 'desktop-designer',
      screenIds: ['dashboard', 'orders'],
      code,
      css
    });
    const document = await (await previews.handle(published.url)).text();
    expect(document).not.toContain('</style><img');
    expect(document).not.toContain('</script><img');
    expect(document).toContain(
      "const proofReady=window.__selenePreviewProofReady;if(typeof proofReady!=='object'||proofReady===null||typeof proofReady.then!=='function'||!(await proofReady))throw new TrustedError('Preview selection authority could not initialize');await import('./preview.js')"
    );
    expect(await (await previews.handle('selene-preview://local/safe/preview.css')).text()).toBe(
      css
    );
    expect(await (await previews.handle('selene-preview://local/safe/preview.js')).text()).toBe(
      code
    );
    expect((await previews.handle('selene-preview://local/safe/unknown')).status).toBe(404);
    const descriptor = previews.describe(policy, 'orders', 'desktop-designer');
    expect(descriptor.url).toBe('selene-preview://local/safe/screens/orders/index.html');
    expect(descriptor.revisionId).toBe('r2');
    expect(descriptor.projectId).toBe('desktop-designer');
    const descriptorDocument = await (await previews.handle(descriptor.url)).text();
    expect(descriptorDocument).toContain('data-preview-screen-id="orders"');
    expect(descriptorDocument).toContain('data-preview-project-id="desktop-designer"');
    expect(descriptorDocument).toContain('projectId:root.dataset.previewProjectId');
    expect(descriptorDocument).toContain('if(readonlyPreview)acceptInitialRuntime()');
    expect(
      (await previews.handle('selene-preview://local/safe/screens/unknown/index.html')).status
    ).toBe(404);
    expect(
      (await previews.handle('selene-preview://local/safe/screens/invalid%2Fscreen/index.html'))
        .status
    ).toBe(404);
    expect(() => previews.describe(policy, 'invalid/screen', 'desktop-designer')).toThrow(
      /screen ID/
    );
    expect(() => previews.describe(policy, 'unknown', 'desktop-designer')).toThrow(/not published/);
    expect(() => previews.describe(policy, 'orders', 'another-project')).toThrow(/not published/);
    expect(() =>
      previews.describe({ ...policy, nonce: 'x'.repeat(24) }, 'orders', 'desktop-designer')
    ).toThrow(/CSP does not match/);
    expect(
      createPreviewDocument(policy, 'r2"></script><img src=x onerror=alert(1)>')
    ).not.toContain('</script><img');

    const publishedSelection = previews.validatePublishedMessage(policy, {
      type: 'select-node',
      nonce: policy.nonce,
      origin: policy.origin,
      revisionId: 'r2',
      interactionSequence: 1,
      nodeId: 'orders.root',
      telemetry: validTelemetry
    });
    if (publishedSelection.type !== 'select-node')
      throw new Error('Published preview selection lost its discriminant.');
    expect(publishedSelection.nodeId).toBe('orders.root');
    expect(() =>
      previews.validatePublishedMessage(policy, {
        type: 'ready',
        nonce: policy.nonce,
        origin: policy.origin,
        revisionId: 'other'
      })
    ).toThrow(/not published/);
    expect(() =>
      previews.validatePublishedMessage({ ...policy, csp: "default-src 'self'" }, {})
    ).toThrow(/CSP/);
  });

  it('issues current signed selection proofs only after one bootstrap key registration', async () => {
    const previews = new PreviewArtifactRegistry();
    const published = previews.publish('proof', policy, {
      revisionId: 'r2',
      projectId: 'desktop-designer',
      bindingId: 'a'.repeat(64),
      compilerNodeIds: ['orders.root', 'orders.action'],
      code: 'export default null',
      css: ''
    });
    const document = await (await previews.handle(published.url)).text();
    expect(document).toContain('generateKey');
    expect(document).toContain('__selenePreviewProofReady');
    expect(document).not.toContain('selectionProofSecret');
    expect(document).not.toContain('x-selene-preview-proof');
    expect((await previews.handle('selene-preview://local/proof/preview.js')).status).toBe(425);
    expect(
      (
        await previews.handle(
          new Request('selene-preview://local/proof/selection-key', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
          })
        )
      ).status
    ).toBe(403);

    const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify'
    ]);
    const publicKey = await webcrypto.subtle.exportKey('jwk', key.publicKey);
    const register = () =>
      previews.handle(
        new Request('selene-preview://local/proof/selection-key', {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=UTF-8' },
          body: JSON.stringify(publicKey)
        })
      );
    const successfulRegistration = await register();
    expect(successfulRegistration.status).toBe(204);
    expect(successfulRegistration.body).toBeNull();
    expect((await register()).status).toBe(403);
    expect((await previews.handle('selene-preview://local/proof/preview.js')).status).toBe(200);
    expect(document).toContain('nativeFetch=window.fetch.bind(window)');
    expect(document).toContain('Element.prototype.closest');

    const signed = async (counter: number, nodeId: string, signingKey = key.privateKey) => {
      const payload = {
        counter,
        nodeId,
        left: 10,
        top: 12,
        width: 100,
        height: 24,
        viewportWidth: 800,
        viewportHeight: 600
      };
      const signature = await webcrypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        signingKey,
        new TextEncoder().encode(JSON.stringify(payload))
      );
      return new Request('selene-preview://local/proof/selection-proof', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, signature: Buffer.from(signature).toString('base64') })
      });
    };
    expect(
      (
        await previews.handle(
          new Request('selene-preview://local/proof/selection-proof', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ counter: 1 })
          })
        )
      ).status
    ).toBe(403);
    const wrongKey = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    expect(
      (await previews.handle(await signed(1, 'orders.root', wrongKey.privateKey))).status
    ).toBe(403);
    expect((await previews.handle(await signed(1, 'orders.root'))).status).toBe(200);
    const first = await (await previews.handle(await signed(2, 'orders.action'))).json();
    expect(previews.consumeSelectionProof((first as { proofId: string }).proofId).nodeRef).toBe(
      'orders.action'
    );
    expect(previews.consumeSelectionProof((first as { proofId: string }).proofId).nodeRef).toBe(
      'orders.action'
    );
    expect((await previews.handle(await signed(2, 'orders.action'))).status).toBe(403);
    expect((await previews.handle(await signed(4, 'orders.action'))).status).toBe(403);

    // A valid signed but unmapped hit consumes counter 3 without minting proof;
    // the next physical hit at counter 4 remains synchronized and valid.
    expect((await previews.handle(await signed(3, 'forged.node'))).status).toBe(403);
    const second = await (await previews.handle(await signed(4, 'orders.root'))).json();
    expect(() => previews.consumeSelectionProof((first as { proofId: string }).proofId)).toThrow(
      /unavailable/
    );
    previews.clearSelectionProofs();
    expect(() => previews.consumeSelectionProof((second as { proofId: string }).proofId)).toThrow(
      /unavailable/
    );
    previews.publish('replacement', policy, {
      revisionId: 'r2',
      projectId: 'desktop-designer',
      bindingId: 'a'.repeat(64),
      compilerNodeIds: ['orders.root'],
      code: '',
      css: ''
    });
    expect(() => previews.consumeSelectionProof((second as { proofId: string }).proofId)).toThrow(
      /unavailable/
    );
  });

  it('fences signed selection authority to each published frame', async () => {
    const previews = new PreviewArtifactRegistry();
    previews.publish('multi-frame', policy, {
      revisionId: 'r2',
      projectId: 'desktop-designer',
      bindingId: 'b'.repeat(64),
      compilerNodeIds: ['orders.root'],
      screenIds: ['orders'],
      code: 'export default null',
      css: ''
    });
    const directUrl = 'selene-preview://local/multi-frame';
    const ordersUrl = `${directUrl}/screens/orders`;
    const rootKey = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const ordersKey = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const register = async (url: string, key: typeof rootKey.publicKey) =>
      previews.handle(
        new Request(`${url}/selection-key`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(await webcrypto.subtle.exportKey('jwk', key))
        })
      );
    const signed = async (url: string, counter: number, signingKey: typeof rootKey.privateKey) => {
      const payload = {
        counter,
        nodeId: 'orders.root',
        left: 10,
        top: 12,
        width: 100,
        height: 24,
        viewportWidth: 800,
        viewportHeight: 600
      };
      const signature = await webcrypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        signingKey,
        new TextEncoder().encode(JSON.stringify(payload))
      );
      return new Request(`${url}/selection-proof`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, signature: Buffer.from(signature).toString('base64') })
      });
    };

    expect((await previews.handle(`${directUrl}/preview.js`)).status).toBe(425);
    expect((await previews.handle(`${ordersUrl}/preview.js`)).status).toBe(425);
    expect((await register(directUrl, rootKey.publicKey)).status).toBe(204);
    expect((await previews.handle(`${directUrl}/preview.js`)).status).toBe(200);
    expect((await previews.handle(`${ordersUrl}/preview.js`)).status).toBe(425);
    expect(
      (
        await previews.handle(
          new Request(`${directUrl}/screens/unknown/selection-key`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
          })
        )
      ).status
    ).toBe(404);
    expect((await register(ordersUrl, ordersKey.publicKey)).status).toBe(204);
    expect((await register(ordersUrl, ordersKey.publicKey)).status).toBe(403);
    expect((await previews.handle(`${ordersUrl}/preview.js`)).status).toBe(200);

    // A signature from the reference frame cannot be replayed through the direct frame.
    expect((await previews.handle(await signed(directUrl, 1, ordersKey.privateKey))).status).toBe(
      403
    );
    expect((await previews.handle(await signed(directUrl, 1, rootKey.privateKey))).status).toBe(
      200
    );
    expect((await previews.handle(await signed(ordersUrl, 1, ordersKey.privateKey))).status).toBe(
      200
    );
    expect((await previews.handle(await signed(directUrl, 1, rootKey.privateKey))).status).toBe(
      403
    );
    expect((await previews.handle(await signed(ordersUrl, 1, ordersKey.privateKey))).status).toBe(
      403
    );
    expect((await previews.handle(await signed(directUrl, 2, rootKey.privateKey))).status).toBe(
      200
    );
    expect((await previews.handle(await signed(ordersUrl, 2, ordersKey.privateKey))).status).toBe(
      200
    );
  });
});
