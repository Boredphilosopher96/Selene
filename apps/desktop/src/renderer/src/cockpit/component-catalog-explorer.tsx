import { useEffect, useMemo, useState } from 'react';

import type { DesignerSnapshot } from '../../../shared/designer-api';
import './component-catalog-explorer.css';

type CatalogEntry = DesignerSnapshot['componentCatalog']['entries'][number];
type CatalogFilter = 'all' | 'local' | 'libraries' | 'patterns' | 'templates';

interface ComponentCatalogExplorerProps {
  readonly entries: readonly CatalogEntry[];
  readonly projectId: string;
  readonly revisionId: string;
  readonly onUseInDesign: (entry: CatalogEntry) => void;
}

const filters: readonly { readonly id: CatalogFilter; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'local', label: 'Local' },
  { id: 'libraries', label: 'Libraries' },
  { id: 'patterns', label: 'Patterns' },
  { id: 'templates', label: 'Templates' }
];

function entryKey(entry: CatalogEntry): string {
  return `${entry.component}:${entry.href}`;
}

function matchesFilter(entry: CatalogEntry, filter: CatalogFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'local') return entry.origin === 'project';
  if (filter === 'libraries')
    return entry.origin === 'design-system' && !entry.patternId && !entry.templateId;
  if (filter === 'patterns') return entry.patternId !== undefined;
  return entry.templateId !== undefined;
}

function entryKind(entry: CatalogEntry): string {
  if (entry.templateId) return `${entry.templateKind === 'screen' ? 'Screen' : 'Section'} template`;
  if (entry.patternId) return 'Pattern';
  return entry.origin === 'project' ? 'Local component' : 'Library component';
}

function searchableEntry(entry: CatalogEntry): string {
  return [
    entry.component,
    entry.packageName,
    entry.version,
    entry.exportName,
    entry.entrypoint,
    entry.patternId,
    entry.templateId,
    entry.description
  ]
    .filter((value): value is string => value !== undefined)
    .join(' ')
    .normalize('NFKC')
    .toLocaleLowerCase();
}

/** A dedicated catalog surface; it never treats the product prototype as Storybook. */
export function ComponentCatalogExplorer({
  entries,
  projectId,
  revisionId,
  onUseInDesign
}: ComponentCatalogExplorerProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CatalogFilter>('all');
  const [selectedKey, setSelectedKey] = useState<string>();
  const visibleEntries = useMemo(() => {
    const normalizedQuery = query.normalize('NFKC').trim().toLocaleLowerCase();
    return entries.filter(
      (entry) =>
        matchesFilter(entry, filter) &&
        (normalizedQuery.length === 0 || searchableEntry(entry).includes(normalizedQuery))
    );
  }, [entries, filter, query]);
  const selectedEntry =
    visibleEntries.find((entry) => entryKey(entry) === selectedKey) ?? visibleEntries[0];
  const selectedEntryKey = selectedEntry === undefined ? undefined : entryKey(selectedEntry);

  useEffect(() => {
    if (selectedEntryKey !== undefined && selectedKey !== selectedEntryKey)
      setSelectedKey(selectedEntryKey);
  }, [selectedEntryKey, selectedKey]);

  const projectCount = entries.filter((entry) => entry.origin === 'project').length;
  const libraryCount = entries.length - projectCount;

  return (
    <section className="component-explorer" aria-label="Component and Storybook explorer">
      <header className="component-explorer__masthead">
        <div>
          <span>Reusable design inventory</span>
          <h2>Components</h2>
          <p>
            Browse governed React building blocks separately from the interactive product prototype.
          </p>
        </div>
        <dl aria-label="Catalog summary">
          <div>
            <dt>Local</dt>
            <dd>{projectCount}</dd>
          </div>
          <div>
            <dt>Libraries</dt>
            <dd>{libraryCount}</dd>
          </div>
          <div>
            <dt>Revision</dt>
            <dd title={revisionId}>{revisionId}</dd>
          </div>
        </dl>
      </header>

      <div className="component-explorer__body">
        <aside className="component-explorer__index" aria-label="Component catalog">
          <label className="component-explorer__search">
            <span>Search catalog</span>
            <input
              type="search"
              value={query}
              placeholder="Name, package, export…"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <div className="component-explorer__filters" role="group" aria-label="Catalog filters">
            {filters.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="component-explorer__result-count" role="status">
            {visibleEntries.length} {visibleEntries.length === 1 ? 'result' : 'results'}
          </p>
          {visibleEntries.length === 0 ? (
            <div className="component-explorer__empty">
              <strong>No matching components</strong>
              <p>Try another name or broaden the catalog filter.</p>
            </div>
          ) : (
            <ol className="component-explorer__list">
              {visibleEntries.map((entry) => {
                const key = entryKey(entry);
                return (
                  <li key={key}>
                    <button
                      type="button"
                      aria-pressed={key === selectedEntryKey}
                      onClick={() => setSelectedKey(key)}
                    >
                      <span className="component-explorer__glyph" aria-hidden="true">
                        {entry.templateId ? '▣' : entry.patternId ? '◫' : '◇'}
                      </span>
                      <span>
                        <strong>{entry.component}</strong>
                        <small>
                          {entry.origin === 'design-system'
                            ? `${entry.packageName}@${entry.version}`
                            : projectId}
                        </small>
                      </span>
                      <em>{entryKind(entry)}</em>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </aside>

        {selectedEntry ? (
          <article className="component-explorer__detail" aria-label={selectedEntry.component}>
            <header className="component-explorer__detail-header">
              <div>
                <span>{entryKind(selectedEntry)}</span>
                <h3>{selectedEntry.component}</h3>
                <p>
                  {selectedEntry.description ??
                    (selectedEntry.origin === 'project'
                      ? 'A React export owned by this project.'
                      : 'An approved export from a configured npm design system.')}
                </p>
              </div>
              <button type="button" onClick={() => onUseInDesign(selectedEntry)}>
                Use in design
              </button>
            </header>

            <div className="component-explorer__preview">
              <div className="component-explorer__preview-chrome">
                <span>Story preview</span>
                <div aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
                <span>Responsive canvas</span>
              </div>
              <div className="component-explorer__preview-unavailable">
                <span aria-hidden="true">◇</span>
                <strong>No validated Storybook preview</strong>
                <p>
                  This catalog projection does not include a host-issued story preview handle.
                  Selene will not guess a URL or execute package code in the renderer.
                </p>
              </div>
            </div>

            <div className="component-explorer__facts">
              <section>
                <header>
                  <span>API</span>
                  <h4>Props and variants</h4>
                </header>
                {selectedEntry.properties && selectedEntry.properties.length > 0 ? (
                  <dl className="component-explorer__props">
                    {selectedEntry.properties.map((property) => (
                      <div key={property.name}>
                        <dt>
                          <code>{property.name}</code>
                          {property.required ? <em>Required</em> : null}
                        </dt>
                        <dd>
                          <strong>{property.label}</strong>
                          <span>
                            {property.control}
                            {property.values ? ` · ${property.values.join(' | ')}` : ''}
                          </span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="component-explorer__fact-empty">
                    No editable prop contract was declared for this catalog entry.
                  </p>
                )}
              </section>

              <section>
                <header>
                  <span>Governance</span>
                  <h4>Source and ownership</h4>
                </header>
                <dl className="component-explorer__provenance">
                  <div>
                    <dt>Owner</dt>
                    <dd>
                      {selectedEntry.origin === 'project'
                        ? projectId
                        : (selectedEntry.packageName ?? 'Unavailable')}
                    </dd>
                  </div>
                  <div>
                    <dt>Export</dt>
                    <dd>{selectedEntry.exportName ?? selectedEntry.component}</dd>
                  </div>
                  <div>
                    <dt>Entrypoint</dt>
                    <dd>{selectedEntry.entrypoint ?? 'Project source'}</dd>
                  </div>
                  <div>
                    <dt>Integrity</dt>
                    <dd title={selectedEntry.artifactDigest}>
                      {selectedEntry.artifactDigest ?? 'Current project revision'}
                    </dd>
                  </div>
                </dl>
              </section>
            </div>
          </article>
        ) : (
          <div className="component-explorer__welcome">
            <span aria-hidden="true">◇</span>
            <h3>Select a component</h3>
            <p>Review its contract, provenance, and governed story availability.</p>
          </div>
        )}
      </div>
    </section>
  );
}
