import type { Meta, StoryObj } from '@storybook/react-vite';

import { PlaceholderPanel } from './placeholder-panel';

const meta = {
  title: 'Foundation/PlaceholderPanel',
  component: PlaceholderPanel,
  args: {
    title: 'Shared UI placeholder',
    children: 'Product-specific content will be added by its owning workstream.'
  }
} satisfies Meta<typeof PlaceholderPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
