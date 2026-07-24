import { useRef, useState, type FormEvent } from 'react';

import './designer-workspace.css';

export type WorkspaceStatus = 'draft' | 'in-review' | 'ready';

export interface WorkspaceComment {
  readonly id: string;
  readonly nodeId: string;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
  readonly resolvedAt?: string | undefined;
}

export interface WorkspaceDirection {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface WorkspaceScreen {
  readonly id: string;
  readonly name: string;
  readonly route: string;
  readonly states: readonly string[];
  readonly nodeIds: readonly string[];
}

export interface DesignerWorkspaceModel {
  readonly projectId: string;
  readonly name: string;
  readonly status: WorkspaceStatus;
  readonly selectedScreenId: string;
  readonly selectedState: string;
  readonly selectedNodeId?: string | undefined;
  readonly screens: readonly WorkspaceScreen[];
  readonly comments: readonly WorkspaceComment[];
  readonly developerDirections: readonly WorkspaceDirection[];
  readonly changelog: readonly { id: string; at: string; summary: string }[];
}

export interface DesignerWorkspaceProps {
  readonly workspace: DesignerWorkspaceModel;
  readonly notice?: string;
  readonly onCreate: () => void;
  readonly onOpenFile: (file: File) => void;
  readonly onExport: () => void;
  readonly onReopen: () => void;
  readonly onScreenChange: (screenId: string) => void;
  readonly onStateChange: (state: string) => void;
  readonly onNodeSelect: (nodeId: string) => void;
  readonly onAddComment: (body: string) => void;
  readonly onResolveComment: (commentId: string) => void;
  readonly onAddDirection: (body: string) => void;
  readonly onStatusChange: (status: WorkspaceStatus) => void;
}

function Preview({
  screenId,
  state,
  selectedNodeId,
  onSelect
}: {
  readonly screenId: string;
  readonly state: string;
  readonly selectedNodeId: string | undefined;
  readonly onSelect: (nodeId: string) => void;
}) {
  const selected = (nodeId: string) => (selectedNodeId === nodeId ? ' preview-node--selected' : '');
  if (screenId === 'orders') {
    return (
      <section aria-label="Orders React preview" className="preview-surface preview-orders">
        <button
          data-selene-node-id="orders.header"
          className={`preview-node${selected('orders.header')}`}
          onClick={() => onSelect('orders.header')}
        >
          <span>Northstar</span>
          <span>Orders</span>
          <span className="avatar">MN</span>
        </button>
        <button
          data-selene-node-id="orders.title"
          className={`preview-node order-title${selected('orders.title')}`}
          onClick={() => onSelect('orders.title')}
        >
          <span>
            <strong>Orders</strong>
            <small>12 orders need attention</small>
          </span>
          <span className="preview-pill">+ Create order</span>
        </button>
        <button
          data-selene-node-id="orders.table"
          className={`preview-node order-table${selected('orders.table')}`}
          onClick={() => onSelect('orders.table')}
        >
          <span>
            <strong>#1048</strong>
            <small>Olivia Parker · $240.00</small>
          </span>
          <span className="status-dot">Processing</span>
          <span>
            <strong>#1047</strong>
            <small>Amir Cooper · $96.00</small>
          </span>
          <span className="status-dot status-dot--quiet">Packed</span>
        </button>
      </section>
    );
  }
  if (screenId === 'settings') {
    return (
      <section aria-label="Settings React preview" className="preview-surface preview-settings">
        <button
          data-selene-node-id="settings.sidebar"
          className={`preview-node settings-sidebar${selected('settings.sidebar')}`}
          onClick={() => onSelect('settings.sidebar')}
        >
          <strong>Workspace</strong>
          <span>General</span>
          <span>Members</span>
          <span>Notifications</span>
        </button>
        <section
          data-selene-node-id="settings.preferences"
          className={`preview-node settings-content${selected('settings.preferences')}`}
        >
          <button
            type="button"
            className="settings-heading"
            onClick={() => onSelect('settings.preferences')}
          >
            <span>
              <strong>General preferences</strong>
              <small>Set the defaults for your team.</small>
            </span>
          </button>
          <label>
            Workspace name
            <input aria-label="Workspace name" defaultValue="Northstar" />
          </label>
          <span className="preview-pill">Save changes</span>
        </section>
      </section>
    );
  }
  return (
    <section aria-label="Dashboard React preview" className="preview-surface preview-dashboard">
      <button
        data-selene-node-id="dashboard.hero"
        className={`preview-node dashboard-hero${selected('dashboard.hero')}`}
        onClick={() => onSelect('dashboard.hero')}
      >
        <span className="eyebrow">Tuesday, July 23</span>
        <strong>{state === 'busy' ? 'A focused day ahead.' : 'Good morning, Mina.'}</strong>
        <small>
          {state === 'busy'
            ? '3 items are waiting on a decision.'
            : 'Here is what needs your attention.'}
        </small>
      </button>
      <div className="dashboard-grid">
        <button
          data-selene-node-id="dashboard.revenue"
          className={`preview-node metric${selected('dashboard.revenue')}`}
          onClick={() => onSelect('dashboard.revenue')}
        >
          <small>Revenue</small>
          <strong>$12,480</strong>
          <span>↑ 12.4%</span>
        </button>
        <button
          data-selene-node-id="dashboard.orders"
          className={`preview-node metric${selected('dashboard.orders')}`}
          onClick={() => onSelect('dashboard.orders')}
        >
          <small>Open orders</small>
          <strong>18</strong>
          <span>4 need review</span>
        </button>
      </div>
      <button
        data-selene-node-id="dashboard.activity"
        className={`preview-node activity-card${selected('dashboard.activity')}`}
        onClick={() => onSelect('dashboard.activity')}
      >
        <strong>Recent activity</strong>
        <span>Olivia placed order #1048</span>
        <span>Team plan updated</span>
      </button>
    </section>
  );
}

export function DesignerWorkspace({ workspace, notice, ...actions }: DesignerWorkspaceProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [comment, setComment] = useState('');
  const [direction, setDirection] = useState('');
  const screen =
    workspace.screens.find((candidate) => candidate.id === workspace.selectedScreenId) ??
    workspace.screens[0];
  const selectedComments = workspace.comments.filter(
    (item) => item.nodeId === workspace.selectedNodeId
  );
  const activity = [
    `Selene agent prepared the ${screen?.name ?? 'preview'} screen.`,
    workspace.selectedNodeId === undefined
      ? 'Select any preview element to discuss it.'
      : `Focused ${workspace.selectedNodeId}.`,
    workspace.comments.some((item) => item.resolvedAt === undefined)
      ? 'A comment is ready for review.'
      : 'All visible comments are resolved.'
  ];

  function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!comment.trim()) return;
    actions.onAddComment(comment.trim());
    setComment('');
  }

  function submitDirection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!direction.trim()) return;
    actions.onAddDirection(direction.trim());
    setDirection('');
  }

  return (
    <main className="designer-workspace" aria-label="Selene designer workspace">
      <header className="workspace-topbar">
        <div>
          <span className="brand-mark">S</span>
          <span className="project-kicker">{workspace.name}</span>
        </div>
        <div className="project-actions">
          <button type="button" onClick={actions.onCreate}>
            Create project
          </button>
          <button type="button" onClick={() => inputRef.current?.click()}>
            Open project
          </button>
          <input
            ref={inputRef}
            className="visually-hidden"
            type="file"
            accept="application/json"
            aria-label="Open exported project"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) actions.onOpenFile(file);
              event.currentTarget.value = '';
            }}
          />
          <button type="button" onClick={actions.onExport}>
            Export
          </button>
          <button type="button" onClick={actions.onReopen}>
            Reopen saved
          </button>
        </div>
      </header>
      {notice ? (
        <p className="workspace-notice" role="status">
          {notice}
        </p>
      ) : null}
      <div className="workspace-layout">
        <aside className="conversation-rail" aria-label="Conversation and activity">
          <div className="rail-heading">
            <span className="agent-orb" aria-hidden="true" />{' '}
            <div>
              <strong>Selene agent</strong>
              <small>Deterministic design partner</small>
            </div>
          </div>
          <section aria-label="Agent activity">
            <h2>Activity</h2>
            {activity.map((item, index) => (
              <p className="agent-message" key={item}>
                <span>{index + 1}</span>
                {item}
              </p>
            ))}
          </section>
          <section className="conversation-prompt" aria-label="Conversation">
            <h2>Conversation</h2>
            <p>
              This local preview uses a deterministic fake agent. It never sends your project
              anywhere.
            </p>
          </section>
        </aside>
        <section className="preview-pane" aria-label="Live React preview">
          <div className="preview-toolbar">
            <span>Live React preview</span>
            <code>{screen?.route}</code>
            <span>{workspace.selectedState}</span>
          </div>
          <Preview
            screenId={screen?.id ?? 'dashboard'}
            state={workspace.selectedState}
            selectedNodeId={workspace.selectedNodeId}
            onSelect={actions.onNodeSelect}
          />
        </section>
        <aside className="inspector" aria-label="Inspector">
          <section>
            <div className="section-title">
              <h2>Screen</h2>
              <span className={`status-badge status-badge--${workspace.status}`}>
                {workspace.status.replace('-', ' ')}
              </span>
            </div>
            <label>
              Navigate
              <select
                aria-label="Navigate screen"
                value={workspace.selectedScreenId}
                onChange={(event) => actions.onScreenChange(event.currentTarget.value)}
              >
                {workspace.screens.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name} · {item.route}
                  </option>
                ))}
              </select>
            </label>
            <label>
              State
              <select
                aria-label="Preview state"
                value={workspace.selectedState}
                onChange={(event) => actions.onStateChange(event.currentTarget.value)}
              >
                {screen?.states.map((state) => (
                  <option value={state} key={state}>
                    {state}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select
                aria-label="Project status"
                value={workspace.status}
                onChange={(event) =>
                  actions.onStatusChange(event.currentTarget.value as WorkspaceStatus)
                }
              >
                <option value="draft">draft</option>
                <option value="in-review">in review</option>
                <option value="ready">ready</option>
              </select>
            </label>
          </section>
          <section aria-label="Selected node">
            <h2>Selection</h2>
            <p className="node-id">{workspace.selectedNodeId ?? 'Choose a preview element'}</p>
            {workspace.selectedNodeId ? (
              <form onSubmit={submitComment}>
                <label>
                  Add comment
                  <textarea
                    aria-label="Comment for selected node"
                    value={comment}
                    onChange={(event) => setComment(event.currentTarget.value)}
                    placeholder="Describe the change…"
                  />
                </label>
                <button type="submit">Add comment</button>
              </form>
            ) : null}
            {selectedComments.map((item) => (
              <article className="comment" key={item.id}>
                <p>{item.body}</p>
                <small>
                  {item.author} · {item.resolvedAt ? 'Resolved' : 'Open'}
                </small>
                {item.resolvedAt ? null : (
                  <button type="button" onClick={() => actions.onResolveComment(item.id)}>
                    Resolve
                  </button>
                )}
              </article>
            ))}
          </section>
          <section>
            <h2>Developer directions</h2>
            <form onSubmit={submitDirection}>
              <label className="visually-hidden" htmlFor="developer-direction">
                Developer direction
              </label>
              <textarea
                id="developer-direction"
                value={direction}
                onChange={(event) => setDirection(event.currentTarget.value)}
                placeholder="Add a handoff direction…"
              />
              <button type="submit">Add direction</button>
            </form>
            {workspace.developerDirections.map((item) => (
              <p className="direction" key={item.id}>
                {item.body}
              </p>
            ))}
          </section>
          <section>
            <h2>Changelog</h2>
            <ul className="changelog">
              {workspace.changelog
                .slice()
                .reverse()
                .map((item) => (
                  <li key={item.id}>{item.summary}</li>
                ))}
            </ul>
          </section>
        </aside>
      </div>
    </main>
  );
}
