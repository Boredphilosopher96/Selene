import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './foundation.css';
import {
  issueOverlayContractError,
  isIssuedOverlayContractError
} from './workspace-collection-contracts';
interface OverlayTheme {
  readonly className: string;
  readonly contrast: string | undefined;
  readonly density: string | undefined;
  readonly direction: string | undefined;
  readonly language: string | undefined;
  readonly motion: string | undefined;
  readonly style: CSSProperties;
  readonly theme: string | undefined;
}

const overlayThemeTokenNames = [
  '--sl-color-canvas',
  '--sl-color-surface',
  '--sl-color-surface-subtle',
  '--sl-color-text',
  '--sl-color-text-muted',
  '--sl-color-border',
  '--sl-color-border-strong',
  '--sl-color-action',
  '--sl-color-action-hover',
  '--sl-color-action-foreground',
  '--sl-color-danger',
  '--sl-color-danger-surface',
  '--sl-color-success',
  '--sl-color-success-surface',
  '--sl-color-warning',
  '--sl-color-warning-surface',
  '--sl-color-info',
  '--sl-color-info-surface',
  '--sl-shadow-raised',
  '--sl-radius-control',
  '--sl-radius-surface',
  '--sl-space-1',
  '--sl-space-2',
  '--sl-space-3',
  '--sl-space-4',
  '--sl-control-height',
  '--sl-transition-fast',
  '--sl-focus-ring'
] as const;
const maximumOverlayTokenLength = 256;
const maximumOverlayTokenCodeUnits = 512;

function boundedThemeValue(value: unknown, allowed: readonly string[]): string | undefined {
  return typeof value === 'string' && allowed.includes(value) ? value : undefined;
}

function boundedLocale(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 35 && /^[A-Za-z0-9-]{1,35}$/.test(value)
    ? value
    : undefined;
}

function themeHost(element: Element | null): HTMLElement | null {
  return element !== null && typeof element.closest === 'function'
    ? element.closest<HTMLElement>('.sl-theme')
    : null;
}

function snapshotOverlayTheme(host: HTMLElement | null): OverlayTheme | undefined {
  if (host === null) return undefined;
  const computed = host.ownerDocument.defaultView?.getComputedStyle(host);
  if (computed === undefined) return undefined;
  const tokens: Record<string, string> = {};
  for (const property of overlayThemeTokenNames) {
    const raw = computed.getPropertyValue(property);
    if (raw.length > maximumOverlayTokenCodeUnits) continue;
    const value = raw.trim();
    if (value.length <= maximumOverlayTokenLength) tokens[property] = value;
  }
  return {
    className: 'sl-theme',
    contrast: boundedThemeValue(host.dataset.contrast, ['more']),
    density: boundedThemeValue(host.dataset.density, ['compact']),
    direction: boundedThemeValue(host.dir, ['ltr', 'rtl', 'auto']),
    language: boundedLocale(host.lang),
    motion: boundedThemeValue(host.dataset.motion, ['reduce']),
    style: tokens as CSSProperties,
    theme: boundedThemeValue(host.dataset.theme, ['dark'])
  };
}

export function useOverlayTheme(
  open: boolean,
  sourceRef?: React.RefObject<Element | null>
): OverlayTheme | undefined {
  const [theme, setTheme] = useState<OverlayTheme>();
  const [observedHost, setObservedHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setObservedHost(null);
      return;
    }
    const source = sourceRef?.current;
    const ownerDocument = source?.ownerDocument ?? globalThis.document;
    const active = source ?? ownerDocument?.activeElement;
    const host = themeHost(active !== null && active?.nodeType === 1 ? active : null);
    if (host !== observedHost) setObservedHost(host);
  });
  useLayoutEffect(() => {
    if (!open || observedHost === null) {
      setTheme(undefined);
      return;
    }
    let active = true;
    const sync = () => {
      if (active) setTheme(snapshotOverlayTheme(observedHost));
    };
    sync();
    const MutationObserver = observedHost.ownerDocument.defaultView?.MutationObserver;
    if (MutationObserver === undefined) return;
    const observer = new MutationObserver(sync);
    observer.observe(observedHost, {
      attributes: true,
      attributeFilter: [
        'class',
        'data-contrast',
        'data-density',
        'data-motion',
        'data-theme',
        'dir',
        'lang',
        'style'
      ]
    });
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [observedHost, open]);
  return theme;
}

/** One host per document keeps portal allocation bounded. Leases are effect-owned. */
type OverlayHostRecord = {
  readonly host: HTMLElement;
  leases: number;
  readonly portalOwners: Set<string>;
};
const overlayHosts = new WeakMap<Document, OverlayHostRecord>();
const maximumOverlayPortals = 32;

function acquireOverlayHost(ownerDocument: Document): HTMLElement {
  const existing = overlayHosts.get(ownerDocument);
  if (existing !== undefined) {
    existing.leases += 1;
    if (!existing.host.isConnected) ownerDocument.body.append(existing.host);
    return existing.host;
  }
  const host = ownerDocument.createElement('div');
  host.dataset.overlayPortalHost = 'true';
  ownerDocument.body.append(host);
  overlayHosts.set(ownerDocument, { host, leases: 1, portalOwners: new Set() });
  return host;
}

function releaseOverlayHost(ownerDocument: Document, host: HTMLElement): void {
  const record = overlayHosts.get(ownerDocument);
  if (record === undefined || record.host !== host) return;
  record.leases -= 1;
  if (record.leases > 0) return;
  host.remove();
  overlayHosts.delete(ownerDocument);
}

function reserveOverlayPortal(host: HTMLElement, owner: string): void {
  const record = overlayHosts.get(host.ownerDocument);
  if (record === undefined || record.host !== host)
    throw issueOverlayContractError('Overlay portal host is not active.');
  if (!record.portalOwners.has(owner) && record.portalOwners.size >= maximumOverlayPortals)
    throw issueOverlayContractError(
      `Overlay host supports at most ${maximumOverlayPortals} active portals.`
    );
  record.portalOwners.add(owner);
}

function releaseOverlayPortal(ownerDocument: Document, host: HTMLElement, owner: string): void {
  const record = overlayHosts.get(ownerDocument);
  if (record?.host === host) record.portalOwners.delete(owner);
}

type OverlayHostLease = { readonly host: HTMLElement; readonly ownerDocument: Document };

export function useOverlayPortalHost(
  sourceRef: React.RefObject<Element | null> | undefined,
  active: boolean,
  owner: string
): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const lease = useRef<OverlayHostLease | null>(null);
  useLayoutEffect(() => {
    if (!active) {
      lease.current = null;
      setHost((current) => (current === null ? current : null));
      return;
    }
    const ownerDocument = sourceRef?.current?.ownerDocument ?? globalThis.document;
    if (ownerDocument === undefined || ownerDocument.body === null) return;
    const shared = acquireOverlayHost(ownerDocument);
    try {
      reserveOverlayPortal(shared, owner);
    } catch (error) {
      releaseOverlayHost(ownerDocument, shared);
      if (isIssuedOverlayContractError(error)) throw error;
      throw issueOverlayContractError('Overlay portal host could not be reserved.');
    }
    lease.current = { host: shared, ownerDocument };
    setHost(shared);
    return () => {
      releaseOverlayPortal(ownerDocument, shared, owner);
      releaseOverlayHost(ownerDocument, shared);
      lease.current = null;
      setHost((current) => (current === shared ? null : current));
    };
  }, [active, owner, sourceRef]);
  return host;
}

export function portalOverlay(
  content: ReactNode,
  theme: OverlayTheme | undefined,
  host: HTMLElement | null,
  owner: string
): ReactNode {
  if (host === null) return null;
  return createPortal(
    <div
      className={theme?.className}
      data-contrast={theme?.contrast}
      data-density={theme?.density}
      data-motion={theme?.motion}
      data-overlay-portal="true"
      data-overlay-owner={owner}
      data-theme={theme?.theme}
      dir={theme?.direction}
      lang={theme?.language}
      style={theme?.style}
    >
      {content}
    </div>,
    host
  );
}
