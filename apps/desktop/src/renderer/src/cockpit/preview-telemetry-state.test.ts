import { describe, expect, it } from 'vitest';

import { shouldClearPreviewTelemetry } from './preview-telemetry-state';

describe('preview telemetry state', () => {
  it('does not clear a host-confirmed selection when an older unselected snapshot effect flushes late', () => {
    expect(shouldClearPreviewTelemetry(undefined, 'dashboard.primary-action')).toBe(false);
  });

  it('clears telemetry only when the observed and current snapshots both lack a selection', () => {
    expect(shouldClearPreviewTelemetry(undefined, undefined)).toBe(true);
    expect(shouldClearPreviewTelemetry('dashboard.primary-action', undefined)).toBe(false);
  });
});
