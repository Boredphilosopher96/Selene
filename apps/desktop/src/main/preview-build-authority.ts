import { serializeCanonicalData, type ReactSourceWorkspace } from '@selene/core';

import {
  validatePreviewBuildTicket,
  type DesignerSnapshot,
  type PreviewBuildTicket
} from '../shared/designer-api';
import type { BoundPreviewBuildIdentity } from './bound-preview-build-coordinator';

export interface ResolvedPreviewBuild {
  readonly ticket: PreviewBuildTicket;
  readonly identity: BoundPreviewBuildIdentity;
  readonly workspace: ReactSourceWorkspace;
}

/**
 * Resolves a renderer-visible identity back to current privileged project state.
 * A stale or modified ticket has no authority and never reaches the compiler.
 */
export class CurrentPreviewBuildAuthority {
  public constructor(private readonly currentSnapshot: () => DesignerSnapshot) {}

  public resolve(value: unknown): ResolvedPreviewBuild {
    const ticket = validatePreviewBuildTicket(value);
    const snapshot = this.currentSnapshot();
    const current = snapshot.editablePrototype.previewTicket;
    if (
      current === undefined ||
      serializeCanonicalData(ticket) !== serializeCanonicalData(current) ||
      snapshot.source.projectId !== ticket.projectId ||
      snapshot.source.revision.id !== ticket.sourceRevisionId ||
      snapshot.editablePrototype.revision !== ticket.graphRevision
    )
      throw new Error('Preview build ticket is stale or does not match the current project.');
    return Object.freeze({
      ticket,
      identity: Object.freeze({
        projectId: ticket.projectId,
        sourceRevisionId: ticket.sourceRevisionId,
        graphRevision: ticket.graphRevision,
        bindingId: ticket.bindingId
      }),
      workspace: structuredClone(snapshot.source)
    });
  }
}
