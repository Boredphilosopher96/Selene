export class VerifiedBunRuntimeError extends Error {
  public constructor(
    public readonly code:
      | 'CANCELLED'
      | 'TIMEOUT'
      | 'TOOL_UNAVAILABLE'
      | 'SETUP_REQUIRED'
      | 'PROCESS_FAILED'
      | 'PROCESS_ORPHANED',
    message: string,
    public readonly processGroupId?: number,
    public readonly cleanupScope: 'runtime-stage' = 'runtime-stage'
  ) {
    super(message);
  }
}
