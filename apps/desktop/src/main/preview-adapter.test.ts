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
  width: 320,
  height: 48,
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
    expect(document).toContain('value.nonce!==policy.nonce||value.revisionId!==policy.revisionId');
    expect(document).toContain("type!=='runtime-state'");
    expect(document).toContain(
      "window.dispatchEvent(new CustomEvent('selene-runtime-state',{detail:message.state}))"
    );
    const inlineModule = inlinePreviewModule(document);
    expect(inlineModule).toContain(
      "report('select-node',{nodeId,telemetry:elementTelemetry(node)})"
    );
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
    expect(inlineModule).toContain(
      'if(canvasNavigationEnabled&&node){apply(preventDefault,event,[]);apply(stopImmediate,event,[])'
    );
    expect(inlineModule).toContain(
      "const action=target.closest('[data-selene-flow-node][data-selene-action-port]')"
    );
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
    // handler that stops propagation before the trusted bridge sees a pinch.
    expect(document).toContain("addWindowListener('wheel',event=>{");
    expect(document).toContain("report('canvas-gesture',{gesture:'zoom'");
    expect(inlineModule.indexOf("addWindowListener('wheel',event=>{")).toBeLessThan(
      inlineModule.indexOf("await import('./preview.js')")
    );
    expect(document).toContain(
      'if(!canvasNavigationEnabled||!event.isTrusted||!event.ctrlKey)return'
    );
    expect(document).toContain('apply(preventDefault,event,[])');
    expect(document).toContain('{capture:true,passive:false}');
    expect(document).toContain(
      'apply(postMessage,port,[{type,origin:policy.origin,nonce:policy.nonce,revisionId:policy.revisionId,...extra}])'
    );
    expect(document).not.toContain('__selenePreviewRendered');
    expect(document).not.toContain('__selenePreviewFailed');
    expect(document).toContain("report('rendered')");
    expect(document).toContain('await waitForCommit()');
    expect(document).toContain('requestFrame(()=>requestFrame(resolve))');
    expect(document).toContain("throw new TrustedError('Preview committed no visible content')");
    const selectedNode = validatePreviewMessage(
      {
        type: 'select-node',
        nonce: policy.nonce,
        origin: policy.origin,
        revisionId: 'r2',
        nodeId: 'orders.root',
        telemetry: validTelemetry
      },
      policy,
      'r2'
    );
    if (selectedNode.type !== 'select-node')
      throw new Error('Preview selection message lost its discriminant.');
    expect(selectedNode.nodeId).toBe('orders.root');
    expect(selectedNode.telemetry.semanticTag).toBe('button');
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
    expect(() =>
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
    expect(document).toContain("await import('./preview.js')");
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
    const descriptorDocument = await (await previews.handle(descriptor.url)).text();
    expect(descriptorDocument).toContain('data-preview-screen-id="orders"');
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
    ).toThrow(/not published/);
    expect(
      createPreviewDocument(policy, 'r2"></script><img src=x onerror=alert(1)>')
    ).not.toContain('</script><img');

    const publishedSelection = previews.validatePublishedMessage(policy, {
      type: 'select-node',
      nonce: policy.nonce,
      origin: policy.origin,
      revisionId: 'r2',
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
});
