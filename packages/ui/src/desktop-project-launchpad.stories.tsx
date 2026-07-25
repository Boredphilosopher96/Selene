import type { Meta, StoryObj } from '@storybook/react-vite';

import type { RecentProject } from '../../../apps/desktop/src/shared/designer-api';
import {
  ProjectLaunchpad,
  type ProjectLaunchpadActions
} from '../../../apps/desktop/src/renderer/src/cockpit/project-launchpad';
import './designer-workspace.css';

const recentProjects = [
  { id: 'northstar', name: 'Northstar commerce' },
  { id: 'atlas', name: 'Atlas operations' }
] satisfies readonly RecentProject[];

function unavailableAction(): never {
  throw new Error('Project actions are not available in this deterministic story.');
}

function launchpadActions({
  projects = [],
  recovery = { active: false, attempts: 0 },
  recoveryError
}: {
  readonly projects?: readonly RecentProject[];
  readonly recovery?: { readonly active: boolean; readonly attempts: number };
  readonly recoveryError?: string;
}): ProjectLaunchpadActions {
  return {
    listRecentProjects: async () => projects,
    openProject: async () => unavailableAction(),
    createProject: async () => unavailableAction(),
    chooseProjectToImport: async () => undefined,
    diagnostics: {
      recovery: async () => {
        if (recoveryError) throw new Error(recoveryError);
        return recovery;
      },
      resetRecovery: async () => recovery
    }
  };
}

function ProjectLaunchpadStory({
  actions,
  startupMessage
}: {
  readonly actions: ProjectLaunchpadActions;
  readonly startupMessage: string;
}) {
  return (
    <main
      aria-label="Electron project launchpad"
      className="designer-workspace project-launchpad-shell sl-theme"
    >
      <ProjectLaunchpad
        actions={actions}
        mode="first-run"
        startupMessage={startupMessage}
        onProjectOpened={async () => undefined}
      />
    </main>
  );
}

const meta = {
  title: 'Desktop/Project Launchpad',
  component: ProjectLaunchpadStory,
  parameters: { layout: 'fullscreen' }
} satisfies Meta<typeof ProjectLaunchpadStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RecentLoaded: Story = {
  args: {
    actions: launchpadActions({ projects: recentProjects }),
    startupMessage: 'Choose a recent local project or start a new one.'
  }
};

export const EmptyFirstRun: Story = {
  args: {
    actions: launchpadActions(),
    startupMessage: 'Create your first local project to begin designing.'
  }
};

export const RecoveryActive: Story = {
  args: {
    actions: launchpadActions({ recovery: { active: true, attempts: 2 } }),
    startupMessage: 'Preview recovery must finish before project work can continue.'
  }
};

export const RecoveryUnavailable: Story = {
  args: {
    actions: launchpadActions({
      recoveryError: 'The desktop host could not report preview recovery.'
    }),
    startupMessage: 'Project actions stay protected until preview recovery can be checked.'
  }
};
