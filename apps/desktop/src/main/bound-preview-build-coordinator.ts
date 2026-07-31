import { createHash } from 'node:crypto';

import {
  serializeCanonicalData,
  validateReactSourceWorkspace,
  type ReactBuildArtifact,
  type ReactCompilerPort,
  type ReactSourceWorkspace
} from '@selene/core';

export interface BoundPreviewBuildIdentity {
  readonly projectId: string;
  readonly sourceRevisionId: string;
  readonly graphRevision: number;
  readonly bindingId: string;
}

export interface BoundPreviewBuildRequest {
  readonly identity: BoundPreviewBuildIdentity;
  readonly workspace: ReactSourceWorkspace;
}

interface PreparedBuild extends BoundPreviewBuildRequest {
  readonly key: string;
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

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError');
}

function immutableArtifact(artifact: ReactBuildArtifact): ReactBuildArtifact {
  const receipt =
    artifact.receipt === undefined
      ? undefined
      : Object.freeze({
          ...artifact.receipt,
          reachableFiles: Object.freeze([...artifact.receipt.reachableFiles])
        });
  return Object.freeze({
    revisionId: artifact.revisionId,
    code: artifact.code,
    ...(artifact.css === undefined ? {} : { css: artifact.css }),
    ...(artifact.sourceMap === undefined ? {} : { sourceMap: artifact.sourceMap }),
    ...(receipt === undefined ? {} : { receipt }),
    diagnostics: Object.freeze(
      artifact.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }))
    )
  });
}

/**
 * Compiles and retains artifacts only under an exact host-issued identity.
 * Same-identity callers share work; no failed build can borrow another project's last-good output.
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

  public async build(
    request: BoundPreviewBuildRequest,
    signal?: AbortSignal
  ): Promise<ReactBuildArtifact> {
    const prepared = this.prepare(request);
    if (signal?.aborted) throw abortError('Bound preview build was cancelled before compilation.');
    const retained = this.retained.get(prepared.key);
    if (retained !== undefined) {
      this.retained.delete(prepared.key);
      this.retained.set(prepared.key, retained);
      return retained;
    }
    return this.join(this.inFlight.get(prepared.key) ?? this.start(prepared), signal);
  }

  public clear(): void {
    for (const flight of this.inFlight.values()) flight.controller.abort();
    this.inFlight.clear();
    this.retained.clear();
  }

  private prepare(request: BoundPreviewBuildRequest): PreparedBuild {
    validateReactSourceWorkspace(request.workspace);
    const workspace = structuredClone(request.workspace);
    const identity = Object.freeze({ ...request.identity });
    if (
      identity.projectId !== workspace.projectId ||
      identity.sourceRevisionId !== workspace.revision.id ||
      !Number.isSafeInteger(identity.graphRevision) ||
      identity.graphRevision < 0 ||
      !sha256Pattern.test(identity.bindingId)
    )
      throw new Error('Bound preview build identity does not match its workspace.');
    const workspaceDigest = createHash('sha256')
      .update(serializeCanonicalData(workspace))
      .digest('hex');
    return {
      key: serializeCanonicalData({ ...identity, workspaceDigest }),
      identity,
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
