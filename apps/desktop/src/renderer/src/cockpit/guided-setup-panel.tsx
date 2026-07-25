import { useState } from 'react';

import type {
  DesignerAgentSummary,
  DesignerSnapshot,
  DesignSystemIntakeReceipt,
  MarkdownIntakeReceipt
} from '../../../shared/designer-api';

export interface GuidedSetupActions {
  selectAgent(agentId: string): Promise<DesignerSnapshot>;
  configureTrustedAgent(): Promise<readonly DesignerAgentSummary[]>;
  snapshot(): Promise<DesignerSnapshot>;
  inspectDesignSystem(request: {
    readonly name: string;
    readonly version: string;
  }): Promise<DesignSystemIntakeReceipt>;
  ingestDesignLanguage(request: { readonly markdown: string }): Promise<MarkdownIntakeReceipt>;
}

interface GuidedSetupPanelProps {
  readonly snapshot: DesignerSnapshot;
  readonly onSnapshot: (snapshot: DesignerSnapshot) => void;
  readonly actions: GuidedSetupActions;
}

/** Host-backed setup controls. Every success message is based on a host receipt. */
export function GuidedSetupPanel({ snapshot, onSnapshot, actions }: GuidedSetupPanelProps) {
  const [designPackageName, setDesignPackageName] = useState('@selene/design-tokens');
  const [designPackageVersion, setDesignPackageVersion] = useState('1.0.0');
  const [designMarkdown, setDesignMarkdown] = useState(
    '# Design\n\n## Principles\n\nUse semantic tokens.'
  );
  const [status, setStatus] = useState('No design input has been staged.');

  const failure = (error: unknown, fallback: string) =>
    setStatus(error instanceof Error ? error.message : fallback);
  return (
    <section aria-label="Guided local setup">
      <h2>Guided local setup</h2>
      <label>
        Trusted custom agent
        <select
          value={snapshot.selectedAgentId}
          onChange={(event) =>
            void actions
              .selectAgent(event.currentTarget.value)
              .then(onSnapshot)
              .catch((error: unknown) => failure(error, 'Could not select the trusted agent.'))
          }
        >
          {snapshot.agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() =>
          void actions
            .configureTrustedAgent()
            .then(async (agents) => {
              if (agents.length > 0) onSnapshot(await actions.snapshot());
              setStatus(
                agents.length === 0
                  ? 'No trusted agent configuration was selected.'
                  : `Loaded ${agents.length} host-configured agent${agents.length === 1 ? '' : 's'}.`
              );
            })
            .catch((error: unknown) => failure(error, 'Trusted agent configuration failed.'))
        }
      >
        Import trusted agent configuration
      </button>
      <label>
        Design package
        <input
          value={designPackageName}
          onChange={(event) => setDesignPackageName(event.currentTarget.value)}
        />
      </label>
      <label>
        Exact version
        <input
          value={designPackageVersion}
          onChange={(event) => setDesignPackageVersion(event.currentTarget.value)}
        />
      </label>
      <button
        type="button"
        onClick={() =>
          void actions
            .inspectDesignSystem({ name: designPackageName, version: designPackageVersion })
            .then((receipt) =>
              setStatus(
                `${receipt.status}: ${receipt.packageName}@${receipt.version}; ${receipt.provenance.provider}; ${receipt.fixture ?? 'configured provider'}; digest ${receipt.artifactDigest.slice(0, 12)}.`
              )
            )
            .catch((error: unknown) => failure(error, 'Design package inspection failed.'))
        }
      >
        Inspect design package
      </button>
      <label>
        Design language Markdown
        <textarea
          value={designMarkdown}
          onChange={(event) => setDesignMarkdown(event.currentTarget.value)}
        />
      </label>
      <button
        type="button"
        onClick={() =>
          void actions
            .ingestDesignLanguage({ markdown: designMarkdown })
            .then((receipt) =>
              setStatus(
                `${receipt.status}: ${receipt.sectionCount} sections from ${receipt.provenance.provider}; digest ${receipt.artifactDigest.slice(0, 12)}.`
              )
            )
            .catch((error: unknown) => failure(error, 'Markdown intake failed.'))
        }
      >
        Stage Markdown
      </button>
      <p aria-live="polite">{status}</p>
    </section>
  );
}
