import { describe, expect, it } from 'vitest';

import {
  assertDesignerApiVersion,
  defaultWorkspaceCockpitPreferences,
  DESIGNER_API_VERSION,
  isSafeDesignLanguageDisplayLabel,
  migrateWorkspaceCockpitPreferencesV1,
  validateWorkspaceCockpitPreferences,
  workspaceCockpitRailMaximum,
  workspaceCockpitRailMinimum,
  validateAIProposalDecision,
  validateAIChangeUndo,
  validateManualDesignUndo,
  validatePreviewBuildTicket,
  validatePrototypeScenarioStart,
  validateStoryPreviewTicket,
  validateSpatialTarget
} from './designer-api';

const viewport = { width: 1100, height: 700 };

describe('validateSpatialTarget', () => {
  it('accepts points and bounded, non-zero regions', () => {
    expect(validateSpatialTarget({ x: 0, y: 1, viewport })).toEqual({ x: 0, y: 1, viewport });
    expect(validateSpatialTarget({ x: 0.2, y: 0.3, width: 0.5, height: 0.4, viewport })).toEqual({
      x: 0.2,
      y: 0.3,
      width: 0.5,
      height: 0.4,
      viewport
    });
  });

  it('requires paired, non-zero region dimensions within the normalized artifact', () => {
    expect(() => validateSpatialTarget({ x: 0.1, y: 0.1, width: 0.2, viewport })).toThrow(
      /provided together/
    );
    expect(() =>
      validateSpatialTarget({ x: 0.1, y: 0.1, width: 0, height: 0.2, viewport })
    ).toThrow(/non-zero/);
    expect(() =>
      validateSpatialTarget({ x: 0.9, y: 0.1, width: 0.2, height: 0.2, viewport })
    ).toThrow(/within normalized bounds/);
    expect(() =>
      validateSpatialTarget({ x: 0.1, y: 0.9, width: 0.2, height: 0.2, viewport })
    ).toThrow(/within normalized bounds/);
  });
});

describe('desktop designer API version', () => {
  it('accepts the current breaking contract version', () => {
    expect(() => assertDesignerApiVersion(DESIGNER_API_VERSION)).not.toThrow();
  });

  it('rejects stale and unknown host contracts clearly', () => {
    expect(() => assertDesignerApiVersion('selene-desktop-designer/v1')).toThrow(
      /Unsupported desktop designer API version/
    );
    expect(() => assertDesignerApiVersion(undefined)).toThrow(
      /Unsupported desktop designer API version/
    );
  });
});

describe('story preview tickets', () => {
  const ticket = {
    format: 'selene-story-preview-ticket/v1',
    capabilityId: 'a'.repeat(32),
    projectId: 'orders',
    sourceRevisionId: 'orders-r1',
    catalogRevision: 'catalog-r1',
    buildId: 'storybook-r1',
    componentId: 'order-card',
    storyId: 'order-card-default'
  };

  it('accepts only the exact bounded data contract', () => {
    expect(validateStoryPreviewTicket(ticket)).toEqual(ticket);
  });

  it('rejects missing, additional, accessor, and malformed capability fields', () => {
    expect(() => validateStoryPreviewTicket({ ...ticket, capabilityId: 'short' })).toThrow(
      /capabilityId/
    );
    expect(() => validateStoryPreviewTicket({ ...ticket, sourcePath: '/private/src' })).toThrow(
      /fields/
    );
    expect(() => {
      const accessor = { ...ticket };
      Object.defineProperty(accessor, 'storyId', { enumerable: true, get: () => 'default' });
      return validateStoryPreviewTicket(accessor);
    }).toThrow();
  });
});

describe('product preview tickets', () => {
  const ticket = {
    format: 'selene-preview-build-ticket/v1',
    projectId: 'orders',
    sourceRevisionId: 'orders-r4',
    graphRevision: 7,
    bindingId: 'a'.repeat(64)
  };

  it('accepts only the exact bounded host identity', () => {
    expect(validatePreviewBuildTicket(ticket)).toEqual(ticket);
  });

  it('rejects additional, stale-shaped, and malformed identity fields', () => {
    expect(() => validatePreviewBuildTicket({ ...ticket, source: {} })).toThrow(/invalid/);
    expect(() => validatePreviewBuildTicket({ ...ticket, graphRevision: -1 })).toThrow(/invalid/);
    expect(() => validatePreviewBuildTicket({ ...ticket, bindingId: 'short' })).toThrow(/invalid/);
    expect(() => validatePreviewBuildTicket({ ...ticket, projectId: '../orders' })).toThrow(
      /invalid/
    );
  });
});

describe('workspace cockpit rail preferences', () => {
  const preferences = {
    format: 'selene-workspace-cockpit-preferences/v1' as const,
    leftRailWidth: workspaceCockpitRailMinimum,
    rightRailWidth: workspaceCockpitRailMaximum,
    leftRailCollapsed: false,
    rightRailCollapsed: false,
    inspectorTab: 'inspect' as const
  };

  it('opens a new workspace on the canvas with both supporting rails available on demand', () => {
    expect(defaultWorkspaceCockpitPreferences).toMatchObject({
      leftRailCollapsed: true,
      rightRailCollapsed: true
    });
  });

  it('accepts the full visible rail range used by the renderer and ARIA controls', () => {
    expect(validateWorkspaceCockpitPreferences(preferences)).toEqual(preferences);
  });

  it('rejects widths outside the visible rail range instead of persisting a hidden CSS value', () => {
    expect(() =>
      validateWorkspaceCockpitPreferences({
        ...preferences,
        leftRailWidth: workspaceCockpitRailMinimum - 1
      })
    ).toThrow(/220 to 340/);
    expect(() =>
      validateWorkspaceCockpitPreferences({
        ...preferences,
        rightRailWidth: workspaceCockpitRailMaximum + 1
      })
    ).toThrow(/220 to 340/);
  });

  it('migrates former v1 widths per field without resetting collapse or the selected tab', () => {
    expect(
      migrateWorkspaceCockpitPreferencesV1({
        ...preferences,
        leftRailWidth: 520,
        rightRailWidth: 341,
        leftRailCollapsed: true,
        rightRailCollapsed: true,
        inspectorTab: 'handoff'
      })
    ).toEqual({
      ...preferences,
      leftRailWidth: workspaceCockpitRailMaximum,
      rightRailWidth: workspaceCockpitRailMaximum,
      leftRailCollapsed: true,
      rightRailCollapsed: true,
      inspectorTab: 'handoff'
    });
  });
});

describe('validateAIChangeUndo', () => {
  const valid = { projectId: 'desktop-designer', requestId: 'desktop-request-1' };

  it('accepts the exact bounded undo request shape', () => {
    expect(validateAIChangeUndo(valid)).toEqual(valid);
  });

  it('rejects missing, extra, accessor, non-plain, and invalid identifier input', () => {
    expect(() => validateAIChangeUndo({ projectId: valid.projectId })).toThrow(/only projectId/);
    expect(() => validateAIChangeUndo({ ...valid, extra: true })).toThrow(/only projectId/);
    const accessor = Object.defineProperty({ requestId: valid.requestId }, 'projectId', {
      enumerable: true,
      configurable: true,
      get: () => valid.projectId
    });
    expect(() => validateAIChangeUndo(accessor)).toThrow(/own writable data property/);
    expect(() => validateAIChangeUndo(Object.create(valid))).toThrow(/plain object/);
    expect(() =>
      validateAIChangeUndo({ projectId: '../outside', requestId: valid.requestId })
    ).toThrow(/valid identifier/);
  });
});

describe('validateManualDesignUndo', () => {
  const valid = {
    projectId: 'desktop-designer',
    undoId: 'undo-manual-edit-1',
    targetRevisionId: 'manual-revision-2'
  };

  it('accepts only the exact bounded receipt identity', () => {
    expect(validateManualDesignUndo(valid)).toEqual(valid);
  });

  it('rejects missing, extra, accessor, non-plain, and invalid identifiers', () => {
    expect(() => validateManualDesignUndo({ projectId: valid.projectId })).toThrow(
      /only projectId/
    );
    expect(() => validateManualDesignUndo({ ...valid, extra: true })).toThrow(/only projectId/);
    const accessor = Object.defineProperty(
      { undoId: valid.undoId, targetRevisionId: valid.targetRevisionId },
      'projectId',
      {
        enumerable: true,
        configurable: true,
        get: () => valid.projectId
      }
    );
    expect(() => validateManualDesignUndo(accessor)).toThrow(/own writable data property/);
    expect(() => validateManualDesignUndo(Object.create(valid))).toThrow(/plain object/);
    expect(() => validateManualDesignUndo({ ...valid, targetRevisionId: '../outside' })).toThrow(
      /valid identifier/
    );
  });
});

describe('validateAIProposalDecision', () => {
  const valid = {
    projectId: 'desktop-designer',
    requestId: 'desktop-request-1',
    candidateRevisionId: 'desktop-proposal-desktop-request-1'
  };

  it('accepts only the exact source-free proposal identity', () => {
    expect(validateAIProposalDecision(valid)).toEqual(valid);
  });

  it('rejects missing, extra, accessor, non-plain, and invalid identifiers', () => {
    expect(() => validateAIProposalDecision({ projectId: valid.projectId })).toThrow(
      /only projectId/
    );
    expect(() => validateAIProposalDecision({ ...valid, source: 'private' })).toThrow(
      /only projectId/
    );
    const accessor = Object.defineProperty(
      {
        requestId: valid.requestId,
        candidateRevisionId: valid.candidateRevisionId
      },
      'projectId',
      {
        enumerable: true,
        configurable: true,
        get: () => valid.projectId
      }
    );
    expect(() => validateAIProposalDecision(accessor)).toThrow(/own writable data property/);
    expect(() => validateAIProposalDecision(Object.create(valid))).toThrow(/plain object/);
    expect(() =>
      validateAIProposalDecision({ ...valid, candidateRevisionId: '../outside' })
    ).toThrow(/valid identifier/);
  });
});

describe('validatePrototypeScenarioStart', () => {
  const valid = {
    projectId: 'desktop-designer',
    graphRevision: 12,
    scenarioId: 'desktop-review'
  };

  it('accepts the exact current-project graph request shape', () => {
    expect(validatePrototypeScenarioStart(valid)).toEqual(valid);
  });

  it('rejects missing, extra, accessor, non-plain, and invalid request values', () => {
    expect(() => validatePrototypeScenarioStart({ projectId: valid.projectId })).toThrow(
      /only projectId/
    );
    expect(() => validatePrototypeScenarioStart({ ...valid, extra: true })).toThrow(
      /only projectId/
    );
    const accessor = Object.defineProperty(
      { graphRevision: valid.graphRevision, scenarioId: valid.scenarioId },
      'projectId',
      { enumerable: true, configurable: true, get: () => valid.projectId }
    );
    expect(() => validatePrototypeScenarioStart(accessor)).toThrow(/own writable data property/);
    expect(() => validatePrototypeScenarioStart(Object.create(valid))).toThrow(/plain object/);
    expect(() => validatePrototypeScenarioStart({ ...valid, projectId: '../outside' })).toThrow(
      /valid identifier/
    );
    expect(() => validatePrototypeScenarioStart({ ...valid, graphRevision: -1 })).toThrow(
      /non-negative safe integer/
    );
  });
});

describe('design-language display labels', () => {
  it('preserves bounded normalized Unicode basenames', () => {
    expect(isSafeDesignLanguageDisplayLabel('設計原則.md')).toBe(true);
    expect(isSafeDesignLanguageDisplayLabel('Règles produit.mdx')).toBe(true);
  });

  it('rejects paths, controls, bidi overrides, non-normalized text, and oversized labels', () => {
    expect(isSafeDesignLanguageDisplayLabel('../DESIGN.md')).toBe(false);
    expect(isSafeDesignLanguageDisplayLabel('folder\\DESIGN.md')).toBe(false);
    expect(isSafeDesignLanguageDisplayLabel('unsafe\u0000.md')).toBe(false);
    expect(isSafeDesignLanguageDisplayLabel('unsafe\u202e.md')).toBe(false);
    expect(isSafeDesignLanguageDisplayLabel('e\u0301.md')).toBe(false);
    expect(isSafeDesignLanguageDisplayLabel(`${'界'.repeat(54)}.md`)).toBe(false);
  });
});
