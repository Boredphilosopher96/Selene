import type { Meta, StoryObj } from '@storybook/react-vite';

import { AddIcon, Button, Card, CloseIcon, IconButton, StatusBadge, TextField } from './index';

function FoundationShowcase() {
  return (
    <main aria-label="Selene UI foundation" className="sl-foundation">
      <div className="sl-foundation__grid">
        <Card as="section" aria-labelledby="actions-heading">
          <h2 id="actions-heading">Actions</h2>
          <div className="sl-state-actions">
            <Button>Save changes</Button>
            <Button variant="secondary">Cancel</Button>
            <Button variant="danger">Remove</Button>
            <IconButton icon={<AddIcon />} label="Add collaborator" />
            <IconButton icon={<CloseIcon />} label="Dismiss notification" />
          </div>
        </Card>
        <Card as="section" aria-labelledby="field-heading">
          <h2 id="field-heading">Field validation</h2>
          <TextField
            hint="Used to identify the project in shared links."
            label="Project name"
            value="Northstar"
            readOnly
          />
        </Card>
        <Card as="section" aria-labelledby="status-heading">
          <h2 id="status-heading">Status</h2>
          <div className="sl-state-actions">
            <StatusBadge>Draft</StatusBadge>
            <StatusBadge tone="success">Ready</StatusBadge>
            <StatusBadge tone="warning">Needs review</StatusBadge>
            <StatusBadge tone="danger">Blocked</StatusBadge>
          </div>
        </Card>
      </div>
    </main>
  );
}

function ThemedFoundation({
  contrast,
  density,
  motion,
  theme
}: {
  readonly contrast?: 'more';
  readonly density?: 'compact';
  readonly motion?: 'reduce';
  readonly theme?: 'dark';
}) {
  const name = [theme === 'dark' ? 'dark' : 'light', contrast === 'more' ? 'high contrast' : null]
    .filter(Boolean)
    .join(', ');
  return (
    <div
      className="sl-theme"
      data-contrast={contrast}
      data-density={density}
      data-motion={motion}
      data-theme={theme}
      style={{ background: 'var(--sl-color-canvas)', padding: 'clamp(1rem, 4vw, 2rem)' }}
    >
      <FoundationShowcase />
      <p className="sl-state-copy">{name} token set</p>
    </div>
  );
}

function StateStory({
  action,
  body,
  eyebrow,
  heading,
  tone
}: {
  readonly action?: string;
  readonly body: string;
  readonly eyebrow: string;
  readonly heading: string;
  readonly tone?: 'offline' | 'permission';
}) {
  return (
    <div
      className="sl-theme"
      style={{ background: 'var(--sl-color-canvas)', padding: 'clamp(1rem, 4vw, 2rem)' }}
    >
      <main aria-label={`Selene UI ${eyebrow.toLowerCase()} state`} className="sl-foundation">
        <Card as="section" className={`sl-state-panel${tone ? ` sl-state-panel--${tone}` : ''}`}>
          <p className="sl-state-eyebrow">{eyebrow}</p>
          <h2>{heading}</h2>
          <p className="sl-state-copy">{body}</p>
          {action ? (
            <div className="sl-state-actions">
              <Button variant="secondary">{action}</Button>
            </div>
          ) : null}
        </Card>
      </main>
    </div>
  );
}

const meta = {
  title: 'Foundation/Primitives',
  component: FoundationShowcase,
  parameters: { layout: 'centered' }
} satisfies Meta<typeof FoundationShowcase>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { render: () => <ThemedFoundation /> };

export const DarkTheme: Story = {
  render: () => <ThemedFoundation theme="dark" />
};

export const HighContrast: Story = {
  render: () => <ThemedFoundation contrast="more" />
};

export const CompactDensity: Story = {
  render: () => <ThemedFoundation density="compact" />
};

export const ReducedMotion: Story = {
  render: () => <ThemedFoundation motion="reduce" />
};

export const ValidationError: Story = {
  render: () => (
    <div
      className="sl-theme"
      style={{ background: 'var(--sl-color-canvas)', padding: 'clamp(1rem, 4vw, 2rem)' }}
    >
      <main aria-label="Selene UI validation error" className="sl-foundation">
        <TextField
          error="Project name must contain at least three characters."
          label="Project name"
          value="No"
          readOnly
        />
      </main>
    </div>
  )
};

export const LoadingAction: Story = {
  render: () => (
    <div
      className="sl-theme"
      style={{ background: 'var(--sl-color-canvas)', padding: 'clamp(1rem, 4vw, 2rem)' }}
    >
      <main aria-label="Selene UI loading action" className="sl-foundation">
        <Button loading>Saving changes</Button>
      </main>
    </div>
  )
};

export const EmptyState: Story = {
  render: () => (
    <StateStory
      action="Create project"
      body="Create a project to begin a local design workspace. Nothing has been removed."
      eyebrow="Empty"
      heading="No projects yet"
    />
  )
};

export const OfflineState: Story = {
  render: () => (
    <StateStory
      action="Try again"
      body="Your local changes are safe. We will reconnect when a network is available."
      eyebrow="Offline"
      heading="Working locally"
      tone="offline"
    />
  )
};

export const PermissionDenied: Story = {
  render: () => (
    <StateStory
      body="You can still review this project, but an owner must grant edit access before changes can be saved."
      eyebrow="Permission"
      heading="Editing is unavailable"
      tone="permission"
    />
  )
};
