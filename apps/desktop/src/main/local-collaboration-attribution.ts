import type { CollaborationSnapshot } from '@selene/collaboration';

const localCollaborationOrganizationId = 'local-desktop';
const legacyLocalCollaborationActorId = 'desktop-reviewer';

/**
 * Upgrades only records proven to use Selene's former profile-global desktop actor. Other
 * collaboration authors, provider identities, and agent provenance remain byte-for-byte stable.
 */
export function migrateLegacyLocalCollaborationAttribution(
  snapshot: CollaborationSnapshot,
  authorId: string
): { readonly snapshot: CollaborationSnapshot; readonly migrated: boolean } {
  if (
    snapshot.project.organizationId !== localCollaborationOrganizationId ||
    !snapshot.revisions.some((revision) => revision.createdBy === legacyLocalCollaborationActorId)
  )
    return { snapshot, migrated: false };
  let migrated = false;
  const actor = (value: string): string => {
    if (value !== legacyLocalCollaborationActorId) return value;
    migrated = true;
    return authorId;
  };
  const actors = (values: readonly string[]): readonly string[] => values.map(actor);
  const designReviewState =
    snapshot.designReviewState === undefined
      ? undefined
      : {
          ...snapshot.designReviewState,
          ...(snapshot.designReviewState.baseline === undefined
            ? {}
            : {
                baseline: {
                  ...snapshot.designReviewState.baseline,
                  createdBy: actor(snapshot.designReviewState.baseline.createdBy)
                }
              }),
          changesSinceBaseline: snapshot.designReviewState.changesSinceBaseline.map((change) =>
            change.provenance.kind === 'actor'
              ? {
                  ...change,
                  provenance: { ...change.provenance, actorId: actor(change.provenance.actorId) }
                }
              : change
          )
        };
  const next: CollaborationSnapshot = {
    ...snapshot,
    revisions: snapshot.revisions.map((revision) => ({
      ...revision,
      createdBy: actor(revision.createdBy)
    })),
    threads: snapshot.threads.map((thread) => ({
      ...thread,
      createdBy: actor(thread.createdBy),
      ...(thread.resolvedBy === undefined ? {} : { resolvedBy: actor(thread.resolvedBy) })
    })),
    comments: snapshot.comments.map((comment) => ({
      ...comment,
      createdBy: actor(comment.createdBy),
      mentionedUserIds: actors(comment.mentionedUserIds)
    })),
    reactions: snapshot.reactions.map((reaction) => ({
      ...reaction,
      userId: actor(reaction.userId)
    })),
    approvals: snapshot.approvals.map((approval) => ({
      ...approval,
      userId: actor(approval.userId)
    })),
    reviewThreads: snapshot.reviewThreads.map((thread) => ({
      ...thread,
      createdBy: actor(thread.createdBy),
      ...(thread.resolvedBy === undefined ? {} : { resolvedBy: actor(thread.resolvedBy) }),
      ...(thread.reopenedBy === undefined ? {} : { reopenedBy: actor(thread.reopenedBy) }),
      ...(thread.movedBy === undefined ? {} : { movedBy: actor(thread.movedBy) }),
      messages: thread.messages.map((message) => ({
        ...message,
        createdBy: actor(message.createdBy),
        mentionedUserIds: actors(message.mentionedUserIds),
        reactions: message.reactions.map((reaction) => ({
          ...reaction,
          userIds: actors(reaction.userIds)
        })),
        readBy: actors(message.readBy)
      }))
    })),
    aiChangeRequests: snapshot.aiChangeRequests.map((request) => ({
      ...request,
      createdBy: actor(request.createdBy)
    })),
    developerAnnotations: snapshot.developerAnnotations.map((annotation) => ({
      ...annotation,
      createdBy: actor(annotation.createdBy)
    })),
    ...(designReviewState === undefined ? {} : { designReviewState })
  };
  return { snapshot: migrated ? next : snapshot, migrated };
}
