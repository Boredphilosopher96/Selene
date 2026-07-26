import { describe, expect, it } from 'vitest';

import {
  createPreviewDocument,
  createPreviewSecurityPolicy,
  PreviewArtifactRegistry,
  validatePreviewMessage
} from './preview-adapter';

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
      "window.dispatchEvent(new CustomEvent('selene-runtime-state',{detail:state}))"
    );
    expect(document).toContain(
      'apply(postMessage,port,[{type,origin:policy.origin,nonce:policy.nonce,revisionId:policy.revisionId,...extra}])'
    );
    expect(document).not.toContain('__selenePreviewRendered');
    expect(document).not.toContain('__selenePreviewFailed');
    expect(document).toContain("report('rendered')");
    expect(document).toContain('await waitForCommit()');
    expect(document).toContain('requestFrame(()=>requestFrame(resolve))');
    expect(document).toContain("throw new TrustedError('Preview committed no visible content')");
    expect(
      validatePreviewMessage(
        {
          type: 'select-node',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          nodeId: 'orders.root'
        },
        policy,
        'r2'
      ).nodeId
    ).toBe('orders.root');
    expect(() =>
      validatePreviewMessage(
        { type: 'select-node', nonce: 'wrong', origin: policy.origin, revisionId: 'r2' },
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
  });

  it('serves adversarial generated source as separate assets and only accepts published pairs', async () => {
    const css = '</style><img src=x onerror=alert(1)>';
    const code = '</script><img src=x onerror=alert(1)>';
    const previews = new PreviewArtifactRegistry();
    const published = previews.publish('safe', policy, { revisionId: 'r2', code, css });
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
    expect(
      createPreviewDocument(policy, 'r2"></script><img src=x onerror=alert(1)>')
    ).not.toContain('</script><img');

    expect(
      previews.validatePublishedMessage(policy, {
        type: 'select-node',
        nonce: policy.nonce,
        origin: policy.origin,
        revisionId: 'r2',
        nodeId: 'orders.root'
      }).nodeId
    ).toBe('orders.root');
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
