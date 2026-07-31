import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { DesignerSnapshot } from '../src/shared/designer-api';
import { WorkspaceToolbar } from '../src/renderer/src/cockpit/workspace-toolbar';
import type { WorkspaceControlActions } from '../src/renderer/src/cockpit/workspace-controls';

type DiagnosticsConsent = 'unknown' | 'granted' | 'denied';

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: Value) => void;
};

function deferred<Value>(): Deferred<Value> {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

const firstConsent = deferred<{ readonly user: DiagnosticsConsent }>();
const firstRecovery = deferred<{ readonly active: boolean }>();
const firstConsentMutation = deferred<{ readonly user: DiagnosticsConsent }>();
let consentRefreshes = 0;
let recoveryRefreshes = 0;
let consentMutations = 0;
const statusMessages: string[] = [];
const diagnosticsTrace: string[] = [];
let rerenderHarness: (() => void) | undefined;

function trace(event: string): void {
  diagnosticsTrace.push(event);
}

function observeSettlement<Value>(label: string, request: Promise<Value>): Promise<Value> {
  trace(`${label}:started`);
  return request.then(
    (value) => {
      trace(`${label}:fulfilled`);
      return value;
    },
    (error: unknown) => {
      trace(`${label}:rejected:${error instanceof Error ? error.message : 'unknown'}`);
      throw error;
    }
  );
}

const baseline = {
  projectId: 'toolbar-strict-mode-project',
  readiness: 'draft',
  currency: 'none',
  changesSinceBaseline: [],
  approvalsStale: false
} as const satisfies DesignerSnapshot['baseline'];

const actions = {
  render: async () => undefined,
  markReadyForReview: async (): Promise<DesignerSnapshot> => {
    throw new Error('Review is not part of the diagnostics harness.');
  },
  markReadyForHandoff: async (): Promise<DesignerSnapshot> => {
    throw new Error('Handoff is not part of the diagnostics harness.');
  },
  configureProductShell: async (): Promise<DesignerSnapshot> => {
    throw new Error('Product structure is not part of the diagnostics harness.');
  },
  exportHandoff: async () => 'unused',
  exportProductHandoff: async () => 'unused',
  diagnostics: {
    consent: () => {
      consentRefreshes += 1;
      const call = consentRefreshes;
      trace(`consent:read:${call}`);
      return observeSettlement(
        `consent:read:${call}`,
        call === 1 ? firstConsent.promise : Promise.resolve({ user: 'unknown' as const })
      );
    },
    recovery: () => {
      recoveryRefreshes += 1;
      const call = recoveryRefreshes;
      trace(`recovery:read:${call}`);
      return observeSettlement(
        `recovery:read:${call}`,
        call === 1 ? firstRecovery.promise : Promise.resolve({ active: false } as const)
      );
    },
    resetRecovery: async () => ({ active: false }) as const,
    setConsent: (choice: 'granted' | 'denied') => {
      consentMutations += 1;
      const call = consentMutations;
      trace(`consent:write:${call}:${choice}`);
      return observeSettlement(
        `consent:write:${call}:${choice}`,
        call === 1 ? firstConsentMutation.promise : Promise.resolve({ user: choice } as const)
      );
    },
    export: async () => ({}) as unknown,
    delete: async () => undefined
  }
} satisfies WorkspaceControlActions;

declare global {
  interface Window {
    seleneWorkspaceToolbarHarness?: {
      readonly state: () => {
        readonly consentMutations: number;
        readonly consentRefreshes: number;
        readonly recoveryRefreshes: number;
        readonly statusMessages: readonly string[];
        readonly trace: readonly string[];
        readonly component: {
          readonly busy: string | undefined;
          readonly consent: string | undefined;
          readonly consentChecked: boolean | undefined;
          readonly consentDisabled: boolean | undefined;
          readonly recovery: string | undefined;
          readonly saving: string | undefined;
        };
      };
      readonly rerender: () => void;
      readonly resolveInitialRefresh: (consent: DiagnosticsConsent) => void;
      readonly resolveConsentMutation: () => void;
    };
  }
}

function WorkspaceToolbarDiagnosticsHarness() {
  const [, setRender] = useState(0);
  rerenderHarness = () => setRender((count) => count + 1);
  // Renderer host facades can be freshly wrapped during a parent render. The
  // toolbar must keep a project read alive across that identity churn.
  const unstableActions = {
    ...actions,
    diagnostics: {
      ...actions.diagnostics,
      consent: () => actions.diagnostics.consent(),
      recovery: () => actions.diagnostics.recovery(),
      setConsent: (choice: 'granted' | 'denied') => actions.diagnostics.setConsent(choice)
    }
  } satisfies WorkspaceControlActions;
  return (
    <WorkspaceToolbar
      baseline={baseline}
      actions={unstableActions}
      onSnapshot={() => undefined}
      onStatus={(message) => statusMessages.push(message)}
      onDeliveryBusyChange={() => undefined}
      workspaceBlocked={false}
      onExportHandoff={() => undefined}
      onExportProductHandoff={() => undefined}
      onExportDiagnostics={() => undefined}
      onPublish={async () => undefined}
      publishActive={false}
      publishStarting={false}
      publishStatus="Idle"
      onCancelPublish={async () => undefined}
      onGitHubSetup={async () => {
        throw new Error('Publishing is not part of the diagnostics harness.');
      }}
      onOpenCompletedReceipt={async () => undefined}
    />
  );
}

window.seleneWorkspaceToolbarHarness = {
  state: () => {
    const panel = document.querySelector<HTMLElement>('[data-diagnostics-consent]');
    const consent = document.querySelector<HTMLInputElement>('.workspace-toolbar__consent input');
    return {
      consentMutations,
      consentRefreshes,
      recoveryRefreshes,
      statusMessages: [...statusMessages],
      trace: [...diagnosticsTrace],
      component: {
        busy: panel?.dataset.diagnosticsBusy,
        consent: panel?.dataset.diagnosticsConsent,
        consentChecked: consent?.checked,
        consentDisabled: consent?.disabled,
        recovery: panel?.dataset.diagnosticsRecovery,
        saving: panel?.dataset.diagnosticsSaving
      }
    };
  },
  rerender: () => rerenderHarness?.(),
  resolveInitialRefresh: (consent) => {
    firstConsent.resolve({ user: consent });
    firstRecovery.resolve({ active: false });
  },
  resolveConsentMutation: () => {
    firstConsentMutation.resolve({ user: 'granted' });
  }
};

const root = document.getElementById('root');
if (!root) throw new Error('Workspace toolbar test fixture requires its root element.');
createRoot(root).render(
  <StrictMode>
    <WorkspaceToolbarDiagnosticsHarness />
  </StrictMode>
);
