import type { Meta, StoryObj } from '@storybook/react-vite';

import { NewOrderPage } from './orders-prototype-pages';

const noOp = () => undefined;

const meta = {
  title: 'Prototype/New order page',
  component: NewOrderPage,
  args: { saved: false, onSave: noOp, onCancel: noOp, onDismiss: noOp }
} satisfies Meta<typeof NewOrderPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Saved: Story = { args: { saved: true } };
