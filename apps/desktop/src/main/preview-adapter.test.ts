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
    const document = createPreviewDocument(policy, {
      revisionId: 'r2',
      code: 'document.body.dataset.rendered = "yes";',
      css: 'main { color: red; }'
    });
    expect(document).toContain("default-src 'none'");
    expect(document).toContain('dataset.rendered');
    expect(document).toContain("closest('[data-selene-node-id]')");
    expect(
      validatePreviewMessage(
        {
          type: 'select-node',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          nodeId: 'orders.root'
        },
        policy
      ).nodeId
    ).toBe('orders.root');
    expect(() =>
      validatePreviewMessage(
        { type: 'select-node', nonce: 'wrong', origin: policy.origin, revisionId: 'r2' },
        policy
      )
    ).toThrow(/nonce/);
  });

  it('rejects oversized and unsupported frame messages', () => {
    expect(() =>
      validatePreviewMessage(
        { type: 'nope', nonce: policy.nonce, origin: policy.origin, revisionId: 'r2' },
        policy
      )
    ).toThrow(/Unknown/);
    expect(() =>
      validatePreviewMessage(
        {
          type: 'ready',
          nonce: policy.nonce,
          origin: policy.origin,
          revisionId: 'r2',
          message: 'x'.repeat(20_000)
        },
        policy
      )
    ).toThrow(/size/);
    expect(() => validatePreviewMessage(undefined, policy)).toThrow(/serializable/);
    expect(() =>
      validatePreviewMessage(
        { type: 'select-node', nonce: policy.nonce, origin: policy.origin, revisionId: 'r2' },
        policy
      )
    ).toThrow(/node ID/);
  });

  it('escapes adversarial generated source and only accepts published policy/revision pairs', () => {
    const document = createPreviewDocument(policy, {
      revisionId: 'r2',
      css: '</style><img src=x onerror=alert(1)>',
      code: '</script><img src=x onerror=alert(1)>'
    });
    expect(document).not.toContain('</style><img');
    expect(document).not.toContain('</script><img');

    const previews = new PreviewArtifactRegistry();
    previews.publish('safe', policy, { revisionId: 'r2', code: '' });
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
  });
});
