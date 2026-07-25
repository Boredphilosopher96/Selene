import { useEffect, useState } from 'react';

import type {
  DesignerAgentSummary,
  DesignerSnapshot,
  DesignSystemInputSelection,
  DesignLanguageInputSelection,
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
  setDesignSystemInputs(inputs: readonly DesignSystemInputSelection[]): Promise<DesignerSnapshot>;
  setDesignLanguageInputs(
    inputs: readonly DesignLanguageInputSelection[]
  ): Promise<DesignerSnapshot>;
  ingestDesignLanguage(request: { readonly markdown: string }): Promise<MarkdownIntakeReceipt>;
  chooseDesignLanguageToImport(request: {
    readonly projectId: string;
  }): Promise<MarkdownIntakeReceipt | undefined>;
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
  const orderedDesignLanguages =
    snapshot.setup?.designLanguages ??
    (stagedDesignLanguage === undefined
      ? []
      : [
          { id: stagedDesignLanguage.artifactDigest, enabled: true, receipt: stagedDesignLanguage }
        ]);
  const updateDesignLanguages = (inputs: readonly DesignLanguageInputSelection[]) => {
    run(
      'Updating active design-language guidance…',
      'Could not update active design-language guidance.',
      () => actions.setDesignLanguageInputs(inputs),
      (next) => {
        if (next.source.projectId !== snapshot.source.projectId)
          throw new Error('Project changed before guidance could be updated.');
        onSnapshot(next);
        const activeInputs =
          next.setup?.designLanguages?.filter((input) => input.enabled).length ?? 0;
        return `${activeInputs} guidance input${activeInputs === 1 ? '' : 's'} active for generation.`;
      }
    );
  };
  const orderedDesignSystems =
    snapshot.setup?.designSystems ??
    (stagedDesignSystem === undefined
      ? []
      : [{ id: stagedDesignSystem.artifactDigest, enabled: true, receipt: stagedDesignSystem }]);
  const updateOrderedDesignSystems = (inputs: readonly DesignSystemInputSelection[]) => {
    run(
      'Updating the active design-system inputs…',
      'Could not update the active design-system inputs.',
      () => actions.setDesignSystemInputs(inputs),
      (next) => {
        if (next.source.projectId !== snapshot.source.projectId)
          throw new Error('Project changed before the design-system inputs could be updated.');
        onSnapshot(next);
        const activeInputs =
          next.setup?.designSystems?.filter((input) => input.enabled).length ?? 0;
        return `${activeInputs} design-system input${activeInputs === 1 ? '' : 's'} active for deterministic generation.`;
      }
    );
  };
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
        <button
          type="button"
          disabled={active}
          onClick={() =>
            run(
              'Waiting for a Markdown file from the host…',
              'Could not import the selected design-language file.',
              async () => {
                const receipt = await actions.chooseDesignLanguageToImport({
                  projectId: snapshot.source.projectId
                });
                return receipt === undefined
                  ? { receipt: undefined }
                  : { receipt, snapshot: await actions.snapshot() };
              },
              ({ receipt, snapshot: next }) => {
                if (receipt === undefined) return 'Design-language import was cancelled.';
                if (next === undefined || next.source.projectId !== snapshot.source.projectId)
                  throw new Error(
                    'Project changed before the design-language receipt could be loaded.'
                  );
                onSnapshot(next);
                return `${receiptStatusLabel(receipt.status)} ${receipt.displayLabel ?? 'Markdown guidance'}: ${receipt.sectionCount} design-language sections from ${receipt.provenance.provider}; receipt ${receipt.artifactDigest.slice(0, 12)}.`;
              }
            )
          }
        >
          Choose Markdown file…
        </button>
      </section>
      <section className="guided-setup__inputs" aria-labelledby="guided-language-inputs-heading">
        <div>
          <h3 id="guided-language-inputs-heading">Ordered design-language guidance</h3>
          <p>
            Enabled guidance is sent to generation in this exact order. Disabled guidance remains
            staged.
          </p>
        </div>
        {orderedDesignLanguages.length === 0 ? (
          <p className="guided-setup__empty">
            No design-language guidance is staged for this project.
          </p>
        ) : (
          <ol className="guided-setup__input-list">
            {orderedDesignLanguages.map((input, index) => {
              const selections = orderedDesignLanguages.map(({ id, enabled }) => ({ id, enabled }));
              const move = (to: number) => {
                const next = [...selections];
                const moving = next[index]!;
                next.splice(index, 1);
                next.splice(to, 0, moving);
                updateDesignLanguages(next);
              };
              return (
                <li key={input.id} className="guided-setup__input">
                  <div>
                    <strong>{input.receipt.displayLabel ?? `Guidance ${index + 1}`}</strong>
                    <p>
                      {input.enabled ? 'Active for generation' : 'Staged, excluded from generation'}{' '}
                      · {input.receipt.sectionCount}{' '}
                      {input.receipt.sectionCount === 1 ? 'section' : 'sections'} ·{' '}
                      {input.receipt.provenance.provider} · {input.id.slice(0, 12)}
                    </p>
                  </div>
                  <div
                    className="guided-setup__input-actions"
                    aria-label={`${input.receipt.displayLabel ?? `Guidance ${index + 1}`} controls`}
                  >
                    <button
                      type="button"
                      disabled={active || index === 0}
                      onClick={() => move(index - 1)}
                    >
                      Move earlier
                    </button>
                    <button
                      type="button"
                      disabled={active || index === orderedDesignLanguages.length - 1}
                      onClick={() => move(index + 1)}
                    >
                      Move later
                    </button>
                    <button
                      type="button"
                      disabled={active}
                      onClick={() =>
                        updateDesignLanguages(
                          selections.map((item) =>
                            item.id === input.id ? { ...item, enabled: !item.enabled } : item
                          )
                        )
                      }
                    >
                      {input.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      disabled={active}
                      onClick={() =>
                        updateDesignLanguages(selections.filter((item) => item.id !== input.id))
                      }
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>
      <section className="guided-setup__inputs" aria-labelledby="guided-inputs-heading">
        <div>
          <h3 id="guided-inputs-heading">Ordered package inputs</h3>
          <p>
            {orderedDesignSystems.filter((input) => input.enabled).length} active of{' '}
            {orderedDesignSystems.length} staged. Active inputs are passed to generation in this
            order; disabled inputs remain available to re-enable.
          </p>
        </div>
        {orderedDesignSystems.length === 0 ? (
          <p className="guided-setup__empty">No package inputs are staged for this project.</p>
        ) : (
          <ol className="guided-setup__input-list">
            {orderedDesignSystems.map((input, index) => {
              const selections = orderedDesignSystems.map(({ id, enabled }) => ({ id, enabled }));
              const swap = (from: number, to: number) => {
                const next = [...selections];
                const moving = next[from];
                if (moving === undefined) return next;
                next.splice(from, 1);
                next.splice(to, 0, moving);
                return next;
              };
              return (
                <li key={input.id} className="guided-setup__input">
                  <div>
                    <strong>
                      {input.receipt.packageName}@{input.receipt.version}
                    </strong>
                    <p>
                      {input.enabled ? 'Active for generation' : 'Staged, excluded from generation'}
                      {' · '}peer compatible · {input.receipt.provenance.provider} ·{' '}
                      {input.receipt.artifactDigest.slice(0, 12)}
                    </p>
                  </div>
                  <div
                    className="guided-setup__input-actions"
                    aria-label={`${input.receipt.packageName} controls`}
                  >
                    <button
                      type="button"
                      disabled={active || index === 0}
                      onClick={() => updateOrderedDesignSystems(swap(index, index - 1))}
                    >
                      Move earlier
                    </button>
                    <button
                      type="button"
                      disabled={active || index === orderedDesignSystems.length - 1}
                      onClick={() => updateOrderedDesignSystems(swap(index, index + 1))}
                    >
                      Move later
                    </button>
                    <button
                      type="button"
                      disabled={active}
                      onClick={() =>
                        updateOrderedDesignSystems(
                          selections.map((selection) =>
                            selection.id === input.id
                              ? { ...selection, enabled: !selection.enabled }
                              : selection
                          )
                        )
                      }
                    >
                      {input.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      disabled={active}
                      onClick={() =>
                        updateOrderedDesignSystems(
                          selections.filter((selection) => selection.id !== input.id)
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
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
