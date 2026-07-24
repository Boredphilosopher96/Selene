import type { Meta, StoryObj } from '@storybook/react-vite';

type ScenarioState = 'loading' | 'empty' | 'error' | 'success';

interface ScenarioArgs {
  readonly state: ScenarioState;
  readonly role: string;
  readonly locale: string;
  readonly theme: 'light' | 'dark';
  readonly reducedMotion: boolean;
}

function EnterpriseScenario({ state, role, locale, theme, reducedMotion }: ScenarioArgs) {
  const message = {
    loading: 'Orders are loading. Focus remains in the main landmark.',
    empty: 'No orders match this view. Create order is available to editors.',
    error: 'Orders could not be loaded. Retry is available without a motion-only cue.',
    success: 'Orders are current. History exposes the generated-design baseline.'
  }[state];
  return (
    <main
      tabIndex={-1}
      aria-label="Enterprise design scenario"
      style={{
        width: 360,
        padding: 20,
        borderRadius: 12,
        color: theme === 'dark' ? '#f8fafc' : '#15202b',
        background: theme === 'dark' ? '#18212f' : '#f8fafc',
        transition: reducedMotion ? 'none' : 'background 160ms ease'
      }}
    >
      <p style={{ margin: 0, fontSize: 12 }}>
        locale: {locale} · role: {role}
      </p>
      <h2 style={{ margin: '12px 0 6px' }}>{state}</h2>
      <p>{message}</p>
      {state === 'loading' ? <div aria-busy="true">Loading…</div> : null}
      {state === 'error' ? <button type="button">Retry</button> : null}
      {state === 'empty' ? <button type="button">Create order</button> : null}
      {state === 'success' ? <button type="button">Compare baseline</button> : null}
    </main>
  );
}

const meta = {
  title: 'Enterprise/Generated design scenarios',
  component: EnterpriseScenario,
  args: { state: 'success', role: 'viewer', locale: 'en-US', theme: 'light', reducedMotion: false },
  argTypes: { state: { control: 'select', options: ['loading', 'empty', 'error', 'success'] } }
} satisfies Meta<typeof EnterpriseScenario>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LoadingOwner: Story = { args: { state: 'loading', role: 'owner' } };
export const EmptyEditor: Story = {
  args: { state: 'empty', role: 'editor', theme: 'dark', reducedMotion: true }
};
export const ErrorCommenter: Story = {
  args: { state: 'error', role: 'commenter', locale: 'ja-JP', reducedMotion: true }
};
export const SuccessViewer: Story = {};
