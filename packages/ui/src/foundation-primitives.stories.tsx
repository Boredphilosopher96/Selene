import type { Meta, StoryObj } from '@storybook/react-vite';

import { AddIcon, Button, Card, CloseIcon, IconButton, StatusBadge, TextField } from './index';

function FoundationShowcase() {
  return (
    <main aria-label="Selene UI foundation" style={{ display: 'grid', gap: '1.25rem', width: 420 }}>
      <Card as="section" aria-labelledby="actions-heading">
        <h2 id="actions-heading">Actions</h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          <StatusBadge>Draft</StatusBadge>
          <StatusBadge tone="success">Ready</StatusBadge>
          <StatusBadge tone="warning">Needs review</StatusBadge>
          <StatusBadge tone="danger">Blocked</StatusBadge>
        </div>
      </Card>
    </main>
  );
}

function ThemedFoundation({
  contrast,
  theme
}: {
  readonly contrast?: 'more';
  readonly theme?: 'dark';
}) {
  const name = contrast === 'more' ? 'high contrast' : theme === 'dark' ? 'dark' : 'light';
  return (
    <div
      className="sl-theme"
      data-contrast={contrast}
      data-theme={theme}
      style={{ background: 'var(--sl-color-canvas)', padding: '2rem' }}
    >
      <FoundationShowcase />
      <p style={{ color: 'var(--sl-color-text-muted)', marginBottom: 0 }}>{name} token set</p>
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

export const ValidationError: Story = {
  render: () => (
    <div className="sl-theme" style={{ background: 'var(--sl-color-canvas)', padding: '2rem' }}>
      <main aria-label="Selene UI validation error" style={{ width: 360 }}>
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
    <div className="sl-theme" style={{ background: 'var(--sl-color-canvas)', padding: '2rem' }}>
      <main aria-label="Selene UI loading action">
        <Button loading>Saving changes</Button>
      </main>
    </div>
  )
};
