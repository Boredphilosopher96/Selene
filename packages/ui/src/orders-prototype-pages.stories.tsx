import type { Meta, StoryObj } from '@storybook/react-vite';

import { OrdersPage } from './orders-prototype-pages';

const noOp = () => undefined;

const meta = {
  title: 'Prototype/Orders page',
  component: OrdersPage,
  args: {
    state: 'success',
    onCreateOrder: noOp,
    onRestoreOrders: noOp,
    onShowEmpty: noOp
  },
  argTypes: { state: { control: 'select', options: ['loading', 'empty', 'error', 'success'] } }
} satisfies Meta<typeof OrdersPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Success: Story = {};
export const Loading: Story = { args: { state: 'loading' } };
export const Empty: Story = { args: { state: 'empty' } };
export const Error: Story = { args: { state: 'error' } };
export const Disabled: Story = { args: { disabled: true } };
export const Responsive: Story = { args: { compact: true } };
