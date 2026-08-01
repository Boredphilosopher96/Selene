import { describe, expect, it } from 'vitest';

import {
  isPreviewSelectionAuthorized,
  retainCurrentPreviewSelectionValues,
  shouldClearPreviewTelemetry
} from './preview-telemetry-state';

describe('preview telemetry state', () => {
  it('does not clear a host-confirmed selection when an older unselected snapshot effect flushes late', () => {
    expect(shouldClearPreviewTelemetry(undefined, 'dashboard.primary-action')).toBe(false);
  });

  it('clears telemetry only when the observed and current snapshots both lack a selection', () => {
    expect(shouldClearPreviewTelemetry(undefined, undefined)).toBe(true);
    expect(shouldClearPreviewTelemetry('dashboard.primary-action', undefined)).toBe(false);
  });

  it('converges proof-first and host-first arrivals only after both fences settle', () => {
    let hostConfirmed = false;
    let hasSelectionProof = true;
    expect(isPreviewSelectionAuthorized(hostConfirmed, hasSelectionProof)).toBe(false);
    hostConfirmed = true;
    expect(isPreviewSelectionAuthorized(hostConfirmed, hasSelectionProof)).toBe(true);

    hostConfirmed = true;
    hasSelectionProof = false;
    expect(isPreviewSelectionAuthorized(hostConfirmed, hasSelectionProof)).toBe(false);
    hasSelectionProof = true;
    expect(isPreviewSelectionAuthorized(hostConfirmed, hasSelectionProof)).toBe(true);
    expect(isPreviewSelectionAuthorized(hostConfirmed, false)).toBe(false);
  });

  it('keeps rich inspected telemetry when a proof arrives after hydration', () => {
    const rich = { display: 'grid', semanticTag: 'button' };
    const fallback = { display: 'block', semanticTag: 'div' };
    expect(
      retainCurrentPreviewSelectionValues(
        { nodeId: 'orders.action', revisionId: 'r2', values: rich },
        'orders.action',
        'r2',
        fallback
      )
    ).toBe(rich);
    expect(
      retainCurrentPreviewSelectionValues(
        { nodeId: 'orders.other', revisionId: 'r2', values: rich },
        'orders.action',
        'r2',
        fallback
      )
    ).toBe(fallback);
  });
});
