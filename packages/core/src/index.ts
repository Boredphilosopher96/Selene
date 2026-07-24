/**
 * Stable, product-neutral primitives. Domain concepts will be introduced by the
 * product-design owner; do not infer them from this bootstrap package.
 */
export interface WorkspaceIdentity {
  readonly id: string;
}

export const corePackageName = '@selene/core';
