import { describe, expect, it } from 'vitest';

import type { AIChangeRequest } from '../../../shared/designer-api';
import {
  canApplyConversationOperation,
  canStartConversationOperation,
  composerDisabledReason,
  isHostRequestActive,
  isCurrentProjectOwner,
  isConversationBusy,
  isCurrentProjectProgress,
  requestInput,
  requestOutcome
} from './ai-conversation-model';

const request: AIChangeRequest = {
  id: 'desktop-request-1',
  agentId: 'fixture-agent',
  instruction: 'Clarify the primary action.',
  status: 'failed',
  createdAt: '2026-07-25T00:00:00.000Z',
  error: 'Agent is offline.',
  target: {
    x: 0.25,
    y: 0.5,
    width: 0.2,
    height: 0.15,
    viewport: { width: 1280, height: 800 },
    nodeRef: 'primary-action',
    artifactId: 'desktop-designer',
    screenId: 'desktop-designer',
    scenarioId: 'owner-loading-desktop',
    state: 'loading',
    revisionId: 'desktop-r1'
  }
};

describe('AI conversation request model', () => {
  it('retries only the immutable user instruction and portable spatial target', () => {
    expect(requestInput(request)).toEqual({
      agentId: 'fixture-agent',
      instruction: 'Clarify the primary action.',
      target: {
        x: 0.25,
        y: 0.5,
        width: 0.2,
        height: 0.15,
        viewport: { width: 1280, height: 800 },
        nodeRef: 'primary-action'
      }
    });
  });

  it('makes failure and composer disabled states truthful', () => {
    expect(requestOutcome(request)).toBe('Agent is offline.');
    expect(
      requestOutcome({
        ...request,
        error: '\u001B[31mspawn /Users/designer/secret at https://provider.example.test\u001B[0m'
      })
    ).toBe('The AI change did not finish. Try again, or choose another configured agent.');
    expect(
      composerDisabledReason({
        agentAvailable: true,
        requestActive: false,
        instruction: request.instruction,
        target: undefined
      })
    ).toBe('Choose a preview target before sending it.');
    expect(
      composerDisabledReason({
        agentAvailable: false,
        requestActive: false,
        instruction: request.instruction,
        target: requestInput(request).target
      })
    ).toBe('No configured agent is available. Complete agent setup before sending a change.');
  });

  it('distinguishes a compiled proposal awaiting a designer decision from an applied change', () => {
    expect(requestOutcome({ ...request, status: 'reviewing' })).toBe(
      'Compiled proposal is ready to preview, accept, or reject.'
    );
  });

  it('keeps owned host progress busy across a visual collapse and rejects stale project progress', () => {
    const progress = {
      requestId: request.id,
      agentId: request.agentId,
      stage: 'thinking' as const,
      message: 'Preparing a safe patch.'
    };
    expect(isHostRequestActive(progress)).toBe(true);
    expect(
      isCurrentProjectProgress({
        progress,
        currentRequestIds: [],
        localSubmissionProjectId: 'project-a',
        currentProjectId: 'project-a'
      })
    ).toBe(true);
    expect(
      isCurrentProjectProgress({
        progress,
        currentRequestIds: [],
        localSubmissionProjectId: 'project-a',
        currentProjectId: 'project-b'
      })
    ).toBe(false);
    expect(
      canApplyConversationOperation({
        token: 3,
        currentToken: 3,
        projectId: 'project-a',
        currentProjectId: 'project-b'
      })
    ).toBe(false);
    expect(isCurrentProjectOwner('project-a', 'project-b')).toBe(false);
    expect(isConversationBusy({ requestActive: false, undoActive: true })).toBe(true);
    expect(canStartConversationOperation({ requestActive: false, undoActive: true })).toBe(false);
  });
});
