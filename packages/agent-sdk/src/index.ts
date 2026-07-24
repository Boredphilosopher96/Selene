/**
 * Product-specific capabilities belong to the owning design work. This defines
 * only the transport-neutral contract boundary consumed by applications.
 */
export interface AgentClient<Request, Response> {
  execute(request: Request): Promise<Response>;
}

export const agentSdkPackageName = '@selene/agent-sdk';
