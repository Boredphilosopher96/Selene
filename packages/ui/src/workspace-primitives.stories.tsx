import { StrictMode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './index';
import {
  Activity,
  AppShell,
  CanvasChrome,
  Dialog,
  InspectorSection,
  ListRow,
  Panel,
  Popover,
  Progress,
  SegmentedControl,
  SelectField,
  SplitView,
  StatePanel,
  Tabs,
  TextareaField,
  Toolbar
} from './workspace';

function InteractionStory() {
  const [mode, setMode] = useState('design');
  const [delayedMode, setDelayedMode] = useState('delayed-design');
  const [delayedOrder, setDelayedOrder] = useState(false);
  const [incidentalRender, setIncidentalRender] = useState(0);
  const [delayedPopover, setDelayedPopover] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [nested, setNested] = useState(false);
  const [controlled, setControlled] = useState(false);
  const [callbackVersion, setCallbackVersion] = useState(0);
  const [controlledEvent, setControlledEvent] = useState('No controlled help event yet.');
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <main
      aria-label="Workspace primitive interactions"
      className="sl-theme"
      style={{ padding: '1rem' }}
    >
      <AppShell>
        <Toolbar label="Document tools">
          <Button onClick={() => setDialog(true)}>Share workspace</Button>
          <Popover contentLabel="Canvas help details" triggerText="Canvas help">
            <p className="sl-state-copy">Hold Space to pan. Escape restores the trigger.</p>
            <button type="button">Read shortcuts</button>
            <Popover contentLabel="Nested help details" triggerText="Open nested help">
              <p className="sl-state-copy">Escape only closes the topmost surface.</p>
            </Popover>
          </Popover>
          <Popover
            contentLabel="Controlled help details"
            onOpenChange={(next) => {
              setControlled(next);
              setControlledEvent(`Callback ${callbackVersion}: ${next ? 'open' : 'closed'}`);
            }}
            open={controlled}
            triggerText="Controlled help"
          >
            <p className="sl-state-copy">The host owns this popover.</p>
            <button onClick={() => setCallbackVersion((version) => version + 1)} type="button">
              Replace controlled callback
            </button>
          </Popover>
          <Popover
            contentLabel="Declined help details"
            onOpenChange={() => undefined}
            open={false}
            triggerText="Declined help"
          >
            <p>Never opened.</p>
          </Popover>
          <Popover
            contentLabel="Delayed close details"
            onOpenChange={(next) => {
              setIncidentalRender((version) => version + 1);
              window.setTimeout(() => setDelayedPopover(next), 180);
            }}
            open={delayedPopover}
            triggerText="Delayed close help"
          >
            <p>Incidental host renders must not discard an acknowledged close intent.</p>
          </Popover>
        </Toolbar>
        <Tabs
          label="Inspector views"
          tabs={[
            { id: 'layers', label: 'Layers', panel: <p>Layers panel.</p> },
            { id: 'assets', label: 'Assets', panel: <p>Assets panel.</p> },
            { disabled: true, id: 'history', label: 'History', panel: <p>Unavailable.</p> },
            { id: 'comments', label: 'Comments', panel: <p>Comments panel.</p> }
          ]}
        />
        <Tabs
          label="Vertical inspector views"
          orientation="vertical"
          tabs={[
            { id: 'details', label: 'Details', panel: <p>Details.</p> },
            { id: 'tokens', label: 'Tokens', panel: <p>Tokens.</p> }
          ]}
        />
        <Tabs
          label="Declined inspector views"
          onValueChange={() => undefined}
          tabs={[
            { id: 'declined-layers', label: 'Declined layers', panel: <p>Layers stay active.</p> },
            { id: 'declined-assets', label: 'Declined assets', panel: <p>Assets were declined.</p> }
          ]}
          value="declined-layers"
        />
        <SegmentedControl
          label="Workspace mode"
          onValueChange={setMode}
          options={[
            { id: 'design', label: 'Design' },
            { id: 'prototype', label: 'Prototype' },
            { disabled: true, id: 'inspect', label: 'Inspect' }
          ]}
          value={mode}
        />
        <SegmentedControl
          label="Declined workspace mode"
          onValueChange={() => undefined}
          options={[
            { id: 'declined-design', label: 'Declined design' },
            { id: 'declined-prototype', label: 'Declined prototype' }
          ]}
          value="declined-design"
        />
        <SegmentedControl
          label="Delayed workspace mode"
          onValueChange={(next) => {
            setIncidentalRender((version) => version + 1);
            window.setTimeout(() => {
              setDelayedMode(next);
              setDelayedOrder(true);
            }, 180);
          }}
          options={
            delayedOrder
              ? [
                  { id: 'delayed-prototype', label: 'Delayed prototype' },
                  { id: 'delayed-design', label: 'Delayed design' }
                ]
              : [
                  { id: 'delayed-design', label: 'Delayed design' },
                  { id: 'delayed-prototype', label: 'Delayed prototype' }
                ]
          }
          value={delayedMode}
        />
        <button type="button">Outside control</button>
        <output
          data-controlled-event={controlledEvent}
          data-incidental-render={incidentalRender}
          hidden
        />
      </AppShell>
      <Dialog
        closeLabel="Close sharing dialog"
        initialFocusRef={closeRef}
        onOpenChange={setDialog}
        open={dialog}
        title="Share workspace"
      >
        <p>Invite a collaborator.</p>
        <button ref={closeRef} type="button">
          Continue
        </button>
        <button onClick={() => setNested(true)} type="button">
          Open confirmation
        </button>
        <button onClick={() => setDialog(false)} type="button">
          Close parent
        </button>
      </Dialog>
      <Dialog
        closeLabel="Close confirmation dialog"
        onOpenChange={setNested}
        open={nested}
        title="Confirm sharing"
      >
        <button type="button">Confirm invite</button>
      </Dialog>
    </main>
  );
}

function CrossDocumentStory() {
  const [ownerDocument, setOwnerDocument] = useState<Document | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const sync = () => setOwnerDocument(frame.contentDocument);
    sync();
    frame.addEventListener('load', sync);
    return () => frame.removeEventListener('load', sync);
  }, []);
  return (
    <main aria-label="Workspace cross-document overlay showcase" style={{ padding: '1rem' }}>
      <iframe ref={frameRef} src="about:blank" title="Workspace overlay document" />
      {ownerDocument === null
        ? null
        : createPortal(
            <main
              className="sl-theme"
              data-theme="dark"
              style={{ minHeight: '12rem', padding: '1rem' }}
            >
              <Popover
                contentLabel="Cross-document details"
                defaultOpen
                triggerText="Cross-document help"
              >
                <p>This portal host belongs to the iframe document.</p>
              </Popover>
            </main>,
            ownerDocument.body
          )}
    </main>
  );
}

function OverlayStory() {
  return (
    <main aria-label="Workspace overlay showcase" className="sl-overlay-showcase">
      <div className="sl-overlay-showcase__canvas">
        <section className="sl-theme sl-overlay-showcase__host" data-theme="dark">
          <h2>Dark canvas host</h2>
          <Popover contentLabel="Dark canvas details" defaultOpen triggerText="Dark canvas help">
            <p>Escapes this transformed, clipped canvas while retaining dark tokens.</p>
          </Popover>
        </section>
        <section
          className="sl-theme sl-overlay-showcase__host"
          data-contrast="more"
          data-density="compact"
          data-motion="reduce"
        >
          <h2>High contrast host</h2>
          <Popover
            contentLabel="High contrast details"
            defaultOpen
            triggerText="High contrast help"
          >
            <p>Per-host contrast, density, and reduced-motion tokens remain isolated.</p>
          </Popover>
        </section>
      </div>
    </main>
  );
}

function ModalStory() {
  const [open, setOpen] = useState(true);
  const [mounted, setMounted] = useState(true);
  return (
    <main
      aria-label="Workspace modal showcase"
      className="sl-theme"
      data-theme="dark"
      style={{ color: 'var(--sl-color-text)', minHeight: '100vh', padding: '1rem' }}
    >
      <h1>Modal lifecycle</h1>
      <button onClick={() => setOpen(true)} type="button">
        Reopen modal
      </button>
      {mounted ? null : (
        <button
          onClick={() => {
            setMounted(true);
            setOpen(true);
          }}
          type="button"
        >
          Mount modal
        </button>
      )}
      {mounted ? (
        <Dialog
          closeLabel="Close modal lifecycle"
          onOpenChange={setOpen}
          open={open}
          title="Modal lifecycle proof"
        >
          <p>This modal is rendered through its themed body-level portal host.</p>
          <button type="button">Confirm lifecycle</button>
          <button onClick={() => setMounted(false)} type="button">
            Unmount modal
          </button>
        </Dialog>
      ) : null}
    </main>
  );
}

function Showcase({
  compact,
  contrast,
  locale,
  motion,
  theme
}: {
  readonly compact?: boolean;
  readonly contrast?: boolean;
  readonly locale?: boolean;
  readonly motion?: boolean;
  readonly theme?: 'dark';
}) {
  const long = locale
    ? 'この長い説明は、狭い画面でも読みやすい折り返しと安定したコントロールのサイズを確認します。'
    : 'A deliberately long localized-ready sentence proves that every compact control remains readable in a narrow inspector.';
  return (
    <main
      aria-label="Workspace primitive showcase"
      className="sl-theme"
      data-contrast={contrast ? 'more' : undefined}
      data-density={compact ? 'compact' : undefined}
      data-motion={motion ? 'reduce' : undefined}
      data-theme={theme}
      style={{ padding: 'clamp(1rem,4vw,2rem)' }}
    >
      <AppShell
        landmark="main"
        landmarkLabel="Workspace primitive content"
        className="sl-foundation"
      >
        <Toolbar label="Workspace actions">
          <Button loading>Saving canvas</Button>
          <Button disabled variant="secondary">
            Publish
          </Button>
          <Popover contentLabel="Version details" defaultOpen triggerText="Version details">
            <p>Autosaved 12 seconds ago.</p>
          </Popover>
        </Toolbar>
        <SplitView>
          <Panel title={locale ? 'プロジェクトの設定と共同作業者' : 'Project settings'}>
            <SelectField
              label={locale ? '公開の可視性' : 'Visibility'}
              onChange={() => undefined}
              options={[
                { id: 'team', label: locale ? 'チームのみ' : 'Team only' },
                { id: 'private', label: locale ? '非公開' : 'Private' }
              ]}
              value="team"
            />
            <TextareaField label={locale ? '長い説明' : 'Long description'} readOnly value={long} />
          </Panel>
          <CanvasChrome label={locale ? 'キャンバスのプレビュー' : 'Canvas preview'}>
            {locale ? 'キャンバスのプレビュー' : 'Canvas preview'}
          </CanvasChrome>
        </SplitView>
        <Tabs
          label="Inspector views"
          tabs={[
            {
              id: 'layout',
              label: 'Layout',
              panel: (
                <InspectorSection title="Spacing and alignment">
                  <ListRow emphasized>Selected frame</ListRow>
                </InspectorSection>
              )
            },
            {
              id: 'content',
              label: 'Content',
              panel: <StatePanel heading="No content">Add a new block to begin.</StatePanel>
            }
          ]}
        />
        <Progress label="Save progress" max={10} value={7} />
        <Activity label="Syncing changes" />
        <StatePanel heading="Permission required" tone="error">
          <p>Ask an owner for edit access before publishing.</p>
          <Button variant="secondary">Request access</Button>
        </StatePanel>
        <StatePanel heading="Loading preview" tone="loading">
          <Activity label="Loading preview" />
        </StatePanel>
      </AppShell>
    </main>
  );
}

const meta = {
  title: 'Foundation/Workspace primitives',
  component: Showcase,
  parameters: { layout: 'fullscreen' }
} satisfies Meta<typeof Showcase>;
export default meta;
type Story = StoryObj<typeof meta>;
export const States: Story = { render: () => <Showcase /> };
export const Dark: Story = { render: () => <Showcase theme="dark" /> };
export const HighContrast: Story = { render: () => <Showcase contrast /> };
export const Compact: Story = { render: () => <Showcase compact /> };
export const ReducedMotion: Story = { render: () => <Showcase motion /> };
export const LocalizedContent: Story = { render: () => <Showcase locale /> };
export const Interaction: Story = { render: () => <InteractionStory /> };
export const Overlays: Story = { render: () => <OverlayStory /> };
export const Modal: Story = {
  render: () => (
    <StrictMode>
      <ModalStory />
    </StrictMode>
  )
};
export const CrossDocument: Story = { render: () => <CrossDocumentStory /> };
