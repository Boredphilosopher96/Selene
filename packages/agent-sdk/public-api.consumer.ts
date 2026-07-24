import {
  recoverAdapterGeneration,
  replaceAdapterGeneration,
  streamValidatedEvents,
  type AgentAdapter,
  type AgentProviderCallContext,
  type AgentProviderRuntime
} from '@selene/agent-sdk';

declare const runtime: AgentProviderRuntime;
const adapter: AgentAdapter = {
  capabilities: ['project.inspect'],
  async *stream(_context: AgentProviderCallContext, execution) {
    yield {
      protocolVersion: '1.0',
      kind: 'event',
      messageId: 'consumer-1',
      sentAt: '2026-07-24T00:00:00Z',
      requestId: execution.requestId,
      event: 'completed'
    };
  }
};

void streamValidatedEvents(
  adapter,
  { requestId: 'request-1', capability: 'project.inspect', input: {} },
  { runtime }
);
replaceAdapterGeneration(adapter, runtime);
recoverAdapterGeneration(adapter, runtime);
