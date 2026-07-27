import { createHash } from 'node:crypto';

import {
  parseReactBindingCompilerEvidence,
  serializeCanonicalData,
  validateReactSourceWorkspace,
  type ReactBindingCompilerEvidence,
  type ReactBuildArtifact,
  type ReactCompilerPort,
  type ReactSourceWorkspace
} from '@selene/core';

export interface BoundPreviewBuildIdentity {
  readonly projectId: string;
  readonly sourceRevisionId: string;
  readonly graphRevision: number;
  /** SHA-256 commitment to the validated graph-to-source binding manifest. */
  readonly bindingId: string;
}

export interface BoundPreviewBuildRequest {
  readonly identity: BoundPreviewBuildIdentity;
  readonly workspace: ReactSourceWorkspace;
  readonly compilerEvidence: ReactBindingCompilerEvidence;
}

interface PreparedBuild {
  readonly key: string;
  readonly identity: BoundPreviewBuildIdentity;
  readonly workspace: ReactSourceWorkspace;
}

interface InFlightBuild {
  readonly key: string;
  readonly controller: AbortController;
  promise: Promise<ReactBuildArtifact>;
  waiters: number;
  settled: boolean;
}

export interface BoundPreviewBuildCoordinatorOptions {
  readonly maximumRetainedArtifacts?: number;
}

const sha256Pattern = /^[a-f0-9]{64}$/;

function sha256(value: unknown): string {
  return createHash('sha256').update(serializeCanonicalData(value)).digest('hex');
}

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError');
}

function immutableArtifact(artifact: ReactBuildArtifact): ReactBuildArtifact {
  const diagnostics = Object.freeze(
    artifact.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }))
  );
  return Object.freeze({
    revisionId: artifact.revisionId,
    code: artifact.code,
    ...(artifact.css === undefined ? {} : { css: artifact.css }),
    ...(artifact.sourceMap === undefined ? {} : { sourceMap: artifact.sourceMap }),
    diagnostics
  });
}

/**
 * Compiles one immutable artifact for an exact host-issued preview identity.
 *
 * Concurrent callers for the same source/graph/binding/evidence tuple share one
 * compiler invocation. Successful artifacts are retained only under that exact
 * tuple, so a failed build can never fall back to another project or revision.
 */
export class BoundPreviewBuildCoordinator {
  private readonly maximumRetainedArtifacts: number;
  private readonly retained = new Map<string, ReactBuildArtifact>();
  private readonly inFlight = new Map<string, InFlightBuild>();

  public constructor(
    private readonly compiler: ReactCompilerPort,
    options: BoundPreviewBuildCoordinatorOptions = {}
  ) {
    const maximum = options.maximumRetainedArtifacts ?? 8;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64)
      throw new Error('Bound preview artifact limit must be between 1 and 64.');
    this.maximumRetainedArtifacts = maximum;
  }

  public build(
    request: BoundPreviewBuildRequest,
    signal?: AbortSignal
  ): Promise<ReactBuildArtifact> {
    const prepared = this.prepare(request);
    if (signal?.aborted)
      return Promise.reject(abortError('Bound preview build was cancelled before compilation.'));
    const retained = this.retained.get(prepared.key);
    if (retained !== undefined) {
      this.retained.delete(prepared.key);
      this.retained.set(prepared.key, retained);
      return Promise.resolve(retained);
    }
    const flight = this.inFlight.get(prepared.key) ?? this.start(prepared);
    return this.join(flight, signal);
  }

  public clear(): void {
    for (const flight of this.inFlight.values()) flight.controller.abort();
    this.inFlight.clear();
    this.retained.clear();
  }

  private prepare(request: BoundPreviewBuildRequest): PreparedBuild {
    validateReactSourceWorkspace(request.workspace);
    const workspace = structuredClone(request.workspace);
    const evidence = parseReactBindingCompilerEvidence(request.compilerEvidence);
    const { identity } = request;
    if (
      typeof identity !== 'object' ||
      identity === null ||
      identity.projectId !== workspace.projectId ||
      identity.sourceRevisionId !== workspace.revision.id ||
      evidence.projectId !== identity.projectId ||
      evidence.sourceRevisionId !== identity.sourceRevisionId ||
      evidence.entrypoint !== workspace.entrypoint ||
      !evidence.reachableFiles.includes(workspace.entrypoint) ||
      evidence.sourceSha256 !== sha256(workspace) ||
      !Number.isSafeInteger(identity.graphRevision) ||
      identity.graphRevision < 0 ||
      !sha256Pattern.test(identity.bindingId)
    )
      throw new Error('Bound preview build identity does not match its compiler inputs.');
    const compilerEvidenceSha256 = sha256(evidence);
    const exactIdentity = Object.freeze({
      projectId: identity.projectId,
      sourceRevisionId: identity.sourceRevisionId,
      graphRevision: identity.graphRevision,
      bindingId: identity.bindingId
    });
    return {
      key: serializeCanonicalData({ ...exactIdentity, compilerEvidenceSha256 }),
      identity: exactIdentity,
      workspace
    };
  }

  private start(prepared: PreparedBuild): InFlightBuild {
    const controller = new AbortController();
    const flight: InFlightBuild = {
      key: prepared.key,
      controller,
      promise: Promise.resolve({
        revisionId: prepared.identity.sourceRevisionId,
        code: '',
        diagnostics: []
      }),
      waiters: 0,
      settled: false
    };
    flight.promise = this.compiler
      .compile(prepared.workspace, controller.signal)
      .then((artifact) => {
        if (controller.signal.aborted) throw abortError('Bound preview compilation was cancelled.');
        if (artifact.revisionId !== prepared.identity.sourceRevisionId)
          throw new Error('Bound preview compiler returned a different source revision.');
        const immutable = immutableArtifact(artifact);
        if (immutable.diagnostics.length === 0) this.retain(prepared.key, immutable);
        return immutable;
      })
      .finally(() => {
        flight.settled = true;
        if (this.inFlight.get(prepared.key) === flight) this.inFlight.delete(prepared.key);
      });
    this.inFlight.set(prepared.key, flight);
    return flight;
  }

  private join(
    flight: InFlightBuild,
    signal: AbortSignal | undefined
  ): Promise<ReactBuildArtifact> {
    flight.waiters += 1;
    return new Promise<ReactBuildArtifact>((resolve, reject) => {
      let completed = false;
      const finish = (settle: () => void): void => {
        if (completed) return;
        completed = true;
        signal?.removeEventListener('abort', onAbort);
        flight.waiters -= 1;
        if (flight.waiters === 0 && !flight.settled) {
          flight.controller.abort();
          if (this.inFlight.get(flight.key) === flight) this.inFlight.delete(flight.key);
        }
        settle();
      };
      const onAbort = (): void =>
        finish(() => reject(abortError('Bound preview build caller was cancelled.')));
      signal?.addEventListener('abort', onAbort, { once: true });
      flight.promise.then(
        (artifact) => finish(() => resolve(artifact)),
        (error: unknown) => finish(() => reject(error))
      );
    });
  }

  private retain(key: string, artifact: ReactBuildArtifact): void {
    this.retained.delete(key);
    this.retained.set(key, artifact);
    while (this.retained.size > this.maximumRetainedArtifacts)
      this.retained.delete(this.retained.keys().next().value as string);
  }
}
