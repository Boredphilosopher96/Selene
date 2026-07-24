import { generateKeyPairSync } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import { SignedXml } from 'xml-crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  createInMemorySamlRequestCorrelationStore,
  SamlServerVerifier,
  SamlRuntimeError,
  type SamlAttributeMapping,
  type SamlRequestCorrelationStore,
  type SamlServerConfig
} from './saml';

const issuer = 'https://idp.example.test/metadata';
const serviceProviderIssuer = 'https://app.example.test/saml/metadata';
const callbackUrl = 'https://app.example.test/saml/consume';
const entryPoint = 'https://idp.example.test/sso';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signingKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const signingCertificate = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const rolloverPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rolloverSigningKey = rolloverPair.privateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();
const rolloverSigningCertificate = rolloverPair.publicKey
  .export({ type: 'spki', format: 'pem' })
  .toString();
const wrongPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const wrongSigningKey = wrongPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const shortLivedCertificate = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUHyZZYCP5GD4eM4b54NIu/3v1KxYwDQYJKoZIhvcNAQEL
BQAwIzEhMB8GA1UEAwwYc2VsZW5lLXNhbWwtZXhwaXJlZC10ZXN0MB4XDTI2MDcy
NDEyMTAwMFoXDTI2MDcyNTEyMTAwMFowIzEhMB8GA1UEAwwYc2VsZW5lLXNhbWwt
ZXhwaXJlZC10ZXN0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnynI
dNPRYj8dw5InCTCZzJvIAnH8Vk7JmGHYQ3vWJVxGELfRLMYcDilRgcRpJ4mDQfVS
v7aJpvY6o8NRSU0i+WAc4v9QaBM+HWyBd0JS97Xxtm1NHBYv416OCwqhKwQaNvKX
XhltVC+8CWCrCuvsW4fAByBaxwjCbY04wXQ6SqObvjU51h2kbEqZWLG8kZirAEeb
tMSdwIiblejSCU/htYSVNqZA31h72xz2ThUFb59SaMMIKVivkcnrGnLlW/AFC7bG
vyVgpYUQ/XA2oOc/tReoWS7Nil0mz1gsSTwVD7WkS7WwCcMZGt8tgEXcmSvMYj1P
hskd5GQane+h4pxrawIDAQABo1MwUTAdBgNVHQ4EFgQUewcVvFdatcoYxB48KUzq
D/JR9zkwHwYDVR0jBBgwFoAUewcVvFdatcoYxB48KUzqD/JR9zkwDwYDVR0TAQH/
BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAdAhkAuOk97mM6pxb7GUl9KX0KLnm
Fl/K8/3tnBdlAUP8czIRjBGUR6Fvo2t7vVbp6zAsVOFUxiZNHMQWgc4X2koz6csp
fYSddOmjZNa8xIWte5IyMWMidHwczMu7nU3Q85OPGDbcbvR9k3Vwo4rq5YjCvKF8
CkE6hBKX2cEguLwjztZ0Q2ct9wW43ENmq9lo6nTanajoCkQcvbzYkmuJFS/KqRXK
YoeZye0yL8LJeifmJtT1AUgCXzTjBNoRcAq01N04owC4i4DSwdc75nEnh3ig1oOo
fZnl3XM78yF8gl50FoGwjKBQGCo77wHqjiaJlUzYlymzP/v5XFX2u61+Xg==
-----END CERTIFICATE-----`;

type SamlFixture = {
  readonly inResponseTo: string;
  readonly assertionIssuer?: string;
  readonly audience?: string;
  readonly recipient?: string;
  readonly notOnOrAfter?: string;
  readonly signed?: boolean;
  readonly wrapping?: boolean;
  readonly attributes?: Readonly<Record<string, readonly string[]>>;
  readonly attributeEntries?: readonly {
    readonly name: string;
    readonly values: readonly string[];
  }[];
  readonly signingKey?: string;
  readonly subject?: string;
  readonly sessionIndex?: string;
};

const defaultAttributes: SamlAttributeMapping = {
  emailAttribute: 'email',
  emailVerifiedAttribute: 'email_verified',
  groupsAttribute: 'groups',
  displayNameAttribute: 'display_name'
};

function serverConfig(
  attributes = defaultAttributes,
  idpSigningCertificates: readonly string[] = [signingCertificate]
): SamlServerConfig {
  return {
    entryPoint,
    callbackUrl,
    serviceProviderIssuer,
    idpIssuer: issuer,
    idpSigningCertificates,
    requestCorrelationStore: createInMemorySamlRequestCorrelationStore(),
    attributes
  };
}

function verifier(attributes = defaultAttributes): SamlServerVerifier {
  return new SamlServerVerifier(serverConfig(attributes));
}

async function requestId(service: SamlServerVerifier): Promise<string> {
  const authorization = await service.beginAuthorization('safe-relay-state');
  const encoded = authorization.searchParams.get('SAMLRequest');
  if (!encoded) throw new Error('Node-SAML did not produce an AuthnRequest');
  const request = inflateRawSync(Buffer.from(encoded, 'base64')).toString('utf8');
  const id = /\bID="([^"]+)"/.exec(request)?.[1];
  if (!id) throw new Error('Node-SAML AuthnRequest did not contain an ID');
  return id;
}

function signedResponse(fixture: SamlFixture): string {
  const now = Date.now();
  const notBefore = new Date(now - 60_000).toISOString();
  const notOnOrAfter = fixture.notOnOrAfter ?? new Date(now + 5 * 60_000).toISOString();
  const attributes = (
    fixture.attributeEntries ??
    Object.entries(fixture.attributes ?? { email: ['person@example.test'] }).map(
      ([name, values]) => ({
        name,
        values
      })
    )
  )
    .map(
      ({ name, values }) =>
        `<saml:Attribute Name="${name}">${values
          .map((value) => `<saml:AttributeValue>${value}</saml:AttributeValue>`)
          .join('')}</saml:Attribute>`
    )
    .join('');
  const assertion = `
    <saml:Assertion ID="_assertion" Version="2.0" IssueInstant="${new Date(now).toISOString()}">
      <saml:Issuer>${fixture.assertionIssuer ?? issuer}</saml:Issuer>
      <saml:Subject>
        <saml:NameID>${fixture.subject ?? 'subject-123'}</saml:NameID>
        <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
          <saml:SubjectConfirmationData InResponseTo="${fixture.inResponseTo}" Recipient="${fixture.recipient ?? callbackUrl}" NotOnOrAfter="${notOnOrAfter}" />
        </saml:SubjectConfirmation>
      </saml:Subject>
      <saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">
        <saml:AudienceRestriction><saml:Audience>${fixture.audience ?? serviceProviderIssuer}</saml:Audience></saml:AudienceRestriction>
      </saml:Conditions>
      <saml:AuthnStatement AuthnInstant="${new Date(now).toISOString()}" SessionIndex="${fixture.sessionIndex ?? 'session-123'}" />
      <saml:AttributeStatement>${attributes}</saml:AttributeStatement>
    </saml:Assertion>`;
  const response = `
    <samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response" Version="2.0" IssueInstant="${new Date(now).toISOString()}" InResponseTo="${fixture.inResponseTo}">
      <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success" /></samlp:Status>
      ${fixture.wrapping ? '<saml:Assertion ID="_attacker"><saml:Issuer>https://attacker.example.test</saml:Issuer></saml:Assertion>' : ''}
      ${assertion}
    </samlp:Response>`;
  if (fixture.signed === false) return Buffer.from(response).toString('base64');
  const signature = new SignedXml();
  signature.privateKey = fixture.signingKey ?? signingKey;
  signature.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
  signature.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  signature.addReference({
    xpath: "//*[local-name(.)='Assertion' and @ID='_assertion']",
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#'
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256'
  });
  signature.computeSignature(response, {
    location: {
      reference: "//*[local-name(.)='Assertion' and @ID='_assertion']",
      action: 'append'
    }
  });
  return Buffer.from(signature.getSignedXml()).toString('base64');
}

describe('Node-SAML 5.1 cryptographic conformance fixtures', () => {
  it('projects only configured signed attributes and validation evidence', async () => {
    const mapping = {
      emailAttribute: 'urn:example:mail',
      emailVerifiedAttribute: 'urn:example:verified',
      groupsAttribute: 'urn:example:groups',
      displayNameAttribute: 'urn:example:name'
    } as const;
    const service = verifier(mapping);
    const inResponseTo = await requestId(service);

    await expect(
      service.validatePostResponse(
        signedResponse({
          inResponseTo,
          attributes: {
            'urn:example:mail': ['person@example.test'],
            'urn:example:verified': ['true'],
            'urn:example:groups': ['design', 'reviewers'],
            'urn:example:name': ['Person Example'],
            ignored: ['attacker-controlled-but-signed-and-unmapped']
          }
        })
      )
    ).resolves.toMatchObject({
      provider: 'saml',
      issuer,
      subject: 'subject-123',
      email: 'person@example.test',
      emailVerified: true,
      groups: ['design', 'reviewers'],
      displayName: 'Person Example',
      validation: {
        audience: serviceProviderIssuer,
        requestCorrelation: 'required'
      }
    });
  });

  it('does not mark email verified when the configured signed attribute is absent', async () => {
    const service = verifier();
    const inResponseTo = await requestId(service);
    const identity = await service.validatePostResponse(signedResponse({ inResponseTo }));
    expect(identity).toMatchObject({ email: 'person@example.test', groups: [] });
    expect(identity).not.toHaveProperty('emailVerified');
  });

  it.each([
    ['expired assertion', { notOnOrAfter: '2000-01-01T00:00:00.000Z' }],
    ['wrong audience', { audience: 'https://attacker.example.test/metadata' }],
    ['wrong recipient', { recipient: 'https://attacker.example.test/saml/consume' }],
    ['wrong issuer', { assertionIssuer: 'https://attacker.example.test/metadata' }],
    ['unsigned assertion', { signed: false }],
    ['signature wrapping', { wrapping: true }]
  ] as const)('rejects the %s fixture', async (_name, fixture) => {
    const service = verifier();
    const inResponseTo = await requestId(service);
    await expect(
      service.validatePostResponse(signedResponse({ inResponseTo, ...fixture }))
    ).rejects.toMatchObject({
      code: 'INVALID_SAML_RESPONSE'
    } satisfies Partial<SamlRuntimeError>);
  });

  it('requires a generated request ID and rejects replay after Node-SAML consumes it', async () => {
    const service = verifier();
    const inResponseTo = await requestId(service);
    const response = signedResponse({ inResponseTo });

    await expect(service.validatePostResponse(response)).resolves.toMatchObject({
      subject: 'subject-123'
    });
    await expect(service.validatePostResponse(response)).rejects.toMatchObject({
      code: 'INVALID_SAML_RESPONSE'
    } satisfies Partial<SamlRuntimeError>);
  });

  it('accepts either configured rollover signing key and rejects an unconfigured key', async () => {
    const certificates = [signingCertificate, rolloverSigningCertificate] as const;
    const oldService = new SamlServerVerifier(serverConfig(defaultAttributes, certificates));
    const oldRequestId = await requestId(oldService);
    await expect(
      oldService.validatePostResponse(signedResponse({ inResponseTo: oldRequestId }))
    ).resolves.toMatchObject({
      subject: 'subject-123'
    });

    const newService = new SamlServerVerifier(serverConfig(defaultAttributes, certificates));
    const newRequestId = await requestId(newService);
    await expect(
      newService.validatePostResponse(
        signedResponse({ inResponseTo: newRequestId, signingKey: rolloverSigningKey })
      )
    ).resolves.toMatchObject({ subject: 'subject-123' });

    const wrongService = new SamlServerVerifier(serverConfig(defaultAttributes, certificates));
    const wrongRequestId = await requestId(wrongService);
    await expect(
      wrongService.validatePostResponse(
        signedResponse({ inResponseTo: wrongRequestId, signingKey: wrongSigningKey })
      )
    ).rejects.toMatchObject({ code: 'INVALID_SAML_RESPONSE' } satisfies Partial<SamlRuntimeError>);
  });

  it('allows only one concurrent verifier to consume a shared request ID', async () => {
    const store = createInMemorySamlRequestCorrelationStore();
    const first = new SamlServerVerifier({ ...serverConfig(), requestCorrelationStore: store });
    const second = new SamlServerVerifier({ ...serverConfig(), requestCorrelationStore: store });
    const inResponseTo = await requestId(first);
    const response = signedResponse({ inResponseTo });

    const outcomes = await Promise.allSettled([
      first.validatePostResponse(response),
      second.validatePostResponse(response)
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  });

  it('enforces request correlation expiry independently of the configured store', async () => {
    const entries = new Map<string, string>();
    const store: SamlRequestCorrelationStore = {
      async putIfAbsent(key, value) {
        if (entries.has(key)) return false;
        entries.set(key, value);
        return true;
      },
      async take(key) {
        const value = entries.get(key) ?? null;
        entries.delete(key);
        return value;
      }
    };
    const service = new SamlServerVerifier({
      ...serverConfig(),
      requestCorrelationStore: store,
      requestIdTtlMs: 10_000
    });
    const inResponseTo = await requestId(service);
    entries.set(
      inResponseTo,
      JSON.stringify({
        version: 1,
        createdAt: Date.now() - 10_000,
        expiresAt: Date.now(),
        value: 'issued-at'
      })
    );

    await expect(
      service.validatePostResponse(signedResponse({ inResponseTo }))
    ).rejects.toMatchObject({
      code: 'INVALID_SAML_RESPONSE'
    } satisfies Partial<SamlRuntimeError>);
  });

  it('fails closed on corrupt or throwing correlation stores', async () => {
    const corrupt: SamlRequestCorrelationStore = {
      async putIfAbsent() {
        // The store acknowledges persistence but returns corrupt data when consumed.
        return true;
      },
      async take() {
        return '{not-json';
      }
    };
    const corruptService = new SamlServerVerifier({
      ...serverConfig(),
      requestCorrelationStore: corrupt
    });
    const corruptRequestId = await requestId(corruptService);
    await expect(
      corruptService.validatePostResponse(signedResponse({ inResponseTo: corruptRequestId }))
    ).rejects.toMatchObject({ code: 'INVALID_SAML_RESPONSE' } satisfies Partial<SamlRuntimeError>);

    const throwing: SamlRequestCorrelationStore = {
      async putIfAbsent() {
        // The failure is during response correlation, after request creation.
        return true;
      },
      async take() {
        throw new Error('store unavailable');
      }
    };
    const throwingService = new SamlServerVerifier({
      ...serverConfig(),
      requestCorrelationStore: throwing
    });
    const throwingRequestId = await requestId(throwingService);
    await expect(
      throwingService.validatePostResponse(signedResponse({ inResponseTo: throwingRequestId }))
    ).rejects.toMatchObject({ code: 'INVALID_SAML_RESPONSE' } satisfies Partial<SamlRuntimeError>);
  });

  it('physically expires and atomically takes bounded in-memory correlations', async () => {
    let now = 1_000;
    const store = createInMemorySamlRequestCorrelationStore({
      maxEntries: 1,
      now: () => now
    });
    await store.putIfAbsent('first', 'one', now + 10);
    await store.putIfAbsent('second', 'two', now + 10);
    await expect(store.take('first')).resolves.toBeNull();
    await expect(store.take('second')).resolves.toBe('two');
    await store.putIfAbsent('once', 'atomic', now + 10);
    await expect(Promise.all([store.take('once'), store.take('once')])).resolves.toEqual([
      'atomic',
      null
    ]);
    await store.putIfAbsent('expired', 'gone', now + 10);
    now += 10;
    await expect(store.take('expired')).resolves.toBeNull();
  });

  it('rejects duplicate correlation insertion and invalid clocks/store results', async () => {
    const store = createInMemorySamlRequestCorrelationStore({ now: () => 1_000 });
    await expect(store.putIfAbsent('request', 'one', 1_010)).resolves.toBe(true);
    await expect(store.putIfAbsent('request', 'two', 1_010)).resolves.toBe(false);
    await expect(store.take('request')).resolves.toBe('one');

    const brokenClock = createInMemorySamlRequestCorrelationStore({ now: () => Number.NaN });
    await expect(brokenClock.putIfAbsent('request', 'one', 1_010)).rejects.toMatchObject({
      code: 'INVALID_SAML_CONFIG'
    } satisfies Partial<SamlRuntimeError>);
    const clockSamples = [1_000, 1_001, 999];
    const regressingClock = createInMemorySamlRequestCorrelationStore({
      now: () => clockSamples.shift() ?? 999
    });
    await expect(regressingClock.putIfAbsent('request', 'one', 1_010)).rejects.toMatchObject({
      code: 'INVALID_SAML_CONFIG'
    } satisfies Partial<SamlRuntimeError>);

    const badResultStore = {
      async putIfAbsent() {
        return 'yes';
      },
      async take() {
        return null;
      }
    } as unknown as SamlRequestCorrelationStore;
    const service = new SamlServerVerifier({
      ...serverConfig(),
      requestCorrelationStore: badResultStore
    });
    await expect(service.beginAuthorization()).rejects.toMatchObject({
      code: 'INVALID_SAML_RESPONSE'
    } satisfies Partial<SamlRuntimeError>);

    const badTakeStore = {
      async putIfAbsent() {
        return true;
      },
      async take() {
        return 1;
      }
    } as unknown as SamlRequestCorrelationStore;
    const badTakeService = new SamlServerVerifier({
      ...serverConfig(),
      requestCorrelationStore: badTakeStore
    });
    const badTakeRequestId = await requestId(badTakeService);
    await expect(
      badTakeService.validatePostResponse(signedResponse({ inResponseTo: badTakeRequestId }))
    ).rejects.toMatchObject({ code: 'INVALID_SAML_RESPONSE' } satisfies Partial<SamlRuntimeError>);
  });

  it('rejects malformed and oversized base64 responses before XML processing', async () => {
    const service = verifier();
    await expect(service.validatePostResponse('not base64!')).rejects.toMatchObject({
      code: 'INVALID_SAML_RESPONSE'
    } satisfies Partial<SamlRuntimeError>);
    await expect(
      service.validatePostResponse(Buffer.alloc(256 * 1024 + 1).toString('base64'))
    ).rejects.toMatchObject({ code: 'INVALID_SAML_RESPONSE' } satisfies Partial<SamlRuntimeError>);
    const exactLimit = new SamlServerVerifier({ ...serverConfig(), maxResponseBytes: 1_024 });
    await expect(
      exactLimit.validatePostResponse(Buffer.alloc(1_024).toString('base64'))
    ).rejects.toThrow('validation failed');
    await expect(
      service.validatePostResponse('!'.repeat(4 * Math.ceil((256 * 1024) / 3) + 1))
    ).rejects.toThrow('malformed or too large');
  });

  it('copies hostile mutable configuration and returns SAML errors for JavaScript misuse', async () => {
    const certificates = [signingCertificate];
    const attributes = { ...defaultAttributes };
    const mutableStore: SamlRequestCorrelationStore = {
      async putIfAbsent() {
        return true;
      },
      async take() {
        return null;
      }
    };
    const service = new SamlServerVerifier({
      ...serverConfig(attributes, certificates),
      requestCorrelationStore: mutableStore
    });
    certificates[0] = rolloverSigningCertificate;
    attributes.emailAttribute = 'attacker';
    mutableStore.putIfAbsent = async () => false;
    await expect(service.beginAuthorization()).resolves.toBeInstanceOf(URL);
    await expect(service.beginAuthorization(null as unknown as string)).rejects.toMatchObject({
      code: 'INVALID_SAML_RESPONSE'
    } satisfies Partial<SamlRuntimeError>);
    await expect(service.validatePostResponse(null as unknown as string)).rejects.toMatchObject({
      code: 'INVALID_SAML_RESPONSE'
    } satisfies Partial<SamlRuntimeError>);
    expect(() => new SamlServerVerifier(null as unknown as SamlServerConfig)).toThrow(
      SamlRuntimeError
    );
  });

  it('rejects invalid RelayState, configuration bounds, and malformed group values', async () => {
    const service = verifier();
    await expect(
      service.beginAuthorization(`relay${String.fromCharCode(0)}`)
    ).rejects.toMatchObject({
      code: 'INVALID_SAML_RESPONSE'
    } satisfies Partial<SamlRuntimeError>);
    await expect(service.beginAuthorization('x'.repeat(2_049))).rejects.toMatchObject({
      code: 'INVALID_SAML_RESPONSE'
    } satisfies Partial<SamlRuntimeError>);
    await expect(service.beginAuthorization('é'.repeat(1_025))).rejects.toMatchObject({
      code: 'INVALID_SAML_RESPONSE'
    } satisfies Partial<SamlRuntimeError>);
    expect(() => new SamlServerVerifier({ ...serverConfig(), requestIdTtlMs: 9_999 })).toThrow(
      'correlation TTL'
    );
    expect(
      () => new SamlServerVerifier({ ...serverConfig(), acceptedClockSkewMs: 120_001 })
    ).toThrow('clock skew');
    expect(
      () => new SamlServerVerifier({ ...serverConfig(), maxResponseBytes: 256 * 1024 + 1 })
    ).toThrow('size limit');
    expect(
      () =>
        new SamlServerVerifier({
          ...serverConfig(),
          serviceProviderIssuer: `sp${String.fromCharCode(0)}`
        })
    ).toThrow('service provider issuer');
    expect(
      () => new SamlServerVerifier({ ...serverConfig(), idpIssuer: 'x'.repeat(1_025) })
    ).toThrow('IdP issuer');
    expect(
      () =>
        new SamlServerVerifier({
          ...serverConfig(),
          idpSigningCertificates: ['x'.repeat(64 * 1024 + 1)]
        })
    ).toThrow('signing certificate');
    expect(
      () =>
        new SamlServerVerifier({ ...serverConfig(), idpSigningCertificates: ['not-a-public-key'] })
    ).toThrow('signing certificate');
    expect(
      () => new SamlServerVerifier({ ...serverConfig(), idpSigningCertificates: [signingKey] })
    ).toThrow('signing certificate');
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-27T00:00:00.000Z'));
    try {
      expect(
        () =>
          new SamlServerVerifier({
            ...serverConfig(),
            idpSigningCertificates: [shortLivedCertificate]
          })
      ).toThrow('expired or not yet valid');
    } finally {
      dateNow.mockRestore();
    }
    expect(
      () =>
        new SamlServerVerifier({
          ...serverConfig(),
          requestCorrelationStore: {} as SamlServerConfig['requestCorrelationStore']
        })
    ).toThrow('correlation store');
    expect(
      () =>
        new SamlServerVerifier({ ...serverConfig(), callbackUrl: `${callbackUrl}?unsafe=query` })
    ).toThrow('callback URL');
    expect(
      () =>
        new SamlServerVerifier({
          ...serverConfig(),
          callbackUrl: `https://app.example.test/${String.fromCharCode(0)}callback`
        })
    ).toThrow('callback URL');
    expect(
      () =>
        new SamlServerVerifier({
          ...serverConfig(),
          entryPoint: `https://idp.example.test/${'x'.repeat(4_097)}`
        })
    ).toThrow('entry point');
    expect(
      () => new SamlServerVerifier({ ...serverConfig(), entryPoint: `${entryPoint}#fragment` })
    ).toThrow('entry point');
    expect(
      () =>
        new SamlServerVerifier({
          ...serverConfig(),
          entryPoint: 'https://user:password@idp.example.test/sso'
        })
    ).toThrow('entry point');
    expect(
      () =>
        new SamlServerVerifier({
          ...serverConfig(),
          entryPoint: `${entryPoint}?tenant=server-configured`
        })
    ).not.toThrow();
    expect(
      () =>
        new SamlServerVerifier({
          ...serverConfig(),
          attributes: { ...defaultAttributes, groupsAttribute: 'not valid group attribute!' }
        })
    ).toThrow('attribute name');
    expect(
      () =>
        new SamlServerVerifier({
          ...serverConfig(),
          idpSigningCertificates: [signingCertificate, signingCertificate]
        })
    ).toThrow('must not contain duplicates');
    expect(() => new SamlServerVerifier({ ...serverConfig(), idpSigningCertificates: [] })).toThrow(
      'signing certificates are invalid'
    );
    expect(
      () =>
        new SamlServerVerifier({
          ...serverConfig(),
          idpSigningCertificates: Array.from({ length: 5 }, () => signingCertificate)
        })
    ).toThrow('signing certificates are invalid');
    expect(
      () =>
        new SamlServerVerifier({
          ...serverConfig(),
          attributes: { ...defaultAttributes, displayNameAttribute: 'email' }
        })
    ).toThrow('must not be duplicated');

    const inResponseTo = await requestId(service);
    await expect(
      service.validatePostResponse(
        signedResponse({
          inResponseTo,
          attributes: { email: ['person@example.test'], groups: ['invalid group id'] }
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_SAML_RESPONSE' } satisfies Partial<SamlRuntimeError>);
  });

  it('rejects excessive group counts and text bounds', async () => {
    const tooManyGroups = Array.from({ length: 65 }, (_, index) => `group-${index}`);
    const service = verifier();
    const groupRequestId = await requestId(service);
    await expect(
      service.validatePostResponse(
        signedResponse({
          inResponseTo: groupRequestId,
          attributes: { email: ['person@example.test'], groups: tooManyGroups }
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_SAML_RESPONSE' } satisfies Partial<SamlRuntimeError>);

    const oversizedEmailService = verifier();
    const emailRequestId = await requestId(oversizedEmailService);
    await expect(
      oversizedEmailService.validatePostResponse(
        signedResponse({
          inResponseTo: emailRequestId,
          attributes: { email: [`person-${'x'.repeat(320)}@example.test`] }
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_SAML_RESPONSE' } satisfies Partial<SamlRuntimeError>);
  });

  it('rejects duplicate mapped attributes, duplicate groups, and multibyte identity overflows', async () => {
    const duplicateAttributeService = verifier();
    const duplicateAttributeRequestId = await requestId(duplicateAttributeService);
    await expect(
      duplicateAttributeService.validatePostResponse(
        signedResponse({
          inResponseTo: duplicateAttributeRequestId,
          attributeEntries: [
            { name: 'email', values: ['person@example.test'] },
            { name: 'email', values: ['second@example.test'] }
          ]
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_SAML_RESPONSE' } satisfies Partial<SamlRuntimeError>);

    const duplicateGroupService = verifier();
    const duplicateGroupRequestId = await requestId(duplicateGroupService);
    await expect(
      duplicateGroupService.validatePostResponse(
        signedResponse({
          inResponseTo: duplicateGroupRequestId,
          attributes: { email: ['person@example.test'], groups: ['design', 'design'] }
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_SAML_RESPONSE' } satisfies Partial<SamlRuntimeError>);

    const multibyteService = verifier();
    const multibyteRequestId = await requestId(multibyteService);
    await expect(
      multibyteService.validatePostResponse(
        signedResponse({ inResponseTo: multibyteRequestId, subject: 'é'.repeat(257) })
      )
    ).rejects.toMatchObject({ code: 'INVALID_SAML_RESPONSE' } satisfies Partial<SamlRuntimeError>);
  });
});
