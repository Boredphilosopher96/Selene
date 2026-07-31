import { randomBytes } from 'node:crypto';

import { projectComponentCatalogManifest, serializeCanonicalData } from '@selene/core';

import {
  validateStoryPreviewTicket,
  type StoryPreviewBuildResult,
  type StoryPreviewTicket
} from '../shared/designer-api';
import type { ComponentCatalogManifestPort, StoryPreviewCapabilityPort } from './designer-service';
import {
  createPreviewSecurityPolicy,
  type PublishedPreview,
  type PreviewSecurityPolicy
} from './preview-adapter';

export interface StoryPreviewIdentity {
  readonly projectId: string;
  readonly sourceRevisionId: string;
  readonly catalogRevision: string;
  readonly buildId: string;
  readonly componentId: string;
  readonly storyId: string;
}

/** Trusted adapter that compiles and publishes one canonical story through the preview sandbox. */
export interface StoryPreviewBuildPort {
  supports(identity: StoryPreviewIdentity): boolean;
  build(identity: StoryPreviewIdentity, signal: AbortSignal): Promise<PublishedPreview>;
}

export class UnconfiguredStoryPreviewBuildPort implements StoryPreviewBuildPort {
  public supports(): false {
    return false;
  }

  public build(): Promise<never> {
    return Promise.reject(new Error('Story preview compilation is not configured.'));
  }
}

interface IssuedStoryPreview {
  readonly key: string;
  readonly ticket: StoryPreviewTicket;
  readonly identity: StoryPreviewIdentity;
}

export interface StoryPreviewAuthorityOptions {
  readonly maximumCapabilities?: number;
  readonly capabilityId?: () => string;
}

function capabilityError(): Error {
  return new Error('Story preview capability is invalid or stale.');
}

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError');
}

function canonicalIdentity(value: StoryPreviewIdentity): StoryPreviewIdentity {
  const validated = validateStoryPreviewTicket({
    format: 'selene-story-preview-ticket/v1',
    capabilityId: 'x'.repeat(32),
    ...value
  });
  return Object.freeze({
    projectId: validated.projectId,
    sourceRevisionId: validated.sourceRevisionId,
    catalogRevision: validated.catalogRevision,
    buildId: validated.buildId,
    componentId: validated.componentId,
    storyId: validated.storyId
  });
}

function canonicalPublishedPreview(value: PublishedPreview): PublishedPreview {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.url !== 'string' ||
    typeof value.revisionId !== 'string' ||
    value.revisionId.length === 0 ||
    value.revisionId.length > 256 ||
    typeof value.policy !== 'object' ||
    value.policy === null
  )
    throw new Error('Story preview builder returned an invalid publication.');
  const policy: PreviewSecurityPolicy = createPreviewSecurityPolicy(
    value.policy.origin,
    value.policy.nonce,
    value.policy.maxMessageBytes
  );
  if (value.policy.csp !== policy.csp || !value.url.startsWith(`${policy.origin}/`))
    throw new Error('Story preview publication does not match its sandbox policy.');
  return Object.freeze({
    url: value.url,
    revisionId: value.revisionId,
    policy: Object.freeze(policy)
  });
}

/**
 * Issues and resolves bounded, unguessable story capabilities.
 *
 * Every use re-reads the current host manifest and requires the exact project,
 * source revision, catalog revision, build, component, and story tuple. Tokens
 * never authorize another story and are invalidated by catalog or source drift.
 */
export class StoryPreviewAuthority implements StoryPreviewCapabilityPort {
  private readonly maximumCapabilities: number;
  private readonly capabilityId: () => string;
  private readonly byCapability = new Map<string, IssuedStoryPreview>();
  private readonly byIdentity = new Map<string, string>();
  private readonly active = new Map<number, AbortController>();

  public constructor(
    private readonly manifests: ComponentCatalogManifestPort,
    private readonly builder: StoryPreviewBuildPort,
    options: StoryPreviewAuthorityOptions = {}
  ) {
    const maximum = options.maximumCapabilities ?? 512;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4_096)
      throw new Error('Story preview capability limit must be between 1 and 4096.');
    this.maximumCapabilities = maximum;
    this.capabilityId = options.capabilityId ?? (() => randomBytes(24).toString('base64url'));
  }

  public issue(input: StoryPreviewIdentity): StoryPreviewTicket | undefined {
    let identity: StoryPreviewIdentity;
    try {
      identity = canonicalIdentity(input);
      this.assertCurrent(identity);
      if (!this.supports(identity)) return undefined;
    } catch {
      return undefined;
    }
    const key = serializeCanonicalData(identity);
    const existingCapability = this.byIdentity.get(key);
    if (existingCapability !== undefined) {
      const existing = this.byCapability.get(existingCapability);
      if (existing !== undefined) {
        this.byCapability.delete(existingCapability);
        this.byCapability.set(existingCapability, existing);
        return existing.ticket;
      }
      this.byIdentity.delete(key);
    }
    const capabilityId = this.nextCapabilityId();
    const ticket = validateStoryPreviewTicket({
      format: 'selene-story-preview-ticket/v1',
      capabilityId,
      ...identity
    });
    const issued = Object.freeze({ key, ticket, identity });
    this.byIdentity.set(key, capabilityId);
    this.byCapability.set(capabilityId, issued);
    this.trim();
    return ticket;
  }

  public async build(callerId: number, value: unknown): Promise<StoryPreviewBuildResult> {
    if (!Number.isSafeInteger(callerId) || callerId < 0)
      throw new Error('Story preview caller is invalid.');
    const issued = this.resolve(value);
    this.active.get(callerId)?.abort();
    const controller = new AbortController();
    this.active.set(callerId, controller);
    try {
      let published: PublishedPreview;
      try {
        published = canonicalPublishedPreview(
          await this.builder.build(issued.identity, controller.signal)
        );
      } catch {
        if (controller.signal.aborted)
          throw abortError('Story preview build was superseded or cancelled.');
        throw new Error('Story preview could not be built.');
      }
      if (controller.signal.aborted)
        throw abortError('Story preview build was superseded or cancelled.');
      const current = this.resolve(value);
      if (current !== issued) throw capabilityError();
      return Object.freeze({
        ...published,
        projectId: issued.identity.projectId,
        sourceRevisionId: issued.identity.sourceRevisionId,
        catalogRevision: issued.identity.catalogRevision,
        buildId: issued.identity.buildId,
        componentId: issued.identity.componentId,
        storyId: issued.identity.storyId
      });
    } finally {
      if (this.active.get(callerId) === controller) this.active.delete(callerId);
    }
  }

  public cancel(callerId: number): void {
    this.active.get(callerId)?.abort();
    this.active.delete(callerId);
  }

  public revokeProject(projectId: string): void {
    for (const [capabilityId, issued] of this.byCapability) {
      if (issued.identity.projectId !== projectId) continue;
      this.byCapability.delete(capabilityId);
      this.byIdentity.delete(issued.key);
    }
  }

  public reset(): void {
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    this.byCapability.clear();
    this.byIdentity.clear();
  }

  private resolve(value: unknown): IssuedStoryPreview {
    let ticket: StoryPreviewTicket;
    try {
      ticket = validateStoryPreviewTicket(value);
    } catch {
      throw capabilityError();
    }
    const issued = this.byCapability.get(ticket.capabilityId);
    if (
      issued === undefined ||
      serializeCanonicalData(issued.ticket) !== serializeCanonicalData(ticket)
    )
      throw capabilityError();
    this.assertCurrent(issued.identity);
    if (!this.supports(issued.identity)) throw capabilityError();
    return issued;
  }

  private assertCurrent(identity: StoryPreviewIdentity): void {
    let value: unknown;
    try {
      value = this.manifests.current(identity.projectId);
    } catch {
      throw capabilityError();
    }
    const projection = projectComponentCatalogManifest(value, {
      projectId: identity.projectId,
      prototypeRevision: identity.sourceRevisionId
    });
    if (
      projection.state !== 'ready' ||
      projection.catalogRevision !== identity.catalogRevision ||
      projection.buildId !== identity.buildId
    )
      throw capabilityError();
    const component = projection.components.find(
      (candidate) => candidate.id === identity.componentId
    );
    if (!component?.stories.some((story) => story.id === identity.storyId)) throw capabilityError();
  }

  private nextCapabilityId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.capabilityId();
      if (/^[A-Za-z0-9_-]{32,128}$/u.test(candidate) && !this.byCapability.has(candidate))
        return candidate;
    }
    throw new Error('Story preview capability issuer did not produce a unique token.');
  }

  private supports(identity: StoryPreviewIdentity): boolean {
    try {
      return this.builder.supports(identity);
    } catch {
      return false;
    }
  }

  private trim(): void {
    while (this.byCapability.size > this.maximumCapabilities) {
      const capabilityId = this.byCapability.keys().next().value as string;
      const removed = this.byCapability.get(capabilityId);
      this.byCapability.delete(capabilityId);
      if (removed !== undefined) this.byIdentity.delete(removed.key);
    }
  }
}
