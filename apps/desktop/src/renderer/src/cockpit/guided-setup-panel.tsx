import { useEffect, useState } from 'react';

import type {
  DesignerAgentSummary,
  DesignerSnapshot,
  DesignSystemIntakeReceipt,
  MarkdownIntakeReceipt
} from '../../../shared/designer-api';
import { useGuidedSetupTask } from './use-guided-setup-task';

const initialDesignMarkdown = '# Design\n\n## Principles\n\nUse semantic tokens.';

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

function receiptStatusLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Host-backed setup controls. Every success message is based on a host receipt. */
export function GuidedSetupPanel({ snapshot, onSnapshot, actions }: GuidedSetupPanelProps) {
  const [designPackageName, setDesignPackageName] = useState('@selene/design-tokens');
  const [designPackageVersion, setDesignPackageVersion] = useState('1.0.0');
  const [designMarkdown, setDesignMarkdown] = useState(initialDesignMarkdown);
  const { active, run, status } = useGuidedSetupTask(snapshot.source.projectId);
  const selectedAgent = snapshot.agents.find((agent) => agent.id === snapshot.selectedAgentId);
  const stagedDesignSystem = snapshot.setup?.designSystem;
  const stagedDesignLanguage = snapshot.setup?.designLanguage;
  useEffect(() => {
    setDesignPackageName(stagedDesignSystem?.packageName ?? '@selene/design-tokens');
    setDesignPackageVersion(stagedDesignSystem?.version ?? '1.0.0');
  }, [snapshot.source.projectId, stagedDesignSystem?.packageName, stagedDesignSystem?.version]);
  useEffect(() => {
    setDesignMarkdown(initialDesignMarkdown);
  }, [snapshot.source.projectId]);
  return (
    <section
      className="guided-setup"
      aria-label="Guided local setup"
      aria-busy={active || undefined}
    >
      <header>
        <p className="guided-setup__eyebrow">Guided setup</p>
        <h2>Trusted agent & design system</h2>
        <p>
          Host receipts stage inputs only; they do not install packages or grant renderer access.
        </p>
      </header>
      <section className="guided-setup__step" aria-labelledby="guided-agent-heading">
        <div>
          <h3 id="guided-agent-heading">1. Trusted agent</h3>
          <p>
            {selectedAgent
              ? `${selectedAgent.label} · ${selectedAgent.capabilities.length} declared capabilities`
              : 'No trusted agent is selected.'}
          </p>
        </div>
        <label>
          Agent
          <select
            disabled={active || snapshot.agents.length === 0}
            value={snapshot.selectedAgentId}
            onChange={(event) => {
              const agentId = event.currentTarget.value;
              run(
                'Selecting the trusted agent…',
                'Could not select the trusted agent.',
                () => actions.selectAgent(agentId),
                (next) => {
                  onSnapshot(next);
                  return `Trusted agent selected: ${next.agents.find((agent) => agent.id === next.selectedAgentId)?.label ?? 'configured agent'}.`;
                }
              );
            }}
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
          disabled={active}
          onClick={() =>
            run(
              'Waiting for a trusted host configuration…',
              'Could not load a trusted host configuration.',
              async () => {
                const agents = await actions.configureTrustedAgent();
                return {
                  agents,
                  snapshot: agents.length > 0 ? await actions.snapshot() : undefined
                };
              },
              ({ agents, snapshot: next }) => {
                if (next) onSnapshot(next);
                return agents.length === 0
                  ? 'No trusted agent configuration was selected.'
                  : `Loaded ${agents.length} host-configured agent${agents.length === 1 ? '' : 's'}.`;
              }
            )
          }
        >
          Configure trusted agent
        </button>
      </section>
      <section className="guided-setup__step" aria-labelledby="guided-system-heading">
        <div>
          <h3 id="guided-system-heading">2. Design system</h3>
          <p>Inspect a named package through the configured host provider. Nothing is installed.</p>
        </div>
        <label>
          Package name
          <input
            disabled={active}
            value={designPackageName}
            onChange={(event) => setDesignPackageName(event.currentTarget.value)}
          />
        </label>
        <label>
          Exact version
          <input
            disabled={active}
            value={designPackageVersion}
            onChange={(event) => setDesignPackageVersion(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          disabled={active || !designPackageName.trim() || !designPackageVersion.trim()}
          onClick={() =>
            run(
              'Inspecting the named design package through the host…',
              'Could not stage the design-system package.',
              () =>
                actions
                  .inspectDesignSystem({
                    name: designPackageName.trim(),
                    version: designPackageVersion.trim()
                  })
                  .then(async (receipt) => ({ receipt, snapshot: await actions.snapshot() })),
              ({ receipt, snapshot: next }) => {
                if (next.source.projectId !== snapshot.source.projectId)
                  throw new Error(
                    'Project changed before the design-system receipt could be loaded.'
                  );
                onSnapshot(next);
                return `${receiptStatusLabel(receipt.status)} ${receipt.packageName}@${receipt.version} from ${receipt.provenance.provider}${receipt.fixture ? ` (${receipt.fixture})` : ''}; receipt ${receipt.artifactDigest.slice(0, 12)}.`;
              }
            )
          }
        >
          Inspect & stage package
        </button>
      </section>
      <section className="guided-setup__step" aria-labelledby="guided-language-heading">
        <div>
          <h3 id="guided-language-heading">3. Design language</h3>
          <p>
            Stage bounded Markdown guidance. Raw JSON and executable input are never accepted here.
          </p>
        </div>
        <label>
          Design language Markdown
          <textarea
            disabled={active}
            value={designMarkdown}
            onChange={(event) => setDesignMarkdown(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          disabled={active || !designMarkdown.trim()}
          onClick={() =>
            run(
              'Staging design language through the host…',
              'Could not stage the design-language guidance.',
              () =>
                actions
                  .ingestDesignLanguage({ markdown: designMarkdown })
                  .then(async (receipt) => ({ receipt, snapshot: await actions.snapshot() })),
              ({ receipt, snapshot: next }) => {
                if (next.source.projectId !== snapshot.source.projectId)
                  throw new Error(
                    'Project changed before the design-language receipt could be loaded.'
                  );
                onSnapshot(next);
                return `${receiptStatusLabel(receipt.status)} ${receipt.sectionCount} design-language sections from ${receipt.provenance.provider}; receipt ${receipt.artifactDigest.slice(0, 12)}.`;
              }
            )
          }
        >
          Stage design language
        </button>
      </section>
      <section className="guided-setup__catalog" aria-label="Component catalog">
        <strong>Component catalog</strong>
        <p>
          {snapshot.componentCatalog.entries.length} host-supplied entries. Storybook catalog
          entries are reference material, not a runnable prototype.
        </p>
      </section>
      <section className="guided-setup__receipts" aria-label="Current project setup receipts">
        <strong>Current project setup</strong>
        <p>
          {stagedDesignSystem
            ? `${receiptStatusLabel(stagedDesignSystem.status)} ${stagedDesignSystem.packageName}@${stagedDesignSystem.version} from ${stagedDesignSystem.provenance.provider}.`
            : 'No design-system receipt is staged for this project.'}
        </p>
        <p>
          {stagedDesignLanguage
            ? `${receiptStatusLabel(stagedDesignLanguage.status)} ${stagedDesignLanguage.sectionCount} design-language sections from ${stagedDesignLanguage.provenance.provider}.`
            : 'No design-language receipt is staged for this project.'}
        </p>
      </section>
      <p className="guided-setup__status" role="status" aria-live="polite">
        {status}
      </p>
    </section>
  );
}
