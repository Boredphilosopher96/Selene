import { useState } from 'react';

import type {
  DesignerAgentSummary,
  DesignerSnapshot,
  DesignSystemIntakeReceipt,
  MarkdownIntakeReceipt,
  ProjectOpenResult
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
  createProject(request: {
    readonly id: string;
    readonly name: string;
    readonly template: 'blank' | 'dashboard' | 'review';
  }): Promise<ProjectOpenResult>;
  importProject(request: { readonly contents: string }): Promise<ProjectOpenResult>;
}

interface GuidedSetupPanelProps {
  readonly snapshot: DesignerSnapshot;
  readonly onSnapshot: (snapshot: DesignerSnapshot) => void;
  /** Opens the project in the primary workspace and renders its compiled preview. */
  readonly onProjectOpened: (opened: ProjectOpenResult) => Promise<void>;
  readonly actions: GuidedSetupActions;
}

/** Host-backed setup controls. Every success message is based on a host receipt. */
export function GuidedSetupPanel({
  snapshot,
  onSnapshot,
  onProjectOpened,
  actions
}: GuidedSetupPanelProps) {
  const [designPackageName, setDesignPackageName] = useState('@selene/design-tokens');
  const [designPackageVersion, setDesignPackageVersion] = useState('1.0.0');
  const [designMarkdown, setDesignMarkdown] = useState(
    '# Design\n\n## Principles\n\nUse semantic tokens.'
  );
  const [projectId, setProjectId] = useState('desktop-prototype');
  const [projectName, setProjectName] = useState('Desktop prototype');
  const [template, setTemplate] = useState<'blank' | 'dashboard' | 'review'>('dashboard');
  const [projectImport, setProjectImport] = useState('');
  const [status, setStatus] = useState('No design input has been staged.');

  const failure = (error: unknown, fallback: string) =>
    setStatus(error instanceof Error ? error.message : fallback);
  const open = async (opened: ProjectOpenResult, action: string) => {
    try {
      await onProjectOpened(opened);
      setStatus(
        `${action} ${opened.receipt.origin} project ${opened.receipt.projectId} at ${opened.receipt.revisionId}.`
      );
    } catch (error) {
      setStatus(
        `Opened ${opened.receipt.projectId}, but preview failed: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }
  };

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
      <label>
        Project ID
        <input value={projectId} onChange={(event) => setProjectId(event.currentTarget.value)} />
      </label>
      <label>
        Project name
        <input
          value={projectName}
          onChange={(event) => setProjectName(event.currentTarget.value)}
        />
      </label>
      <label>
        Project template
        <select
          value={template}
          onChange={(event) =>
            setTemplate(event.currentTarget.value as 'blank' | 'dashboard' | 'review')
          }
        >
          <option value="blank">Blank</option>
          <option value="dashboard">Dashboard</option>
          <option value="review">Review</option>
        </select>
      </label>
      <button
        type="button"
        onClick={() =>
          void actions
            .createProject({ id: projectId, name: projectName, template })
            .then((opened) => open(opened, 'Opened'))
            .catch((error: unknown) => failure(error, 'Project creation failed.'))
        }
      >
        Create selected project
      </button>
      <label>
        Import project JSON
        <textarea
          value={projectImport}
          onChange={(event) => setProjectImport(event.currentTarget.value)}
        />
      </label>
      <button
        type="button"
        disabled={!projectImport}
        onClick={() =>
          void actions
            .importProject({ contents: projectImport })
            .then((opened) => open(opened, 'Opened imported'))
            .catch((error: unknown) => failure(error, 'Project import failed.'))
        }
      >
        Import project
      </button>
      <p aria-live="polite">{status}</p>
    </section>
  );
}
