export interface PreviewProjectOwnerIdentity {
  readonly projectId: string;
  readonly epoch: number;
}

/** An accepted reopen revokes old cockpit callbacks even for the same project ID. */
export class PreviewProjectOwner {
  private epoch = 0;
  private current: PreviewProjectOwnerIdentity | undefined;

  public choose(projectId: string): PreviewProjectOwnerIdentity {
    const owner = Object.freeze({ projectId, epoch: ++this.epoch });
    this.current = owner;
    return owner;
  }

  public isCurrent(owner: PreviewProjectOwnerIdentity | undefined): boolean {
    return owner !== undefined && this.current === owner;
  }

  public ownsProject(projectId: string): boolean {
    return this.current?.projectId === projectId;
  }

  public clear(): void {
    this.current = undefined;
  }
}
